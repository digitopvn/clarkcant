import type { IncomingMessage, Server } from "node:http";

import { type ConversationId, type Instant, nowInstant } from "@clarkcant/contracts";
import { recordVoiceTranscript } from "@clarkcant/core";
import { GeminiLiveAdapter, type VoiceProviderAdapter } from "@clarkcant/voice-adapters";
import { type RawData, WebSocketServer, type WebSocket } from "ws";

import { tokenMatches } from "./gateway.ts";
import type { NodeServices } from "./services.ts";

/**
 * The voice socket.
 *
 * ## Why the node is in the path at all
 *
 * The browser must never hold a provider credential. A node-side proxy is what makes that true
 * without an ephemeral-token flow: the key lives in this process, the browser sends audio and
 * receives audio, and no credential of any kind reaches the page. That property is the reason
 * this file exists, and it is asserted by a test rather than assumed.
 *
 * ## The wire, browser side
 *
 * Text frames are JSON control messages; binary frames are always raw PCM16 audio.
 *
 * Client to node:
 *   `{ type: "auth", token, conversationId? }` — must be the first frame, see below
 *   `{ type: "end" }`                          — end the session politely
 *   binary                                     — PCM16, 16 kHz, mono
 *
 * Node to client:
 *   `{ type: "ready", sessionId, inputSampleRateHz, outputSampleRateHz, willRecord }`
 *   `{ type: "denied", code, message, heldBy? }`
 *   `{ type: "state", state }`
 *   `{ type: "transcript", role, text, final }`
 *   `{ type: "error", code, message }`
 *   `{ type: "ended", recordedMessages }`
 *   binary                                     — PCM16, 24 kHz, mono
 *
 * ## Why the token is not in the URL
 *
 * A browser `WebSocket` cannot set an `Authorization` header, so the credential has to travel
 * some other way, and the query string is the wrong answer: URLs are written to access logs, to
 * proxy logs, and to browser history. So the socket is accepted unauthenticated and **the first
 * frame must be the auth message**. Any binary frame that arrives before authentication is
 * refused and the socket is closed, because audio arriving from an unauthenticated peer is
 * either a bug or an attempt, and neither deserves a provider session.
 *
 * ## One session per node
 *
 * A second request is refused, naming the tab that holds the session, rather than being queued or
 * sharing. Two live sessions on one node would double the provider quota being spent with no way
 * for the operator to see it, and "who has the microphone" is a question the media-focus contract
 * already answers by naming the holder.
 */

export interface VoiceGatewayOptions {
  server: Server;
  services: NodeServices;
  /**
   * Reads the provider credential.
   *
   * Injected rather than read here, so this module never touches the environment and a test can
   * supply one without a real key existing.
   */
  credential: () => string | undefined;
  /** Model id, without the `models/` prefix. */
  model?: string;
  /**
   * What the person said, sent to the conversation the agent answers in.
   *
   * Injected rather than imported, because what this module needs from the rest of the node is one
   * function: here is a sentence, tell me what to say back. Injecting it is also what keeps the whole
   * voice path testable without a provider account and without a model.
   *
   * Absent means no agent is wired, and then the live model's own words are the answer, exactly as
   * before this channel existed.
   */
  answer?: (input: {
    conversationId: ConversationId;
    text: string;
    at: Instant;
    /**
     * The answer as it is being written, for a caller already showing it.
     *
     * What arrives is the text so far rather than a fragment to append: the node accumulates, so a
     * consumer replaces what it shows instead of having to guess whether two updates overlap.
     */
    onText?: (text: string) => void;
  }) => Promise<VoiceAnswerResult | undefined>;
  /**
   * Record the user's spoken decision on an operation.
   *
   * Injected for the same reason `answer` is: the node owns what a decision means - the digest, the expiry, the
   * receipt - and this module owns only the conversation that produced it.
   */
  decideApproval?: (input: {
    conversationId: ConversationId;
    approvalId: string;
    decision: "granted" | "denied";
    digest: string;
  }) => Promise<{ ok: boolean; message: string }>;
  /** Injected by tests so the transport can be exercised without a provider. */
  createAdapter?: () => VoiceProviderAdapter;
  now?: () => Instant;
  /** Path the socket is served on. */
  path?: string;
}

