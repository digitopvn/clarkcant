import { timingSafeEqual } from "node:crypto";

import {
  type AttachmentRef,
  type Instant,
  type MessageBlock,
  type MessageRecord,
  type Principal,
  ATTACHMENT_LIMITS,
  commandEnvelopeSchema,
  nowInstant,
  protocolRangeSchema,
  redactSecrets,
  surfaceCompositionSpecSchema,
  validateAttachmentCandidate,
} from "@clarkcant/contracts";
import {
  claimLiveOwner,
  decideApproval,
  getActionBinding,
  getInstance,
  handleUserMessage,
  invokeMiniAppAction,
  listCapabilitySummaries,
  listRegisteredPreferences,
  liveOwnerOf,
  liveStateOf,
  pinInstance,
  readExecutionPolicy,
  readSnapshotForDisplay,
  releaseLiveOwner,
  sweepExpiredLiveOwners,
  undoRegisteredPreference,
  unpinInstance,
  writeRegisteredPreference,
} from "@clarkcant/core";
import {
  type CalendarEventRecord,
  appendMessage,
  attachmentUsageForPrincipal,
  createConversation,
  findBundleForSnapshot,
  findCompositionByInstance,
  getAttachment,
  getConversation,
  getDatasetForPrincipal,
  getLocalImage,
  insertAttachment,
  listCalendarEvents,
  listConversations,
  listLocalImages,
  nextMessageSequence,
  oneRow,
  recentEvents,
  deleteCredential,
  putPreference,
} from "@clarkcant/storage";
import { credentialNames, putCredential } from "@clarkcant/storage";

import { nodeBackgroundSessions } from "./background-sessions.ts";
import { decideTurnAction, decisionTimeoutMsFromEnv, searchDecisionBudget } from "./jev-decider.ts";
import { PI_BUILTIN_TOOLS, nodeToolCatalogue } from "./tool-catalogue.ts";


import {
  MAX_IMAGE_BYTES,
  createLocalEvent,
  importLocalImage,
  removeLocalEvent,
  removeLocalImage,
  resolveLiveSections,
  updateLocalEvent,
} from "./mini-app-data.ts";
import { readBlob, sniffContentType, writeBlob } from "./blobs.ts";
import { attachmentRefFromRecord, resolveAttachmentRefs } from "./attachments.ts";
import { markProjectUsed, projectContext, resolveProject } from "./project-finder.ts";
import { receiptForModel, runApprovedCommand } from "./run-command.ts";
import { initialPrompt } from "./project-session.ts";
import { indexMessages, ingestSessionEntries, searchSessions, textOfMessage } from "./session-search.ts";
import { type NodeServices, buildTimeline } from "./services.ts";
import { availableCredentials } from "./readiness.ts";

/**
 * Authenticated command gateway.
 *
 * The gateway's main job is to refuse things, and to build the caller's identity from the
 * transport rather than from the request body. A payload that names its own principal is
 * data, not authority, which is why no route below reads an identity out of JSON.
 *
 * The transport is `node:http` with no framework so the authorization path has nowhere to
 * hide: every authenticated route goes through exactly one check.
 */

export interface GatewayRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface GatewayResponse {
  status: number;
  body: unknown;
  /**
   * A body written over time rather than returned at once.
   *
   * A conversation turn takes as long as the model takes, and the whole point of streaming it is that
   * the text is readable while that happens. The alternative — a promise that resolves with the whole
   * reply — cannot express "here is part of it", so the shape has to allow the transport to write
   * before the handler returns. Validation still happens in the handler, so a malformed request or a
   * missing conversation is still an ordinary JSON refusal with a status code; only the events are
   * streamed, because by the time they exist the status has been sent.
   */
  stream?: {
    contentType: string;
    run: (send: (chunk: string) => void) => Promise<void>;
  };
  /**
   * Bytes to send verbatim instead of a JSON body.
   *
   * Only imported images and stored attachments use this. Answering an image request with a base64
   * JSON envelope would mean the browser holds a copy of the file in memory as text and the content
   * type is whatever the caller decides, which is the opposite of serving an approved artifact under
   * the type the host verified.
   *
   * `headers` are additional headers a route needs and the transport does not own — a disposition for
   * an attachment, `nosniff` for anything served back to a browser. The transport refuses a key it
   * owns, so a route cannot serve bytes under a content type the host never verified.
   */
  binary?: { bytes: Uint8Array; contentType: string; headers?: Record<string, string> };
}

export interface GatewayDeps {
  services: NodeServices;
  /** Injected so tests can make time deterministic. */
  now?: () => string;
  /** Injected so conversation identifiers are deterministic in tests. */
  newConversationId?: () => string;
}

/**
 * Constant-time comparison, so the gate does not leak a token's length or prefix.
 *
 * Exported because the voice socket has to make the identical decision, and a second comparison
 * written beside this one is a second comparison that can drift: the failure mode of two
 * well-meant token checks is that one of them quietly stops being constant-time.
 */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(headers: GatewayRequest["headers"]): string | undefined {
  const raw = headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const [scheme, token] = value.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || token === undefined) return undefined;
  return token;
}

