import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import { type VoiceCapabilities, describeAppIntent, voicePromptFor } from "@clarkcant/contracts";
import { handleUserMessage, recordAppIntentEvent } from "@clarkcant/core";
import { credentialNames, readCredential } from "@clarkcant/storage";
import {
  GeminiTranscribeLiveAdapter,
  type VoiceProviderAdapter,
  recognizerRetry,
} from "@clarkcant/voice-adapters";
import type { RecognitionProvenance } from "@clarkcant/contracts";
import { catalogFamilies, libraryEntries } from "@clarkcant/widget-catalog";
import type { WidgetTarget } from "@clarkcant/core";

import { grantConversationDeletion } from "../application/conversation-delete.ts";
import {
  type AppIntentDeps,
  consumeConfirmation,
  decideAppIntent,
  mintConfirmation,
  preferredAppIntentLocale,
} from "../app-intents.ts";
import {
  answerQuestionForNode,
  decideApprovalForNode,
  interactionDepsFor,
  invokeWidgetAction,
  widgetActionTarget,
} from "../gateway.ts";
import {
  spokenActionDone,
  spokenActionFailed,
  spokenActionRefusal,
  spokenActionWaiting,
  spokenApprovalDecided,
  spokenWidgetWords,
} from "../application/action-speech.ts";
import type { WidgetPerformer } from "../application/widget-actions.ts";
import { carryOutSpokenStop } from "../application/stop-turn.ts";
import { readThemeRegistry, themeRegistryDeps } from "../application/themes.ts";
import { pendingForConversation } from "../interactions.ts";
import { credentialSources } from "../readiness.ts";
import { voiceCredential } from "../voice-live-check.ts";
import { indexMessages, textOfMessage } from "../session-search.ts";
import { type NodeServices } from "../services.ts";
import { accumulateAnswerText } from "../voice-answer.ts";
import { voiceRecognitionContext } from "../voice-vocabulary.ts";
import {
  type PendingVoiceInteraction,
  VOICE_ANSWER_NOTE,
  VOICE_CREDENTIAL_NAME,
  type VoiceFrameSink,
  type VoiceGatewayOptions,
  attachVoiceGateway,
} from "../voice-session.ts";
import { NO_FOCUSED_SURFACE_SAY, type VoiceWidgetApproval, type VoiceWidgetRun } from "../widget-voice-action.ts";

/**
 * The voice socket, and everything a live session needs to reach the rest of the node.
 *
 * Attached to the same server as the command gateway, so a browser needs one origin and one token rather than a
 * second service to discover. The credential is read here and handed to the gateway as a function, which is what
 * keeps it out of the module that serves the browser.
 *
 * Every answer a spoken sentence can produce goes through the same function its click goes through - the approval
 * decision, the question answer, the app-intent registry, the widget action - because "voice is not a second
 * product" is only true while it is not a second implementation.
 *
 * The scripted provider is passed in rather than imported: it lives behind the fixture gate in `test-support/`, and a
 * name this module cannot reach by itself is a gate this module cannot walk around.
 */

/** The scripted provider, structurally typed so this module never names `test-support/`. */
export interface ScriptedVoiceProvider {
  /** The seam the node publishes, so a test can script what the provider will hear. */
  service: { setWords(words: string): void };
  /** One adapter per session. */
  createAdapter: () => VoiceProviderAdapter;
}

export interface NodeVoiceDeps {
  /** The gateway's own server: one listener, one origin, one token. */
  server: Server;
  services: NodeServices;
  /** Present only when `CC_VOICE_FIXTURE=1`; absent means the real adapter is built. */
  fixtureVoice: ScriptedVoiceProvider | undefined;
  /** Read when a session opens rather than captured, so a key typed while the node runs is found. */
  env: Record<string, string | undefined>;
}

export interface NodeVoice {
  /** What the configured provider can do, published to the settings route. */
  capabilities: () => VoiceCapabilities;
  /** Ends the gateway's own sessions, so a shutdown closes the socket before it closes the server. */
  close: () => Promise<void>;
}

/**
 * The registry's dependencies.
 *
 * A function rather than a constant so the clock is read when a decision is made, not when the node booted.
 */
