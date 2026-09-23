import { join } from "node:path";

import {
  type AppIntent,
  type AppIntentDecision,
  type AppIntentResolution,
  type AttachmentRef,
  type Instant,
  type MessageBlock,
  type MessageRecord,
  type Principal,
  commandEnvelopeSchema,
  nowInstant,
  surfaceCompositionSpecSchema,
} from "@clarkcant/contracts";
import {
  activeGeneration,
  brokeredCapabilities,
  claimLiveOwner,
  decideApproval,
  directoryIndexPath,
  findIsolatedFrame,
  getActionBinding,
  getInstance,
  handleUserMessage,
  liveOwnerOf,
  liveStateOf,
  mintFrameGrant,
  pinInstance,
  readDirectoryIndex,
  readSnapshotForDisplay,
  releaseLiveOwner,
  sweepExpiredLiveOwners,
  unpinInstance,
} from "@clarkcant/core";
import {
  appendAuditEvent,
  appendMessage,
  createConversation,
  findBundleForSnapshot,
  findCompositionByInstance,
  getConversation,
  listConversations,
  nextMessageSequence,
  oneRow,
} from "@clarkcant/storage";

import { type AppIntentDeps, decideAppIntent, mintConfirmation } from "../app-intents.ts";
import { invokeWidgetAction } from "../application/widget-actions.ts";
import { resolveAttachmentRefs } from "../attachments.ts";
import { nodeBackgroundSessions } from "../background-sessions.ts";
import { type InteractionDeps, answerQuestion, cancelQuestion } from "../interactions.ts";
import { resolveLiveSections } from "../mini-app-data.ts";
import { decideTurnAction, decisionTimeoutMsFromEnv, searchDecisionBudget } from "../jev-decider.ts";
import { type OwnedResources, ownedResources } from "../preflight.ts";
import { markProjectUsed, projectContext, resolveProject } from "../project-finder.ts";
import { initialPrompt } from "../project-session.ts";
import { receiptForModel, runApprovedCommand } from "../run-command.ts";
import { type NodeServices, buildTimeline } from "../services.ts";
import { indexMessages, textOfMessage } from "../session-search.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The conversation family: the thread, its messages, its turns, its questions and its approvals, plus
 * the raw command envelope the durable path sends.
 *
 * The route owns the HTTP: which method and shape is accepted, which status a refusal deserves, and
 * the streaming envelope a turn is reported with. Everything it needs is a parameter, and `services` is
 * narrowed to the fields in `ConversationServices` rather than taken as the whole bundle: those fields were
 * injected at composition, so this is not a lookup, and a module handed every seam can reach one its
 * interface never named.
 *
 * The order the routes were dispatched in is unchanged; the gateway calls the two entry points below at
 * the positions the branches used to occupy.
 */

/**
 * The node services the conversation family reads, named one field at a time.
 *
 * The seven are every service these routes touch: the node itself, the conductor that owns widget instances, the
 * search service a written message is indexed into, the selector wiring that decides what to do with a message that
 * arrives mid-turn, the two project seams a session start needs, and the turn control a background request runs
 * through. Nothing else of the bundle is here, so a route cannot start reaching for a service this file never asked
 * for.
 */
export type ConversationServices = Pick<
  NodeServices,
  "runtime" | "conductor" | "search" | "jev" | "projects" | "projectSessions" | "turnControl"
>;

/** What the conversation routes need. */
export interface ConversationRouteDeps {
  services: ConversationServices;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
  /** Injected so conversation identifiers are deterministic in tests. */
  newConversationId?: () => string;
}

/** What the durable command envelope needs: the node's own identity, and nothing else. */
export interface RawCommandRouteDeps {
  services: Pick<NodeServices, "runtime">;
  request: GatewayRequest;
  at: () => string;
}

/**
 * Resolve what a live composed surface shows right now.
 *
 * The rows are read here rather than left to the client to fetch per dataset reference, so the live
 * view and the snapshot bundle are the same shape and the client has one render path. The state is
 * read under the same call, which is what lets a control start at the value the server holds
 * instead of at the default in the spec.
 */