function json(status: number, body: unknown): GatewayResponse {
  return { status, body };
}

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>): GatewayResponse {
  return json(status, { code, message, ...(extra ?? {}) });
}

/** Parse a JSON body, reporting a malformed one rather than throwing. */
function readJson(request: GatewayRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: GatewayResponse } {
  if (request.body.trim() === "") return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(request.body) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, response: fail(400, "INVALID_SCHEMA", "the request body must be a JSON object") };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: fail(400, "INVALID_SCHEMA", "the request body is not valid JSON") };
  }
}

/**
 * Handle one request.
 *
 * Returning a discriminated result rather than throwing keeps every refusal visible in one
 * place, which is what makes the negative tests meaningful.
 */
export async function handleRequest(deps: GatewayDeps, request: GatewayRequest): Promise<GatewayResponse> {
  const at = deps.now ?? (() => nowInstant());
  const { services } = deps;
  const { runtime } = services;

  /*
   * CORS preflight, answered before the token check.
   *
   * A browser sends `OPTIONS` without credentials before any request that carries an
   * `Authorization` header, so requiring a token here would make every cross-origin request
   * fail at the preflight and look like a network error in the client. The preflight grants
   * nothing: the actual request still has to present the token.
   */
  if (request.method === "OPTIONS") {
    return { status: 204, body: null };
  }

  // The only unauthenticated route, and it deliberately discloses no node identity: an
  // open readiness probe must not become a way to enumerate nodes.
  if (request.method === "GET" && request.path === "/health") {
    return json(200, {
      status: "ok",
      runtime: services.describe(),
      negotiatedProtocol: protocolRangeSchema.parse({ name: "agent.nodelink", min: 1, max: 2 }),
      checkedAt: at(),
    });
  }

  if (!tokenMatches(runtime.identity.localToken, bearer(request.headers))) {
    // Identical for a missing and a wrong token: distinguishing them would tell an
    // attacker which half to work on.
    return fail(401, "UNAUTHENTICATED", "a valid bearer token is required for every command");
  }

  const segments = request.path.split("/").filter((segment) => segment.length > 0);

  if (request.method === "GET" && request.path === "/node") {
    return json(200, {
      nodeId: runtime.identity.nodeId,
      label: runtime.identity.label,
      createdAt: runtime.identity.createdAt,
      // Reported here rather than inferred by the client, so the settings surface can say what
      // this node is configured for before it has answered anything. `null` means no model, which
      // is a state worth showing plainly: the node answers from scripts and capabilities only.
      model: services.model,
    });
  }

  if (request.method === "GET" && request.path === "/model") {
    // The catalogue comes from the SDK, so a provider added by upgrading pi appears here without this node changing,
    // and the current selection is reported beside it rather than inferred from it: a node configured for a model its
    // installation no longer offers is a state worth showing plainly instead of hiding.
    const catalogue = await (services.modelCatalogue?.() ?? Promise.resolve([]));
    return json(200, { current: services.model, catalogue });
  }

  /*
   * A model a person chose.
   *
   * Stored, and applied to sessions created afterwards: the model is resolved when a session is created, which is the
   * only moment a choice can reach one, so the answer names that scope rather than implying a conversation already
   * running changed underneath somebody. A conversation that is open keeps the model it started with.
   *
   * The choice is still checked against the catalogue first: a stored model this installation cannot run would fail
   * every later turn with a message about a provider rather than about the choice that caused it.
   */
  if (segments.length === 1 && segments[0] === "model" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const provider = typeof parsed.value.provider === "string" ? parsed.value.provider.trim() : "";
    const id = typeof parsed.value.id === "string" ? parsed.value.id.trim() : "";
    if (provider === "" || id === "") {
      return fail(400, "INVALID_SCHEMA", "a model choice needs a provider and a model id");
    }
    const catalogue = await (services.modelCatalogue?.() ?? Promise.resolve([]));
    const offered = catalogue.find((entry) => entry.id === provider);
    if (catalogue.length > 0 && (offered === undefined || !offered.models.some((model) => model.id === id))) {
      return fail(400, "INVALID_SCHEMA", `provider "${provider}" does not offer a model "${id}"`);
    }
    putPreference(services.runtime.db, {
      principalId: services.runtime.identity.ownerPrincipalId,
      key: "model",
      value: `${provider}/${id}`,
      scope: "node",
      source: "settings",
      at: nowInstant(),
    });
    return json(200, { ok: true, stored: { provider, id }, applies: "conversations started after this" });
  }

  if (request.method === "GET" && request.path === "/capabilities") {
    return json(200, {
      // Summaries only: dumping every tool schema into every turn is both expensive and a
      // prompt-injection surface, so a schema is loaded once a capability is chosen.
      capabilities: listCapabilitySummaries({ db: runtime.db, nodeId: runtime.identity.nodeId }),
    });
  }

  // `at` answers a plain string; a preference write is stamped with a branded instant, and the
  // gateway's own clock is the one every other write on this path already uses.
  const preferenceDeps = { db: runtime.db, now: () => at() as Instant };

  /*
   * The registered preferences, their current values, and when each change takes effect.
   *
   * A registry rather than a free-form store. A key nothing declares is refused by name, because a
   * stored value nothing reads is a setting that silently does nothing — and because answering only
   * for declared keys is what keeps credentials, which have their own store and their own routes,
   * out of this response by construction rather than by remembering to filter them.
   *
   * A preference the user has never set is answered with the default the product would use and
   * `isDefault: true`, so the surface renders a real current state instead of inventing one and
   * cannot present a default as a choice somebody made.
   */
  if (segments.length === 1 && segments[0] === "preferences" && request.method === "GET") {
    return json(200, {
      preferences: listRegisteredPreferences(preferenceDeps, runtime.identity.ownerPrincipalId),
    });
  }

  /*
   * The effects this node performed without an approval card.
   *
   * This is what makes autonomy checkable rather than merely trusted: an approval card is its own record, and
   * an effect that skipped the card would otherwise leave nothing a person could look at. Read from the same
   * event log the task lifecycle writes to.
   *
   * The document is passed through as the writer stored it, and the writer is `recordEffectExecution`, which
   * puts a description and an operation digest there — never a credential, and never the output of a command.
   */
  if (segments.length === 1 && segments[0] === "activity" && request.method === "GET") {
    const events = recentEvents(runtime.db, { stream: "activity", limit: 20 });
    return json(200, {
      effects: events.map((event) => {
        const document = (typeof event.document === "object" && event.document !== null
          ? event.document
          : {}) as Record<string, unknown>;
        return {
          at: event.occurredAt,
          kind: event.kind,
          mode: typeof document.mode === "string" ? document.mode : "unknown",
          category: typeof document.category === "string" ? document.category : "unknown",
          description: typeof document.description === "string" ? document.description : "",
          operationDigest: typeof document.operationDigest === "string" ? document.operationDigest : "",
          because: typeof document.because === "string" ? document.because : "",
        };
      }),
    });
  }

  if (segments.length === 2 && segments[0] === "preferences" && request.method === "PUT") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    // Presence, not truthiness: `false` and `""` are values a preference may legitimately hold, so
    // the only thing refused here is a body that names no value at all.
    if (!("value" in parsed.value)) {
      return fail(400, "INVALID_SCHEMA", "a preference write needs a value");
    }
    const outcome = writeRegisteredPreference(preferenceDeps, {
      principalId: runtime.identity.ownerPrincipalId,
      key: segments[1] ?? "",
      value: parsed.value.value,
    });
    if (!outcome.ok) {
      // A key this node does not have is not found; a value it does not accept is a bad request.
      // The message names the field and never echoes what arrived.
      return fail(
        outcome.code === "PREFERENCE_UNKNOWN" ? 404 : 400,
        outcome.code,
        outcome.message,
      );
    }
    return json(200, { preference: outcome.preference });
  }

  if (
    segments.length === 3 &&
    segments[0] === "preferences" &&
    segments[2] === "undo" &&
    request.method === "POST"
  ) {
    const outcome = undoRegisteredPreference(preferenceDeps, {
      principalId: runtime.identity.ownerPrincipalId,
      key: segments[1] ?? "",
    });
    if (!outcome.ok) return fail(404, outcome.code, outcome.message);
    // `undone: false` travels as a success, because a key nobody has written has nothing to undo:
    // reporting a change that did not happen would be worse than reporting that there was none.
    return json(200, outcome);
  }

  // /datasets/:id
  if (segments[0] === "datasets" && segments.length === 2 && request.method === "GET") {
    const dataset = getDatasetForPrincipal(
      runtime.db,
      segments[1] ?? "",
      runtime.identity.ownerPrincipalId,
    );
    if (!dataset) return fail(404, "RESOURCE_NOT_FOUND", "that dataset is not available on this node");
    // The freshness travels with the data so a cached read cannot be presented as live.
    return json(200, dataset);
  }

  if (segments[0] === "calendar" || segments[0] === "images") {
    return handleMiniAppDataRoutes(deps, request, segments, at);
  }

  if (segments[0] === "attachments") {
    return handleAttachmentRoutes(deps, request, segments, at);
  }

  if (segments[0] === "search") {
    return await handleSearchRoutes(deps, request, segments);
  }

  if (segments[0] === "conversations") {
    return await handleConversationRoutes(deps, request, segments, at);
  }

  /*
   * A secret a person typed.
   *
   * The response says what happened and nothing about what was said: the names that are now set, never the values
   * and never how long they were. A length is a fact about a secret, and a card that printed one would be the
   * first place it leaked from. Nothing here logs the body either, which is why an invalid request names the
   * shape it wanted rather than echoing what it got.
   */
  if (segments.length === 1 && segments[0] === "credentials" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const fields = parsed.value.fields;
    if (!Array.isArray(fields) || fields.length === 0) {
      return fail(400, "INVALID_SCHEMA", "a credential request must carry at least one field");
    }
    const at = nowInstant();
    // The node's owner, read here rather than from the conversation-scoped binding the routes below use: this
    // route is not about a conversation, and a secret is stored against the person who typed it, not against
    // the thread they happened to be in.
    const owner = services.runtime.identity.ownerPrincipalId;
    for (const field of fields as { name?: unknown; value?: unknown }[]) {
      const name = typeof field.name === "string" ? field.name.trim() : "";
      const value = typeof field.value === "string" ? field.value : "";
      if (name === "" || value === "") {
        return fail(400, "INVALID_SCHEMA", "every credential field needs a name and a value");
      }
      putCredential(services.runtime.db, { principalId: owner, name, value, at });
    }
    return json(201, { ok: true, names: credentialNames(services.runtime.db, owner) });
  }

  /*
   * The work running behind the conversation.
   *
   * A count and a list rather than a single flag, because the useful question is not "is something running" but
   * "what is running, and did the last one finish". Newest first, and empty when nothing has been started - an
   * invented placeholder entry would make the count meaningless.
   */
  /*
   * One request, run somewhere else, asked for directly.
   *
   * The decider is one way a background request happens; a person highlighting a passage and saying "do this
   * elsewhere" is the other, and it must not depend on the decider having an opinion about it.
   */
  /*
   * A secret a person takes back.
   *
   * This is what logging out of a provider is: the key is the only thing the node holds, so a node that has forgotten
   * it stops using that provider on the next turn. The answer names what remains, never a value and never a length.
   */
  if (segments.length === 2 && segments[0] === "credentials" && request.method === "DELETE") {
    const name = decodeURIComponent(segments[1] ?? "").trim();
    if (name === "") return fail(400, "INVALID_SCHEMA", "a credential name is required");
    const owner = services.runtime.identity.ownerPrincipalId;
    const removed = deleteCredential(services.runtime.db, owner, name);
    // 404 rather than a cheerful 200 for a name that was not there: "I removed it" and "there was nothing to remove"
    // are different answers, and a surface that cannot tell them apart cannot say why nothing changed.
    if (!removed) return fail(404, "RESOURCE_NOT_FOUND", `no credential named ${name}`);
    return json(200, { ok: true, names: credentialNames(services.runtime.db, owner) });
  }

  if (segments.length === 1 && segments[0] === "background-sessions" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const text = typeof parsed.value.text === "string" ? parsed.value.text.trim() : "";
    const requested = typeof parsed.value.conversationId === "string" ? parsed.value.conversationId : "";
    if (text === "" || requested === "") {
      return fail(400, "INVALID_SCHEMA", "a background request needs a conversationId and a non-empty text");
    }
    // The owner of this node, built here because this route sits above the branch where the request's own principal is
    // resolved: a background request from a selection is the owner's, and there is no other person it could be.
    const owner: Principal = {
      principalId: runtime.identity.ownerPrincipalId as Principal["principalId"],
      kind: "user",
      nodeId: runtime.identity.nodeId as Principal["nodeId"],
    };
    const started = startBackgroundWork(services, owner, () => at() as never, requested, text);
    if ("refusal" in started) return fail(409, "BACKGROUND_UNAVAILABLE", started.refusal);
    return json(202, { accepted: true, sessionId: started.sessionId });
  }

  /*
   * What this node can do, and what the agent it drives can do.
   *
   * Two lists rather than one, because they are two different things and a reader needs to know which is which: the
   * harness's tools are this node's own, and the agent's are pi's. An extension's tools are not listed because they
   * depend on pi's own configuration, and a list that guessed at them would be wrong in the one direction that
   * matters - claiming a capability this node does not have.
   */
  /*
   * What pi loads on this machine.
   *
   * Names and kinds, never contents: an extension can hold a credential, and a listing that read files would be the place
   * it leaked from. Reported apart from this harness's own tools for the same reason the tab reports two lists - a reader
   * deciding whether something is possible needs to know which half would do it.
   */
  if (segments.length === 1 && segments[0] === "extensions" && request.method === "GET") {
    return json(200, { extensions: await (services.extensions?.() ?? Promise.resolve([])) });
  }

  /*
   * pi's own configuration.
   *
   * Scalars, with anything whose name sounds like a secret already redacted by the adapter, which is also where the
   * decision not to read auth.json lives. A panel showing configuration has no business near a credentials file, and the
   * redaction happens at the one place that can see the file rather than on the way out of here.
   */
  /*
   * What this node has already been told.
   *
   * Built for the first run, which should not ask for a provider, a model and a key that are already configured - and it
   * says nothing an operator could not read out of their own .env file. Names only, never values, and never a length.
   */
  if (segments.length === 1 && segments[0] === "readiness" && request.method === "GET") {
    return json(200, {
      model: services.model !== null,
      credentials: availableCredentials({
        env: process.env,
        vault: credentialNames(services.runtime.db, services.runtime.identity.ownerPrincipalId),
      }),
    });
  }

  if (segments.length === 1 && segments[0] === "pi-settings" && request.method === "GET") {
    return json(200, { settings: await (services.piSettings?.() ?? Promise.resolve([])) });
  }

  if (segments.length === 1 && segments[0] === "tools" && request.method === "GET") {
    return json(200, {
      self: nodeToolCatalogue(),
      agent: PI_BUILTIN_TOOLS,
      agentNote: "Công cụ gốc của pi. Extension mà pi tự nạp thêm thì không liệt kê ở đây.",
    });
  }

  if (segments.length === 1 && segments[0] === "background-sessions" && request.method === "GET") {
    return json(200, {
      running: nodeBackgroundSessions.running(),
      sessions: nodeBackgroundSessions.list(),
    });
  }

  if (request.method === "POST" && request.path === "/command") {
    return handleRawCommand(deps, request, at);
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}