function appIntentDepsFor(services: NodeServices): AppIntentDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => new Date().toISOString() as never,
    newId: services.conductor.newId,
    widgetTargets: widgetTargetsFromCatalog(),
    runningConversations: () => services.turnControl?.running() ?? [],
    themes: () => readThemeRegistry(themeRegistryDeps(services)),
  };
}

/**
 * The widgets a spoken or typed sentence may name, built from the canonical catalogue.
 *
 * Display names and aliases become widget phrases; families become family targets. The matcher takes
 * the longest phrase that matches, so "thu vien anh" is not stolen by the shorter "anh".
 */
function widgetTargetsFromCatalog(): WidgetTarget[] {
  const targets: WidgetTarget[] = [];
  for (const entry of libraryEntries()) {
    targets.push({ phrase: entry.displayName, definitionId: entry.definition.id });
    for (const alias of entry.aliases) targets.push({ phrase: alias, definitionId: entry.definition.id });
  }
  for (const family of catalogFamilies()) targets.push({ phrase: family, family });
  return targets;
}

export function attachNodeVoice(deps: NodeVoiceDeps): NodeVoice {
  /**
   * The voice socket.
   *
   * Attached to the same server as the command gateway, so a browser needs one origin and one
   * token rather than a second service to discover. The credential is read here and handed to the
   * gateway as a function, which is what keeps it out of the module that serves the browser.
   */
  const voiceModel = process.env.CC_VOICE_MODEL;
  /**
   * A provider that answers on a script, so the browser-to-node path can be verified end to end
   * without an account and without spending quota on every run. A node running it says so, because
   * a fake that is indistinguishable from the real thing is worse than having no fake at all.
   */
  const voiceFixture = deps.fixtureVoice !== undefined;
  const scripted = deps.fixtureVoice;
  if (scripted !== undefined) deps.services.voiceFixture = scripted.service;

  /**
   * Live-provider test utterance service.
   *
   * Present only when CC_LIVE_PROVIDER_TEST=1. This allows tests to inject utterances via the
   * /voice-live/utterance endpoint. The utterances are sent to the real Gemini Live session as
   * user text input, so the model processes them like spoken input and can decide to call control_app.
   * The decision flows through the existing control_app → runAppIntent executor.
   */
  const liveProviderTestEnabled = deps.env?.CC_LIVE_PROVIDER_TEST === "1";
  let voiceLiveUtterance: { sendUserText?: (text: string) => void; enqueueUtterance(words: string): void } | undefined;
  if (liveProviderTestEnabled) {
    voiceLiveUtterance = {
      enqueueUtterance(words: string) {
        // Send immediately if sendUserText is available (wired by the voice session).
        // If not wired yet, the utterance is lost—but for testing, the voice session exists
        // before test utterances are sent via the HTTP endpoint.
        this.sendUserText?.(words);
      },
    };
    deps.services.voiceLiveUtterance = voiceLiveUtterance;
  }

  const storedVoiceCredential = (): string | undefined =>
    readCredential(deps.services.runtime.db, deps.services.runtime.identity.ownerPrincipalId, VOICE_CREDENTIAL_NAME);
  const credential = nodeVoiceCredential({ fixture: voiceFixture, env: deps.env, stored: storedVoiceCredential });

  const voice = attachVoiceGateway({
    server: deps.server,
    services: deps.services,
    credential,
    ...(scripted === undefined ? {} : { createAdapter: () => scripted.createAdapter() }),
    ...(voiceModel === undefined ? {} : { model: voiceModel }),
    ...(voiceLiveUtterance === undefined ? {} : { voiceLiveUtterance }),
    ...recognitionWiring({ services: deps.services, env: deps.env, credential, fixture: voiceFixture }),
    /**
     * What a finished sentence does.
     *
     * It becomes a message in the conversation and the agent answers it, with whatever tools the
     * answer needs. The words that come back are what the voice session reads aloud, which is why the
     * live model is told not to answer anything itself: this is the only answer in the room.
     */
    answer: async ({ conversationId, text, at: spokenAt, onText, onAppIntent, onWidgetPerform }) => {
      const forwardText = onText === undefined ? undefined : accumulateAnswerText(onText);
      const outcome = await handleUserMessage(deps.services.conductor, {
        conversationId: conversationId as never,
        principal: {
          principalId: deps.services.runtime.identity.ownerPrincipalId as never,
          kind: "user",
          nodeId: deps.services.runtime.identity.nodeId as never,
        },
        text,
        at: spokenAt as never,
        // Spoken turns are answered briefly: the session has to read the answer out loud.
        note: VOICE_ANSWER_NOTE,
        // `source: "voice"` on a `control_app` call this turn makes: the tool reads this the same way
        // `model-bootstrap.ts` does for a typed turn, off the same `Turn.channel` field.
        channel: "voice",
        // What the person said, heard on their own voice surface: it counts as their words (`MessageRecord.surface`).
        surface: "voice",
        // And it is the person who asked.
        origin: "person",
        // The voice surface is a caller holding an open stream like any other, so it gets the same
        // events the typed path gets. Text is forwarded, accumulated: the surface replaces what it shows, so a
        // frame has to carry the answer so far rather than the fragment that just arrived. `accumulateAnswerText`
        // holds the measurement that made this a function of its own. A `host-control` event — the app-control
        // tool's decision — is forwarded separately, over the wire frame the browser already knows how to run.
        ...(forwardText === undefined && onAppIntent === undefined && onWidgetPerform === undefined
          ? {}
          : {
              emit: (event) => {
                forwardText?.(event);
                if (event.type === "host-control" && onAppIntent !== undefined) {
                  // The voice surface reports what it did, like the typed stream's page does.
                  deps.services.hostControl.expect(event.decision);
                  onAppIntent(event.decision);
                }
                if (event.type === "widget-perform" && onWidgetPerform !== undefined) {
                  // Same canonical path as a typed turn: the page showing the widget asks its frame and reports back. A
                  // closed socket sent nothing, so the turn's wait hears "nobody to ask", not an unknown outcome.
                  deliverToVoiceFrame(deps.services, onWidgetPerform, event.request);
                }
              },
            }),
      });
      // Indexed where the messages were just written, for the same reason the typed route does it:
      // a sentence that was spoken is a message like any other, and search must not disagree with the
      // conversation about what was said.
      indexMessages(deps.services.search, { conversationId, messages: outcome.messages, at: spokenAt });

      const reply = outcome.messages
        .filter((message) => message.role === "assistant")
        .map((message) => textOfMessage(message))
        .join("\n\n")
        .trim();
      /*
       * A turn can end with something waiting for an answer: an operation to approve, or a question card. The voice
       * session asks out loud either way, and needs enough of the card to phrase it — the digest for an approval,
       * the options for a question — because it sends its answer back through the same function the button does.
       */
      let pending: PendingVoiceInteraction | undefined;
      for (const block of outcome.messages.flatMap((message) => message.blocks)) {
        if (block.type === "approval-card" && block.decision === "pending") {
          pending = {
            kind: "approval",
            approvalId: block.approvalId,
            digest: block.operationDigest,
            description: block.operationDescription,
          };
          break;
        }
        if (block.type === "question-card" && block.status === "waiting") {
          pending = {
            kind: "question",
            questionId: block.questionId,
            questionType: block.questionType,
            prompt: block.prompt,
            options: block.options.map((option) => ({ id: option.id, label: option.label })),
            allowOther: block.allowOther,
            voicePrompt: block.voicePrompt,
          };
          break;
        }
      }
      return {
        reply,
        recordedMessages: outcome.messages.length,
        ...(pending === undefined ? {} : { pendingInteraction: pending }),
      };
    },
    /** Carry out what the user just said yes or no to, and only while the card still waits (`spokenApprovalWiring`). */
    ...spokenApprovalWiring(deps.services),
    /**
     * Record what the person just said, through the same function the HTTP route calls.
     *
     * That is the whole of "voice and a click mean the same thing": not a second path that is kept in step with the
     * first, but the same function. By the time this is called the session has already matched the words against
     * the question's own options, so nothing here has to be lenient about speech.
     */
    answerQuestion: async ({ conversationId, questionId, text, optionIds, confirmed }) => {
      const result = await answerQuestionForNode(deps.services, {
        conversationId,
        questionId,
        principal: {
          principalId: deps.services.runtime.identity.ownerPrincipalId,
          kind: "user",
          nodeId: deps.services.runtime.identity.nodeId,
        },
        ...(text === undefined ? {} : { text }),
        ...(optionIds === undefined ? {} : { optionIds }),
        ...(confirmed === undefined ? {} : { confirmed }),
        viaVoice: true,
        at: new Date().toISOString() as never,
      });
      return result.ok ? { ok: true, message: "Đã ghi câu trả lời." } : { ok: false, message: result.message };
    },
    /**
     * What this conversation is still waiting on, in the shape the voice session reads.
     *
     * Read from the interaction records rather than from this session's own turn, because the answer belongs to the
     * conversation: a card a click asked is still answerable by a sentence, and one this session asked is still
     * answerable by a click. The newest question wins, which is the one a person reading the transcript is looking at.
     */
    pendingFor: (voiceConversationId) => {
      const question = pendingForConversation(interactionDepsFor(deps.services, voiceConversationId)).at(-1);
      if (question === undefined) return undefined;
      return {
        kind: "question",
        questionId: question.questionId,
        questionType: question.questionType,
        prompt: question.prompt,
        options: question.options.map((option) => ({ id: option.id, label: option.label })),
        allowOther: question.allowOther,
        // Derived from the options that are actually offered, the same way the card derives it, so what is heard
        // cannot drift from what is on screen.
        voicePrompt: voicePromptFor(question),
      };
    },
    /**
     * What a spoken sentence means to the application.
     *
     * The same registry the typed route and a click go through, with source "voice" so the audit answers "was this
     * clicked or heard". `none` is returned unchanged and the session then treats the sentence as a question for the
     * agent, which is what keeps ordinary speech out of the app-control path.
     */
    resolveAppIntent: ({ text, conversationId }) => {
      const intentDeps = appIntentDepsFor(deps.services);
      const principalId = deps.services.runtime.identity.ownerPrincipalId;
      const decision = decideAppIntent(
        intentDeps,
        { principalId, request: { text, source: "voice" }, conversationId },
        (intent) => mintConfirmation(intentDeps, { principalId, intent, source: "voice" }),
      );
      return carryOutSpokenStop(deps.services, decision, conversationId);
    },
    /**
     * Turn a spoken confirmation into permission, once.
     *
     * A refusal as well as a failure comes back as a non-executable decision, because the page must never be handed
     * something it would act on when the answer was no or the token was stale.
     */
    confirmAppIntent: ({ token, decision }) => {
      const intentDeps = appIntentDepsFor(deps.services);
      const outcome = consumeConfirmation(intentDeps, { principalId: deps.services.runtime.identity.ownerPrincipalId, token });
      if (!outcome.ok) {
        const say =
          outcome.code === "CONFIRMATION_EXPIRED"
            ? "Lời xác nhận đã quá hạn. Bạn nói lại câu lệnh nhé."
            : "Tôi không còn lời xác nhận nào đang chờ.";
        return { kind: "refused", say };
      }
      if (decision === "denied") return { kind: "refused", say: "Tôi đã bỏ qua câu lệnh đó." };
      if (outcome.intent.kind === "conversation.delete") {
        const principalId = deps.services.runtime.identity.ownerPrincipalId;
        return grantConversationDeletion({...intentDeps, principalId}, outcome.intent, preferredAppIntentLocale(intentDeps, principalId));
      }
      recordAppIntentEvent(intentDeps, { intent: outcome.intent, source: outcome.source, confirmed: true });
      return {
        kind: "intent",
        intent: outcome.intent,
        requiresConfirmation: false,
        readBack: describeAppIntent(
          outcome.intent,
          preferredAppIntentLocale(intentDeps, deps.services.runtime.identity.ownerPrincipalId),
        ),
      };
    },
    /** Run a widget action the person asked for out loud (`spokenWidgetAction`). */
    widgetAction: (input) => spokenWidgetAction(deps.services, input),
  });
  /*
   * Published to the settings route, from the same object the voice sessions use.
   *
   * A surface that built its own capability list would be a second source of truth for what the provider
   * supports, and the first thing to drift from it.
   */
  deps.services.voiceCapabilities = () => voice.capabilities();
  /*
   * Whether voice is usable, answered from both places a key can be.
   *
   * The environment is where an operator puts one; the vault is where the settings surface writes one, and on a
   * desktop that is the common case. Reading only the environment printed "no GEMINI_API_KEY, so a voice session will
   * be refused" on a node whose credential card had just been filled in — a line that was not merely unhelpful but
   * wrong about what this node would do.
   */
  // Which key a session would open on, by source and never by value, so an operator with a key in both places can
  // read which one is in effect.
  const voiceKeySource = credentialSources({
    env: deps.env,
    vault: credentialNames(deps.services.runtime.db, deps.services.runtime.identity.ownerPrincipalId),
  })[VOICE_CREDENTIAL_NAME];
  process.stderr.write(
    voiceFixture
      ? "voice: FIXTURE provider loaded — audio and transcripts on /voice are scripted, not model output\n"
      : voiceKeySource === "vault" || voiceKeySource === "environment"
        ? `voice: live voice sessions available on /voice (model ${voiceModel ?? "the pinned default"}; key from the ${voiceKeySource})\n`
        : "voice: no credential for the live provider, so a voice session will be refused by name rather than failing silently\n",
  );

  return { capabilities: () => voice.capabilities(), close: () => voice.close() };
}

