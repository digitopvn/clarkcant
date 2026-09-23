import type { IncomingMessage, Server } from "node:http";

import {
  answerFromUtterance,
  type AppIntentDecision,
  type AppIntentResolution,
  type ConfirmationDecision,
  type ConversationId,
  type Instant,
  type QuestionKind,
  type SemanticView,
  type VoiceCapabilities,
  nowInstant,
} from "@clarkcant/contracts";
import { recordVoiceTranscript, semanticViewOf } from "@clarkcant/core";
import { GeminiLiveAdapter, type VoiceProviderAdapter } from "@clarkcant/voice-adapters";
import { type RawData, WebSocketServer, type WebSocket } from "ws";

import { tokenMatches } from "./gateway.ts";
import {
  NO_FOCUSED_SURFACE_SAY,
  describeVoiceWidgetAction,
  resolveVoiceWidgetAction,
  type VoiceWidgetAction,
  type VoiceWidgetRun,
} from "./widget-voice-action.ts";
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
 *   `{ type: "focus", instanceId }`            — which widget the person is looking at, if any
 *   `{ type: "end" }`                          — end the session politely
 *   binary                                     — PCM16, 16 kHz, mono
 *
 * Node to client:
 *   `{ type: "ready", sessionId, inputSampleRateHz, outputSampleRateHz, willRecord }`
 *   `{ type: "denied", code, message, heldBy? }`
 *   `{ type: "state", state }`
 *   `{ type: "transcript", role, text, final }`
 *   `{ type: "app-intent", decision }`          — the application's answer to a command it was given
 *   `{ type: "widget-action-result", instanceId, revision, ok, say }` — what came of a spoken widget action
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

/**
 * How often the node asks a socket to prove it is still reachable.
 *
 * The lease is released when a socket closes, and a close frame is not something a peer can be relied on
 * to send: a frozen path or a machine that loses power leaves the peer gone while the node's socket stays
 * open. With one live session per node that single dead peer then refuses every session afterwards, and
 * there is no way out of it short of restarting the node. Measured through a proxy that stops forwarding
 * without closing either side: the next session was refused `VOICE_SESSION_BUSY` naming the gone peer, and
 * it stayed held.
 *
 * An unanswered ping is the signal, because it is the smallest one that tells "gone" from "quiet": a browser
 * answers pings in the protocol rather than in page code, so a backgrounded tab answers exactly like a
 * focused one, and nothing here depends on the page running. A peer that cannot answer cannot be talked to
 * either, so its session is over even though its socket is not.
 *
 * Two intervals is the bound, so a gone peer frees the slot within about half a minute. That is deliberate on
 * both sides: shorter would start ending live sessions over a network stall that a voice call does not survive
 * anyway, and longer leaves somebody staring at "end it before starting another" with nothing to end.
 */