/**
 * Append a host-authored reply.
 *
 * Written here rather than in the conductor because these are the node's own words about its own
 * state — which project it opened, which question it is asking — not a model's answer. It is indexed
 * for search at the same time, so what the conversation shows and what search finds cannot disagree.
 */
/**
 * Where a command may run, computed at the moment it is decided.
 *
 * Both halves are read fresh rather than captured when the request was made: an approval can sit for a
 * quarter of an hour, and a project that was indexed then may not be known now.
 */
function blocksOfConversation(services: NodeServices, conversationId: string): Record<string, unknown>[] {
  const timeline = buildTimeline(services, { conversationId, afterSequence: 0 });
  const blocks: Record<string, unknown>[] = [];
  // SAFETY: the timeline type describes a message's blocks as unparsed JSON. The node wrote them, and
  // every route that renders a block validates the ones claiming host ownership before drawing it.
  const messages = timeline.messages as unknown as { blocks?: Record<string, unknown>[] }[];
  for (const message of messages) blocks.push(...(message.blocks ?? []));
  return blocks;
}

/**
 * Append a message the host wrote — a question, a notice, or the receipt of an operation.
 *
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
function startBackgroundWork(
  services: NodeServices,
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

function appendHostReply(
  services: NodeServices,
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
 * History search.
 *
 * The scope comes from the transport, exactly as every other route does: there is no principal in
 * the query, so a caller cannot ask for somebody else's history by naming them. What a caller *can*
 * narrow is the conversation, the task and the time window, all of which are filters within the
 * principal's own history.
 */