export interface VoiceGateway {
  /** How many sessions are live right now. */
  activeSessionCount(): number;
  /** The holder of the session, for a caller that needs to report it. */
  activeSessionHolder(): string | undefined;
  close(): Promise<void>;
}

/** What the agent answered, and what its turn added to the conversation. */
export interface VoiceAnswerResult {
  /** The words to read back. Empty when the agent produced nothing worth saying. */
  reply: string;
  /**
   * An operation the agent asked for, still waiting on a decision.
   *
   * A turn that proposes a command ends with a card nobody has decided. The person holding a microphone is not
   * going to click it, so the session asks about it out loud and takes the spoken answer as the decision; the
   * alternative is a card that waits for a press the voice mode never offers.
   */
  pendingApproval?: { approvalId: string; digest: string; description: string };
  /**
   * Messages this turn wrote to the conversation.
   *
   * Reported rather than recounted here, because the node knows what it stored and this module would
   * have to re-read the conversation to learn it.
   */
  recordedMessages: number;
}

/**
 * Whether a spoken answer meant yes or no.
 *
 * A keyword match rather than a model call, and deliberately so: this decides whether a command runs on the
 * machine, and a decision that a provider could paraphrase is a decision nobody can predict. Only recognised
 * words decide anything - anything else is not guessed at, and the session asks again, which is the honest
 * response to a mumble about something that is going to run.
 *
 * Both accented and unaccented spellings are listed because speech transcription is inconsistent about marks.
 */
export function interpretDecision(text: string): "granted" | "denied" | undefined {
  const said = text.toLowerCase();
  const denied = ["không", "khong", "đừng", "thôi", "thoi", "từ chối", "tu choi", "hủy", "huy", "no"];
  const granted = ["đồng ý", "dong y", "cho phép", "cho phep", "duyệt", "duyet", "được", "duoc", "ok", "yes"];
  // Refusal is tested first: "không được" contains a word that would otherwise read as permission.
  if (denied.some((word) => said.includes(word))) return "denied";
  if (granted.some((word) => said.includes(word))) return "granted";
  return undefined;
}

/** Close codes. 1008 is a policy refusal; 1013 is "try again when something changes". */
const CLOSE_POLICY = 1008;
const CLOSE_TRY_LATER = 1013;

/**
 * What the live session is for.
 *
 * It is the voice, not the mind. Left to itself the model answers whatever it hears, and then the
 * same question has two answers in the room: the model's guess, made without any tool and without
 * the conversation, and the agent's, which is the only one of the two that read the files, ran the
 * command or knows what was said five minutes ago. So the session is told to transcribe and to read
 * back, and to leave answering to the agent.
 */
const VOICE_INSTRUCTION = [
  "Bạn là giọng nói của trợ lý, không phải bộ não của nó.",
  "Có hai loại đầu vào và hai việc khác nhau, đừng lẫn chúng với nhau.",
  "Khi nghe tiếng người dùng nói: chép lại lời họ, và không tự trả lời, không hỏi lại, không bình luận.",
  "Khi nhận được một lượt văn bản: đó là câu trả lời của trợ lý, và việc của bạn là đọc nguyên văn đoạn văn đó ngay lập tức, không thêm bớt chữ nào.",
].join(" ");

/**
 * What a spoken turn asks the agent for.
 *
 * The session reads the answer out loud, and a long answer is not a conversation: the person waits through it,
 * cannot skim it, and cannot skip a part they already understood. So the spoken turn asks for the short
 * version - the same facts in fewer words - while the full answer still belongs to the conversation, where it
 * can be read at whatever length it needs.
 */
export const VOICE_ANSWER_NOTE = [
  "Câu trả lời này sẽ được đọc to lên trong một phiên thoại.",
  "Hãy trả lời thật ngắn gọn: một tới ba câu, hoặc một đoạn dưới 60 từ.",
  "Vẫn phải đủ ý và không bỏ sót thông tin quan trọng; nếu thiếu chỗ nào thì nói ngắn rằng còn chi tiết trong hội thoại.",
  "Không dùng bảng, không liệt kê dài, không khối mã; nhiều bước thì nói gọn bằng lời.",
].join(" ");