function resolveLiveWidget(
  services: Pick<NodeServices, "runtime" | "conductor">,
  conversationId: string,
  instanceId: string,
  principalId: string,
): GatewayResponse {
  const { runtime } = services;
  const instance = getInstance(services.conductor, instanceId);
  if (instance === undefined) {
    return fail(404, "RESOURCE_NOT_FOUND", "that instance is not on this node");
  }
  if (instance.ownerPrincipalId !== principalId) {
    return fail(403, "NOT_AUTHORIZED", "that instance belongs to another principal");
  }

  /*
   * A widget that runs in its own frame has no composition to resolve.
   *
   * Its code is the package's, so what a client needs is the URL to mount it from and the bindings it may invoke —
   * and that is what this returns instead. The check comes first because it is what decides which of the two shapes
   * this route answers with, and a client that had to guess would be a client that guessed wrong once.
   */
  const index = readDirectoryIndex(directoryIndexPath(process.env));
  const isolated = findIsolatedFrame({
    directory: index.kind === "configured" ? index.entries : [],
    widgetId: instance.definitionRef.id,
    // A git/npm entry this node has fetched is served from its cache path exactly like a local package (H1); the
    // cache root here must match the one the install route fetched into.
    cacheRoot: join(runtime.dataDir, "package-cache"),
  });
  if (isolated.ok) {
    /*
     * What the frame is actually brokered is the *granted* set, not the requested one.
     *
     * `isolated.requestedCapabilities` is the manifest's own request — metadata a package wrote about itself,
     * never an authority (`packages/core/src/widget-package.ts`). The generation this node actually activated
     * carries the capabilities a real consent decision granted (`install-consent.ts`, wired in
     * `application/package-install.ts`), narrower than the request whenever the policy asked or refused one. A
     * frame with no active generation on record (should not happen for a package this node just resolved a frame
     * for, but is not proven impossible) is brokered nothing rather than the unchecked request.
     */
    const generation = activeGeneration(
      { db: runtime.db, nodeId: runtime.identity.nodeId, now: nowInstant, newId: () => "" },
      isolated.packageId,
      runtime.identity.nodeId,
    );
    const grantedForFrame = brokeredCapabilities(isolated.requestedCapabilities, generation?.grantedCapabilities);

    return json(200, {
      kind: "isolated-frame",
      instanceId,
      revision: instance.revision,
      readOnly: false,
      frame: {
        /*
         * Relative to this node, served from the package path so the widget's own relative imports resolve, and
         * carrying a grant: the frame is loaded by navigation, which cannot carry a bearer token, so this is what
         * lets it fetch its own document — and only its own. Five minutes is longer than a frame takes to load and
         * short enough that a URL somebody copied stops working.
         */
        url: `/frame/${mintFrameGrant({
          instanceId,
          packageId: isolated.packageId,
          version: isolated.version,
          secret: runtime.identity.localToken,
          expiresAtMs: Date.parse(nowInstant()) + 5 * 60 * 1000,
        })}/${isolated.entryPath}`,
        isolation: isolated.isolation,
        grantedCapabilities: grantedForFrame,
        allowedOrigins: isolated.allowedOrigins,
      },
      /*
       * The bindings the instance holds, each with the digest the client must send back.
       *
       * The same shape the composition path returns, and for the same reason: an invocation is re-authorized
       * against the instance, the digest and the revision, so a client that could not send the digest it displayed
       * could not be authorized at all. A frame names one of these ids and nothing else.
       */
      bindings: instance.actionBindingIds.flatMap((bindingId) => {
        const binding = getActionBinding(services.conductor, bindingId);
        if (binding === undefined) return [];
        return [
          {
            actionBindingId: binding.actionBindingId,
            label: binding.label,
            effectCategory: binding.effectCategory,
            bindingDigest: binding.bindingDigest,
          },
        ];
      }),
      /*
       * The props the widget was created with. The frame cannot read them from anywhere else: it has no session, no
       * storage and no route of its own, so what it is showing has to arrive with the thing that mounts it.
       */
      props: instance.props,
    });
  }

  const composition = findCompositionByInstance(runtime.db, instanceId, principalId);
  if (composition === undefined) {
    // A bundled composition is a state, not an error: the instance exists and the client falls back
    // to a single-widget render or to the message's text alternative.
    return fail(404, "RESOURCE_NOT_FOUND", "that instance has no composition on this node");
  }

  const state = liveStateOf(services.conductor, instanceId);
  const owner = liveOwnerOf(services.conductor, instanceId);
  const resolved = resolveLiveSections(
    {
      db: runtime.db,
      nodeId: runtime.identity.nodeId,
      dataDir: runtime.dataDir,
      now: () => nowInstant() as never,
      newId: services.conductor.newId,
    },
    { principalId: principalId as never, composition, state: state?.body ?? {} },
  );

  // Bindings are re-read here rather than taken from the stored spec, because a stored document
  // must not be able to introduce an action after the fact. The digest travels with each one so a
  // client can send back exactly what it displayed.
  const bindings = instance.actionBindingIds.flatMap((bindingId) => {
    const binding = getActionBinding(services.conductor, bindingId);
    if (binding === undefined) return [];
    const spec = composition.actions.find((action) => action.actionBindingId === bindingId);
    if (spec === undefined) return [];
    return [
      {
        actionBindingId: binding.actionBindingId,
        sectionId: spec.sectionId,
        label: binding.label,
        kind: binding.proposal.kind,
        effectCategory: binding.effectCategory,
        bindingDigest: binding.bindingDigest,
      },
    ];
  });

  return json(200, {
    kind: "composition",
    compositionId: composition.compositionId,
    // A live surface never mints its own authority: the bindings below are references, and every
    // invocation is re-authorized against the instance, the digest and the current revision.
    readOnly: false,
    spec: composition,
    bindings,
    sections: resolved.sections,
    availability: resolved.availability,
    revision: instance.revision,
    stateRevision: state?.revision ?? 0,
    state: state?.body ?? {},
    ownerSurface: owner?.surface ?? null,
    capturedAt: null,
    tombstone: null,
    period: resolved.period,
    timezone: resolved.timezone,
    conversationId,
  });
}

/**
 * Where a command may run, computed at the moment it is decided.
 *
 * Both halves are read fresh rather than captured when the request was made: an approval can sit for a
 * quarter of an hour, and a project that was indexed then may not be known now.
 */
function blocksOfConversation(
  services: Pick<NodeServices, "runtime">,
  conversationId: string,
): Record<string, unknown>[] {
  const timeline = buildTimeline(services, { conversationId, afterSequence: 0 });
  const blocks: Record<string, unknown>[] = [];
  // SAFETY: the timeline type describes a message's blocks as unparsed JSON. The node wrote them, and
  // every route that renders a block validates the ones claiming host ownership before drawing it.
  const messages = timeline.messages as unknown as { blocks?: Record<string, unknown>[] }[];
  for (const message of messages) blocks.push(...(message.blocks ?? []));
  return blocks;
}

/**
 * The interaction manager for one conversation.
 *
 * Built per conversation rather than once per node, because every question belongs to a conversation: the
 * durable state is that conversation's transcript, and an answer only means something against the card that
 * asked. The two halves are the ones the approval route already uses — read the blocks, append a message — so
 * a question and an approval cannot end up disagreeing about what the timeline is.
 */
export function interactionDepsFor(
  services: Pick<NodeServices, "runtime" | "conductor" | "search">,
  conversationId: string,
): InteractionDeps {
  return {
    conversationId,
    now: () => nowInstant(),
    newId: services.conductor.newId,
    // SAFETY: the timeline hands back a message's blocks as unparsed JSON, exactly as it does for the approval
    // route above. The node wrote these rows, and the manager reads only `question-card` and `tool-activity`
    // fields after checking `type`, so a block of any other shape is skipped rather than trusted.
    blocks: () => blocksOfConversation(services, conversationId) as unknown as MessageBlock[],
    append: ({ at, blocks }) => {
      appendHostReply(services, { conversationId, blocks, at });
    },
  };
}

/**
 * Record an answer and open the turn it starts.
 *
 * One function, called by the HTTP route and by the voice session, because "voice and a click mean the same thing"
 * has to be structurally true rather than a claim two code paths keep in step. What a caller can differ on is the
 * answer's shape: an utterance has already been matched against the question's own options before it arrives here.
 */