/**
 * The key a voice session and the dedicated recognizer open on.
 *
 * The vault first, then the environment (`voiceCredential`): a key typed into the credential card is the key the person
 * expects to be used, and an older variable in the environment must not quietly answer instead. Read at open time
 * rather than cached, so the next attempt after typing one finds it. The scripted fixture never reaches a provider, so
 * it gets a placeholder rather than a key.
 */
export function nodeVoiceCredential(input: {
  fixture: boolean;
  env: Record<string, string | undefined>;
  stored: () => string | undefined;
}): () => string | undefined {
  return () =>
    input.fixture ? "fixture-credential" : voiceCredential({ env: input.env, vaultCredential: input.stored() }).value;
}

type SpokenWidgetActionInput = Parameters<NonNullable<VoiceGatewayOptions["widgetAction"]>>[0];
type SpokenApprovalInput = Parameters<NonNullable<VoiceGatewayOptions["decideApproval"]>>[0];

/**
 * How a voice session decides an approval card out loud, as one set: the decision through the route a click takes,
 * whether the card it is listening for still waits, and the person's language for what it says about either.
 */
/** The operator setting that opts a node into the dedicated recognizer. Unset: the live session's transcription. */
export const VOICE_RECOGNIZER_ENV = "CC_VOICE_RECOGNIZER";
const DEDICATED_RECOGNIZERS = ["gemini-transcribe"] as const;