export function attachVoiceGateway(options: VoiceGatewayOptions): VoiceGateway {
  const path = options.path ?? "/voice";
  const now = options.now ?? nowInstant;
  const createAdapter =
    options.createAdapter ?? ((): VoiceProviderAdapter => new GeminiLiveAdapter(voiceAdapterDefaults(options)));

  const wss = new WebSocketServer({ noServer: true });
  let active: { sessionId: string; holder: string } | undefined;
  let sessionCounter = 0;

  options.server.on("upgrade", (request, socket, head) => {
    // Paths this gateway does not own are left alone rather than swallowed, so adding another
    // socket later does not mean editing this branch.
    if (new URL(request.url ?? "/", "http://localhost").pathname !== path) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      void serve(ws, request);
    });
  });

  async function serve(ws: WebSocket, request: IncomingMessage): Promise<void> {
    sessionCounter += 1;
    const sessionId = `voice-${sessionCounter}`;
    const holder = `${request.socket.remoteAddress ?? "unknown"}#${sessionId}`;

    let authenticated = false;
    let conversationId: ConversationId | undefined;
    let adapter: VoiceProviderAdapter | undefined;
    let userText = "";
    let assistantText = "";
    let recorded = false;
    /** Messages the agent's turns wrote, so the closing report counts what actually happened. */
    let answeredMessages = 0;
    /** An operation the agent asked for and is waiting on, if the person has not answered yet. */
    let waiting: { approvalId: string; digest: string; description: string } | undefined;
    /**
     * Utterances are answered one at a time, in the order they were said.
     *
     * A second question asked while the first is still being answered would be spoken over it, and the
     * two replies would arrive in whatever order the work finished rather than the order the person
     * spoke. Chaining keeps the conversation in the order it happened.
     */
    let answerQueue: Promise<void> = Promise.resolve();

    const send = (payload: unknown): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    const deny = (code: string, message: string, extra: Record<string, unknown> = {}, closeCode = CLOSE_POLICY): void => {
      send({ type: "denied", code, message, ...extra });
      ws.close(closeCode, code);
    };

    /**
     * Record the session once.
     *
     * Guarded by a flag rather than by the socket's state, because both a polite end and a dropped
     * connection can reach here and a session recorded twice is worse than one not recorded.
     */
    const record = (): number => {
      if (recorded || !authenticated) return 0;
      recorded = true;
      if (conversationId === undefined) return 0;
      // With an agent in the path every answered utterance is already a message in the conversation,
      // written while it was being said. What the agent wrote is reported as it is, and whatever is
      // left over is what never became a message - a sentence the agent could not answer, or one that
      // arrived while no answer was possible. That is the floor this session must not fall through:
      // leaving it out once made a broken answer path look like a session where nobody spoke.
      if (options.answer !== undefined) {
        // Only the user's side can be a leftover here. The live model's own words are its reading of the
        // reply the agent already wrote, so keeping them would store the same answer twice - which is
        // exactly the duplicate that appeared when this fallback was added.
        if (userText.trim() === "") return answeredMessages;
        const leftover = recordVoiceTranscript(options.services.conductor, {
          conversationId,
          userText,
          assistantText: "",
          at: now(),
        });
        return answeredMessages + leftover.length;
      }
      if (userText.trim() === "" && assistantText.trim() === "") return 0;

      const messages = recordVoiceTranscript(options.services.conductor, {
        conversationId,
        userText,
        assistantText,
        at: now(),
      });
      return answeredMessages + messages.length;
    };

    /**
     * Send one finished utterance to the agent, then read its answer back.
     *
     * The utterance is taken from the accumulated fragments, because the adapter closes an utterance
     * with an empty final fragment rather than repeating the text in it.
     */
    const ask = (at: Instant): void => {
      const askIn = conversationId;
      const answer = options.answer;
      const text = userText.trim();
      if (text === "" || askIn === undefined || answer === undefined) return;
      // Cleared only when this sentence really is being answered. Clearing it earlier would throw away
      // the only copy of something that was said, and the closing report would then have nothing to keep.
      userText = "";

      // A sentence said while an approval is waiting is a decision, not a question for the agent.
      const pending = waiting;
      const decide = options.decideApproval;
      if (pending !== undefined && decide !== undefined) {
        const decision = interpretDecision(text);
        if (decision === undefined) {
          // One more try, in the same words: the operation is going to run on the machine, so a sentence that
          // could have meant anything does not decide it.
          const again = "Tui chưa rõ ý bạn. Bạn cho phép chạy hay là không?";
          send({ type: "transcript", role: "assistant", text: again, final: true });
          adapter?.speak(again);
          return;
        }

        waiting = undefined;
        answerQueue = answerQueue.then(async () => {
          const decided = await decide({
            conversationId: askIn,
            approvalId: pending.approvalId,
            decision,
            digest: pending.digest,
          });
          const said = decided.ok
            ? decision === "granted"
              ? "Đã duyệt. Tui chạy lệnh đó ngay."
              : "Đã từ chối. Không có gì được chạy."
            : `Không thực hiện được: ${decided.message}`;
          send({ type: "transcript", role: "assistant", text: said, final: true });
          adapter?.speak(said);
        });
        return;
      }

      answerQueue = answerQueue
        .then(async () => {
          // The answer so far, accumulated here so the surface showing it never has to decide whether two
          // updates overlap.
          let draft = "";
          const result = await answer({
            conversationId: askIn,
            text,
            at,
            onText: (textSoFar) => {
              draft = textSoFar;
              if (draft.trim() === "") return;
              send({ type: "transcript", role: "assistant", text: draft, final: false });
            },
          });
          if (result === undefined) return;
          answeredMessages += result.recordedMessages;
          const reply = result.reply.trim();
          if (reply === "") return;
          // Shown as the assistant's words before it is spoken, so the transcript matches what is
          // heard even if playback never happens. The final text is the stored one, which is the one
          // that counts when a stream stops early.
          send({ type: "transcript", role: "assistant", text: reply, final: true });
          adapter?.speak(reply);

          // A proposed command waits for a person. Asked here, in the same turn that produced it, because the
          // card is otherwise a click the voice mode cannot offer.
          const proposed = result.pendingApproval;
          if (proposed !== undefined) {
            waiting = proposed;
            const question = `${proposed.description}. Bạn cho phép chạy hay là không?`;
            send({ type: "transcript", role: "assistant", text: question, final: true });
            adapter?.speak(question);
          }
        })
        .catch((cause: unknown) => {
          // A failed answer must not end the session. The microphone still works and the next sentence
          // deserves its own attempt, so this is reported and the queue moves on.
          send({
            type: "error",
            code: "VOICE_ANSWER_FAILED",
            message: cause instanceof Error ? cause.message : "the agent could not answer",
          });
        });
    };

    const finish = async (): Promise<void> => {
      const recordedMessages = record();
      // Only the socket that owns the slot may release it. A refused second socket closes too,
      // and clearing the slot unconditionally here would end a session that is still running —
      // which is how this was found.
      if (active?.sessionId === sessionId) active = undefined;
      await adapter?.disconnect().catch(() => undefined);
      send({ type: "ended", recordedMessages });
    };

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!authenticated) {
        if (isBinary) {
          // Audio before authentication never reaches the provider.
          deny("UNAUTHENTICATED", "the first frame must be an auth message, not audio");
          return;
        }
        void authenticate(data);
        return;
      }

      if (isBinary) {
        adapter?.sendAudio(new Uint8Array(data as Buffer));
        return;
      }

      const control = safeJson(data.toString());
      if (control?.["type"] === "end") {
        void finish().then(() => ws.close(1000, "ended by client"));
        return;
      }
      if (control?.["type"] === "mute") {
        // Mute is applied at the adapter as well as at the client's track. Two layers on purpose:
        // a mute that depends on one is a mute that fails silently when that one is broken.
        adapter?.setMuted(control["muted"] === true);
      }
    });

    async function authenticate(data: RawData): Promise<void> {
      const message = safeJson(data.toString());
      if (message?.["type"] !== "auth") {
        deny("UNAUTHENTICATED", "the first frame must be an auth message");
        return;
      }

      const presented = message["token"];
      if (typeof presented !== "string" || !tokenMatches(options.services.runtime.identity.localToken, presented)) {
        // Identical for a missing and a wrong token, as the HTTP gate is: distinguishing them
        // tells an attacker which half to work on.
        deny("UNAUTHENTICATED", "a valid bearer token is required to open a voice session");
        return;
      }

      if (active !== undefined) {
        deny(
          "VOICE_SESSION_BUSY",
          `this node already has a live voice session (${active.holder}); end it before starting another`,
          { heldBy: active.holder },
          CLOSE_TRY_LATER,
        );
        return;
      }

      const credential = options.credential();
      if (credential === undefined || credential === "") {
        deny("VOICE_NOT_CONFIGURED", "this node has no credential for the live voice provider", {}, CLOSE_TRY_LATER);
        return;
      }

      const requested = message["conversationId"];
      conversationId = typeof requested === "string" && requested !== "" ? (requested as ConversationId) : undefined;

      authenticated = true;
      active = { sessionId, holder };
      adapter = createAdapter();

      adapter.onStateChange((state) => send({ type: "state", state }));
      adapter.onAudio((pcm16) => {
        // Audio goes back as a binary frame, not as JSON: base64 inside a control message would
        // inflate every chunk by a third and put a string conversion on the latency path.
        if (ws.readyState === ws.OPEN) ws.send(pcm16, { binary: true });
      });
      adapter.onTranscript((fragment) => {
        if (fragment.role === "user") {
          userText += fragment.text;
          // The final fragment of an utterance is the adapter saying this one is complete, so this is
          // where a sentence becomes a message.
          if (fragment.isFinal) ask(fragment.at);
        } else if (fragment.role === "assistant") {
          assistantText += fragment.text;
        }
        // The live model's own words are only the answer when there is no agent. With one in the path
        // they are the model reading back what it was given, and forwarding them would show the reply
        // twice.
        if (fragment.role === "assistant" && options.answer !== undefined) return;
        send({ type: "transcript", role: fragment.role, text: fragment.text, final: fragment.isFinal });
      });

      try {
        // The adapter asks for the credential rather than being handed one at construction, so
        // the window in which it exists is the length of this call.
        await adapter.connect({ sessionId, tokenProvider: async () => credential });
      } catch (cause) {
        authenticated = false;
        active = undefined;
        deny(
          "VOICE_CONNECT_FAILED",
          cause instanceof Error ? cause.message : "the live voice session could not be opened",
          {},
          CLOSE_TRY_LATER,
        );
        return;
      }

      send({
        type: "ready",
        sessionId,
        inputSampleRateHz: 16000,
        outputSampleRateHz: 24000,
        // Reported rather than assumed, so a client that opened voice without a conversation knows
        // the transcript will not be stored instead of finding out later.
        willRecord: conversationId !== undefined,
      });
    }

    ws.on("close", () => {
      void finish();
    });

    ws.on("error", () => {
      void finish();
    });
  }

  return {
    activeSessionCount: () => (active === undefined ? 0 : 1),
    activeSessionHolder: () => active?.holder,
    close: async () => {
      active = undefined;
      for (const client of wss.clients) client.close(1001, "the node is shutting down");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** Options for the real adapter, resolved once so every session is configured the same way. */
/**
 * The options the node's own live adapter is built with.
 *
 * Exported because the instruction it carries is a requirement, not a detail: without it the live model
 * answers on its own and the room gets two answers to one question. A test asserts it rather than
 * trusting the reader to notice its absence.
 */
export function voiceAdapterDefaults(options: {
  model?: string;
}): ConstructorParameters<typeof GeminiLiveAdapter>[0] {
  return {
    systemInstruction: VOICE_INSTRUCTION,
    ...(options.model === undefined ? {} : { model: options.model }),
  };
}

function safeJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