export async function answerQuestionForNode(
  services: Pick<NodeServices, "runtime" | "conductor" | "search">,
  input: {
    conversationId: string;
    principal: { principalId: string; kind: "user"; nodeId: string };
    questionId: string;
    text?: unknown;
    optionIds?: unknown;
    confirmed?: unknown;
    viaVoice?: boolean;
    at: Instant;
  },
): Promise<{ ok: true; note: string } | { ok: false; code: string; message: string }> {
  const answered = answerQuestion(interactionDepsFor(services, input.conversationId), input.questionId, {
    text: input.text,
    optionIds: input.optionIds,
    confirmed: input.confirmed,
    ...(input.viaVoice === true ? { viaVoice: true } : {}),
  });
  if (!answered.ok) return { ok: false, code: answered.code, message: answered.message };

  /*
   * What the person sees, and what the model gets.
   *
   * The visible message states the answer; the note carries the same sentence plus the instruction to carry on.
   * The note travels to the model rather than into the transcript, for the same reason the command receipt does:
   * the transcript already says what happened, and saying it twice is what made a reader complain about a receipt
   * printed twice.
   */
  await handleUserMessage(services.conductor, {
    conversationId: input.conversationId as never,
    principal: input.principal as never,
    text: answered.note,
    note: `${answered.note}\n\nĐây là câu trả lời của người dùng cho câu hỏi bạn đã hỏi. Hãy tiếp tục công việc đang làm dở.`,
    at: input.at,
  });
  return { ok: true, note: answered.note };
}

/**
 * The folders this node owns, for the path that runs an approved command.
 *
 * The same set the guarded path uses — configured workspace roots, the node's own data directory, and the directory
 * the operator launched it from — because asking a person is not a reason to widen what this node may touch.
 */
export function ownedResourcesFor(services: Pick<NodeServices, "runtime" | "projects">): OwnedResources {
  return ownedResources([...services.projects.roots(), services.runtime.dataDir, process.cwd()]);
}

/**
 * Append a message the host wrote — a question, a notice, or the receipt of an operation.
 * * *
 * `blocks` is what a receipt needs: a command's outcome is a tool record and an evidence line, not a
 * paragraph. `text` stays because most host replies are one sentence, and a caller that has to build a
 * text block by hand is a caller that will eventually build it wrong.
 */
/**
 * Starts one request in a worker of its own, and reports it when the worker settles.
 *
 * One implementation for the two ways this happens: the decider choosing background for a message sent mid-turn, and a
 * person asking for one from a selection. At module scope rather than inside the request handler, because the handler
 * has blocks that do not contain each other and a declaration in one of them is invisible from another - which is what
 * a first attempt at this did.
 *
 * The registry is written before the worker starts rather than after, so the count is right while somebody is looking at
 * it, and a failure comes back into the conversation as a message too: background work that fails in silence is worse
 * than work that never started.
 */
export function startBackgroundWork(
  services: Pick<NodeServices, "runtime" | "conductor" | "search" | "turnControl">,
  principal: Principal,
  at: () => Instant,
  conversationId: string,
  text: string,
): { sessionId: string } | { refusal: string } {
  const control = services.turnControl;
  if (control === undefined) return { refusal: "node này không có model để chạy việc nền" };

  const sessionId = services.conductor.newId("bg");
  nodeBackgroundSessions.start({ sessionId, title: text.slice(0, 120), at: at() });
  void (async () => {
    try {
      const said = await control.runInBackground({ conversationId, principal, text });
      nodeBackgroundSessions.finish({ sessionId, status: "done", at: at() });
      if (said !== "") appendHostReply(services, { conversationId, text: said, at: at() });
    } catch (cause) {
      nodeBackgroundSessions.finish({ sessionId, status: "failed", at: at() });
      appendHostReply(services, {
        conversationId,
        text: `Việc nền không xong: ${cause instanceof Error ? cause.message : String(cause)}`,
        at: at(),
      });
    }
  })();
  return { sessionId };
}

export function appendHostReply(
  services: Pick<NodeServices, "runtime" | "conductor" | "search">,
  input: { conversationId: string; text?: string; blocks?: MessageBlock[]; at: Instant },
): { messageId: string } {
  const blocks: MessageBlock[] =
    input.blocks ?? [{ type: "text", format: "plain", content: input.text ?? "", streaming: false }];
  const message: MessageRecord = {
    messageId: services.conductor.newId("msg") as MessageRecord["messageId"],
    conversationId: input.conversationId as MessageRecord["conversationId"],
    role: "assistant",
    blocks,
    authorNodeId: services.runtime.identity.nodeId as MessageRecord["authorNodeId"],
    createdAt: input.at,
    delivery: "accepted",
  };
  appendMessage(services.runtime.db, message, nextMessageSequence(services.runtime.db, input.conversationId));
  indexMessages(services.search, { conversationId: input.conversationId, messages: [message], at: input.at });
  return { messageId: message.messageId };
}


/**
 * Decide what a typed message means to the application.
 *
 * Shared by both message routes. The composer uses the streaming one, and the plain route was wired first - which
 * meant a typed "mở settings" reached the model instead of the registry until this was found. One function is what
 * keeps the next route from being the one that forgot to record the audit event.
 */