async function handleSearchRoutes(
  deps: GatewayDeps,
  request: GatewayRequest,
  segments: string[],
): Promise<GatewayResponse> {
  const search = deps.services.search;

  // POST /search/sessions/:sessionId/ingest
  if (segments.length === 4 && segments[1] === "sessions" && segments[3] === "ingest" && request.method === "POST") {
    const sessionId = segments[2] ?? "";
    const outcome = ingestSessionEntries(search, { sessionId });
    if ("error" in outcome) {
      const status = outcome.error.includes("another principal") ? 403 : 404;
      return fail(status, "SESSION_NOT_INDEXED", outcome.error);
    }
    return json(200, outcome);
  }

  // GET /search/sessions?q=…&limit=…  and  POST /search/sessions {query}
  if (segments.length === 2 && segments[1] === "sessions") {
    const fromQuery = request.query.q ?? "";
    let text = fromQuery;
    let limit: number | undefined;
    let conversationId: string | undefined;
    let taskId: string | undefined;
    let source: "message" | "session_entry" | undefined;

    if (request.method === "POST") {
      const parsed = readJson(request);
      if (!parsed.ok) return parsed.response;
      text = typeof parsed.value.query === "string" ? parsed.value.query : "";
      if (typeof parsed.value.limit === "number") limit = parsed.value.limit;
      if (typeof parsed.value.conversationId === "string") conversationId = parsed.value.conversationId;
      if (typeof parsed.value.taskId === "string") taskId = parsed.value.taskId;
      if (parsed.value.source === "message" || parsed.value.source === "session_entry") source = parsed.value.source;
    } else if (request.method !== "GET") {
      return fail(405, "METHOD_NOT_ALLOWED", `${request.method} is not supported on /search/sessions`);
    }

    if (text.trim() === "") {
      return fail(400, "INVALID_SCHEMA", "a search must carry a non-empty query");
    }

    const outcome = await searchSessions(search, {
      text: text.slice(0, 500),
      ...(limit === undefined ? {} : { limit: Math.max(1, Math.min(limit, 50)) }),
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(source === undefined ? {} : { source }),
    });
    return json(200, outcome);
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}

/**
 * Local calendar and imported images.
 *
 * Both are principal-scoped at the query rather than checked after the fact, so a request for
 * somebody else's event resolves to `404` — the same answer as a request for an event that does
 * not exist. Distinguishing the two would turn this route into a way to enumerate another
 * principal's calendar.
 */
/**
 * Files a person attached, and the bytes they point at.
 *
 * Three properties, each of which a different route would lose:
 *
 * - **The bytes decide the type.** The declared content type is a claim, and `sniffContentType` is
 *   what makes it a fact; a mismatch is refused rather than stored under the type the client asked
 *   for, so nothing here can be served back as something executable.
 * - **A reference is not a location.** The answer carries `attachmentId` and a content-addressed
 *   `blobRef`, never the path on this node. The path stays in the row and is re-checked against the
 *   blob root before anything is opened.
 * - **A name is text a person typed.** It is redacted before it is stored as well as before it is
 *   returned, because that is where a credential turns up.
 */
function handleAttachmentRoutes(
  deps: GatewayDeps,
  request: GatewayRequest,
  segments: string[],
  at: () => string,
): GatewayResponse {
  const { runtime, conductor } = deps.services;
  const principalId = runtime.identity.ownerPrincipalId;

  if (segments.length === 1 && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;

    const conversationId = typeof parsed.value.conversationId === "string" ? parsed.value.conversationId : "";
    const filename = typeof parsed.value.filename === "string" ? parsed.value.filename : "";
    const mime = typeof parsed.value.mime === "string" ? parsed.value.mime : "";
    const contentBase64 = typeof parsed.value.contentBase64 === "string" ? parsed.value.contentBase64 : "";
    if (conversationId === "" || contentBase64 === "") {
      return fail(
        400,
        "INVALID_SCHEMA",
        "an upload needs a conversationId, a filename, a content type and contentBase64",
      );
    }
    if (getConversation(runtime.db, conversationId) === undefined) {
      return fail(404, "RESOURCE_NOT_FOUND", "that conversation is not on this node");
    }

    // Refused from the encoded length alone when that is already over the ceiling: a 100 MB base64
    // string should not become a 75 MB buffer just to find out it was too big.
    if (contentBase64.length > Math.ceil((ATTACHMENT_LIMITS.maxBytes * 4) / 3) + 1024) {
      return fail(413, "ATTACHMENT_TOO_LARGE", `a file must be at most ${ATTACHMENT_LIMITS.maxBytes} bytes`);
    }

    const bytes = Buffer.from(contentBase64, "base64");
    const sniffed = sniffContentType(bytes, mime);
    if (!sniffed.ok) return fail(415, sniffed.code, sniffed.message);

    const checked = validateAttachmentCandidate({
      filename,
      mime: sniffed.mime,
      sizeBytes: bytes.byteLength,
      usedBytes: attachmentUsageForPrincipal(runtime.db, principalId),
    });
    if (!checked.ok) return fail(attachmentRefusalStatus(checked.code), checked.code, checked.message);

    const written = writeBlob({ dataDir: runtime.dataDir, bytes, extension: sniffed.extension });
    const record = {
      attachmentId: conductor.newId("att"),
      principalId,
      conversationId,
      filename: redactSecrets(checked.filename),
      mime: checked.mime,
      kind: checked.kind,
      sizeBytes: bytes.byteLength,
      sha256: written.digest,
      blobPath: written.blobPath,
      createdAt: at(),
    };
    insertAttachment(runtime.db, record);
    return { status: 201, body: { attachmentRef: attachmentRefFromRecord(record) } };
  }

  const attachmentId = decodeURIComponent(segments[1] ?? "");
  if (attachmentId === "") {
    return fail(400, "INVALID_SCHEMA", "an attachment route must name an attachment");
  }

  if (segments.length === 2 && request.method === "GET") {
    const record = getAttachment(runtime.db, attachmentId, principalId);
    // One answer for "no such attachment" and "not yours": distinguishing them would make this route
    // a way to enumerate another principal's files.
    if (record === undefined) return fail(404, "RESOURCE_NOT_FOUND", "that attachment is not on this node");
    return json(200, { attachmentRef: attachmentRefFromRecord(record) });
  }

  if (segments.length === 3 && segments[2] === "content" && request.method === "GET") {
    const record = getAttachment(runtime.db, attachmentId, principalId);
    if (record === undefined) return fail(404, "RESOURCE_NOT_FOUND", "that attachment is not on this node");

    const blob = readBlob({ dataDir: runtime.dataDir, blobPath: record.blobPath });
    if (!blob.ok) {
      return fail(blob.code === "BLOB_MISSING" ? 410 : 500, blob.code, blob.message);
    }

    // Only a picture or text may render in place. A pdf opens as a download, and nothing in the
    // allowlist can become a document the browser would execute, which is what makes `inline` safe
    // here rather than merely convenient.
    const inline = record.kind === "image" || record.mime.startsWith("text/");
    return {
      status: 200,
      body: null,
      binary: {
        bytes: blob.bytes,
        contentType: record.mime,
        headers: {
          "x-content-type-options": "nosniff",
          "content-disposition": `${inline ? "inline" : "attachment"}; filename="${dispositionName(record.filename)}"`,
        },
      },
    };
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}

/** Which status a refusal deserves, so the mapping exists once rather than at each branch. */
function attachmentRefusalStatus(code: string): number {
  if (code === "ATTACHMENT_NAME_NOT_ALLOWED") return 400;
  if (code === "ATTACHMENT_TOO_LARGE") return 413;
  if (code === "ATTACHMENT_QUOTA_EXCEEDED") return 409;
  return 415;
}

/**
 * A file name safe to put in a header.
 *
 * Quotes, backslashes and line breaks are removed rather than escaped: a name is untrusted text, and
 * a header that can be broken out of is a response-splitting bug rather than a formatting problem.
 */
function dispositionName(filename: string): string {
  return filename.replaceAll(/["\\\r\n]/g, "").slice(0, 120);
}

function handleMiniAppDataRoutes(
  deps: GatewayDeps,
  request: GatewayRequest,
  segments: string[],
  at: () => string,
): GatewayResponse {
  const { runtime } = deps.services;
  const principalId = runtime.identity.ownerPrincipalId;
  const dataDeps = {
    db: runtime.db,
    nodeId: runtime.identity.nodeId,
    dataDir: runtime.dataDir,
    now: () => at() as never,
    newId: deps.services.conductor.newId,
  };

  /* Calendar */
  if (segments[0] === "calendar" && segments[1] === "events") {
    if (segments.length === 2) {
      if (request.method === "GET") {
        const from = request.query.from;
        const to = request.query.to;
        const events = listCalendarEvents(runtime.db, {
          principalId,
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        });
        return json(200, {
          events: events.map(toEventView),
          // Stated in the response rather than only in the docs: these are local records, and a
          // client that assumed a provider sync would be wrong about what it is showing.
          source: "local",
        });
      }
      if (request.method === "POST") {
        const parsed = readJson(request);
        if (!parsed.ok) return parsed.response;
        const created = createLocalEvent(dataDeps, {
          principalId,
          title: parsed.value.title,
          startsAt: parsed.value.startsAt,
          endsAt: parsed.value.endsAt,
          timezone: parsed.value.timezone,
        });
        if (!created.ok) return fail(400, created.code, created.message);
        return json(201, { event: toEventView(created.event) });
      }
      return fail(405, "METHOD_NOT_ALLOWED", `${request.method} is not supported on /calendar/events`);
    }

    const eventId = segments[2];
    if (eventId === undefined) return fail(400, "INVALID_SCHEMA", "a calendar route must name an event");
    if (request.method === "PATCH" || request.method === "PUT") {
      const parsed = readJson(request);
      if (!parsed.ok) return parsed.response;
      const existing = listCalendarEvents(runtime.db, { principalId }).find((event) => event.eventId === eventId);
      if (existing === undefined) return fail(404, "RESOURCE_NOT_FOUND", "that event is not on this calendar");
      const updated = updateLocalEvent(dataDeps, {
        principalId,
        eventId,
        title: parsed.value.title ?? existing.title,
        startsAt: parsed.value.startsAt ?? existing.startsAt,
        endsAt: parsed.value.endsAt ?? existing.endsAt,
        timezone: parsed.value.timezone ?? existing.timezone,
      });
      if (!updated.ok) {
        return fail(updated.code === "EVENT_NOT_FOUND" ? 404 : 400, updated.code, updated.message);
      }
      return json(200, { event: toEventView(updated.event) });
    }
    if (request.method === "DELETE") {
      const removed = removeLocalEvent(dataDeps, { principalId, eventId });
      if (!removed.ok) return fail(404, removed.code, removed.message);
      return json(200, { removed: true });
    }
    return fail(405, "METHOD_NOT_ALLOWED", `${request.method} is not supported on a calendar event`);
  }

  /* Images */
  if (segments[0] === "images") {
    if (segments.length === 1) {
      if (request.method === "GET") {
        return json(200, { images: listLocalImages(runtime.db, principalId).map(toImageView) });
      }
      if (request.method === "POST") {
        const parsed = readJson(request);
        if (!parsed.ok) return parsed.response;
        const dataBase64 = typeof parsed.value.dataBase64 === "string" ? parsed.value.dataBase64 : "";
        if (dataBase64.length === 0) {
          return fail(400, "INVALID_SCHEMA", "an image import must carry a dataBase64 field");
        }
        // Checked before decoding: a 100 MB base64 string should be refused without allocating it.
        if (dataBase64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1024) {
          return fail(413, "IMAGE_TOO_LARGE", `an imported image must be at most ${MAX_IMAGE_BYTES} bytes`);
        }
        const bytes = Buffer.from(dataBase64, "base64");
        const imported = importLocalImage(dataDeps, {
          principalId,
          bytes,
          declaredMimeType: typeof parsed.value.mimeType === "string" ? parsed.value.mimeType : "",
          altText: parsed.value.altText,
          ...(typeof parsed.value.filename === "string" ? { filename: parsed.value.filename } : {}),
        });
        if (!imported.ok) return fail(415, imported.code, imported.message);
        return json(201, { image: toImageView(imported.image) });
      }
      return fail(405, "METHOD_NOT_ALLOWED", `${request.method} is not supported on /images`);
    }

    const imageId = segments[1];
    if (imageId === undefined) return fail(400, "INVALID_SCHEMA", "an image route must name an image");
    const image = getLocalImage(runtime.db, imageId, principalId);
    if (image === undefined) return fail(404, "RESOURCE_NOT_FOUND", "that image is not on this node");

    if (request.method === "GET") {
      // The path was written by `importLocalImage` under the node's blob directory. The reader
      // re-checks containment anyway: a row edited by hand must not become an arbitrary file read.
      const blob = readBlob({ dataDir: runtime.dataDir, blobPath: image.blobPath });
      if (!blob.ok) {
        // A row whose bytes are gone is a missing file, not a server fault: the client shows its
        // missing-image fallback and the row stays so the user can see what was there.
        return fail(blob.code === "BLOB_MISSING" ? 410 : 500, blob.code, blob.message);
      }
      return {
        status: 200,
        body: null,
        // The content type is the one the host verified from the magic bytes, never the one the
        // uploader declared.
        binary: { bytes: blob.bytes, contentType: image.mimeType },
      };
    }
    if (request.method === "DELETE") {
      const removed = removeLocalImage(dataDeps, { principalId, imageId });
      if (!removed) return fail(404, "RESOURCE_NOT_FOUND", "that image is not on this node");
      return json(200, { removed: true });
    }
    return fail(405, "METHOD_NOT_ALLOWED", `${request.method} is not supported on an image`);
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
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
  services: NodeServices,
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

function toEventView(event: CalendarEventRecord): Record<string, unknown> {
  return {
    eventId: event.eventId,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    date: event.localDate,
    source: "local",
  };
}

function toImageView(image: {
  imageId: string;
  mimeType: string;
  byteSize: number;
  width: number | undefined;
  height: number | undefined;
  digest: string;
  altText: string;
  createdAt: string;
}): Record<string, unknown> {
  return {
    imageId: image.imageId,
    mimeType: image.mimeType,
    byteSize: image.byteSize,
    width: image.width ?? null,
    height: image.height ?? null,
    digest: image.digest,
    alt: image.altText,
    createdAt: image.createdAt,
    /** Where the bytes can be fetched. Opaque: the client never builds a blob path. */
    url: `/images/${image.imageId}`,
  };
}

async function handleConversationRoutes(
  deps: GatewayDeps,
  request: GatewayRequest,
  segments: string[],
  at: () => string,
): Promise<GatewayResponse> {
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

    const outcome = await handleUserMessage(services.conductor, {
      conversationId: conversationId as never,
      principal,
      text: text.slice(0, 20_000),
      at: at_,
      attachmentRefs: attachments.refs,
      // Only the demo path asks for a scripted sample; a real message never gets one.
      ...(parsed.value.demo === true ? { demo: true } : {}),
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
    const session = await services.projectSessions.start({
      goal: initialPrompt(text, resolution.project.name, context),
      projectRoots: [resolution.project.path],
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

    const invocation = {
      conversationId,
      principalId: runtime.identity.ownerPrincipalId,
      instanceId,
      actionBindingId: typeof parsed.value.actionBindingId === "string" ? parsed.value.actionBindingId : "",
      expectedRevision:
        typeof parsed.value.expectedRevision === "number" ? parsed.value.expectedRevision : Number.NaN,
      expectedBindingDigest:
        typeof parsed.value.expectedBindingDigest === "string" ? parsed.value.expectedBindingDigest : "",
      input:
        typeof parsed.value.input === "object" && parsed.value.input !== null && !Array.isArray(parsed.value.input)
          ? (parsed.value.input as Record<string, unknown>)
          : {},
      invocationId: typeof parsed.value.invocationId === "string" ? parsed.value.invocationId : "",
    };

    if (invocation.actionBindingId === "" || invocation.invocationId === "") {
      return fail(400, "INVALID_SCHEMA", "an action invocation needs an actionBindingId and an invocationId");
    }
    if (!Number.isFinite(invocation.expectedRevision)) {
      return fail(400, "INVALID_SCHEMA", "an action invocation needs the expectedRevision the client saw");
    }

    const outcome = invokeMiniAppAction(services.conductor, {
      ...invocation,
      // Read at the invocation rather than captured, so a mode the user changed applies to the next action
      // they take instead of the next time the node starts.
      policy: readExecutionPolicy(
        { db: runtime.db, now: () => at() as Instant },
        runtime.identity.ownerPrincipalId,
      ),
    });
    if (!outcome.ok) {
      const status =
        outcome.code === "INSTANCE_UNKNOWN" || outcome.code === "ACTION_UNKNOWN"
          ? 404
          : outcome.code === "NOT_AUTHORIZED" || outcome.code === "POLICY_REFUSED"
            ? 403
            : outcome.code === "REVISION_MISMATCH"
              ? 409
              : outcome.code === "BINDING_STALE" || outcome.code === "INVOCATION_KEY_REUSED"
                ? 409
                : 400;
      return fail(status, outcome.code, outcome.message, {
        ...(outcome.currentRevision === undefined ? {} : { currentRevision: outcome.currentRevision }),
      });
    }

    return json(200, {
      duplicate: outcome.duplicate,
      instanceId: outcome.instanceId,
      revision: outcome.revision,
      stateRevision: outcome.stateRevision,
      state: outcome.state,
      pinId: outcome.pinId ?? null,
      // The whole page comes back after a mutation, so the client does not have to guess whether
      // its cursor is still valid.
      timeline: buildTimeline(services, { conversationId, afterSequence: 0 }),
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
  services: NodeServices,
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
  });
  if (!ran.ok) return { ok: false, code: ran.code, message: ran.message };

  appendHostReply(services, { conversationId: input.conversationId, blocks: ran.blocks, at: input.at });

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
  services: NodeServices,
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
function handleRawCommand(deps: GatewayDeps, request: GatewayRequest, at: () => string): GatewayResponse {
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