/**
 * How a node hears the person: the session vocabulary always, the dedicated recognizer when the operator chose it.
 *
 * Not a setting in the interface. Which recognizer hears best is a measurement - the benchmark harness exists to make
 * it - and a person should not be asked to choose between providers they cannot evaluate. Until audio measurements
 * decide, the live session's own transcription stays the default and the dedicated recognizer is an operator opt-in
 * (`CC_VOICE_RECOGNIZER=gemini-transcribe`). It uses the same credential the live session does, read the same way.
 *
 * The scripted fixture provider never gets a real recognizer: a fixture session must not reach a provider.
 */
export function recognitionWiring(input: {
  services: NodeServices;
  env: Record<string, string | undefined>;
  credential: () => string | undefined;
  fixture: boolean;
}): Pick<VoiceGatewayOptions, "recognitionContext" | "createRecognizer" | "utteranceRetry" | "onRecognition"> {
  const { services } = input;
  const recognitionContext: VoiceGatewayOptions["recognitionContext"] = ({ conversationId }) =>
    voiceRecognitionContext(services, {
      conversationId,
      locale: preferredAppIntentLocale(appIntentDepsFor(services), services.runtime.identity.ownerPrincipalId),
    });
  const onRecognition = (provenance: RecognitionProvenance): void => {
    process.stderr.write(`${describeRecognition(provenance)}\n`);
  };
  const chosen = input.env[VOICE_RECOGNIZER_ENV]?.trim();
  if (chosen === undefined || chosen === "" || input.fixture) return { recognitionContext, onRecognition };
  if (!(DEDICATED_RECOGNIZERS as readonly string[]).includes(chosen)) {
    process.stderr.write(
      `voice: ${VOICE_RECOGNIZER_ENV} names no recognizer this node has (known: ${DEDICATED_RECOGNIZERS.join(", ")}), so the live session's transcription is used\n`,
    );
    return { recognitionContext, onRecognition };
  }
  const tokenProvider = async (): Promise<string> => {
    const key = input.credential();
    if (key === undefined || key === "") throw new Error("no credential for the recognizer");
    return key;
  };
  process.stderr.write("voice: the dedicated recognizer (gemini-transcribe) hears the person; the live session stays the voice\n");
  return {
    recognitionContext,
    onRecognition,
    createRecognizer: () => new GeminiTranscribeLiveAdapter(),
    // A retry is one utterance on a fresh connection, so it is not reopened: it either answers in time or is skipped.
    utteranceRetry: recognizerRetry({ createRecognizer: () => new GeminiTranscribeLiveAdapter({ maxReopens: 0 }), tokenProvider }),
  };
}