const DEFAULT_HEARTBEAT_MS = 15_000;

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
   * How often a socket is asked to prove it is reachable.
   *
   * Defaults to `DEFAULT_HEARTBEAT_MS`. A test shortens it rather than waiting half a minute for a property
   * that has nothing to do with the value.
   */
  heartbeatMs?: number;
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
    /**
     * Forwards a `control_app` decision made while answering this utterance, so it reaches the renderer
     * through the same wire frame a deterministic spoken app-command already uses - `{type: "app-intent",
     * decision}` - and from there the same `runAppIntent` executor a click or a typed command runs.
     *
     * The agent turn that answers a spoken sentence has the app-control tool available exactly as a typed
     * turn does; this is the one extra step voice needs, because a typed turn already reaches the browser
     * over the SSE stream this socket has no part in.
     */
    onAppIntent?: (decision: AppIntentDecision) => void;
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
  /**
   * Answer a question the agent asked, through the same route a click uses.
   *
   * Injected for the same reason `decideApproval` is, and to the same end: voice is a surface, not a second
   * mechanism. If this grew its own way of recording an answer, the two surfaces would eventually disagree about
   * what a person chose — and the transcript would be the place that disagreement showed up.
   */
  answerQuestion?: (input: {
    conversationId: ConversationId;
    questionId: string;
    text?: string;
    optionIds?: string[];
    confirmed?: boolean;
  }) => Promise<{ ok: boolean; message: string }>;
  /**
   * What the conversation is still waiting for, when this session is not the one that asked.
   *
   * A card waiting in the conversation is waiting for whoever answers it: a person holding a microphone and looking
   * at that card expects the label to work, and a session that only remembered its own turn would read their answer
   * as a new request and leave the card standing. Asking the node is what makes "a click and a sentence are the same
   * act" true rather than a slogan.
   */
  pendingFor?: (conversationId: ConversationId) => PendingVoiceInteraction | undefined;

  /**
   * What a sentence means to the application, as opposed to what it means to the agent.
   *
   * Injected for the same reason `answer` is: the node owns the registry and the matching rules, and this
   * module owns the conversation. `none` means the sentence was not a command and belongs to the agent, which
   * is what keeps "how do I look at the settings of this host" out of the app-control path.
   */
  resolveAppIntent?: (input: { text: string; conversationId: ConversationId }) => AppIntentResolution;
  /**
   * Turn a pending confirmation into permission, or refuse it.
   *
   * This is the only way an executable decision reaches the page, and it can only be reached by a sentence said
   * while a token was waiting. A denial comes back as a refusal rather than as an error, because declining is a
   * complete answer to the question that was asked.
   */
  confirmAppIntent?: (input: { token: string; decision: ConfirmationDecision }) => AppIntentDecision;
  /**
   * Run a widget action the person asked for out loud.
   *
   * Injected like `decideApproval`, and for the same reason: the node owns whether an action may run - the owner
   * check, the revision it holds, the binding digest, and one effect per invocation - while this module owns the
   * conversation that asked. The point of it being one injected function is that a spoken action goes through the
   * function a click goes through rather than a second copy of those checks.
   */
  widgetAction?: (input: {
    conversationId: ConversationId;
    action: VoiceWidgetAction;
    focused: SemanticView | undefined;
  }) => Promise<VoiceWidgetRun>;
  /** Injected by tests so the transport can be exercised without a provider. */
  createAdapter?: () => VoiceProviderAdapter;
  now?: () => Instant;
  /**
   * How long the transcription has to be quiet before the sentence is taken as finished.
   *
   * Measured rather than assumed: the provider sends the user's sentence once, whole, with no interim text on
   * the way, and its closing marker arrives only when the model's own turn ends - which was six point eight
   * seconds later in the probe, with the agent's answer waiting behind it. Closing on the transcription's own
   * silence takes the model's turn off the critical path. Short enough to feel immediate, long enough that a
   * provider which does send partials is not cut off mid-sentence.
   */
  utteranceSettleMs?: number;
  /** Path the socket is served on. */
  path?: string;
}

export interface VoiceGateway {
  /** How many sessions are live right now. */
  activeSessionCount(): number;
  /** The holder of the session, for a caller that needs to report it. */
  activeSessionHolder(): string | undefined;
  /**
   * What the configured provider can do, as it reports it.
   *
   * Read by the settings surface before it draws a voice control, so a provider that cannot select a voice
   * shows no selector rather than one that changes nothing. Constructs an adapter to ask it: construction
   * does not connect, and the alternative is duplicating a provider's capability list somewhere else, which
   * is the duplication this contract exists to prevent.
   */
  capabilities(): VoiceCapabilities;
  close(): Promise<void>;
}

/**
 * What the node is waiting for, as far as a voice session is concerned.
 *
 * One union for both shapes, because voice has exactly one job when something is pending: read it out and take
 * the spoken answer. An approval is a yes-or-no question; a question card is four kinds of question. The session
 * does not need to know more than how to phrase each one, and it deliberately does not get its own way of
 * recording either answer.
 */
export type PendingVoiceInteraction =
  | { kind: "approval"; approvalId: string; digest: string; description: string }
  | {
      kind: "question";
      questionId: string;
      questionType: QuestionKind;
      prompt: string;
      options: { id: string; label: string }[];
      allowOther: boolean;
      /** Spoken by the host, derived from the options so the words cannot drift from the card. */
      voicePrompt: string;
    };