function typedAppIntent(
  services: Pick<NodeServices, "runtime" | "conductor">,
  conversationId: string,
  text: string,
  at: () => string,
): AppIntentResolution {
  const intentDeps: AppIntentDeps = {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => at() as never,
    newId: services.conductor.newId,
  };
  const principalId = services.runtime.identity.ownerPrincipalId;
  return decideAppIntent(
    intentDeps,
    { principalId, request: { text, source: "chat" }, conversationId: conversationId as never },
    (intent: AppIntent) => mintConfirmation(intentDeps, { principalId, intent, source: "chat" }),
  );
}
export async function handleConversationRoutes(deps: ConversationRouteDeps): Promise<GatewayResponse> {
  const { request, segments, at } = deps;
  const { services } = deps;
  const { runtime } = services;
  const principal = {
    principalId: runtime.identity.ownerPrincipalId as never,
    kind: "user" as const,
    nodeId: runtime.identity.nodeId as never,
  };

  // /conversations
  if (segments.length === 1) {
    if (request.method === "GET") {
      return json(200, {
        conversations: listConversations(runtime.db).map((conversationId) => ({
          conversationId,
          ...(getConversation(runtime.db, conversationId) ?? {}),
        })),
      });
    }
    if (request.method === "POST") {
      const parsed = readJson(request);
      if (!parsed.ok) return parsed.response;
      const conversationId =
        deps.newConversationId?.() ?? `conv_${runtime.identity.nodeId.slice(5, 13)}_${Date.now().toString(36)}`;
      const title = typeof parsed.value.title === "string" ? parsed.value.title.slice(0, 200) : undefined;
      createConversation(runtime.db, {
        conversationId,
        homeNodeId: runtime.identity.nodeId,
        ...(title === undefined ? {} : { title }),
        at: at() as never,
      });
      return json(201, { conversationId, homeNodeId: runtime.identity.nodeId });
    }
    return fail(405, "METHOD_NOT_ALLOWED", `${request.method} is not supported on /conversations`);
  }

  const conversationId = segments[1];
  if (conversationId === undefined) {
    return fail(400, "INVALID_SCHEMA", "a conversation route must name a conversation");
  }
  const conversation = getConversation(runtime.db, conversationId);
  if (!conversation) {
    return fail(404, "RESOURCE_NOT_FOUND", `conversation ${conversationId} does not exist`);
  }

  // A conversation accepts commands only on its home node. Two nodes writing one timeline
  // is the multi-master case the protocol refuses rather than reconciles.
  if (conversation.homeNodeId !== runtime.identity.nodeId) {
    return fail(
      403,
      "WRONG_NODE_FOR_RESOURCE",
      `this conversation is homed on ${conversation.homeNodeId}; send commands there rather than forking the timeline`,
    );
  }

  // /conversations/:id/messages
  if (segments.length === 3 && segments[2] === "messages" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const text = parsed.value.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return fail(400, "INVALID_SCHEMA", "a message must carry a non-empty text field");
    }

    /*
     * A typed command to the application.
     *
     * Checked before the turn machinery, because "mở settings" is not something to steer into a running answer. An
     * intent is answered by the host and recorded with source "chat"; a command-shaped sentence that maps to nothing
     * gets an honest "I did not understand" and no model turn at all, which is the issue's rule about not guessing;
     * anything else falls through untouched and reaches the agent exactly as before.
     */
    const asked = typedAppIntent(services, conversationId, text, at);
    if (asked.kind !== "none") {
      const said = asked.kind === "refused" ? asked.say : asked.readBack;
      const appended = appendHostReply(services, { conversationId, text: said, at: at() as never });
      return json(200, { accepted: true, messageId: appended.messageId, appIntent: asked });
    }

    /*
     * A message sent while the assistant is still working.
     *
     * The three answers are not interchangeable, so the decider chooses rather than a rule. Two of them need nothing
     * new and are handled here: joining the turn already running, and stopping it so this message takes its place. The
     * third - doing this in the background while the current work carries on - still needs a worker, so a background
     * answer is treated as an interrupt, because running the message is what sending it asked for.
     *
     * A turn's elapsed time is not tracked yet, so the decider is told zero. That biases it toward interrupt, which is
     * the recoverable direction rather than the silent one.
     */
    const control = services.turnControl;
    if (control !== undefined && control.running().includes(conversationId)) {
      const decided = await decideTurnAction(
        {
          jev: services.jev.deps,
          budget: () => searchDecisionBudget(services.jev.config, { timeoutMs: decisionTimeoutMsFromEnv(process.env) }),
        },
        { text, runningMs: 0 },
      );
      const action = decided.status === "decided" ? decided.action : "interrupt";
      if (action === "steer" && (await control.steer(conversationId, text))) {
        return json(202, {
          accepted: true,
          resolution: "steered",
          ...(decided.status === "decided" ? {} : { reason: decided.reason }),
        });
      }
      if (action === "background") {
        const started = startBackgroundWork(services, principal, () => at() as never, conversationId, text);
        // No worker to run it in: the message is what the person asked for, so it becomes the turn instead.
        if ("refusal" in started) {
          control.interrupt(conversationId);
        } else {
          return json(202, { accepted: true, resolution: "background", sessionId: started.sessionId });
        }
      }
      // An interrupt, or a steer that found nothing left to join: either way this message becomes its own turn.
      control.interrupt(conversationId);
    }

    const at_ = at() as never;
    const attachments = resolveAttachmentRefs({
      db: services.runtime.db,
      principalId: runtime.identity.ownerPrincipalId,
      conversationId,
      ids: parsed.value.attachmentIds,
    });
    if (!attachments.ok) return fail(400, "ATTACHMENT_NOT_AVAILABLE", attachments.message);

    // A `control_app` call this turn makes is otherwise silent on this route: there is no stream to carry
    // it, so it is collected here and reported in the response instead, for a caller of the plain HTTP
    // route to run through the same `runAppIntent` executor the streaming and voice routes already reach.
    const hostControlDecisions: AppIntentDecision[] = [];
    const outcome = await handleUserMessage(services.conductor, {
      conversationId: conversationId as never,
      principal,
      text: text.slice(0, 20_000),
      at: at_,
      attachmentRefs: attachments.refs,
      // Only the demo path asks for a scripted sample; a real message never gets one.
      ...(parsed.value.demo === true ? { demo: true } : {}),
      emit: (event) => {
        if (event.type === "host-control") hostControlDecisions.push(event.decision);
      },
    });

    // Indexed here, where the messages were just written, so a message that exists is searchable.
    // Doing it in the same request is what keeps "the conversation shows it" and "search finds it"
    // from disagreeing after a crash between the two.
    indexMessages(services.search, { conversationId, messages: outcome.messages, at: at_ });

    // A turn the model answered is already finished, so reporting it as accepted would be a
    // lie about what the caller is holding. 202 is reserved for the paths that genuinely have
    // work still to do: a dispatched or parked task.
    const finished = outcome.resolution === "model" || outcome.resolution === "model-failed";

    return json(finished ? 200 : 202, {
      resolution: outcome.resolution,
      taskId: outcome.taskId ?? null,
      messageIds: outcome.messages.map((message) => message.messageId),
      // The whole timeline page is returned so the client does not have to guess whether
      // its cursor is still valid after its own write.
      timeline: buildTimeline(services, { conversationId, afterSequence: 0 }),
      // Present only while non-zero: a caller that never sees `control_app` used should not learn the
      // field exists.
      ...(hostControlDecisions.length === 0 ? {} : { hostControl: hostControlDecisions }),
    });
  }

  // /conversations/:id/messages/stream
  //
  // The same message, reported while it is being answered. It shares everything with the route above
  // except the reporting: the same validation, the same conductor, the same indexing and the same
  // final timeline in the last event, so a client that ignores the deltas sees exactly what the
  // non-streaming route would have returned.
  if (segments.length === 4 && segments[2] === "messages" && segments[3] === "stream" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const text = parsed.value.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return fail(400, "INVALID_SCHEMA", "a message must carry a non-empty text field");
    }

    /*
     * A typed command to the application, on the route the composer actually uses.
     *
     * The same registry and the same host answer as the non-streaming route; the difference is only where the
     * decision travels, because this answer is a stream. A command is not a turn, so nothing is sent to the model
     * and the frame carries the decision the page acts on.
     */
    const askedIntent = typedAppIntent(services, conversationId, text, at);
    if (askedIntent.kind !== "none") {
      const said = askedIntent.kind === "refused" ? askedIntent.say : askedIntent.readBack;
      const appended = appendHostReply(services, { conversationId, text: said, at: at() as never });
      return {
        status: 200,
        body: null,
        stream: {
          contentType: "text/event-stream",
          run: async (send) => {
            // The sentence is a delta so a client that renders replies renders this one too, and the `done` frame
            // carries the decision plus the timeline the other routes would have returned.
            send(sse("delta", { text: said }));
            send(
              sse("done", {
                resolution: "app-intent",
                taskId: null,
                messageIds: [appended.messageId],
                timeline: buildTimeline(services, { conversationId, afterSequence: 0 }),
                appIntent: askedIntent,
              }),
            );
          },
        },
      };
    }

    const at_ = at() as never;
    const attachments = resolveAttachmentRefs({
      db: services.runtime.db,
      principalId: runtime.identity.ownerPrincipalId,
      conversationId,
      ids: parsed.value.attachmentIds,
    });
    if (!attachments.ok) return fail(400, "ATTACHMENT_NOT_AVAILABLE", attachments.message);
    return {
      status: 200,
      body: null,
      stream: {
        contentType: "text/event-stream",
        run: (send) =>
          streamUserMessage(
            services,
            {
              conversationId,
              principal,
              text: text.slice(0, 20_000),
              at: at_,
              attachmentRefs: attachments.refs,
              ...(parsed.value.demo === true ? { demo: true } : {}),
            },
            send,
          ),
      },
    };
  }

  // /conversations/:id/approvals/:approvalId/decide
  //
  // The one route that can start a command, and it starts nothing without a decision from a user: the
  // principal comes from the transport, `decideApproval` refuses a non-user decider, the digest the
  // approver saw must match the stored one, and the payload it covers is re-hashed here again before
  // anything runs. A refusal is never a block — a message describing something that did not happen is how
  // a transcript starts lying.
  if (segments.length === 5 && segments[2] === "approvals" && segments[4] === "decide" && request.method === "POST") {
    const approvalId = segments[3];
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const decisionValue = parsed.value.decision;
    const decision = decisionValue === "granted" || decisionValue === "denied" ? decisionValue : undefined;
    const digest = typeof parsed.value.digest === "string" ? parsed.value.digest : "";
    if (approvalId === undefined || decision === undefined || digest === "") {
      return fail(400, "INVALID_SCHEMA", "a decision must carry decision: granted|denied and the digest it was shown");
    }

    const decided = await decideApprovalForNode(services, {
      conversationId,
      approvalId,
      decision,
      digest,
      principal,
      at: at() as never,
    });
    if (!decided.ok) return fail(409, decided.code, decided.message);

    return json(200, {
      decision,
      ...(decided.outcome === undefined ? {} : { outcome: decided.outcome }),
      timeline: buildTimeline(services, { conversationId, afterSequence: 0 }),
    });
  }

  /*
   * /conversations/:id/questions/:questionId/answer
   *
   * The other half of `ask_user_question`, and the reason that tool can return immediately: the answer is its
   * own request, arriving whenever the person gets to it. Nothing was waiting on the node for it — the turn
   * that asked ended — so this route starts a new turn rather than resuming anything.
   *
   * Text and voice both land here. The client posts a click and the voice session posts an utterance it has
   * already matched against the question's own options; there is no second path that could disagree about what
   * an answer means.
   */
  if (segments.length === 5 && segments[2] === "questions" && segments[4] === "answer" && request.method === "POST") {
    const questionId = segments[3];
    if (questionId === undefined) return fail(400, "INVALID_SCHEMA", "an answer needs the question it answers");
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;

    const answered = await answerQuestionForNode(services, {
      conversationId,
      principal,
      questionId,
      text: parsed.value.text,
      optionIds: parsed.value.optionIds,
      confirmed: parsed.value.confirmed,
      viaVoice: parsed.value.viaVoice === true,
      at: at() as never,
    });
    if (!answered.ok) {
      const status = answered.code === "QUESTION_NOT_FOUND" ? 404 : 409;
      return fail(status, answered.code, answered.message);
    }

    return json(200, {
      ok: true,
      note: answered.note,
      timeline: buildTimeline(services, { conversationId, afterSequence: 0 }),
    });
  }

  // /conversations/:id/questions/:questionId/cancel
  if (segments.length === 5 && segments[2] === "questions" && segments[4] === "cancel" && request.method === "POST") {
    const questionId = segments[3];
    if (questionId === undefined) return fail(400, "INVALID_SCHEMA", "a cancellation needs the question it drops");
    const cancelled = cancelQuestion(interactionDepsFor(services, conversationId), questionId);
    if (!cancelled) return fail(404, "RESOURCE_NOT_FOUND", "that question is not waiting in this conversation");
    return json(200, { ok: true, timeline: buildTimeline(services, { conversationId, afterSequence: 0 }) });
  }


  // /conversations/:id/start-session
  if (segments.length === 3 && segments[2] === "start-session" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const text = typeof parsed.value.text === "string" ? parsed.value.text.trim() : "";
    if (text === "") {
      return fail(400, "INVALID_SCHEMA", "a start-session request must carry the user's text");
    }

    const resolution = await resolveProject(services.projects, { intent: text });
    const startedAt = at() as never;

    if (resolution.status === "rejected") {
      return fail(409, resolution.code, resolution.message);
    }

    if (resolution.status === "clarify" || resolution.status === "ask-for-directory") {
      // One question, and it is written into the conversation so the answer has somewhere to land.
      const message = appendHostReply(services, {
        conversationId,
        text:
          resolution.status === "clarify"
            ? `${resolution.question}\n${resolution.options.map((option: string) => `- ${option}`).join("\n")}`
            : resolution.question,
        at: startedAt,
      });
      return json(200, {
        status: resolution.status === "clarify" ? "clarify" : "needs-path",
        question: resolution.question,
        options: resolution.status === "clarify" ? resolution.options : [],
        messageId: message.messageId,
        timeline: buildTimeline(services, { conversationId, afterSequence: 0 }),
      });
    }

    // Resolved. The directory was verified by the finder; the session is started in it, and the brief
    // carries the same path, which is what makes "work in this project" true.
    const availability = services.projectSessions.available();
    if (!availability.available) {
      return fail(503, "SESSION_UNAVAILABLE", availability.reason ?? "this node cannot start a session");
    }

    const context = projectContext(resolution.project);
    /*
     * The approved roots for this session, passed whole rather than as their first element.
     *
     * `projectRoots` is the boundary the session's file tools are confined to, so the array is the contract:
     * the starter canonicalises every entry and the tools admit paths under all of them. A resolution carries
     * exactly one root today — the directory the finder verified, and the only root granted (see
     * `api.spec.ts`) — and a resolution that carried more would need no change here.
     */
    const approvedRoots = [resolution.project.path];
    const session = await services.projectSessions.start({
      goal: initialPrompt(text, resolution.project.name, context),
      projectRoots: approvedRoots,
    });
    markProjectUsed(services.projects, resolution.project.projectId);

    const message = appendHostReply(services, {
      conversationId,
      text: `Đã mở phiên làm việc trong ${resolution.project.name} (${resolution.relPath}). ${context}`,
      at: startedAt,
    });

    return json(201, {
      status: "started",
      projectName: resolution.project.name,
      relPath: resolution.relPath,
      mode: resolution.mode,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? null,
      messageId: message.messageId,
      timeline: buildTimeline(services, { conversationId, afterSequence: 0 }),
    });
  }

  // /conversations/:id/timeline
  if (segments.length === 3 && segments[2] === "timeline" && request.method === "GET") {
    const after = Number.parseInt(request.query.after ?? "0", 10);
    if (!Number.isFinite(after) || after < 0) {
      return fail(400, "INVALID_SCHEMA", "the `after` cursor must be a non-negative integer");
    }
    return json(200, buildTimeline(services, { conversationId, afterSequence: after }));
  }

  // /conversations/:id/widgets/:instanceId/actions
  if (
    segments.length === 5 &&
    segments[2] === "widgets" &&
    segments[4] === "actions" &&
    request.method === "POST"
  ) {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const instanceId = segments[3] ?? "";

    // The URL and the body must agree. A body that names a different instance is a request that
    // intends something other than what its own path says, and resolving which one is authoritative
    // is a decision this route should not have to make.
    if (typeof parsed.value.instanceId === "string" && parsed.value.instanceId !== instanceId) {
      return fail(400, "INSTANCE_MISMATCH", "the body names a different instance than the path");
    }

    const result = invokeWidgetAction(services, {
      conversationId,
      principalId: runtime.identity.ownerPrincipalId,
      instanceId,
      actionBindingId: typeof parsed.value.actionBindingId === "string" ? parsed.value.actionBindingId : "",
      expectedRevision: typeof parsed.value.expectedRevision === "number" ? parsed.value.expectedRevision : Number.NaN,
      expectedBindingDigest: typeof parsed.value.expectedBindingDigest === "string" ? parsed.value.expectedBindingDigest : "",
      input:
        typeof parsed.value.input === "object" && parsed.value.input !== null && !Array.isArray(parsed.value.input)
          ? (parsed.value.input as Record<string, unknown>)
          : {},
      invocationId: typeof parsed.value.invocationId === "string" ? parsed.value.invocationId : "",
    });

    if (result.ok) return json(result.status, result.body);
    return fail(result.status, result.code, result.message, {
      ...(result.currentRevision === undefined ? {} : { currentRevision: result.currentRevision }),
    });
  }

  // /conversations/:id/widgets/:instanceId/live
  if (
    segments.length === 5 &&
    segments[2] === "widgets" &&
    segments[4] === "live" &&
    request.method === "GET"
  ) {
    const instanceId = segments[3] ?? "";
    return resolveLiveWidget(services, conversationId, instanceId, runtime.identity.ownerPrincipalId);
  }

  // /conversations/:id/widgets/:instanceId/live-owner
  if (
    segments.length === 5 &&
    segments[2] === "widgets" &&
    segments[4] === "live-owner" &&
    (request.method === "POST" || request.method === "DELETE")
  ) {
    const instanceId = segments[3] ?? "";
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const ownerToken = typeof parsed.value.ownerToken === "string" ? parsed.value.ownerToken : "";
    if (ownerToken === "") {
      return fail(400, "INVALID_SCHEMA", "a live-owner request must carry the client's ownerToken");
    }

    if (request.method === "DELETE") {
      // A release that names a token this client does not hold is a release of somebody else's
      // claim, and is refused by the token comparison rather than by a principal check.
      const released = releaseLiveOwner(services.conductor, instanceId, ownerToken);
      if (!released) {
        return fail(409, "NOT_OWNER", "that client does not hold the live claim on this instance");
      }
      return json(200, { released: true, ownerSurface: null });
    }

    const surface = parsed.value.surface === "pin" ? "pin" : "inline";
    const leaseMs = typeof parsed.value.leaseMs === "number" && parsed.value.leaseMs > 0 ? parsed.value.leaseMs : undefined;
    // Expired claims are cleared first so the reply distinguishes "somebody else is holding it"
    // from "somebody else held it until a moment ago".
    sweepExpiredLiveOwners(services.conductor);
    const claimed = claimLiveOwner(services.conductor, {
      instanceId,
      surface,
      ownerToken,
      ...(leaseMs === undefined ? {} : { leaseMs }),
    });
    if (!claimed.ok) {
      return fail(409, claimed.code, "another surface holds the live view of this instance", {
        heldBySurface: claimed.heldBy.surface,
        ...(claimed.expiresAt === undefined ? {} : { expiresAt: claimed.expiresAt }),
      });
    }
    return json(200, {
      claimed: true,
      surface,
      expiresAt: claimed.expiresAt,
      ...(claimed.recoveredFrom === undefined ? {} : { recovered: true }),
    });
  }

  // /conversations/:id/snapshots/:snapshotId/presentation
  if (
    segments.length === 5 &&
    segments[2] === "snapshots" &&
    segments[4] === "presentation" &&
    request.method === "GET"
  ) {
    const snapshotId = segments[3] ?? "";
    const display = readSnapshotForDisplay(services.conductor, snapshotId);
    if (display === undefined) {
      return fail(404, "RESOURCE_NOT_FOUND", "that snapshot is not on this node");
    }
    const bundle = findBundleForSnapshot(runtime.db, snapshotId, runtime.identity.ownerPrincipalId);
    if (bundle !== undefined && bundle.instanceId !== display.snapshot.instanceId) {
      return fail(409, "OWNERSHIP_MISMATCH", "the stored bundle does not belong to this snapshot's instance");
    }
    return json(200, {
      snapshot: display.snapshot,
      // `read-only` is the point of this route: history never carries an action binding, so a
      // snapshot cannot be used to mutate anything even if a client tried.
      readOnly: true,
      text: display.text,
      ...(bundle === undefined
        ? { bundleRef: null, sections: [], tombstone: null }
        : {
            bundleRef: bundle.bundleId,
            sections: bundle.sections,
            // The spec travels with the bundle so a historical render shows the period and template
            // it was captured with, not the defaults of whatever the live instance is doing now.
            spec: bundle.composition,
            tombstone: bundle.tombstone ?? null,
            catalogDigest: bundle.catalogDigest,
          }),
    });
  }

  // /conversations/:id/widgets/:instanceId/composition
  if (
    segments.length === 5 &&
    segments[2] === "widgets" &&
    segments[4] === "composition" &&
    request.method === "GET"
  ) {
    const instanceId = segments[3] ?? "";
    const principalId = runtime.identity.ownerPrincipalId;
    const composition = findCompositionByInstance(runtime.db, instanceId, principalId);
    if (composition === undefined) {
      return fail(404, "RESOURCE_NOT_FOUND", "that instance has no composition on this node");
    }
    const spec = surfaceCompositionSpecSchema.parse(composition);
    // The bundle is read through the snapshot the message referenced, so a composition without a
    // captured snapshot answers with the spec alone and the client falls back to text.
    const snapshot = oneRow<{ snapshot_id: string }>(
      runtime.db,
      "SELECT snapshot_id FROM widget_snapshots WHERE instance_id = ? ORDER BY captured_at DESC LIMIT 1",
      instanceId,
    );
    const bundle =
      snapshot === undefined ? undefined : findBundleForSnapshot(runtime.db, snapshot.snapshot_id, principalId);
    if (bundle !== undefined && bundle.instanceId !== instanceId) {
      // A bundle that names a different instance is a malformed ownership relation, not a bundle.
      return fail(409, "OWNERSHIP_MISMATCH", "the stored bundle does not belong to this instance");
    }
    return json(200, {
      compositionId: spec.compositionId,
      spec,
      bundleRef: bundle?.bundleId ?? null,
      tombstone: bundle?.tombstone ?? null,
      sections: bundle?.sections ?? [],
      capturedAt: bundle?.capturedAt ?? null,
      byteSize: bundle?.byteSize ?? 0,
    });
  }

  // /conversations/:id/pins
  if (segments.length === 3 && segments[2] === "pins" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const instanceId = parsed.value.instanceId;
    if (typeof instanceId !== "string") {
      return fail(400, "INVALID_SCHEMA", "a pin request must name an instanceId");
    }
    const displayMode = parsed.value.displayMode === "expanded" ? "expanded" : "compact";
    const result = pinInstance(services.conductor, { conversationId, instanceId, displayMode });
    if (!result.ok) {
      const status = result.code === "WIDGET_INSTANCE_UNKNOWN" ? 404 : 409;
      return fail(status, result.code, result.message);
    }
    return json(201, { pinId: result.pinId, timeline: buildTimeline(services, { conversationId, afterSequence: 0 }) });
  }

  // /conversations/:id/pins/:pinId
  if (segments.length === 4 && segments[2] === "pins" && request.method === "DELETE") {
    const pinId = segments[3];
    if (pinId === undefined) {
      return fail(400, "INVALID_SCHEMA", "a pin route must name a pin");
    }
    const removed = unpinInstance(services.conductor, { conversationId, pinId });
    if (!removed) return fail(404, "RESOURCE_NOT_FOUND", "that pin is not on this conversation");
    // Unpinning is a presentation change. Note data and running jobs are untouched, which
    // is why nothing here cancels a task.
    return json(200, { removed: true, timeline: buildTimeline(services, { conversationId, afterSequence: 0 }) });
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}

