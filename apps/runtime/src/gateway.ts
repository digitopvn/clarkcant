import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";


import { type PairingDeps } from "./peers.ts";

import {
  type AppIntent,
  type AppIntentResolution,
  type AttachmentRef,
  type Instant,
  type MessageBlock,
  type MessageRecord,
  type Principal,
  commandEnvelopeSchema,
  nowInstant,
  protocolRangeSchema,
  surfaceCompositionSpecSchema,
} from "@clarkcant/contracts";
import {
  autonomySettingsFromPolicy,
  claimLiveOwner,
  directoryIndexPath,
  findIsolatedFrame,
  mintFrameGrant,
  verifyFrameGrant,
  readPackageFile,
  widgetDocument,
  widgetDocumentPolicy,
  readDirectoryIndex,
  cancelTask,
  decideApproval,
  getActionBinding,
  getInstance,
  handleUserMessage,
  invokeMiniAppAction,
  listCapabilitySummaries,
  liveOwnerOf,
  liveStateOf,
  pinInstance,
  readExecutionPolicy,
  readSnapshotForDisplay,
  releaseLiveOwner,
  sweepExpiredLiveOwners,
  unpinInstance,
} from "@clarkcant/core";
import {
  type CalendarEventRecord,
  appendMessage,
  createConversation,
  findBundleForSnapshot,
  findCompositionByInstance,
  getArtifact,
  getConversation,
  getDatasetForPrincipal,
  getLocalImage,
  listCalendarEvents,
  listConversations,
  listLocalImages,
  nextMessageSequence,
  oneRow,
  deleteCredential,
  putPreference,
} from "@clarkcant/storage";
import { credentialNames, putCredential, putSecretMetadata, secretKindOr, appendAuditEvent } from "@clarkcant/storage";
import {
  DEFAULT_NARROWING,
  readAutonomySettings,
  saveAutonomySettings,
} from "./autonomy-settings.ts";
import { type OwnedResources, ownedResources } from "./preflight.ts";
import { cycleModelPool, readCurrentAlias, readModelPool, writeModelPool } from "./model-registry.ts";
import { parseModelPool, validateProfileAgainstCatalogue } from "@clarkcant/contracts";
import type { InteractionDeps } from "./interactions.ts";
import { answerQuestion, cancelQuestion } from "./interactions.ts";

import { nodeBackgroundSessions } from "./background-sessions.ts";
import { deleteMemory, listMemories, memoryCounts, type MemoryDeps } from "./memory.ts";
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
import { readBlob } from "./blobs.ts";
import { resolveAttachmentRefs } from "./attachments.ts";
import { markProjectUsed, projectContext, resolveProject } from "./project-finder.ts";
import { receiptForModel, runApprovedCommand, stopRunningCommands } from "./run-command.ts";
import { type AppIntentDeps, decideAppIntent, mintConfirmation } from "./app-intents.ts";
import { initialPrompt } from "./project-session.ts";
import { indexMessages, ingestSessionEntries, searchSessions, textOfMessage } from "./session-search.ts";
import { type NodeServices, buildTimeline } from "./services.ts";
import { availableCredentials } from "./readiness.ts";
import { handleAttachmentRoutes } from "./routes/attachments.ts";
import { type GatewayRequest, type GatewayResponse, bearer, fail, json, readJson, tokenMatches } from "./routes/http.ts";
import { handlePreviewRoutes } from "./routes/previews.ts";
import { handlePreferenceRoutes } from "./routes/preferences.ts";
import { handlePackageRoutes } from "./routes/packages.ts";
import { handleInteractionRoutes } from "./routes/interactions.ts";
import { handlePairingRoutes, handlePeerUplinkRoutes } from "./routes/peers.ts";

export type { GatewayRequest, GatewayResponse } from "./routes/http.ts";
/**
 * Re-exported so the voice socket keeps importing the one constant-time comparison from where it always
 * has: the check is the same decision, and a second copy of it is a second copy that can drift.
 */
export { tokenMatches } from "./routes/http.ts";

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

export interface GatewayDeps {
  services: NodeServices;
  /** Injected so tests can make time deterministic. */
  now?: () => string;
  /** Injected so conversation identifiers are deterministic in tests. */
  newConversationId?: () => string;
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