/**
 * One line about one utterance, for the operator: who heard it, how many terms the session had, which normalisation
 * rules fired, and what a retry came to. Counts and rule names only - never the sentence, and never a changed term,
 * since a term is still a fragment of what was said.
 */
export function describeRecognition(provenance: RecognitionProvenance): string {
  const rules = new Map<string, number>();
  for (const change of provenance.normalization) rules.set(change.rule, (rules.get(change.rule) ?? 0) + 1);
  const changes = rules.size === 0 ? "none" : [...rules].map(([rule, count]) => `${rule}×${count}`).join(" ");
  const retry = provenance.retry === undefined ? "" : ` retry=${provenance.retry.reason}:${provenance.retry.outcome}`;
  const settle = provenance.settleMs === undefined ? "" : ` settle=${Math.round(provenance.settleMs)}ms`;
  return `voice: recognized via ${provenance.provider}/${provenance.model} context=${provenance.contextApplied ? "applied" : "node-side"} terms=${provenance.termCount} changes=${changes} abstained=${provenance.abstained}${retry}${settle}`;
}

export function spokenApprovalWiring(
  services: NodeServices,
): Required<Pick<VoiceGatewayOptions, "decideApproval" | "approvalWaits" | "speechLocale">> {
  return {
    decideApproval: (input) => decideSpokenApproval(services, input),
    // Read from the approvals row, so a card decided by a click or expired no longer takes the next sentence.
    approvalWaits: (approvalId) => waitingApprovalRow(services, approvalId) !== undefined,
    speechLocale: () => preferredAppIntentLocale(appIntentDepsFor(services), services.runtime.identity.ownerPrincipalId),
  };
}

