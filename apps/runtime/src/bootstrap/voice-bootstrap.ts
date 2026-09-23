import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import { type VoiceCapabilities, describeAppIntent, voicePromptFor } from "@clarkcant/contracts";
import { handleUserMessage, recordAppIntentEvent } from "@clarkcant/core";
import { credentialNames, readCredential } from "@clarkcant/storage";
import type { VoiceProviderAdapter } from "@clarkcant/voice-adapters";
import { catalogFamilies, libraryEntries } from "@clarkcant/widget-catalog";
import type { WidgetTarget } from "@clarkcant/core";

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
import { pendingForConversation } from "../interactions.ts";
import { availableCredentials } from "../readiness.ts";
import { indexMessages, textOfMessage } from "../session-search.ts";
import { type NodeServices } from "../services.ts";
import { accumulateAnswerText } from "../voice-answer.ts";
import {
  type PendingVoiceInteraction,
  VOICE_ANSWER_NOTE,
  VOICE_CREDENTIAL_NAME,
  attachVoiceGateway,
} from "../voice-session.ts";
import { NO_FOCUSED_SURFACE_SAY } from "../widget-voice-action.ts";

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
  const voice = attachVoiceGateway({
    server: deps.server,
    services: deps.services,
    credential: () =>
      voiceFixture
        ? "fixture-credential"
        : // The vault first, then the environment. A key typed into the credential card is a key the person
          // expects to be used, and an environment variable that happens to be absent must not make that
          // expectation false. Read at open time rather than cached, so the next attempt after typing one finds it.
          deps.env["GEMINI_API_KEY"] ??
          readCredential(deps.services.runtime.db, deps.services.runtime.identity.ownerPrincipalId, VOICE_CREDENTIAL_NAME),
    ...(scripted === undefined ? {} : { createAdapter: () => scripted.createAdapter() }),
    ...(voiceModel === undefined ? {} : { model: voiceModel }),
    /**
     * What a finished sentence does.
     *
     * It becomes a message in the conversation and the agent answers it, with whatever tools the
     * answer needs. The words that come back are what the voice session reads aloud, which is why the
     * live model is told not to answer anything itself: this is the only answer in the room.
     */
    answer: async ({ conversationId, text, at: spokenAt, onText, onAppIntent }) => {
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
        // The voice surface is a caller holding an open stream like any other, so it gets the same
        // events the typed path gets. Text is forwarded, accumulated: the surface replaces what it shows, so a
        // frame has to carry the answer so far rather than the fragment that just arrived. `accumulateAnswerText`
        // holds the measurement that made this a function of its own. A `host-control` event — the app-control
        // tool's decision — is forwarded separately, over the wire frame the browser already knows how to run.
        ...(forwardText === undefined && onAppIntent === undefined
          ? {}
          : {
              emit: (event) => {
                forwardText?.(event);
                if (event.type === "host-control") onAppIntent?.(event.decision);
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
    /**
     * Carry out what the user just said yes or no to.
     *
     * The same function the HTTP route calls, so a decision made by voice and a decision made by pressing the
     * card mean exactly the same thing: the same digest check, the same receipt in the same conversation.
     */
    decideApproval: async ({ conversationId, approvalId, decision, digest }) => {
      const result = await decideApprovalForNode(deps.services, {
        conversationId,
        approvalId,
        decision,
        digest,
        principal: {
          principalId: deps.services.runtime.identity.ownerPrincipalId,
          kind: "user",
          nodeId: deps.services.runtime.identity.nodeId,
        },
        at: new Date().toISOString() as never,
      });
      return result.ok
        ? // The agent's continuation is what the person should hear: the command ran, and this is what the agent
          // made of it. `message` is spoken by the session.
          { ok: true, message: result.continuation ?? result.outcome ?? "Đã chạy xong lệnh đó." }
        : { ok: false, message: result.message };
    },
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
      return decideAppIntent(
        intentDeps,
        { principalId, request: { text, source: "voice" }, conversationId },
        (intent) => mintConfirmation(intentDeps, { principalId, intent, source: "voice" }),
      );
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
    /**
     * Run a widget action the person asked for out loud.
     *
     * The same function a click goes through, with the difference that a click brings a cursor and a sentence does
     * not: the revision and the binding digest are read from the node's own state rather than taken from the page. A
     * sentence is a request to do the thing, not a claim about which revision it was looking at.
     */
    widgetAction: async ({ conversationId, action, focused }) => {
      const instanceId = focused?.instanceId;
      if (instanceId === undefined) return { ok: false, say: NO_FOCUSED_SURFACE_SAY };

      const target = widgetActionTarget(deps.services, instanceId, action.actionBindingId);
      if (target === undefined) {
        // The page's view was older than the instance, or the action is gone. Either way this is a refusal and not a
        // guess: invoking a binding the instance no longer announces is exactly what the digest check exists for.
        return { ok: false, say: "Widget đang mở không còn hành động đó nữa. Bạn mở lại rồi thử lại giúp tôi nhé." };
      }

      const result = invokeWidgetAction(deps.services, {
        conversationId,
        principalId: deps.services.runtime.identity.ownerPrincipalId,
        instanceId,
        actionBindingId: action.actionBindingId,
        expectedRevision: target.revision,
        expectedBindingDigest: target.bindingDigest,
        // What the words implied. Empty when the person named the action without saying what it should do, and the
        // widget's own contract then answers that it wanted an argument - which is better than this guessing a period.
        input: action.args,
        invocationId: `inv_${randomUUID()}`,
      });

      if (!result.ok) return { ok: false, say: `Không thực hiện được: ${result.message}` };
      const landedOn = typeof result.body.revision === "number" ? result.body.revision : target.revision;
      return { ok: true, instanceId, revision: landedOn, say: `Đã ${action.label}.` };
    },
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
  const voiceHasCredential = availableCredentials({
    env: process.env,
    vault: credentialNames(deps.services.runtime.db, deps.services.runtime.identity.ownerPrincipalId),
  }).includes(VOICE_CREDENTIAL_NAME);
  process.stderr.write(
    voiceFixture
      ? "voice: FIXTURE provider loaded — audio and transcripts on /voice are scripted, not model output\n"
      : voiceHasCredential
        ? `voice: live voice sessions available on /voice (model ${voiceModel ?? "the pinned default"})\n`
        : "voice: no credential for the live provider, so a voice session will be refused by name rather than failing silently\n",
  );

  return { capabilities: () => voice.capabilities(), close: () => voice.close() };
}