/**
 * Carry out a decision on an operation the agent asked for.
 *
 * Shared by the HTTP route and the voice session, because "the user approved this" has to mean exactly the
 * same thing in both places: the decider must be a user, the digest the approver saw must match the one
 * stored with the request, the payload comes from the card that displayed it rather than from the caller,
 * and that payload is hashed again before anything runs. A refusal is never a block - a message describing
 * something that did not happen is how a transcript starts lying.
 */
export async function decideApprovalForNode(
  services: Pick<NodeServices, "runtime" | "conductor" | "search" | "projects">,
  input: {
    conversationId: string;
    approvalId: string;
    decision: "granted" | "denied";
    digest: string;
    principal: { principalId: string; kind: "user"; nodeId: string };
    at: Instant;
  },
): Promise<{ ok: true; outcome?: string; continuation?: string } | { ok: false; code: string; message: string }> {
  const coordination = {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => input.at as never,
    newId: services.conductor.newId,
  };
  const decided = decideApproval(coordination, {
    approvalId: input.approvalId as never,
    decision: input.decision,
    decidingPrincipal: input.principal as never,
    seenOperationDigest: input.digest,
  });
  if (!decided.ok) return { ok: false, code: decided.code, message: decided.message };

  if (input.decision === "denied") {
    appendHostReply(services, {
      conversationId: input.conversationId,
      text: "Đã từ chối chạy lệnh đó. Không có gì được chạy.",
      at: input.at,
    });
    return { ok: true };
  }

  // The payload lives with the card that displayed it, so the operation approved and the operation run are
  // the same record rather than two copies that can drift.
  const card = blocksOfConversation(services, input.conversationId).find(
    (block) => block.type === "approval-card" && block.approvalId === input.approvalId,
  );
  const payload = card !== undefined && typeof card.payload === "string" ? card.payload : undefined;
  if (payload === undefined) {
    return { ok: false, code: "APPROVAL_PAYLOAD_MISSING", message: "the approved operation is not in this conversation" };
  }

  const ran = await runApprovedCommand({
    payload,
    expectedDigest: decided.approval.operationDigest,
    approvalId: input.approvalId,
    // Re-checked here rather than trusted from the card: the folders this node owns can change between the card being
    // drawn and the decision being made, and this is the moment it matters.
    resources: ownedResourcesFor(services),
  });
  if (!ran.ok) return { ok: false, code: ran.code, message: ran.message };

  appendHostReply(services, { conversationId: input.conversationId, blocks: ran.blocks, at: input.at });

  // The approved path is audited here rather than in the runner, because this is where the decision and the outcome
  // are both known: what a person approved, and what came of running it.
  appendAuditEvent(services.runtime.db, {
    auditId: services.conductor.newId("audit"),
    principalId: services.runtime.identity.ownerPrincipalId,
    nodeId: services.runtime.identity.nodeId,
    kind: "command",
    summary: ran.description,
    outcome: ran.outcome.exitCode === 0 && !ran.outcome.timedOut ? "done" : "failed",
    ref: input.approvalId,
    at: input.at,
  });

  /*
   * Hand the outcome back to the agent.
   *
   * The turn that proposed this command ended with the card: the model asked, the tool returned an
   * acknowledgement, and the turn was over. Nothing else will ever tell it what happened, so without this the
   * transcript shows a command that ran and an agent that never noticed - a receipt, and then silence, which is
   * exactly what it looked like.
   *
   * The result is fed back as what it is: real output rather than a prediction, with the instruction to carry
   * on. It is a new turn in the same conversation, so it costs a model call, and that cost is the difference
   * between an agent that asked for help and one that stops at the asking.
   */
  const receipt = receiptForModel(ran.blocks);
  const continued = await handleUserMessage(services.conductor, {
    conversationId: input.conversationId as never,
    principal: input.principal as never,
    text: "Lệnh đã được duyệt và đã chạy xong.",
    /*
     * The receipt goes to the model rather than into the transcript.
     *
     * The card above the line already shows the command, its verdict and its output as a code block, and the
     * model needs the output to carry on. Putting it in the message as well printed the same output twice -
     * once in the receipt, once in the message that followed it - which is what a reader complained about.
     */
    note: `${receipt}\n\nĐây là kết quả thật, không phải dự đoán. Hãy tiếp tục công việc đang làm dở.`,
    at: input.at,
  });
  // Indexed where the messages were written, so a continuation is findable like anything else said.
  indexMessages(services.search, {
    conversationId: input.conversationId,
    messages: continued.messages,
    at: input.at,
  });
  const said = continued.messages
    .filter((message) => message.role === "assistant")
    .map((message) => textOfMessage(message))
    .join("\n\n")
    .trim();

  return { ok: true, outcome: ran.description, ...(said === "" ? {} : { continuation: said }) };
}
/**
 * Write one server-sent event.
 *
 * The payload is JSON on a single `data:` line rather than a raw string, because a delta can contain
 * a newline and a bare newline ends the event: the reader would then see the rest of the text as a
 * malformed frame and drop it. JSON encodes that character, and the size cost is a few bytes.
 */