/**
 * Carry out what the person just said yes or no to.
 *
 * The same function the HTTP route calls, so a decision made by voice and a decision made by pressing the card mean
 * exactly the same thing: the same digest check, the same receipt in the same conversation.
 */
export async function decideSpokenApproval(
  services: NodeServices,
  { conversationId, approvalId, decision, digest, onWidgetPerform }: SpokenApprovalInput,
): Promise<{ ok: boolean; message: string }> {
  const result = await decideApprovalForNode(services, {
    conversationId,
    approvalId,
    decision,
    digest,
    // An approved widget action goes to the frame on the page this voice session runs on, which reports back like a
    // typed turn's page does. A session that cannot run one gets "approved, nothing sent".
    ...(onWidgetPerform === undefined ? {} : { perform: voicePerformer(services, onWidgetPerform) }),
    principal: {
      principalId: services.runtime.identity.ownerPrincipalId,
      kind: "user",
      nodeId: services.runtime.identity.nodeId,
    },
    at: new Date().toISOString() as never,
  });
  if (!result.ok) return { ok: false, message: result.message };
  const locale = preferredAppIntentLocale(appIntentDepsFor(services), services.runtime.identity.ownerPrincipalId);
  // `message` is what the session says, so it is what happened rather than what was hoped for: the receipt of the
  // operation — for a widget action, whether the widget did it and what it answered, as its own words — or the agent's
  // continuation after a command. Never a "running it now" said before the outcome is known.
  if (decision === "denied") return { ok: true, message: spokenApprovalDecided("denied", locale) };
  const said = result.continuation ?? result.outcome;
  return {
    ok: true,
    message: said === undefined ? spokenApprovalDecided("granted", locale) : `${said}${spokenWidgetWords(result.widgetOutput, locale)}`,
  };
}