/** What the agent answered, and what its turn added to the conversation. */
export interface VoiceAnswerResult {
  /** The words to read back. Empty when the agent produced nothing worth saying. */
  reply: string;
  /**
   * What the agent asked for and is waiting on, if the person has not answered yet.
   *
   * A turn can end with something nobody has answered: a proposed command, or a question card. The person holding
   * a microphone is not going to click either, so the session asks out loud and takes the spoken answer — the
   * alternative is a card waiting for a press that voice mode never offers.
   */
  pendingInteraction?: PendingVoiceInteraction;
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
  const denied = ["không", "khong", "đừng", "thôi", "thoi", "từ chối", "tu choi", "hủy", "huy", "khoan", "no"];
  const granted = [
    "đồng ý",
    "dong y",
    "cho phép",
    "cho phep",
    "duyệt",
    "duyet",
    "được",
    "duoc",
    "ừ",
    "ok",
    "yes",
    "chạy đi",
    "chay di",
    "làm đi",
    "lam di",
    "tiến hành",
    "tien hanh",
  ];
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
  /*
   * Silence while the person speaks.
   *
   * This used to ask the model to transcribe what it heard, and the transcription was already being made
   * without it: both transcription configs are on, and the provider's own reading of the input is what the
   * transcript is built from. So the only thing that instruction added was the model saying those words out
   * loud - the person's own sentence, read back to them by their assistant before it had any answer to give.
   */
  "Khi nghe tiếng người dùng nói: giữ im lặng, không nói gì, không chép lại, không trả lời, không hỏi lại, không bình luận.",
  "Khi nhận được một lượt văn bản: đó là câu trả lời của trợ lý, và việc của bạn là đọc nguyên văn đoạn văn đó ngay lập tức, không thêm bớt chữ nào.",
].join(" ");

/**
 * The name the live provider's credential is stored under.
 *
 * One name in one place, because three things have to agree about it: the node reads it at open time, the card asks
 * the person for it by this name, and the interface names it when voice cannot start without it.
 */