  /*
   * The node's own web build: the widget runtime bundle and the chunks it imports.
   *
   * The bundle re-exports from a shared chunk — the app and the runtime use the same SDK — and a frame that could load
   * one but not the other would fail at the import. Both come from here so the frame's scripts are same-origin.
   *
   * Unauthenticated on purpose, and it is the one route where that is honest: this is the app's own build output, the
   * same public code any browser fetches to load the app, and a sandboxed frame cannot present a token anyway. The path
   * is resolved and checked to be inside the build, so it is not a way to read anything else.
   */
  if (request.method === "GET" && (request.path === "/widget-runtime.js" || request.path.startsWith("/assets/"))) {
    const dist = process.env["CC_WEB_DIST"];
    if (dist === undefined || dist === "") {
      return fail(503, "NO_WEB_BUILD", "this node was not told where its web build is, so it cannot serve a widget runtime");
    }
    const relative = request.path === "/widget-runtime.js" ? "widget-runtime.js" : request.path.slice(1);
    const root = resolve(dist);
    const candidate = resolve(join(root, relative));
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      return fail(403, "FILE_OUTSIDE_PACKAGE", "that path is outside the node's web build");
    }
    try {
      const bytes = readFileSync(candidate);
      const type = request.path.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : request.path.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
      return { status: 200, body: null, binary: { bytes, contentType: type, headers: { "cache-control": "no-store" } } };
    } catch {
      return fail(404, "FILE_NOT_FOUND", "this node's web build has no such file");
    }
  }

  /*
   * One route accepts a scoped grant instead of the bearer token, and it is the only one.
   *
   * A widget's document is fetched by the browser as a navigation, and a navigation cannot carry an
   * `Authorization` header — so without this the frame would be served a 401 and nothing would ever render. The grant
   * is checked here, before the token, and it has to name the exact package the URL asks for: a grant that read
   * "some instance" could be replayed against any other package on the node.
   */
  /*
   * The frame grant travels as a **path segment**, not as a cookie and not as a query.
   *
   * A cookie is an ambient credential, and this one would have to be `SameSite=None` to be sent from a sandboxed
   * frame — whose opaque origin makes every request cross-site — which is a worse trade than it looks. A query would
   * only cover the document itself: a subresource URL is the author's, so `./main.js` arrives with nothing attached
   * and the widget's own module would be refused.
   *
   * A path segment covers both, because relative URLs inherit it: `/frame/<grant>/widgets/main/index.html` asks for
   * `/frame/<grant>/widgets/main/main.js` next, and the same grant authorizes it for exactly the package it names.
   */
  const grantSegment =
    request.method === "GET" && request.path.startsWith("/frame/") ? request.path.split("/")[2] : undefined;
  const grant =
    grantSegment === undefined || grantSegment === ""
      ? undefined
      : verifyFrameGrant({
          grant: grantSegment,
          secret: runtime.identity.localToken,
          nowMs: Date.parse(nowInstant()),
        });
  const grantCovers = grant?.ok === true;
  /*
   * A grant that was presented and did not verify is refused as itself, not as "no token".
   *
   * The difference is the whole reason the codes exist: "your grant expired" is something a person can act on, and
   * "unauthenticated" for a URL the node itself just minted reads like a bug in the node.
   */
  if (grantSegment !== undefined && grantSegment !== "" && grant !== undefined && !grant.ok) {
    return fail(403, grant.code, grant.message);
  }

  /*
   * The two routes another node calls, answered before the local token check.
   *
   * A peer does not hold this node's local token and must not: that token authorizes commands on this
   * machine. What a peer presents is a token derived from its own identity when the pairing was made,
   * and the peer that token identifies is the only value `authenticatedSenderNodeId` is ever allowed
   * to be - an envelope that names its own sender is exactly the mistake acceptance test T08 covers.
   */
  const pairing: PairingDeps = {
    db: runtime.db,
    identity: runtime.identity,
    now: () => at() as Instant,
    newId: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
  };

  const peerUplinkResponse = handlePeerUplinkRoutes({ pairing, runtime, request });
  if (peerUplinkResponse !== undefined) return peerUplinkResponse;

  if (!grantCovers && !tokenMatches(runtime.identity.localToken, bearer(request.headers))) {
    // Identical for a missing and a wrong token: distinguishing them would tell an
    // attacker which half to work on.
    return fail(401, "UNAUTHENTICATED", "a valid bearer token is required for every command");
  }

  const segments = request.path.split("/").filter((segment) => segment.length > 0);

  /*
   * Pairing, from the side a person drives.
   *
   * Each of these is a decision about this machine, which is why they sit after the token check and
   * none of them is reachable by a peer. The module owns the routes, this only hands them the pairing
   * seam it already built.
   */
  const pairingResponse = handlePairingRoutes({ pairing, runtime, now: at, request, segments });
  if (pairingResponse !== undefined) return pairingResponse;

  if (request.method === "GET" && request.path === "/node") {
    return json(200, {
      nodeId: runtime.identity.nodeId,
      label: runtime.identity.label,
      createdAt: runtime.identity.createdAt,
      // The device key's fingerprint is what a peer compares when pairing, so it is reported here
      // rather than only inside the pairing flow: a person asked "is this the right machine?" needs
      // to be able to read it out from the node they are standing at.
      fingerprint: runtime.identity.fingerprint,
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
    /*
     * When the choice takes effect, told rather than implied.
     *
     * A running turn reads the stored choice each time it creates a session, so a pick lands on the next
     * conversation. A node with no turn has nothing to read it yet: it starts with this model the next time the node
     * starts, and answering "the next conversation" there would describe a change that is not going to happen. The
     * client turns either code into the sentence beside the field.
     */
    return json(200, {
      ok: true,
      stored: { provider, id },
      applies: services.turnControl === undefined ? "next-start" : "next-session",
    });
  }

  /*
   * The autonomy settings, as the panel that predates the canonical policy reads and writes them.
   *
   * Both directions go through the one policy: the read projects it into the five legacy fields, and the write
   * translates those fields back into it — keeping the rules the legacy shape has no way to name, because a
   * write through a shape that cannot express a refusal must not delete one. Nothing here is a second copy of
   * the policy, and the narrowing table travels with the read because the panel shows what the guardrail is
   * allowed to ask for — a list the host owns and a model may only pick from.
   */
  if (request.method === "GET" && request.path === "/autonomy") {
    return json(200, {
      settings: readAutonomySettings(
        { db: services.runtime.db, now: () => nowInstant() },
        services.runtime.identity.ownerPrincipalId,
      ),
      policy: readExecutionPolicy(
        { db: services.runtime.db, now: () => nowInstant() },
        services.runtime.identity.ownerPrincipalId,
      ),
      narrowing: DEFAULT_NARROWING.map((entry) => ({ id: entry.id, description: entry.description })),
    });
  }

  if (request.method === "POST" && request.path === "/autonomy") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const saved = saveAutonomySettings(
      { db: services.runtime.db, now: () => nowInstant() },
      services.runtime.identity.ownerPrincipalId,
      parsed.value.settings ?? parsed.value,
    );
    /*
     * A refused write is answered as a refusal. The panel renders the answer as the state of the node, so
     * reporting `ok: true` with a policy the registry would not store would describe a change that did not
     * happen — and the fields it names are the ones the user has to fix.
     */
    if (!saved.ok) return fail(400, saved.code, saved.message);
    // The scope is stated rather than implied: this node reads the policy per command, so the next command
    // already runs under it, and a panel that said "restart to apply" would be lying about that.
    return json(200, {
      ok: true,
      settings: autonomySettingsFromPolicy(saved.stored),
      policy: saved.stored,
      applies: "the next command this node runs",
    });
  }

  /*
   * The emergency stop.
   *
   * It kills rather than asks, because the point of a stop is that it works on something that is not listening. The
   * order is the order of reach: a child process is the one thing that outlives this node's turn, then the turns
   * themselves, then the background workers nobody is awaiting.
   */
  if (request.method === "POST" && request.path === "/stop") {
    const commands = stopRunningCommands();
    const control = services.turnControl;
    let turns = 0;
    let background = 0;
    if (control !== undefined) {
      for (const runningIn of control.running()) {
        if (control.interrupt(runningIn)) turns += 1;
      }
      // SAFETY: the stop is optional on the control object because a node can be built without background workers at
      // all; reading it through a narrow shape keeps every other caller of `control` typed as it was.
      const stopBackground = (control as { stopBackgroundSessions?: () => Promise<number> }).stopBackgroundSessions;
      background = stopBackground === undefined ? 0 : await stopBackground.call(control);
    }

    const stopped = commands + turns + background;
    if (stopped > 0) {
      // Written down whether or not anybody was watching: a stop is the event most likely to need explaining later.
      appendAuditEvent(services.runtime.db, {
        auditId: services.conductor.newId("audit"),
        principalId: services.runtime.identity.ownerPrincipalId,
        nodeId: services.runtime.identity.nodeId,
        kind: "stop",
        summary: `dừng khẩn cấp: ${commands} lệnh, ${turns} lượt, ${background} việc nền`,
        outcome: "stopped",
        at: nowInstant(),
      });
    }
    return json(200, { ok: true, stopped: { commands, turns, background } });
  }

  if (segments.length === 1 && segments[0] === "capabilities" && request.method === "GET") {
    return json(200, {
      // Summaries only: dumping every tool schema into every turn is both expensive and a
      // prompt-injection surface, so a schema is loaded once a capability is chosen.
      capabilities: listCapabilitySummaries({ db: runtime.db, nodeId: runtime.identity.nodeId }),
    });
  }

  /*
   * The pool of models a person keeps.
   *
   * Read and written whole, like the autonomy settings, and checked against pi's own catalogue on the way in: a
   * stored profile this installation cannot run would fail every later turn with a message about a provider rather
   * than about the choice that caused it. The catalogue is not copied into the pool — it is consulted.
   */
  if (request.method === "GET" && request.path === "/model-pool") {
    const catalogue = await (services.modelCatalogue?.() ?? Promise.resolve([]));
    const owner = services.runtime.identity.ownerPrincipalId;
    const pool = readModelPool(services.runtime.db, owner);
    return json(200, {
      pool,
      currentAlias: readCurrentAlias(services.runtime.db, owner),
      // Which profiles this node can actually run, so a panel can say so instead of leaving a row looking usable.
      checked: pool.profiles.map((profile) => ({
        alias: profile.alias,
        ...validateProfileAgainstCatalogue(profile, catalogue),
      })),
    });
  }

  if (request.method === "POST" && request.path === "/model-pool") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const catalogue = await (services.modelCatalogue?.() ?? Promise.resolve([]));
    const pool = parseModelPool(parsed.value.pool ?? parsed.value);
    // Refused before it is stored: a profile this node cannot run is a promise it cannot keep, and the refusal names
    // which of the two identifiers was wrong.
    if (catalogue.length > 0) {
      for (const profile of pool.profiles) {
        const check = validateProfileAgainstCatalogue(profile, catalogue);
        if (!check.ok) return fail(400, "INVALID_SCHEMA", check.message);
      }
    }
    const stored = writeModelPool(services.runtime.db, services.runtime.identity.ownerPrincipalId, pool, nowInstant());
    return json(200, { ok: true, pool: stored });
  }

  /*
   * The hotkey: one press moves to the next enabled profile and writes what the next generation will run.
   *
   * What it deliberately does not do is touch the session underneath a running turn. Pi resolves a model when a
   * session is created, so the change is applied as a new generation at the next turn boundary — which is what the
   * answer says, rather than implying the running turn changed models mid-sentence.
   */
  if (request.method === "POST" && request.path === "/model-pool/cycle") {
    const cycled = cycleModelPool(services.runtime.db, services.runtime.identity.ownerPrincipalId, nowInstant());
    if (cycled.next === undefined) {
      return fail(409, "NO_MODEL_PROFILE", "pool này không có profile nào đang bật, nên không có gì để chuyển tới.");
    }
    return json(200, {
      ok: true,
      ...(cycled.current === undefined ? {} : { previous: cycled.current }),
      alias: cycled.next.alias,
      provider: cycled.next.provider,
      modelId: cycled.next.modelId,
      applies: "a new generation; the running turn is not touched",
    });
  }
  /*
   * What the configured voice provider can do.
   *
   * Reported rather than assumed by the surface: a picker hard-coded with one provider's voice names would
   * offer them to a provider that has never heard of them, and the failure would arrive as a session that
   * connects and then says nothing. A node with no voice gateway answers with a provider that supports
   * nothing, which is a real answer — the tab then shows a reason instead of a control.
   */
  if (segments.length === 2 && segments[0] === "voice" && segments[1] === "capabilities" && request.method === "GET") {
    const capabilities = services.voiceCapabilities?.();
    return json(200, {
      capabilities: capabilities ?? {
        provider: "none",
        supportsVoiceSelection: false,
        voices: [],
        supportsPreview: false,
        note: "Node này chưa bật voice.",
      },
    });
  }

  const preferenceResponse = handlePreferenceRoutes({ services, request, segments, at });
  if (preferenceResponse !== undefined) return preferenceResponse;

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
    return handleAttachmentRoutes({ services, request, segments, at });
  }

  if (segments[0] === "previews") {
    return handlePreviewRoutes({ services, request, segments });
  }

  if (segments[0] === "search") {
    return await handleSearchRoutes(deps, request, segments);
  }

  if (segments[0] === "memory") {
    const answered = handleMemoryRoutes(deps, request, segments);
    if (answered !== undefined) return answered;
  }

  const interactionResponse = await handleInteractionRoutes({ services, request, segments, at });
  if (interactionResponse !== undefined) return interactionResponse;

  if (segments[0] === "voice-fixture") {
    return handleVoiceFixtureRoute(services, request, segments);
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
    for (const field of fields as { name?: unknown; value?: unknown; kind?: unknown; description?: unknown; consumer?: unknown }[]) {
      const name = typeof field.name === "string" ? field.name.trim() : "";
      const value = typeof field.value === "string" ? field.value : "";
      if (name === "" || value === "") {
        return fail(400, "INVALID_SCHEMA", "every credential field needs a name and a value");
      }
      putCredential(services.runtime.db, { principalId: owner, name, value, at });
      /*
       * The value goes to the store; what the node remembers about it goes to the metadata row.
       *
       * Written together, because the two halves are useless apart: a value nobody can describe is a secret the
       * agent can never be told about, and a description with no value behind it is a promise this node cannot
       * keep — which is the state `request_secret` reports as not available rather than as ready.
       *
       * The consumer is recorded as the form said it. It is what the broker checks before handing the value to
       * anything, so it is the honest answer to "what will this be used for" rather than a label.
       */
      putSecretMetadata(services.runtime.db, {
        secretId: services.conductor.newId("secret"),
        principalId: owner,
        name,
        description: typeof field.description === "string" ? field.description.slice(0, 1_000) : "",
        kind: secretKindOr(field.kind),
        backend: "node-store",
        backendRef: name,
        allowedConsumers: typeof field.consumer === "string" && field.consumer.trim() !== "" ? [field.consumer.trim()] : [],
        injectionPolicy: "tool-only",
        nodeId: services.runtime.identity.nodeId,
        at,
      });
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

  /*
   * Ask a task to stop, and record the answer in the conversation.
   *
   * A stop that only lived in the response to this call would leave the transcript showing a task still going,
   * so the node writes what it did. `confirmed` is the part a caller must not round up: with an executor still
   * running the task holds `cancel_requested` until that executor says what happened.
   */
  if (segments.length === 3 && segments[0] === "tasks" && segments[2] === "cancel" && request.method === "POST") {
    const taskId = decodeURIComponent(segments[1] ?? "");
    const outcome = cancelTask(
      { db: runtime.db, nodeId: runtime.identity.nodeId, now: nowInstant, newId: services.conductor.newId },
      taskId,
    );
    if (!outcome.ok) return fail(409, outcome.code, outcome.message, { taskId });
    appendHostReply(services, {
      conversationId: outcome.task.conversationId,
      at: nowInstant(),
      text: outcome.confirmed
        ? `Đã dừng task ${taskId}. Không có việc nào đang chạy nên không còn gì đang chờ.`
        : `Đã ghi nhận yêu cầu dừng task ${taskId}. Việc đang chạy vẫn có thể đang hoàn tất, nên task chưa được coi là đã dừng cho tới khi nơi chạy xác nhận.`,
    });
    return json(200, { taskId: outcome.task.taskId, state: outcome.task.state, confirmed: outcome.confirmed });
  }

  /*
   * Open an artifact.
   *
   * Expiry is reported rather than folded into "not found": an artifact that reads as missing tells the user
   * their file never existed, when the truth is that the node had it and a retention window passed. That
   * difference decides whether they ask for it again or go looking for a fault.
   *
   * The reply describes the artifact and never says where its bytes live — the node's data directory is not
   * something a client needs in order to show a file, and handing it over would only describe somebody's disk.
   */
  if (segments.length === 2 && segments[0] === "artifacts" && request.method === "GET") {
    const artifactId = decodeURIComponent(segments[1] ?? "");
    const artifact = getArtifact(runtime.db, artifactId);
    if (artifact === undefined) {
      return fail(404, "ARTIFACT_NOT_FOUND", "Không có artifact nào với id này trên node.", { artifactId });
    }
    return json(200, {
      artifact: {
        artifactId: artifact.artifactId,
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes,
        mimeType: artifact.mimeType,
        originNodeId: artifact.originNodeId,
        createdAt: artifact.createdAt,
        expiresAt: artifact.expiresAt ?? null,
        // ISO instants compare correctly as strings, and both sides are UTC.
        expired: artifact.expiresAt !== undefined && artifact.expiresAt <= at(),
      },
    });
  }

  /*
   * Who is driving a controlled surface — a browser session or a desktop session.
   *
   * Takeover hands the wheel to the user by bumping the lease epoch, which invalidates the action the agent had
   * already planned rather than reaching into a process this node does not control. Stop ends the session and
   * bumps the epoch for the same reason: an action already in flight must not land on a session that has ended.
   *
   * A session that is missing or already stopped is refused rather than quietly reported as done, because a
   * takeover that silently did nothing leaves the user believing they have the wheel.
   */
  if (
    segments.length === 3 &&
    segments[0] === "control-sessions" &&
    (segments[2] === "takeover" || segments[2] === "stop") &&
    request.method === "POST"
  ) {
    const sessionId = decodeURIComponent(segments[1] ?? "");
    const at = nowInstant();
    const session =
      segments[2] === "takeover"
        ? services.controlSessions.takeover(sessionId, at)
        : services.controlSessions.stop(sessionId, at);
    if (session === undefined) {
      return fail(409, "CONTROL_SESSION_UNAVAILABLE", "Không đổi được phiên này vì phiên không tồn tại hoặc đã dừng.", {
        sessionId,
      });
    }
    return json(200, { session });
  }

  const packageResponse = handlePackageRoutes({ services, request, segments });
  if (packageResponse !== undefined) return packageResponse;


  /*
   * A package's files, reached through a frame grant.
   *
   * The same files as the route below and the same injection, reached by a path that carries the grant: everything the
   * document then loads inherits it, and the grant names the one package it may read, so this is not a way to browse
   * what is installed.
   */
  if (grantCovers && segments.length >= 3 && segments[0] === "frame" && request.method === "GET") {
    const index = readDirectoryIndex(directoryIndexPath(process.env));
    if (index.kind !== "configured") {
      return fail(409, index.kind === "not-configured" ? "NO_DIRECTORY" : "DIRECTORY_UNREADABLE", index.reason);
    }
    const entry = index.entries.find(
      (candidate) => candidate.packageId === grant.packageId && candidate.version === grant.version,
    );
    if (entry === undefined) {
      return fail(404, "NOT_IN_DIRECTORY", "the package this grant names is no longer in the directory");
    }
    const file = readPackageFile({ entry, relativePath: segments.slice(2).join("/") });
    if (!file.ok) {
      return fail(
        file.code === "FILE_NOT_FOUND" ? 404 : file.code === "FILE_OUTSIDE_PACKAGE" ? 403 : 409,
        file.code,
        file.message,
      );
    }
    if (file.contentType.startsWith("text/html")) {
      const nonce = randomUUID().replaceAll("-", "");
      const appOrigin = process.env["CC_APP_ORIGIN"] ?? `http://${request.headers["host"] ?? "127.0.0.1"}`;
      const document = widgetDocument({ html: file.bytes.toString("utf8"), appOrigin, nonce });
      return {
        status: 200,
        body: null,
        binary: {
          bytes: Buffer.from(document, "utf8"),
          contentType: file.contentType,
          headers: { "content-security-policy": widgetDocumentPolicy({ appOrigin, nonce }) },
        },
      };
    }
    return { status: 200, body: null, binary: { bytes: file.bytes, contentType: file.contentType } };
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
 * The interaction manager for one conversation.
 *
 * Built per conversation rather than once per node, because every question belongs to a conversation: the
 * durable state is that conversation's transcript, and an answer only means something against the card that
 * asked. The two halves are the ones the approval route already uses — read the blocks, append a message — so
 * a question and an approval cannot end up disagreeing about what the timeline is.
 */
export function interactionDepsFor(services: NodeServices, conversationId: string): InteractionDeps {
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
  services: NodeServices,
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
export function ownedResourcesFor(services: NodeServices): OwnedResources {
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
 * Decide what a typed message means to the application.
 *
 * Shared by both message routes. The composer uses the streaming one, and the plain route was wired first - which
 * meant a typed "mở settings" reached the model instead of the registry until this was found. One function is what
 * keeps the next route from being the one that forgot to record the audit event.
 */
function typedAppIntent(
  services: NodeServices,
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

/**
 * The revision and binding digest a spoken action is checked against, read from the node's own state.
 *
 * A click brings a cursor: the revision it saw, and the digest of the binding it was shown. A spoken sentence brings
 * nothing at all, so there is nothing to trust and nothing to be stale relative to - the node reads what it holds.
 * That is also why this refuses an action the instance no longer announces: the sentence was matched against a view
 * the page sent, and the page's view may be older than the instance.
 */
export function widgetActionTarget(
  services: NodeServices,
  instanceId: string,
  actionBindingId: string,
): { revision: number; bindingDigest: string } | undefined {
  const instance = getInstance(services.conductor, instanceId);
  if (instance === undefined) return undefined;
  if (!instance.actionBindingIds.includes(actionBindingId)) return undefined;
  const binding = getActionBinding(services.conductor, actionBindingId);
  if (binding === undefined) return undefined;
  return { revision: instance.revision, bindingDigest: binding.bindingDigest };
}

/** One widget action invocation, as either a click or a spoken command asks for it. */
export interface WidgetActionRequest {
  conversationId: string;
  principalId: string;
  instanceId: string;
  actionBindingId: string;
  expectedRevision: number;
  expectedBindingDigest: string;
  input: Record<string, unknown>;
  invocationId: string;
}

export type WidgetActionResult =
  | { ok: true; status: 200; body: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string; currentRevision?: number };

/**
 * Invoke a widget action.
 *
 * The single path a click and a spoken command both take. Everything that decides whether an action may run lives
 * here - the owner check, the revision the client saw, the binding digest, and one effect per invocation id - so a
 * second path would not be a second interface to the same gate, it would be a way around one of them.
 *
 * Extracted from the route so the voice path has somewhere to call rather than something to copy. The route keeps the
 * request-shaped validation and this keeps the authorization, which is the split that matters: what the HTTP body
 * looks like is the transport's business, and whether an action may run is not.
 */
export function invokeWidgetAction(services: NodeServices, request: WidgetActionRequest): WidgetActionResult {
  // The guard main added at the route, kept where the invocation actually happens so both callers get it.
  if (!Number.isFinite(request.expectedRevision)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_SCHEMA",
      message: "an action invocation needs the expectedRevision the client saw",
    };
  }

  // Read at the invocation rather than captured, so a mode the user changed applies to the next action they take
  // instead of the next time the node starts.
  const policy = readExecutionPolicy(
    { db: services.runtime.db, now: () => new Date().toISOString() as Instant },
    services.runtime.identity.ownerPrincipalId,
  );
  const outcome = invokeMiniAppAction(services.conductor, { ...request, policy });
  if (!outcome.ok) {
    const status =
      outcome.code === "INSTANCE_UNKNOWN" || outcome.code === "ACTION_UNKNOWN"
        ? 404
        : outcome.code === "NOT_AUTHORIZED"
          ? 403
          : outcome.code === "REVISION_MISMATCH" || outcome.code === "BINDING_STALE" || outcome.code === "INVOCATION_KEY_REUSED"
            ? 409
            : 400;
    return {
      ok: false,
      status,
      code: outcome.code,
      message: outcome.message,
      ...(outcome.currentRevision === undefined ? {} : { currentRevision: outcome.currentRevision }),
    };
  }

  return {
    ok: true,
    status: 200,
    body: {
      duplicate: outcome.duplicate,
      instanceId: outcome.instanceId,
      revision: outcome.revision,
      stateRevision: outcome.stateRevision,
      state: outcome.state,
      pinId: outcome.pinId ?? null,
      // The whole page comes back after a mutation, so the client does not have to guess whether
      // its cursor is still valid.
      timeline: buildTimeline(services, { conversationId: request.conversationId, afterSequence: 0 }),
    },
  };
}

/**
 * The voice fixture's script.
 *
 * Unreachable on a real node: with no scripted provider loaded there is no seam and this answers 404, so there is no way
 * to tell a production provider what to say. It exists because the fixture is otherwise one fixed sentence, and a
 * browser journey that cannot say a command cannot test what the node does with one - which is exactly the evidence
 * phase 5 was missing.
 */
function handleVoiceFixtureRoute(
  services: NodeServices,
  request: GatewayRequest,
  segments: readonly string[],
): GatewayResponse {
  const fixture = services.voiceFixture;
  if (fixture === undefined) return fail(404, "NOT_FOUND", "no voice fixture is loaded on this node");
  if (segments.length !== 2 || segments[1] !== "words" || request.method !== "POST") {
    return fail(404, "NOT_FOUND", "no such voice-fixture route");
  }
  const parsed = readJson(request);
  if (!parsed.ok) return parsed.response;
  const words = parsed.value.words;
  if (typeof words !== "string" || words.trim() === "") {
    return fail(400, "INVALID_SCHEMA", "words must be a non-empty string");
  }
  fixture.setWords(words.trim());
  return json(200, { ok: true, words: words.trim() });
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
  });
  if (isolated.ok) {
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
        requestedCapabilities: isolated.requestedCapabilities,
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

/**
 * What this node remembers, and removing one thing from it.
 *
 * Reading answers with the records and a count per kind, because a screen that shows a list also wants to say how
 * much there is. Deleting removes the row for real, and a delete that matched nothing is a 404 rather than a quiet
 * success: the caller asked to remove something and it is still there, so "it worked" would be a lie the person
 * cannot see through.
 *
 * The principal comes from the token on both paths, which is what makes somebody else's memory unreachable rather
 * than merely unaddressed.
 */
function handleMemoryRoutes(
  deps: GatewayDeps,
  request: GatewayRequest,
  segments: readonly string[],
): GatewayResponse | undefined {
  if (segments[0] !== "memory" || segments.length > 2) return undefined;
  const { services } = deps;
  const { runtime } = services;
  const principalId = runtime.identity.ownerPrincipalId;
  const memoryDeps: MemoryDeps = {
    db: runtime.db,
    now: () => new Date().toISOString(),
    newId: services.conductor.newId,
  };

  if (segments.length === 1) {
    if (request.method !== "GET") return fail(405, "METHOD_NOT_ALLOWED", "memory is read here, not written");
    return {
      status: 200,
      body: { items: listMemories(memoryDeps, principalId), counts: memoryCounts(memoryDeps, principalId) },
    };
  }

  if (request.method !== "DELETE") return fail(405, "METHOD_NOT_ALLOWED", "a remembered thing is deleted here");
  const memoryId = segments[1] ?? "";
  if (!deleteMemory(memoryDeps, principalId, memoryId)) {
    return fail(404, "NOT_FOUND", "this node has no such remembered thing for this principal");
  }
  return { status: 200, body: { removed: true } };
}