/**
 * The frame on a voice session's page, as a performer: the node expects the report, the request goes out on the
 * session's socket, and the dispatch waits for the page's report. One builder for a spoken press and an approval
 * decided by voice, so both hand an offered action over the same way.
 */
export function voicePerformer(services: NodeServices, onWidgetPerform: VoiceFrameSink): WidgetPerformer {
  return async (request) =>
    deliverToVoiceFrame(services, onWidgetPerform, request) ? services.widgetPerforms.wait(request.performId) : "no-surface";
}

/**
 * Hand a perform to the voice session's page, expecting its report only when it really went out. A session that
 * closed before this was sent (a press queued behind a long answer, a turn outliving its socket) reached no frame, so
 * the wait answers "nobody to ask" with nothing sent — never an unknown outcome the inbox would ask about.
 */
export function deliverToVoiceFrame(
  services: Pick<NodeServices, "widgetPerforms">,
  onWidgetPerform: VoiceFrameSink,
  request: Parameters<VoiceFrameSink>[0],
): boolean {
  services.widgetPerforms.expect(request.performId);
  if (onWidgetPerform(request)) return true;
  services.widgetPerforms.forget(request.performId);
  return false;
}

/**
 * Run a widget action the person asked for out loud.
 *
 * The same function a click goes through, with the difference that a click brings a cursor and a sentence does not:
 * the revision and the binding digest are read from the node's own state rather than taken from the page. A sentence
 * is a request to do the thing, not a claim about which revision it was looking at. An action the widget offers to
 * Clark reaches the frame through the session's page when that page can perform one, and is refused otherwise.
 */
export async function spokenWidgetAction(services: NodeServices, input: SpokenWidgetActionInput): Promise<VoiceWidgetRun> {
  try {
    return await runSpokenWidgetAction(services, input);
  } catch {
    // Said, not swallowed: a throw here would otherwise leave the person hearing nothing at all. Nothing is claimed
    // about the widget, because the throw may have come after something was sent.
    const locale = preferredAppIntentLocale(appIntentDepsFor(services), services.runtime.identity.ownerPrincipalId);
    return { ok: false, say: spokenActionFailed(input.action.label, locale) };
  }
}

/**
 * The approval an action's 202 answered with, as the voice session asks it: only while it still waits, with the
 * digest and description its card carries, so the spoken answer goes through the same check a click does.
 */
function pendingApprovalOf(services: NodeServices, body: Record<string, unknown>): VoiceWidgetApproval | undefined {
  const required = body.approvalRequired as { approvalId?: unknown } | undefined;
  const approvalId = typeof required?.approvalId === "string" ? required.approvalId : undefined;
  if (approvalId === undefined || approvalId === "") return undefined;
  const row = waitingApprovalRow(services, approvalId);
  return row === undefined ? undefined : { kind: "approval", approvalId, digest: row.digest, description: row.description };
}

/** An approval that still waits for a decision: pending and unexpired. Undefined once decided, expired or unknown. */
export function waitingApprovalRow(
  services: Pick<NodeServices, "runtime">,
  approvalId: string,
): { digest: string; description: string } | undefined {
  return services.runtime.db
    .prepare(
      `SELECT operation_digest AS digest, operation_description AS description FROM approvals
        WHERE approval_id = ? AND decision = 'pending' AND expires_at > ?`,
    )
    .get(approvalId, new Date().toISOString()) as { digest: string; description: string } | undefined;
}