export const VOICE_CREDENTIAL_NAME = "gemini";

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

    /*
     * Whether the agent has asked for something to be said, and has not finished saying it.
     *
     * The voice channel carries exactly what the agent decided to say, and nothing the model volunteers. That rule
     * exists because of what a person heard: the live model is told to stay quiet while they talk, and a rule that
     * describes silence rather than the work gets said out loud - the instruction's own words came back through the
     * speaker over and over.
     */
    let awaitingSpeech = false;
    const say = (text: string): void => {
      awaitingSpeech = true;
      adapter?.speak(text);
    };
    let userText = "";
    /**
     * Closes the sentence when the transcription stops growing.
     *
     * The provider's own end-of-utterance marker is tied to the model's turn, so waiting for it puts a full
     * model turn between the person stopping and the agent starting. This is the same decision made from
     * evidence that arrives first.
     */
    let settle: ReturnType<typeof setTimeout> | undefined;
    let assistantText = "";
    let recorded = false;
    /** Messages the agent's turns wrote, so the closing report counts what actually happened. */
    let answeredMessages = 0;
    /** What the agent asked for and is waiting on, if the person has not answered yet. */
    let waiting: PendingVoiceInteraction | undefined;
    /**
     * A token for a command that asked a question first.
     *
     * Held in the session rather than in the page, which is the point of the whole two-step: the page never
     * receives an executable quit, so nothing a page can do on its own ends the application.
     */
    let waitingIntent: string | undefined;
    /**
     * The widget the person is looking at, as an id and nothing else.
     *
     * Only the id crosses the wire, and the node builds the semantic view from what it holds. That is stricter than it
     * first looks: a page cannot describe an instance into existence, cannot describe one it does not own, and cannot
     * hand over a stale view - the view that decides what a sentence may do is the node's own reading. It is also less
     * to send, and the client has no mapper to keep in step with the contract.
     */
    let focusedInstanceId: string | undefined;
    /** A widget action that is waiting for a spoken yes, when the widget says it needs one. */
    let waitingWidget: VoiceWidgetAction | undefined;
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
      // A sentence still settling when the session closes belongs to the session, not to a turn that will never
      // arrive, so the pending close is dropped and whatever was transcribed is left for the fallback to keep.
      if (settle !== undefined) {
        clearTimeout(settle);
        settle = undefined;
      }
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
    /**
     * The focused instance's semantic view, built from what this node holds.
     *
     * Built on demand rather than kept, so what decides a sentence is the node's current reading of the instance
     * instead of a description a page sent earlier and may have outgrown. `semanticViewOf` is the same function the
     * agent's semantic view comes from, so a spoken action and an agent action see one account of the widget.
     */
    const focusedViewNow = (): SemanticView | undefined =>
      focusedInstanceId === undefined
        ? undefined
        : semanticViewOf(options.services.conductor, focusedInstanceId, { source: "live" });

    /**
     * Run a widget action and report what came of it.
     *
     * One place, shared by the sentence that needs no confirmation and the one that does, so a confirmed action cannot
     * end up on a different route than an unconfirmed one.
     */
    const runWidgetAction = (action: VoiceWidgetAction): void => {
      const run = options.widgetAction;
      const runIn = conversationId;
      if (run === undefined || runIn === undefined) return;
      answerQueue = answerQueue.then(async () => {
        const outcome = await run({ conversationId: runIn, action, focused: focusedViewNow() });
        // The page is told what changed rather than that something changed: it updates the same state a click updates,
        // and it can only do that from the node's own account of the revision it landed on.
        send({
          type: "widget-action-result",
          ok: outcome.ok,
          say: outcome.say,
          ...(outcome.ok ? { instanceId: outcome.instanceId, revision: outcome.revision } : {}),
        });
        send({ type: "transcript", role: "assistant", text: outcome.say, final: true });
        say(outcome.say);
      });
    };

    const ask = (at: Instant): void => {
      const askIn = conversationId;
      const answer = options.answer;
      const text = userText.trim();
      // Only a sentence and a conversation are required to get this far. Whether an agent is wired is checked
      // further down, at the point that needs one: the command channel has nothing to do with the model, and a
      // node with no agent can still open Settings or resize its own window when asked out loud.
      if (text === "") return;
      if (askIn === undefined) {
        /*
         * Said, not swallowed.
         *
         * A session with no conversation has nowhere to put a sentence: the agent answers inside a conversation, and
         * without one the words were transcribed and then dropped. The person heard nothing at all - no reply, no
         * error, and a surface that read "listening" - which is what gets reported as "voice does not work".
         * Measured on this path: the same audio with a conversation bound produced the agent's answer and 468 KB of
         * speech back; without one it produced neither.
         */
        userText = "";
        const unbound =
          "Phiên thoại này chưa gắn với hội thoại nào, nên tui không có chỗ để trả lời. Bạn mở lại voice khi đang ở trong hội thoại giúp tui nhé.";
        send({ type: "transcript", role: "assistant", text: unbound, final: true });
        say(unbound);
        return;
      }
      // Cleared only when this sentence really is being answered. Clearing it earlier would throw away
      // the only copy of something that was said, and the closing report would then have nothing to keep.
      userText = "";

      // A sentence said while something is pending is an answer, not a new request for the agent. The question need
      // not have been asked here: what is pending belongs to the conversation, so a card a click asked is answerable
      // by a sentence and a card this session asked is answerable by a click.
      const pending = waiting ?? options.pendingFor?.(askIn);
      if (pending !== undefined && pending.kind === "approval" && options.decideApproval !== undefined) {
        const decide = options.decideApproval;
        const decision = interpretDecision(text);
        if (decision === undefined) {
          // One more try, in the same words. The operation is going to run on the machine, so a sentence that could
          // have meant anything does not decide it - and this says which two words would, because a person who just
          // said something reasonable should not have to guess why it was not understood.
          const again = "Tui chưa rõ ý bạn. Bạn nói “đồng ý” hoặc “không” giúp tui nhé.";
          send({ type: "transcript", role: "assistant", text: again, final: true });
          say(again);
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
          say(said);
        });
        return;
      }

      /*
       * A question, read against its own options.
       *
       * `answerFromUtterance` can only produce an answer the card offered, which is what lets the same route serve
       * a click and a sentence without being lenient about either. When the words do not fit, the question is asked
       * again with its options named: a question asked twice is recoverable, a misheard choice is not.
       */
      /*
       * A sentence said while the application is waiting to confirm a command answers that question.
       *
       * This sits after the approval branch on purpose: an operation that is about to run on the machine is the
       * more dangerous of the two questions waiting, so it is answered first and a sentence cannot decide both.
       * Only recognised words decide anything, and the confirmation is sent to the node, which spends the token -
       * so the executable decision comes back from the node rather than being assembled here.
       */
      const pendingIntent = waitingIntent;
      const confirmIntent = options.confirmAppIntent;
      if (pendingIntent !== undefined && confirmIntent !== undefined) {
        const decision = interpretDecision(text);
        if (decision === undefined) {
          const again = "Tui chưa rõ ý bạn. Bạn nói “đồng ý” hoặc “không” giúp tui nhé.";
          send({ type: "transcript", role: "assistant", text: again, final: true });
          say(again);
          return;
        }

        waitingIntent = undefined;
        answerQueue = answerQueue.then(() => {
          const decided = confirmIntent({ token: pendingIntent, decision });
          send({ type: "app-intent", decision: decided });
          const said = decided.kind === "refused" ? decided.say : decided.readBack;
          send({ type: "transcript", role: "assistant", text: said, final: true });
          say(said);
          return Promise.resolve();
        });
        return;
      }

      /*
       * A sentence said while a widget action is waiting for a yes.
       *
       * The same rule as the other two questions: only recognised words decide anything, and anything else asks again
       * rather than being taken as agreement.
       */
      const pendingWidget = waitingWidget;
      if (pendingWidget !== undefined) {
        const decision = interpretDecision(text);
        if (decision === undefined) {
          const again = "Tui chưa rõ ý bạn. Bạn nói “đồng ý” hoặc “không” giúp tui nhé.";
          send({ type: "transcript", role: "assistant", text: again, final: true });
          say(again);
          return;
        }
        waitingWidget = undefined;
        if (decision === "denied") {
          const said = "Đã bỏ qua hành động đó.";
          send({ type: "transcript", role: "assistant", text: said, final: true });
          say(said);
          return;
        }
        runWidgetAction(pendingWidget);
        return;
      }

      /*
       * A question, read against its own options.
       *
       * `answerFromUtterance` can only produce an answer the card offered, which is what lets the same route serve
       * a click and a sentence without being lenient about either. When the words do not fit, the question is asked
       * again with its options named: a question asked twice is recoverable, a misheard choice is not.
       */
      if (pending !== undefined && pending.kind === "question" && options.answerQuestion !== undefined) {
        const record = options.answerQuestion;
        const answer = answerFromUtterance(
          { questionType: pending.questionType, options: pending.options, allowOther: pending.allowOther },
          text,
        );
        if (answer === undefined) {
          const named =
            pending.options.length === 0 ? "" : ` Có thể là: ${pending.options.map((option) => option.label).join(", ")}.`;
          const again = `Tui chưa khớp được câu trả lời với câu hỏi. ${pending.prompt}${named}`;
          send({ type: "transcript", role: "assistant", text: again, final: true });
          say(again);
          return;
        }

        waiting = undefined;
        answerQueue = answerQueue.then(async () => {
          const recorded = await record({
            conversationId: askIn,
            questionId: pending.questionId,
            ...(answer.text === undefined ? {} : { text: answer.text }),
            ...(answer.optionIds === undefined ? {} : { optionIds: answer.optionIds }),
            ...(answer.confirmed === undefined ? {} : { confirmed: answer.confirmed }),
          });
          const said = recorded.ok ? "Đã ghi câu trả lời của bạn." : `Không ghi được câu trả lời: ${recorded.message}`;
          send({ type: "transcript", role: "assistant", text: said, final: true });
          say(said);
        });
        return;
      }

      /*
       * A spoken command to the application.
       *
       * Checked before the agent sees the sentence, because "mở settings" is not a question to answer. A refusal
       * is spoken and nothing happens, which is the issue's rule about not guessing at a command; `none` leaves the
       * sentence to the agent exactly as before.
       */
      const resolveIntent = options.resolveAppIntent;
      if (resolveIntent !== undefined) {
        const resolved = resolveIntent({ text, conversationId: askIn });
        if (resolved.kind !== "none") {
          if (resolved.kind === "needs-confirmation") waitingIntent = resolved.confirmationToken;
          // The decision is sent as its own frame so the page can act on the one member that is executable, and the
          // transcript carries the sentence so the timeline reads like a conversation.
          send({ type: "app-intent", decision: resolved });
          const said = resolved.kind === "refused" ? resolved.say : resolved.readBack;
          send({ type: "transcript", role: "assistant", text: said, final: true });
          say(said);
          return;
        }
      }

      /*
       * A spoken command about the widget that is open.
       *
       * After the questions that may be waiting, because a sentence said while one is waiting is an answer to it. The
       * action is resolved by the shared resolver: a sentence selects among the actions the focused instance offers,
       * and the binding id comes from that view rather than from the words. An unmatched sentence is refused when a
       * widget is open and left to the agent when none is - which is why those two are different sentences rather than
       * one "I did not understand".
       */
      if (options.widgetAction !== undefined) {
        const resolved = resolveVoiceWidgetAction({ utterance: text, focused: focusedViewNow() });
        if (resolved.ok) {
          if (resolved.action.requiresApproval) {
            // Asked before anything runs. A widget says which of its actions need a person, and a spoken sentence is
            // not a person deciding.
            waitingWidget = resolved.action;
            const question = describeVoiceWidgetAction(resolved.action);
            send({ type: "transcript", role: "assistant", text: question, final: true });
            say(question);
            return;
          }
          runWidgetAction(resolved.action);
          return;
        }
        if (resolved.say !== NO_FOCUSED_SURFACE_SAY) {
          send({ type: "transcript", role: "assistant", text: resolved.say, final: true });
          say(resolved.say);
          return;
        }
      }

      // The agent path needs an agent. This is the only branch that does, so the check lives here.
      if (answer === undefined) return;

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
            // Reuses the same wire frame a deterministic spoken app-command already sends, so the browser
            // needs no new handler to run a `control_app` decision through `runAppIntent`.
            onAppIntent: (decision) => send({ type: "app-intent", decision }),
          });
          if (result === undefined) return;
          answeredMessages += result.recordedMessages;
          const reply = result.reply.trim();
          if (reply === "") return;
          // Shown as the assistant's words before it is spoken, so the transcript matches what is
          // heard even if playback never happens. The final text is the stored one, which is the one
          // that counts when a stream stops early.
          send({ type: "transcript", role: "assistant", text: reply, final: true });
          say(reply);

          // A proposed command waits for a person. Asked here, in the same turn that produced it, because the
          // card is otherwise a click the voice mode cannot offer.
          const proposed = result.pendingInteraction;
          if (proposed !== undefined) {
            waiting = proposed;
            // Read from the card's own wording, so what is heard is what is on screen: an approval keeps its
            // yes-or-no phrasing, and a question is read through the host-generated voice prompt.
            const question =
              proposed.kind === "approval"
                ? `${proposed.description}. Bạn cho phép chạy hay là không?`
                : proposed.voicePrompt;
            send({ type: "transcript", role: "assistant", text: question, final: true });
            say(question);
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
        return;
      }
      if (control?.["type"] === "focus") {
        // The id is all this takes, and the view is built from the node's own state when a sentence needs it. A frame
        // without a usable id clears the focus, so a spoken action then answers that nothing is open rather than
        // acting on an instance named by a page.
        const named = control["instanceId"];
        focusedInstanceId = typeof named === "string" && named.trim() !== "" ? named : undefined;
        return;
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
        deny(
          "VOICE_NOT_CONFIGURED",
          "this node has no credential for the live voice provider",
          // Machine-readable, because the interface has something useful to do about it: the name is what a
          // credential card asks for, and a person reading "no credential" alone has to guess which one.
          { reason: "missing-credential", credentialName: VOICE_CREDENTIAL_NAME },
          CLOSE_TRY_LATER,
        );
        return;
      }

      const requested = message["conversationId"];
      conversationId = typeof requested === "string" && requested !== "" ? (requested as ConversationId) : undefined;

      authenticated = true;
      active = { sessionId, holder };
      adapter = createAdapter();

      adapter.onStateChange((state) => {
        // The provider says when it stops speaking; until it does, the audio it sends belongs to the reply we asked for.
        if (state !== "speaking") awaitingSpeech = false;
        send({ type: "state", state });
      });
      adapter.onAudio((pcm16) => {
        // Not ours to play: the agent did not ask for this to be said, so it is not said.
        if (!awaitingSpeech) return;
        // Audio goes back as a binary frame, not as JSON: base64 inside a control message would
        // inflate every chunk by a third and put a string conversion on the latency path.
        if (ws.readyState === ws.OPEN) ws.send(pcm16, { binary: true });
      });
      adapter.onTranscript((fragment) => {
        if (fragment.role === "user") {
          userText += fragment.text;
          // The final fragment of an utterance is the adapter saying this one is complete, so this is
          // where a sentence becomes a message.
          if (fragment.isFinal) {
            ask(fragment.at);
          } else if (fragment.text.trim() !== "") {
            // Transcribed words arrived and more may still be coming: wait for the quiet, then take the sentence.
            // Restarted on every fragment, so a provider that streams partials extends the same sentence rather
            // than being cut off in the middle of it.
            if (settle !== undefined) clearTimeout(settle);
            settle = setTimeout(() => {
              settle = undefined;
              ask(now());
            }, options.utteranceSettleMs ?? 400);
          }
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

    /*
     * Reachable is not the same as present.
     *
     * Without this, a peer that vanished without closing holds the node's only voice slot until somebody
     * restarts the node — see `DEFAULT_HEARTBEAT_MS` for the measurement, which found the slot released after
     * about two intervals. Two intervals is the bound: one to
     * ask, one to notice nobody answered.
     *
     * Terminating rather than closing is deliberate. A peer that does not answer a ping is not reading a close
     * frame either, and `terminate` is what runs the release path below.
     */
    let awaitingPong = false;
    const heartbeat = setInterval(() => {
      if (awaitingPong) {
        ws.terminate();
        return;
      }
      awaitingPong = true;
      ws.ping();
    }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

    ws.on("pong", () => {
      awaitingPong = false;
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      void finish();
    });

    ws.on("error", () => {
      void finish();
    });
  }

  return {
    activeSessionCount: () => (active === undefined ? 0 : 1),
    activeSessionHolder: () => active?.holder,
    capabilities: () => createAdapter().capabilities,
    close: async () => {
      // Releases the only lease this gateway holds. Set before anything that can block, so a
      // shutdown that later times out still leaves the slot free for the node's next session.
      active = undefined;

      /*
       * `wss.close(cb)` alone waits for every client's closing handshake to finish before its
       * callback runs, and `ws`'s own per-socket close timer only fires after 30s — long past
       * what a node shutdown can afford to block on. A peer that stops reading (network death, a
       * killed tab) never answers a close frame, so terminating every client outright and
       * bounding the wait is what keeps shutdown itself bounded; `terminate()` drops the
       * connection immediately and is what removes it from `wss.clients`, which is what lets
       * `wss.close(cb)`'s callback fire.
       */
      for (const client of wss.clients) client.terminate();

      const CLOSE_TIMEOUT_MS = 2000;
      await Promise.race([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
      ]);
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