function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Answer one message, reporting the reply as it is written.
 *
 * `done` carries the same timeline the non-streaming route returns, so the caller replaces its
 * optimistic view with the node's own record rather than keeping two accounts of the conversation.
 * It is sent on every path that produced a message, including a failed model turn: the failure is a
 * host card in the timeline, which is a result and not a stream error. `error` is reserved for the
 * case where there is no message at all, and it is sent on the stream because the status line has
 * long since been written.
 */
async function streamUserMessage(
  services: Pick<NodeServices, "runtime" | "conductor" | "search">,
  input: {
    conversationId: string;
    principal: Principal;
    text: string;
    at: Instant;
    attachmentRefs?: readonly AttachmentRef[];
    demo?: boolean;
  },
  send: (chunk: string) => void,
): Promise<void> {
  try {
    const outcome = await handleUserMessage(services.conductor, {
      conversationId: input.conversationId as never,
      principal: input.principal,
      text: input.text,
      at: input.at,
      attachmentRefs: input.attachmentRefs ?? [],
      ...(input.demo === true ? { demo: true } : {}),
      emit: (event) => {
        // One frame per event the turn produced, named as the turn named it. Translating here would
        // mean two vocabularies for the same facts, and the transcript stores one of them.
        if (event.type === "text-delta") send(sse("delta", { text: event.text }));
        else if (event.type === "reasoning-delta") send(sse("reasoning", { text: event.text }));
        else if (event.type === "tool-start") {
          send(sse("tool-start", { toolCallId: event.toolCallId, name: event.name, label: event.label, args: event.args }));
        } else if (event.type === "tool-end") {
          send(sse("tool-end", { toolCallId: event.toolCallId, status: event.status, result: event.result }));
        } else if (event.type === "host-control") {
          // An agent-issued app-control action, delivered as its own frame rather than folded into a
          // tool-end result: the client's one executor (`runAppIntent`) reads a decision, and the
          // `control_app` tool's own text result stays a report to the model, not a second copy of it.
          send(sse("host-control", { decision: event.decision }));
        }
      },
    });

    // Indexed here for the same reason the non-streaming route indexes here: a message that the
    // conversation shows has to be one that search finds, and a crash between the two is the gap
    // this ordering closes.
    indexMessages(services.search, { conversationId: input.conversationId, messages: outcome.messages, at: input.at });

    send(
      sse("done", {
        resolution: outcome.resolution,
        taskId: outcome.taskId ?? null,
        messageIds: outcome.messages.map((message) => message.messageId),
        timeline: buildTimeline(services, { conversationId: input.conversationId, afterSequence: 0 }),
      }),
    );
  } catch (cause) {
    send(
      sse("error", {
        code: "TURN_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }
}

/**
 * Raw command envelope route.
 *
 * Kept alongside the conversation routes because the envelope is the durable, idempotent
 * path: a client that must not double-execute sends here, and the same `idempotencyKey`
 * is what makes a retry safe.
 */
export function handleRawCommand(deps: RawCommandRouteDeps): GatewayResponse {
  const { request, at } = deps;
  const { services } = deps;
  const { runtime } = services;

  const parsed = readJson(request);
  if (!parsed.ok) return parsed.response;

  const envelope = commandEnvelopeSchema.safeParse(parsed.value);
  if (!envelope.success) {
    return fail(400, "INVALID_SCHEMA", "the command envelope does not match the contract", {
      issues: envelope.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }

  return json(202, {
    accepted: true,
    commandId: envelope.data.commandId,
    // Derived from the authenticated channel, never from the body.
    principal: {
      principalId: runtime.identity.ownerPrincipalId,
      kind: "user",
      nodeId: runtime.identity.nodeId,
    },
    receivedAt: at(),
    note: "accepted for durable processing; this is not an outcome",
  });
}
