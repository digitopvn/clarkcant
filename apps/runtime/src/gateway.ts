import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";


import { type PairingDeps } from "./peers.ts";

import {
  type Instant,
  type Principal,
  nowInstant,
  protocolRangeSchema,
} from "@clarkcant/contracts";
import {
  autonomySettingsFromPolicy,
  directoryIndexPath,
  verifyFrameGrant,
  readPackageFile,
  widgetDocument,
  widgetDocumentPolicy,
  readDirectoryIndex,
  cancelTask,
  listCapabilitySummaries,
  readExecutionPolicy,
} from "@clarkcant/core";
import {
  type CalendarEventRecord,
  getArtifact,
  getDatasetForPrincipal,
  getLocalImage,
  listCalendarEvents,
  listLocalImages,
  deleteCredential,
  putPreference,
} from "@clarkcant/storage";
import { credentialNames, putCredential, putSecretMetadata, secretKindOr, appendAuditEvent } from "@clarkcant/storage";
import {
  DEFAULT_NARROWING,
  readAutonomySettings,
  saveAutonomySettings,
} from "./autonomy-settings.ts";

import { cycleModelPool, readCurrentAlias, readModelPool, writeModelPool } from "./model-registry.ts";
import { parseModelPool, validateProfileAgainstCatalogue } from "@clarkcant/contracts";


import { nodeBackgroundSessions } from "./background-sessions.ts";
import { deleteMemory, listMemories, memoryCounts, type MemoryDeps } from "./memory.ts";

import { PI_BUILTIN_TOOLS, nodeToolCatalogue } from "./tool-catalogue.ts";


import {
  MAX_IMAGE_BYTES,
  createLocalEvent,
  importLocalImage,
  removeLocalEvent,
  removeLocalImage,
  updateLocalEvent,
} from "./mini-app-data.ts";
import { readBlob } from "./blobs.ts";


import {
  stopRunningCommands,
} from "./run-command.ts";


import {
  ingestSessionEntries,
  searchSessions,
} from "./session-search.ts";
import {
  type NodeServices,
} from "./services.ts";
import { availableCredentials } from "./readiness.ts";
import { handleAttachmentRoutes } from "./routes/attachments.ts";
import { type GatewayRequest, type GatewayResponse, bearer, fail, json, readJson, tokenMatches } from "./routes/http.ts";
import { handlePreviewRoutes } from "./routes/previews.ts";
import { handlePreferenceRoutes } from "./routes/preferences.ts";
import { handlePackageRoutes } from "./routes/packages.ts";
import { handleInteractionRoutes } from "./routes/interactions.ts";
import { appendHostReply, handleConversationRoutes, handleRawCommand, startBackgroundWork } from "./routes/conversations.ts";

/*
 * Re-exported from the module that now owns them, so the voice session keeps importing the same
 * symbols from the same place: the decision these make has to be identical in both callers, and a
 * second copy written beside the first is a second copy that can drift.
 */
export { answerQuestionForNode, decideApprovalForNode, interactionDepsFor } from "./routes/conversations.ts";
export {
  invokeWidgetAction,
  widgetActionTarget,
  type WidgetActionRequest,
  type WidgetActionResult,
} from "./application/widget-actions.ts";
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
    return await handleConversationRoutes({
      services,
      request,
      segments,
      at,
      // Passed through rather than dropped: a test that injects it is the reason the id is not a clock.
      ...(deps.newConversationId === undefined ? {} : { newConversationId: deps.newConversationId }),
    });
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
    return handleRawCommand({ services, request, at });
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