async function runSpokenWidgetAction(
  services: NodeServices,
  { conversationId, action, focused, onWidgetPerform }: SpokenWidgetActionInput,
): Promise<VoiceWidgetRun> {
  const instanceId = focused?.instanceId;
  if (instanceId === undefined) return { ok: false, say: NO_FOCUSED_SURFACE_SAY };

  const target = widgetActionTarget(services, instanceId, action.actionBindingId);
  if (target === undefined) {
    // The page's view was older than the instance, or the action is gone. Either way this is a refusal and not a
    // guess: invoking a binding the instance no longer announces is exactly what the digest check exists for.
    return { ok: false, say: "Widget đang mở không còn hành động đó nữa. Bạn mở lại rồi thử lại giúp tôi nhé." };
  }
  if (target.kind === "perform" && onWidgetPerform === undefined) {
    // An action the widget offers runs in the frame on the screen that shows it. A session whose page did not say it
    // can hand one to a frame and report back has no way to reach it, so the press is refused before anything is sent.
    const performLocale = preferredAppIntentLocale(appIntentDepsFor(services), services.runtime.identity.ownerPrincipalId);
    return {
      ok: false,
      say: performLocale === "vi"
        ? `Tôi không bấm “${action.label}” bằng giọng nói được. Bạn nhờ Clark làm việc đó trong cuộc trò chuyện nhé; chưa có gì được gửi.`
        : `I can't press “${action.label}” by voice. Ask Clark to do it in the conversation instead; nothing was sent.`,
    };
  }

  const result = await invokeWidgetAction(
    services,
    {
      conversationId,
      principalId: services.runtime.identity.ownerPrincipalId,
      instanceId,
      actionBindingId: action.actionBindingId,
      expectedRevision: target.revision,
      expectedBindingDigest: target.bindingDigest,
      // What the words implied. Empty when the person named the action without saying what it should do, and the
      // widget's own contract then answers that it wanted an argument - which is better than this guessing a period.
      input: action.args,
      invocationId: `inv_${randomUUID()}`,
    },
    "voice",
    // Spoken on the person's own voice surface, so it is the person who asked, as for a spoken turn.
    "person",
    // An offered action reaches the frame through this session's page, which reports back as a typed turn's page
    // does: the same performer `decideApproval` builds, so a press and an approval are handed over one way. The person
    // asked for it themselves, and a card the policy asks for is placed in the conversation before this returns.
    { askedBy: "person-voice", ...(onWidgetPerform === undefined ? {} : { perform: voicePerformer(services, onWidgetPerform) }) },
  );

  const locale = preferredAppIntentLocale(appIntentDepsFor(services), services.runtime.identity.ownerPrincipalId);
  // Said from the code and details in the person's language: a call that may have run is never "could not do it".
  if (!result.ok) return { ok: false, say: spokenActionRefusal(action.label, { code: result.code, ...(result.detail === undefined ? {} : { detail: result.detail }) }, locale) };
  if (result.body.outcome === "background") {
    // Started, not done: the run reports into the conversation and the inbox when it ends.
    return { ok: true, instanceId, revision: target.revision, say: spokenActionWaiting(action.label, "background", locale) };
  }
  if (result.body.outcome === "job") {
    // Started, not done, and not waiting on an approval either: the widget follows the job.
    return { ok: true, instanceId, revision: target.revision, say: spokenActionWaiting(action.label, "job", locale) };
  }
  if (result.status === 202) {
    // The policy asked. The card is already in the conversation - placed by the dispatch before it answered, or waiting
    // there from an earlier ask of the same operation - so this says so; saying "done" would claim something that has
    // not happened. The person answers the card: by a click, or by the yes or no this session now listens for, which is
    // decided through the same route a click is.
    const waiting = result.body.alreadyWaiting === true ? "approval-waiting" : "approval";
    const pendingInteraction = pendingApprovalOf(services, result.body);
    return {
      ok: true,
      instanceId,
      revision: target.revision,
      say: spokenActionWaiting(action.label, waiting, locale, pendingInteraction !== undefined),
      ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
    };
  }
  const landedOn = typeof result.body.revision === "number" ? result.body.revision : target.revision;
  // A service or a frame answers with what it did, and that answer is what the person asked to hear: read out as the
  // widget's words, not Clark's.
  const output = typeof result.body.output === "string" ? result.body.output : undefined;
  return { ok: true, instanceId, revision: landedOn, say: spokenActionDone(action.label, output, locale) };
}
