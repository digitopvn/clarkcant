/**
 * The detached widget window.
 *
 * Phase 7 §Detach: "Detached window receives only widget host bootstrap + instance ref, not full privileged
 * conversation context." That sentence is made true here **by construction rather than by redaction**: the
 * bootstrap names every field it may carry, so there is no path by which a token, a gateway URL or a conversation
 * id can travel with it. A window holding the local token could read the whole conversation, and the fix for that
 * is not to filter a rich payload but to have no rich payload to filter.
 *
 * Ownership is the other half, and it belongs to the host: the main process performs the handoff, so the detached
 * renderer never holds a credential and never claims anything for itself. One instance, one live owner — whichever
 * window is showing it.
 */

import { z } from "zod";

import appearanceSchema from "./appearance-schema.json" with { type: "json" };
import semanticProposalSchema from "./semantic-proposal-schema.json" with { type: "json" };
import performReportSchema from "./widget-perform-report-schema.json" with { type: "json" };
import performRequestSchema from "./widget-perform-request-schema.json" with { type: "json" };
import { DETACHED_WINDOW_CHANNELS, createWindowOptions } from "./security.mjs";

const appearanceContract = z.fromJSONSchema(appearanceSchema);

/** Same canonical schema as the client/iframe; no raw theme or privileged fields cross the relay. */
export function reviewDetachedAppearance(payload) {
  try {
    if (JSON.stringify(payload).length > 32_768) return { ok: false, reason: "appearance exceeds the relay limit" };
    const checked = appearanceContract.safeParse(payload);
    return checked.success ? { ok: true, appearance: checked.data } : { ok: false, reason: "appearance does not match the public contract" };
  } catch {
    return { ok: false, reason: "appearance must be bounded JSON" };
  }
}

/**
 * The channels a detached window may use.
 *
 * Two belong to the window that owns the conversation and two to the detached window itself, and they are
 * separate on purpose: detaching is an act of the conversation, while `detached:bootstrap` is a question only a
 * window that was already detached has any business asking.
 */
export const DETACHED_CHANNELS = Object.freeze([
  "desktop:detachWidget",
  "desktop:attachWidget",
  ...DETACHED_WINDOW_CHANNELS,
]);

/**
 * The exact fields a detached window may receive. Nothing else, and that is the whole security property.
 *
 * `live` is the widget host bootstrap: the composition the host already fetched for this instance. It is the
 * instance's own data, and the reason it can travel is that it carries no credential — having it lets the window
 * *draw* the widget, and drawing is all a window without a token can do.
 */
const BOOTSTRAP_FIELDS = Object.freeze(["instanceRef", "title", "widgetKind", "live", "appearance"]);

/**
 * Fields that would make a detached window privileged if they ever appeared.
 *
 * Named so a test asserts their absence by name rather than trusting that nobody added one: "the detached window
 * has no token" is a claim worth checking, and only a checked claim survives the next change.
 */
export const PRIVILEGED_FIELDS = Object.freeze([
  "token",
  "localToken",
  "gateway",
  "gatewayUrl",
  "conversationId",
  "principalId",
  "dataDir",
  "identityFile",
]);

/**
 * The bootstrap for one detached instance.
 *
 * Every field is named here, so a caller cannot widen it by passing something through: an input carrying a token
 * produces a bootstrap carrying no token, because the token is not one of the three things this reads.
 */
export function detachedBootstrap(input) {
  const record = input ?? {};
  return {
    instanceRef: String(record.instanceRef ?? ""),
    title: String(record.title ?? ""),
    widgetKind: String(record.widgetKind ?? "widget"),
    live: record.live,
    ...(record.appearance === undefined ? {} : { appearance: record.appearance }),
  };
}

/**
 * Decide whether a payload may be handed to a detached window.
 *
 * Refuses rather than strips. A payload that arrived with a token is a sign that something upstream meant to send
 * one, and quietly removing it would leave that intention in place for the next change to complete.
 *
 * @returns {{ ok: true, bootstrap: object } | { ok: false, reason: string }}
 */
export function reviewDetachedBootstrap(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "the bootstrap must be an object" };
  }
  const keys = Object.keys(payload);
  const privileged = keys.filter((key) => PRIVILEGED_FIELDS.includes(key));
  if (privileged.length > 0) {
    return { ok: false, reason: `the bootstrap carries privileged fields: ${privileged.join(", ")}` };
  }
  const unknown = keys.filter((key) => !BOOTSTRAP_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, reason: `the bootstrap carries fields a detached window does not receive: ${unknown.join(", ")}` };
  }
  const appearance = payload.appearance === undefined ? undefined : reviewDetachedAppearance(payload.appearance);
  if (appearance !== undefined && !appearance.ok) return appearance;
  if (payload.live === undefined || payload.live === null || typeof payload.live !== "object") {
    // A window with no composition has nothing to draw, and an empty frame reads as a widget that failed to load
    // rather than as a detach that could not be prepared.
    return { ok: false, reason: "a detached window needs the widget host bootstrap it is a view of" };
  }
  if (payload.live.kind === "isolated-frame" && (payload.live.frame === null || typeof payload.live.frame !== "object")) {
    /*
     * A widget in its own frame runs here through the host's relays, but only while it has a frame: `frame: null` is a
     * widget whose package is gone, and what is left of it is its text, which the conversation already shows. Refused
     * here as well as unoffered in the conversation, so no caller can open a window with nothing to run.
     */
    return { ok: false, reason: "a widget with no frame (frame: null, its package is gone) stays in the conversation" };
  }
  if (typeof payload.instanceRef !== "string" || payload.instanceRef === "") {
    // A detached window with no instance reference has nothing to show, and an empty frame would read as a widget
    // that failed to load rather than as a request that made no sense.
    return { ok: false, reason: "a detached window needs the instance reference it is a view of" };
  }
  return { ok: true, bootstrap: { ...payload, ...(appearance === undefined ? {} : { appearance: appearance.appearance }) } };
}

/**
 * What a detached window may ask the host to do.
 *
 * The window holds no token, so it cannot invoke an action itself — and it must not, because the credential that
 * would let it is the credential that reads the whole conversation. So an intent travels to the host, which
 * performs it with its own credentials and answers. This is what keeps "receives only the bootstrap" true while
 * the same owner lease moves to the detached window: the window decides *what*, the host is what *can*.
 *
 * The fields are named, so the payload cannot carry an owner token, a conversation id or a gateway URL: those are
 * the host's, and a relay that accepted them would be a window invoking anything.
 */
const INTENT_FIELDS = Object.freeze(["instanceRef", "actionBindingId", "expectedRevision", "input", "invocationId"]);

/**
 * The limits the host holds every relay to: a bucket per verb, a ceiling on how many calls wait at once, and a size per
 * payload. A copy of `DETACHED_RELAY_LIMITS` in `@clarkcant/widget-host`, which this file cannot import because Electron
 * loads no TypeScript; `detached-window.spec.ts` holds the two equal.
 *
 * Every verb is bounded in time as well (`timeoutMs`): a node that accepts calls and never answers would otherwise hold
 * the in-flight slots until the window closed, and every relay would be refused as busy meanwhile. A press waits longer
 * than the longest deadline the node sets on a service call or a workflow (a workflow's 300 s, `action-limits.ts` in the
 * runtime), so such a press the node is still running is not given up on; `action-limits.spec.ts` there holds the two
 * apart. An agent button's model turn has no such deadline and can outlast it. A press that times out was sent and may
 * take effect, so the window reports it as uncertain, never refused.
 */
export const RELAY_LIMITS = Object.freeze({
  inFlight: 8,
  "frame.read": Object.freeze({ burst: 10, refillPerSecond: 1, timeoutMs: 30_000 }),
  "state.save": Object.freeze({ maxBytes: 256 * 1024, burst: 20, refillPerSecond: 5, timeoutMs: 30_000 }),
  "semantic.publish": Object.freeze({ maxBytes: 16 * 1024, burst: 10, refillPerSecond: 4, timeoutMs: 10_000 }),
  intent: Object.freeze({ maxBytes: 64 * 1024, burst: 10, refillPerSecond: 2, inFlight: 4, timeoutMs: 330_000 }),
  "dev.session": Object.freeze({ burst: 5, refillPerSecond: 1, timeoutMs: 30_000 }),
  artifacts: Object.freeze({ burst: 300, refillPerSecond: 10, timeoutMs: 30_000 }),
  // No time limit of its own: a verb's node calls take its first bucket's (`artifacts`), so one here would never apply.
  "artifacts.dialog": Object.freeze({ burst: 5, refillPerSecond: 0.1, inFlight: 1 }),
  jobs: Object.freeze({ burst: 60, refillPerSecond: 5, timeoutMs: 30_000 }),
  tokens: Object.freeze({ burst: 10, refillPerSecond: 0.2, inFlight: 2, timeoutMs: 30_000 }),
});

/**
 * Which buckets each relayed verb spends from, when it is not the verb's own.
 *
 * The file, job and token verbs share a bucket per capability, as the frame session's do (`FRAME_BROKER_LIMITS` in
 * `@clarkcant/widget-host`). A pick and an export open an OS dialog the person answers, so they spend from the dialog
 * bucket as well: one dialog at a time, and a few in a row before the window has to wait. The first bucket named is
 * the one whose time limit the verb's node calls get.
 */
export const RELAY_BUCKETS = Object.freeze({
  "artifacts.pick": Object.freeze(["artifacts", "artifacts.dialog"]),
  "artifacts.describe": Object.freeze(["artifacts"]),
  "artifacts.create": Object.freeze(["artifacts"]),
  "artifacts.read": Object.freeze(["artifacts"]),
  "artifacts.write": Object.freeze(["artifacts"]),
  "artifacts.finalize": Object.freeze(["artifacts"]),
  "artifacts.export": Object.freeze(["artifacts", "artifacts.dialog"]),
  "artifacts.attach": Object.freeze(["artifacts"]),
  "artifacts.discard": Object.freeze(["artifacts"]),
  "jobs.get": Object.freeze(["jobs"]),
  "jobs.list": Object.freeze(["jobs"]),
  "jobs.cancel": Object.freeze(["jobs"]),
  "tokens.request": Object.freeze(["tokens"]),
  "tokens.end": Object.freeze(["tokens"]),
});

/** The buckets a verb spends from: those `RELAY_BUCKETS` names, or the verb's own. */
export function relayBucketsFor(verb) {
  return RELAY_BUCKETS[verb] ?? [verb];
}

/**
 * The header a relayed press carries, the same one the conversation's own presses do (`COMPOSER_SURFACE_HEADER` in
 * `@clarkcant/contracts`): the person pressed it, so the node records them as who asked. Writes the widget makes on its
 * own — state, what it shows — carry none.
 */
export const COMPOSER_SURFACE_HEADER = "x-clarkcant-surface";

/** The bound on an id a frame names: the widget SDK's own (`actionBindingId`, `invocationId`). */
const MAX_ID_LENGTH = 128;

/** The JSON length of a payload, or undefined when it is not JSON at all. */
function jsonBytes(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : Buffer.byteLength(text, "utf8");
  } catch {
    return undefined;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The checks every relay payload goes through first: an object (or nothing, for a verb that takes nothing), no
 * privileged field, and no field the verb does not take. Refused rather than stripped, as the bootstrap is.
 *
 * @returns {{ ok: true, payload: Record<string, unknown> } | { ok: false, reason: string }}
 */
function reviewRelayFields(raw, fields, what) {
  if (raw === undefined && fields.length === 0) return { ok: true, payload: {} };
  if (!isPlainObject(raw)) return { ok: false, reason: `${what} must be an object` };
  const keys = Object.keys(raw);
  const privileged = keys.filter((key) => PRIVILEGED_FIELDS.includes(key) || key === "instanceId");
  if (privileged.length > 0) {
    // A relayed call carrying a credential or an id is an attempt to act as the host, or somewhere else, not to ask.
    return { ok: false, reason: `${what} may not carry privileged fields: ${privileged.join(", ")}` };
  }
  const unknown = keys.filter((key) => !fields.includes(key));
  if (unknown.length > 0) {
    return { ok: false, reason: `${what} carries fields the host does not accept: ${unknown.join(", ")}` };
  }
  return { ok: true, payload: raw };
}

const isId = (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
const isRevision = (value) => Number.isSafeInteger(value) && value >= 0;

/** @returns {{ ok: true, intent: object } | { ok: false, reason: string }} */
export function reviewDetachedIntent(payload) {
  const fields = reviewRelayFields(payload, INTENT_FIELDS, "an intent");
  if (!fields.ok) return fields;
  if (typeof payload.instanceRef !== "string" || payload.instanceRef === "") {
    return { ok: false, reason: "an intent has to name the instance it acts on" };
  }
  if (!isId(payload.actionBindingId)) {
    return { ok: false, reason: "an intent has to name the binding it invokes" };
  }
  if (!isRevision(payload.expectedRevision)) {
    return { ok: false, reason: "an intent has to say which revision of the widget it was pressed on" };
  }
  if (payload.input !== undefined && !isPlainObject(payload.input)) {
    return { ok: false, reason: "an intent's input must be an object" };
  }
  // The frame's own idempotency key, so a press it retries is one effect; absent, the host makes one per attempt.
  if (payload.invocationId !== undefined && !isId(payload.invocationId)) {
    return { ok: false, reason: "an intent's invocation id must be a short string" };
  }
  const bytes = jsonBytes(payload);
  if (bytes === undefined || bytes > RELAY_LIMITS.intent.maxBytes) {
    return { ok: false, reason: `an intent is limited to ${String(RELAY_LIMITS.intent.maxBytes)} bytes` };
  }
  return { ok: true, intent: payload };
}

/**
 * A request for a fresh read of the instance the window shows. It takes nothing: which instance is the host's to say.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function reviewDetachedFrameRead(payload) {
  const fields = reviewRelayFields(payload, [], "a frame read");
  return fields.ok ? { ok: true } : fields;
}

/** A dev-session status read. It takes nothing either: the session is the one the host's last read named. */
export function reviewDetachedDevSession(payload) {
  const fields = reviewRelayFields(payload, [], "a dev-session read");
  return fields.ok ? { ok: true } : fields;
}

/**
 * A state write the frame made, relayed as the conversation sends it: a patch and the state revision it was made
 * against. The node checks the owner, the kind, the schema and the revision; the host bounds the size.
 *
 * @returns {{ ok: true, write: { expectedRevision: number, patch: Record<string, unknown> } } | { ok: false, reason: string }}
 */
export function reviewDetachedStateSave(payload) {
  const fields = reviewRelayFields(payload, ["expectedRevision", "patch"], "a state write");
  if (!fields.ok) return fields;
  if (!isRevision(payload.expectedRevision)) {
    return { ok: false, reason: "a state write has to say which state revision it was made against" };
  }
  if (!isPlainObject(payload.patch)) return { ok: false, reason: "a state write's patch must be an object" };
  const bytes = jsonBytes(payload);
  if (bytes === undefined || bytes > RELAY_LIMITS["state.save"].maxBytes) {
    return { ok: false, reason: `a state write is limited to ${String(RELAY_LIMITS["state.save"].maxBytes)} bytes` };
  }
  return { ok: true, write: { expectedRevision: payload.expectedRevision, patch: payload.patch } };
}

const semanticProposalContract = z.fromJSONSchema(semanticProposalSchema);

/**
 * What the frame says it shows, relayed for the next turn and for voice: the public proposal shape and nothing else,
 * so a window cannot name actions or reach the turn with anything but a bounded summary and values.
 *
 * @returns {{ ok: true, proposal: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function reviewDetachedSemanticPublish(payload) {
  const fields = reviewRelayFields(payload, ["proposal"], "a semantic publish");
  if (!fields.ok) return fields;
  const bytes = jsonBytes(payload);
  if (bytes === undefined || bytes > RELAY_LIMITS["semantic.publish"].maxBytes) {
    return { ok: false, reason: `a semantic publish is limited to ${String(RELAY_LIMITS["semantic.publish"].maxBytes)} bytes` };
  }
  const checked = semanticProposalContract.safeParse(payload.proposal);
  if (!checked.success) return { ok: false, reason: "the proposal does not match the public contract" };
  return { ok: true, proposal: checked.data };
}

/*
 * The file, job and token relays.
 *
 * Each payload is the frame's request as the widget SDK words it (`artifactRequestSchema`, `jobRequestSchema`,
 * `tokenRequestSchema` in `@clarkcant/widget-sdk`), checked again here with the same patterns and bounds, because the
 * window that sends it is a renderer the host cannot tell from an honest one. None of them takes a conversation or an
 * instance: the host performs each against the instance it opened the window for, and the node re-checks the grant.
 */

/**
 * The SDK's own patterns and bounds, repeated: the Electron host cannot load TypeScript. `detached-window.spec.ts`
 * holds each one equal to its source (`ARTIFACT_BRIDGE_LIMITS`, `artifactRequestSchema`, `jobRefWireSchema`,
 * `tokenRequestSchema` and `TOKEN_BRIDGE_LIMITS` in `@clarkcant/widget-sdk`; `browserTokenSessionSchema` and
 * `BROWSER_TOKEN_LIMITS` in `@clarkcant/contracts`).
 */
export const ARTIFACT_RELAY_LIMITS = Object.freeze({
  chunkBytes: 262_144,
  chunkBase64Chars: Math.ceil(262_144 / 3) * 4,
  maxAccept: 16,
  acceptMaxChars: 120,
  mimeTypeMinChars: 3,
  mimeTypeMaxChars: 120,
  nameMaxChars: 200,
});
export const TOKEN_RELAY_LIMITS = Object.freeze({
  providerMaxChars: 64,
  scopes: 16,
  scopeMaxChars: 128,
  minTtlSeconds: 30,
  maxTtlSeconds: 3_600,
});
export const RELAY_PATTERNS = Object.freeze({
  artifactId: /^art_[A-Za-z0-9_-]{1,120}$/,
  jobId: /^job_[A-Za-z0-9_-]{1,120}$/,
  acceptType: /^[a-z][a-z0-9.+-]*\/(\*|[a-z0-9][a-z0-9.+-]*)$/,
  /** A frame's token session: minted by the frame host, one per mounted frame. */
  tokenSession: /^[A-Za-z0-9_-]{16,128}$/,
  tokenProvider: /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/,
  tokenScope: /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/,
});
const ARTIFACT_ID = RELAY_PATTERNS.artifactId;
const JOB_ID = RELAY_PATTERNS.jobId;
const ACCEPT_TYPE = RELAY_PATTERNS.acceptType;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const TOKEN_SESSION = RELAY_PATTERNS.tokenSession;
const TOKEN_PROVIDER = RELAY_PATTERNS.tokenProvider;
const TOKEN_SCOPE = RELAY_PATTERNS.tokenScope;
/** The words the host's dialogs are drawn in, in the person's language (`desktopDialogLabels`). */
const DIALOG_LABELS = Object.freeze(["filterName", "replaceTitle", "replaceMessage", "replace", "cancel"]);

const isArtifactId = (value) => typeof value === "string" && ARTIFACT_ID.test(value);
const isName = (value) => typeof value === "string" && value.length >= 1 && value.length <= ARTIFACT_RELAY_LIMITS.nameMaxChars;
const isOffset = (value) => Number.isSafeInteger(value) && value >= 0;
const isShortText = (value, max) => typeof value === "string" && value.length <= max;

function reviewDialogLabels(labels) {
  if (labels === undefined) return true;
  if (!isPlainObject(labels)) return false;
  return Object.entries(labels).every(([key, value]) => DIALOG_LABELS.includes(key) && isShortText(value, 200));
}

/**
 * What each relayed verb takes, and the check its payload passes. A verb that takes nothing takes no fields at all.
 *
 * @type {Readonly<Record<string, { fields: readonly string[], check: (payload: Record<string, any>) => string | undefined }>>}
 */
const RELAY_REQUESTS = Object.freeze({
  "artifacts.pick": {
    fields: ["accept", "title", "filterName"],
    check: (payload) => {
      const accept = payload.accept ?? [];
      if (!Array.isArray(accept) || accept.length > ARTIFACT_RELAY_LIMITS.maxAccept) {
        return `a pick accepts at most ${String(ARTIFACT_RELAY_LIMITS.maxAccept)} types`;
      }
      if (!accept.every((entry) => typeof entry === "string" && entry.length <= ARTIFACT_RELAY_LIMITS.acceptMaxChars && ACCEPT_TYPE.test(entry))) {
        return "a pick's accepted types are MIME types such as text/plain or image/*";
      }
      if (payload.title !== undefined && !isShortText(payload.title, 120)) return "a pick's title is a short string";
      if (payload.filterName !== undefined && !isShortText(payload.filterName, 200)) return "a pick's filter name is a short string";
      return undefined;
    },
  },
  "artifacts.describe": {
    fields: ["artifactId"],
    check: (payload) => (isArtifactId(payload.artifactId) ? undefined : "a request names an artifact by its id"),
  },
  "artifacts.create": {
    fields: ["mimeType", "name"],
    check: (payload) => {
      if (typeof payload.mimeType !== "string" || payload.mimeType.length < ARTIFACT_RELAY_LIMITS.mimeTypeMinChars || payload.mimeType.length > ARTIFACT_RELAY_LIMITS.mimeTypeMaxChars) {
        return "a new file names its type";
      }
      if (payload.name !== undefined && !isName(payload.name)) return "a file's name is 1 to 200 characters";
      return undefined;
    },
  },
  "artifacts.read": {
    fields: ["artifactId", "offset", "length"],
    check: (payload) => {
      if (!isArtifactId(payload.artifactId)) return "a request names an artifact by its id";
      if (!isOffset(payload.offset)) return "a read starts at a whole, non-negative offset";
      if (!Number.isSafeInteger(payload.length) || payload.length < 1 || payload.length > ARTIFACT_RELAY_LIMITS.chunkBytes) {
        return `a read is 1 to ${String(ARTIFACT_RELAY_LIMITS.chunkBytes)} bytes`;
      }
      return undefined;
    },
  },
  "artifacts.write": {
    fields: ["artifactId", "offset", "chunkBase64"],
    check: (payload) => {
      if (!isArtifactId(payload.artifactId)) return "a request names an artifact by its id";
      if (!isOffset(payload.offset)) return "a write starts at a whole, non-negative offset";
      if (!isShortText(payload.chunkBase64, ARTIFACT_RELAY_LIMITS.chunkBase64Chars) || !BASE64.test(payload.chunkBase64)) {
        return `a write is base64 of at most ${String(ARTIFACT_RELAY_LIMITS.chunkBytes)} bytes`;
      }
      return undefined;
    },
  },
  "artifacts.finalize": {
    fields: ["artifactId"],
    check: (payload) => (isArtifactId(payload.artifactId) ? undefined : "a request names an artifact by its id"),
  },
  "artifacts.export": {
    fields: ["artifactId", "suggestedName", "replace", "labels"],
    check: (payload) => {
      if (!isArtifactId(payload.artifactId)) return "a request names an artifact by its id";
      if (!isName(payload.suggestedName)) return "a save suggests a name of 1 to 200 characters";
      if (payload.replace !== undefined && typeof payload.replace !== "boolean") return "replace is true or false";
      if (!reviewDialogLabels(payload.labels)) return "a save's dialog words are short strings the host knows";
      return undefined;
    },
  },
  "artifacts.attach": {
    fields: ["artifactId", "name"],
    check: (payload) => {
      if (!isArtifactId(payload.artifactId)) return "a request names an artifact by its id";
      if (payload.name !== undefined && !isName(payload.name)) return "a file's name is 1 to 200 characters";
      return undefined;
    },
  },
  "artifacts.discard": {
    fields: ["artifactId"],
    check: (payload) => (isArtifactId(payload.artifactId) ? undefined : "a request names an artifact by its id"),
  },
  "jobs.get": {
    fields: ["jobId"],
    check: (payload) => (typeof payload.jobId === "string" && JOB_ID.test(payload.jobId) ? undefined : "a request names a job by its id"),
  },
  "jobs.list": { fields: [], check: () => undefined },
  "jobs.cancel": {
    fields: ["jobId"],
    check: (payload) => (typeof payload.jobId === "string" && JOB_ID.test(payload.jobId) ? undefined : "a request names a job by its id"),
  },
  "tokens.request": {
    fields: ["session", "request"],
    check: (payload) => {
      if (typeof payload.session !== "string" || !TOKEN_SESSION.test(payload.session)) return "a token request names its frame's session";
      const request = payload.request;
      if (!isPlainObject(request)) return "a token request is an object";
      const unknown = Object.keys(request).filter((key) => !["provider", "scopes", "ttlSeconds"].includes(key));
      if (unknown.length > 0) return `a token request carries fields the host does not accept: ${unknown.join(", ")}`;
      if (!isShortText(request.provider, TOKEN_RELAY_LIMITS.providerMaxChars) || !TOKEN_PROVIDER.test(request.provider)) return "a token request names its provider";
      if (
        !Array.isArray(request.scopes) ||
        request.scopes.length < 1 ||
        request.scopes.length > TOKEN_RELAY_LIMITS.scopes ||
        !request.scopes.every((scope) => isShortText(scope, TOKEN_RELAY_LIMITS.scopeMaxChars) && TOKEN_SCOPE.test(scope))
      ) {
        return `a token request names 1 to ${String(TOKEN_RELAY_LIMITS.scopes)} scopes`;
      }
      if (request.ttlSeconds !== undefined && (!Number.isInteger(request.ttlSeconds) || request.ttlSeconds < TOKEN_RELAY_LIMITS.minTtlSeconds || request.ttlSeconds > TOKEN_RELAY_LIMITS.maxTtlSeconds)) {
        return `a token lives ${String(TOKEN_RELAY_LIMITS.minTtlSeconds)} to ${String(TOKEN_RELAY_LIMITS.maxTtlSeconds)} seconds`;
      }
      return undefined;
    },
  },
  "tokens.end": {
    fields: ["session"],
    check: (payload) => (typeof payload.session === "string" && TOKEN_SESSION.test(payload.session) ? undefined : "an end names its frame's session"),
  },
});

/** The file, job and token verbs the host relays, by the name their channel carries after `detached:`. */
export const BROKER_RELAY_VERBS = Object.freeze(Object.keys(RELAY_REQUESTS));

/**
 * A file, job or token request from the detached window, checked before the host acts on it.
 *
 * @returns {{ ok: true, payload: Record<string, any> } | { ok: false, reason: string }}
 */
export function reviewDetachedBrokerRequest(verb, raw) {
  const spec = RELAY_REQUESTS[verb];
  if (spec === undefined) return { ok: false, reason: `the host relays no verb called ${String(verb)}` };
  const fields = reviewRelayFields(raw, spec.fields, `a ${verb} request`);
  if (!fields.ok) return fields;
  const refused = spec.check(fields.payload);
  return refused === undefined ? { ok: true, payload: fields.payload } : { ok: false, reason: refused };
}

/**
 * The token sessions a detached window's frames were issued tokens under, so the host can end every one of them when the
 * window goes, or when the frame it ran is replaced, whether or not the renderer said so. Bounded: past `limit` a new
 * session is not recorded, and the host refuses to issue under it rather than issue a token it could not end.
 */
export function tokenSessions(limit = 64) {
  const sessions = new Set();
  return {
    /** Whether `session` is recorded (or may be): false only for a new session past the bound. */
    admits(session) {
      return sessions.has(session) || sessions.size < limit;
    },
    record(session) {
      if (sessions.has(session) || sessions.size < limit) sessions.add(session);
    },
    forget(session) {
      sessions.delete(session);
    },
    /** Every recorded session, and the record emptied: each is ended once. */
    drain() {
      const all = [...sessions];
      sessions.clear();
      return all;
    },
    list() {
      return [...sessions];
    },
  };
}

/**
 * The node's answer to a frame read, checked before the window sees it.
 *
 * It must be the instance the window was opened for and still a widget in its own frame; anything else would hand the
 * window a different widget than the one it shows. The frame's URL is made absolute against the node, and must stay on
 * the node: the window frames it, and a URL elsewhere would be a document the node never granted.
 *
 * @param {unknown} body
 * @param {{ instanceId: string, baseUrl: string }} bound
 * @returns {{ ok: true, live: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function reviewDetachedFrameAnswer(body, bound) {
  if (!isPlainObject(body)) return { ok: false, reason: "the node's read is not an object" };
  if (body.kind !== "isolated-frame") return { ok: false, reason: "the widget no longer runs in its own frame" };
  if (body.instanceId !== bound.instanceId) return { ok: false, reason: "the node answered for another instance" };
  if (body.frame === null) return { ok: true, live: body };
  if (!isPlainObject(body.frame) || typeof body.frame.url !== "string") {
    return { ok: false, reason: "the node's read has no frame address" };
  }
  let url;
  try {
    url = new URL(body.frame.url, bound.baseUrl);
  } catch {
    return { ok: false, reason: "the frame address is not a URL" };
  }
  if (url.origin !== new URL(bound.baseUrl).origin) return { ok: false, reason: "the frame address is not on the node" };
  return { ok: true, live: { ...body, frame: { ...body.frame, url: url.href } } };
}

/**
 * The relays' budget: a bucket per verb, a cap on calls in flight across all of them, and, for presses, a cap of their
 * own. A call over any of them is refused at once rather than queued, so a renderer that asks without pause costs the
 * host a refusal per call and the node nothing.
 *
 * `take(verb)` answers a `done()` the caller runs when its call settles, or the refusal.
 *
 * @param {{ limits?: typeof RELAY_LIMITS, now?: () => number }} [input]
 * @returns {{ take: (verb: string) => ({ ok: true, done: () => void } | { ok: false, refused: string, code: string }) }}
 */
export function relayBudget(input = {}) {
  const limits = input.limits ?? RELAY_LIMITS;
  const now = input.now ?? (() => Date.now());
  /** @type {Map<string, { tokens: number, at: number, inFlight: number }>} */
  const buckets = new Map();
  let inFlight = 0;
  const take = (verb) => {
    const names = relayBucketsFor(verb);
    if (names.some((name) => limits[name] === undefined || typeof limits[name] !== "object")) {
      return { ok: false, refused: `the host relays no verb called ${String(verb)}`, code: "RELAY_UNKNOWN" };
    }
    const at = now();
    const held = names.map((name) => {
      const limit = limits[name];
      const bucket = buckets.get(name) ?? { tokens: limit.burst, at, inFlight: 0 };
      bucket.tokens = Math.min(limit.burst, bucket.tokens + (Math.max(0, at - bucket.at) / 1000) * limit.refillPerSecond);
      bucket.at = at;
      buckets.set(name, bucket);
      return { name, limit, bucket };
    });
    if (inFlight >= limits.inFlight || held.some(({ limit, bucket }) => limit.inFlight !== undefined && bucket.inFlight >= limit.inFlight)) {
      return { ok: false, refused: "the host is still relaying earlier calls; try again shortly", code: "RELAY_BUSY" };
    }
    // Every bucket is checked before any is spent, so a refusal costs none of them.
    const empty = held.find(({ bucket }) => bucket.tokens < 1);
    if (empty !== undefined) {
      return {
        ok: false,
        refused: `at most ${String(empty.limit.refillPerSecond)} ${empty.name} calls a second, after a burst of ${String(empty.limit.burst)}`,
        code: "RELAY_RATE_LIMITED",
      };
    }
    for (const { bucket } of held) {
      bucket.tokens -= 1;
      bucket.inFlight += 1;
    }
    inFlight += 1;
    let settled = false;
    return {
      ok: true,
      done: () => {
        if (settled) return;
        settled = true;
        for (const { bucket } of held) bucket.inFlight -= 1;
        inFlight -= 1;
      },
    };
  };
  return { take };
}

/**
 * Run one relayed verb under a budget, with a node caller bound to that verb's time limit.
 *
 * `run` receives the only `callNode` it may use, so no relay reaches the node without a bound. A call over the budget
 * is refused at once; a call the node never answers ends as `NODE_TIMEOUT`; either way the slot is freed when the call
 * settles.
 *
 * @param {{ take: (verb: string) => ({ ok: true, done: () => void } | { ok: false, refused: string, code: string }) }} budget
 * @param {string} verb
 * @param {(path: string, init?: Record<string, unknown>) => Promise<any>} callNode
 * @param {(call: (path: string, init?: Record<string, unknown>) => Promise<any>) => Promise<any>} run
 */
export async function runRelay(budget, verb, callNode, run) {
  const taken = budget.take(verb);
  if (!taken.ok) return { ok: false, refused: taken.refused, code: taken.code, details: {} };
  const timeoutMs = RELAY_LIMITS[relayBucketsFor(verb)[0]]?.timeoutMs;
  try {
    return await run((path, init) => callNode(path, { ...init, timeoutMs }));
  } finally {
    taken.done();
  }
}

/** How long the package-change signals have to be quiet before the detached window is told to re-read its frame. */
export const PACKAGES_CHANGED_SETTLE_MS = 500;

/**
 * The shell's package-change signals, passed on to the detached window once a burst of them has settled.
 *
 * Each signal the window hears is a frame read, and the read budget (`frame.read`) refuses past its burst: a run of
 * installs passed on one by one would have the last read refused and leave the frame a build behind. So every signal
 * restarts a short wait, and only the last one in a run reaches the window. The window is looked up when the wait ends,
 * and one closed or destroyed by then hears nothing.
 *
 * @param {{
 *   target: () => ({ isDestroyed: () => boolean, webContents: { isDestroyed: () => boolean, send: (channel: string) => void } } | undefined),
 *   settleMs?: number,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 * }} input
 * @returns {{ signal: () => void }}
 */
export function relayPackagesChanged(input) {
  const timers = input.timers ?? globalThis;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const signal = () => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = undefined;
      const window = input.target();
      if (window === undefined || window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send("detached:packagesChanged");
    }, input.settleMs ?? PACKAGES_CHANGED_SETTLE_MS);
  };
  return { signal };
}

/** Where a redacted folder path stood: the package root, as the diagnostics' own `path` is relative to it. */
const REDACTED_ROOT = ".";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A widget dev session's status as the detached window may see it: without the developer's folder path (owner decision
 * E), wherever it appears.
 *
 * `root` and `placed` are dropped, and every string left — a build message is the reader's own words, and a bundler's
 * names absolute files — has the folder replaced by `.`, so a file under it reads relative to the package, the way a
 * diagnostic's `path` does. The folder is matched in either slash direction, URL-encoded, and ignoring case (a path on
 * Windows or macOS may be spelled in any case), and only as whole names, so `/w/widget` is not taken for `/w/widget2` or `/w/widget.bak`.
 *
 * @param {Record<string, unknown>} view
 * @returns {Record<string, unknown>}
 */
export function redactDevSessionView(view) {
  const { root, ...rest } = view;
  delete rest.placed;
  if (typeof root !== "string") return rest;
  const trimmed = root.replace(/[\\/]+$/, "");
  if (trimmed === "") return rest;
  const forward = trimmed.replace(/\\/g, "/");
  const spellings = [...new Set([trimmed, forward, trimmed.replace(/\//g, "\\"), encodeURI(forward)])].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![\\w~-])(?:${spellings.map(escapeRegExp).join("|")})(?![\\w~-]|\\.[\\w~-])`, "giu");
  const redact = (value) => {
    if (typeof value === "string") return value.replace(pattern, REDACTED_ROOT);
    if (Array.isArray(value)) return value.map(redact);
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
    return value;
  };
  return redact(rest);
}

/**
 * The detached window's lease on the instance it shows.
 *
 * The same numbers as the conversation's own surface (`CLAIM_REFRESH_MS` in `DesktopSurfaces.tsx`): refreshed well
 * inside its lifetime, so one missed refresh does not hand the instance to somebody else.
 */
export const DETACHED_LEASE = Object.freeze({ refreshMs: 30_000, leaseMs: 90_000, endWithinMs: 5_000 });

/**
 * Keep the detached window's claim alive while it is open.
 *
 * A claim made once lapses, and after that any surface can claim the instance while this window still shows it: two
 * live owners, which is what the lease exists to prevent. So the host re-claims on a timer with the same owner token.
 *
 * A refusal that says somebody else holds the instance now (`ALREADY_OWNED`) means this window is no longer the owner,
 * and `onLost` is told once so the host can close it. Any other failure — the node restarting, a network blip — is
 * retried on the next tick: the lease outlives a missed refresh on purpose.
 *
 * `stop()` answers the claim still on its way to the node, if there is one. A release sent before that claim lands
 * would be undone by it, and the instance would stay held for a whole lease by a window that no longer exists.
 *
 * @param {{
 *   claim: () => Promise<{ ok: boolean, code?: string }>,
 *   onLost: (answer: { ok: false, code?: string, refused?: string }) => void,
 *   refreshMs?: number,
 *   timers?: { setInterval: typeof setInterval, clearInterval: typeof clearInterval },
 * }} input
 * @returns {{ stop: () => Promise<void> }}
 */
export function keepDetachedLease(input) {
  const timers = input.timers ?? globalThis;
  let stopped = false;
  let refreshing = false;
  /** @type {Promise<void>} */
  let inFlight = Promise.resolve();
  const stop = () => {
    stopped = true;
    timers.clearInterval(timer);
    return inFlight;
  };
  const timer = timers.setInterval(() => {
    // One refresh at a time: a node slow to answer must not collect a queue of claims behind it.
    if (stopped || refreshing) return;
    refreshing = true;
    const sent = input.claim();
    inFlight = sent.then(
      () => undefined,
      () => undefined,
    );
    void sent
      .then((answer) => {
        if (stopped || answer.ok || answer.code !== "ALREADY_OWNED") return;
        stop();
        input.onLost(answer);
      })
      .catch(() => undefined)
      .finally(() => {
        refreshing = false;
      });
  }, input.refreshMs ?? DETACHED_LEASE.refreshMs);
  return { stop };
}

const CLOSED_BEFORE_CLAIM = Object.freeze({ ok: false, refused: "the window closed before it could show the widget" });

/**
 * The whole life of the detached window's lease: the first claim, the refreshes, and the release.
 *
 * Two orderings matter, and both are about a claim landing at the node after the window is gone, which would hold
 * the instance for a whole lease with nothing on screen:
 *
 * - `begin()` claims only while the window is still open. A window closed while it was loading claims nothing.
 * - `end()` waits for every claim still on its way — the first one or a refresh — before it releases, so the release
 *   is the last word. It settles once the release has, which is when the conversation may take the instance back.
 *
 * The wait in `end()` is bounded (`endWithinMs`). A node that accepts the call and never answers would otherwise keep
 * the conversation from taking the widget back for minutes, with no window on screen. Past the bound `end()` settles
 * anyway: the claim and release it waited for still run in their order, and a release the node never hears lapses
 * with the lease.
 *
 * `begin()` claims once. A second call answers with the first call's result rather than starting a second refresh
 * timer, which `end()` would not stop and which would keep claiming after the release.
 *
 * @param {{
 *   claim: () => Promise<{ ok: boolean, code?: string, refused?: string }>,
 *   release: () => Promise<unknown>,
 *   onLost: (answer: { ok: false, code?: string, refused?: string }) => void,
 *   isOpen: () => boolean,
 *   refreshMs?: number,
 *   endWithinMs?: number,
 *   timers?: {
 *     setInterval: typeof setInterval,
 *     clearInterval: typeof clearInterval,
 *     setTimeout?: typeof setTimeout,
 *     clearTimeout?: typeof clearTimeout,
 *   },
 * }} input
 * @returns {{ begin: () => Promise<{ ok: boolean, code?: string, refused?: string }>, end: () => Promise<void> }}
 */
export function holdDetachedLease(input) {
  const timers = input.timers ?? globalThis;
  let ended = false;
  /** @type {Promise<unknown> | undefined} */
  let claiming;
  /** @type {{ stop: () => Promise<void> } | undefined} */
  let kept;
  /** @type {Promise<void> | undefined} */
  let ending;
  /** @type {Promise<{ ok: boolean, code?: string, refused?: string }> | undefined} */
  let begun;
  const begin = () => {
    begun ??= claimOnce();
    return begun;
  };
  const claimOnce = async () => {
    if (ended || !input.isOpen()) return CLOSED_BEFORE_CLAIM;
    const sent = input.claim();
    claiming = sent;
    const answer = await sent.catch((cause) => ({ ok: false, refused: String(cause?.message ?? cause) }));
    // Closed while the claim was on its way: `end()` already waits for it and releases after it.
    if (ended) return CLOSED_BEFORE_CLAIM;
    if (!answer.ok) return answer;
    kept = keepDetachedLease({
      claim: input.claim,
      onLost: input.onLost,
      refreshMs: input.refreshMs,
      timers: input.timers,
    });
    return answer;
  };
  const end = () => {
    if (ending !== undefined) return ending;
    ended = true;
    const pending = [claiming, kept?.stop()].filter((entry) => entry !== undefined);
    const released = Promise.allSettled(pending).then(async () => {
      // Nothing was ever claimed, so there is nothing to give back.
      if (claiming === undefined) return;
      try {
        await input.release();
      } catch {
        // A release the node did not hear lapses with the lease; the conversation's own claim says so if it matters.
      }
    });
    const setTimer = timers.setTimeout ?? globalThis.setTimeout;
    const clearTimer = timers.clearTimeout ?? globalThis.clearTimeout;
    ending = new Promise((resolve) => {
      const bound = setTimer(resolve, input.endWithinMs ?? DETACHED_LEASE.endWithinMs);
      void released.then(() => {
        clearTimer(bound);
        resolve();
      });
    });
    return ending;
  };
  return { begin, end };
}

/**
 * The detached window's lease, wired to the window it belongs to.
 *
 * This is the main process's whole use of `holdDetachedLease`, kept here so it can be driven with a stand-in window:
 *
 * - the window counts as open only while it is still the detached window and not destroyed;
 * - a refresh refused because somebody else holds the instance closes the window;
 * - a first claim that is refused closes the window, and `begin()` answers with the refusal;
 * - closing the window, for whatever reason, ends the lease, then runs `afterRelease` (the host ends the token sessions
 *   the window's frames were issued under), and the conversation is told to take the widget back only once both have
 *   settled or their bounds have passed (`onEnded`). `released` settles at the same moment, so quitting can wait for it.
 *
 * @param {{
 *   window: { on: (event: "closed", listener: () => void) => unknown, close: () => void, isDestroyed: () => boolean },
 *   isCurrent: () => boolean,
 *   claim: () => Promise<{ ok: boolean, code?: string, refused?: string }>,
 *   release: () => Promise<unknown>,
 *   afterRelease?: () => Promise<unknown>,
 *   onClosed?: () => void,
 *   onEnded: () => void,
 *   refreshMs?: number,
 *   endWithinMs?: number,
 *   timers?: Parameters<typeof holdDetachedLease>[0]["timers"],
 * }} input
 * @returns {{ begin: () => Promise<{ ok: boolean, code?: string, refused?: string }>, released: Promise<void> }}
 */
export function superviseDetachedWindow(input) {
  const { window } = input;
  const close = () => {
    if (!window.isDestroyed()) window.close();
  };
  const lease = holdDetachedLease({
    claim: input.claim,
    release: input.release,
    isOpen: () => input.isCurrent() && !window.isDestroyed(),
    onLost: close,
    refreshMs: input.refreshMs,
    endWithinMs: input.endWithinMs,
    timers: input.timers,
  });
  /** @type {() => void} */
  let markReleased = () => undefined;
  const released = new Promise((resolve) => {
    markReleased = resolve;
  });
  window.on("closed", () => {
    input.onClosed?.();
    void lease.end().then(async () => {
      /*
       * Then what the window's frames were given is revoked, before the conversation is told to take the widget back:
       * the frame it mounts there asks for its own tokens under a session of its own. Bounded like the release, so a
       * node that never answers cannot keep the widget from going back; a token not revoked lapses at its expiry.
       */
      if (input.afterRelease !== undefined) {
        const setTimer = input.timers?.setTimeout ?? globalThis.setTimeout;
        const clearTimer = input.timers?.clearTimeout ?? globalThis.clearTimeout;
        let bound;
        await Promise.race([
          Promise.resolve()
            .then(input.afterRelease)
            .catch(() => undefined),
          new Promise((resolve) => {
            bound = setTimer(resolve, input.endWithinMs ?? DETACHED_LEASE.endWithinMs);
          }),
        ]);
        clearTimer(bound);
      }
      markReleased();
      try {
        input.onEnded();
      } catch {
        // The window that would have been told is gone; it takes the widget back when it is next shown.
      }
    });
  });
  const begin = async () => {
    const answer = await lease.begin();
    if (!answer.ok) close();
    return answer;
  };
  return { begin, released };
}

/** Where a detached window opens: beside its parent, and inside the work area the parent is already in. */
export function detachedBounds(parentBounds, workArea) {
  const width = Math.max(320, Math.min(560, Math.round((parentBounds?.width ?? 900) * 0.5)));
  const height = Math.max(320, Math.min(720, Math.round((parentBounds?.height ?? 700) * 0.8)));
  const area = workArea ?? parentBounds ?? { x: 0, y: 0, width: 1280, height: 800 };
  // Offset from the parent so it reads as related to it, then clamped so it cannot open off-screen.
  const wantedX = (parentBounds?.x ?? area.x) + (parentBounds?.width ?? area.width) + 16;
  const wantedY = parentBounds?.y ?? area.y;
  return {
    width,
    height,
    x: Math.max(area.x, Math.min(wantedX, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(wantedY, area.y + area.height - height)),
  };
}

/**
 * The window the instance is detached into.
 *
 * The same hardening as the main window — sandbox, context isolation, no Node in the renderer — with a narrower
 * bridge. Detaching is a presentation change, so nothing here widens what code in the renderer may reach.
 */
export function detachedWindowOptions(preloadPath, parentBounds, workArea) {
  return {
    /*
     * `webPreferences` is where Electron reads a preload from, and this was the bug the desktop smoke test was
     * written to find: the hardened options were spread at the **top level** of the BrowserWindow, so `preload` was
     * a key Electron ignores and the detached window opened with no bridge at all. The window looked right, answered
     * nothing, and every check that did not open one passed.
     */
    webPreferences: createWindowOptions(preloadPath),
    ...detachedBounds(parentBounds, workArea),
    title: "ClarkCant — widget",
    // The detached window is a view of one instance; the conversation's own menu belongs to the window that owns
    // the conversation.
    autoHideMenuBar: true,
    fullscreenable: false,
    show: false,
  };
}

/*
 * Clark's performs on the detached instance.
 *
 * The node decides a perform — gate, input schema, policy, ledger — before any window sees it, and sends it to the
 * conversation's page as it always does. That page hands it here (`desktop:forwardWidgetPerform`) when the instance is
 * open in this window; the host pushes it to the window (`detached:perform`), whose frame answers, and the window's
 * report (`detached:perform.report`) is posted by the host to `POST /app-intents/widget-perform/:performId`. No window
 * decides anything: the conversation cannot push to the detached window itself, the detached window cannot forward a
 * perform, and a report is taken only for an id the host pushed and is still waiting on.
 */

/**
 * The bounds on performs in the detached window.
 *
 * At most four wait at once, as many as a frame's own session takes (`FRAME_PERFORMS_IN_FLIGHT`). A request is the
 * node's own, bounded as a frame message is (`FRAME_MESSAGE_MAX_BYTES`). A report is at most 8 KiB of UTF-8 JSON
 * (`DETACHED_PERFORM_REPORT_MAX_BYTES`): ample for ASCII, but a contract-valid `output` of 4,000 Vietnamese, emoji or
 * control characters encodes to more, so the window cuts the output to fit before it reports. The host waits `answerWithinMs` for the window's report: longer than the frame's
 * own wait for its widget (`FRAME_PERFORM_TIMEOUT_MS`), so a widget that does not answer is reported as such by the
 * window, and shorter than the node's (`WIDGET_PERFORM_REPORT_WITHIN_MS`), so the host's "no answer" reaches the node
 * before it gives up. `detached-window.spec.ts` holds both orderings and each copied bound to its source.
 */
export const DETACHED_PERFORM_LIMITS = Object.freeze({
  inFlight: 4,
  requestMaxBytes: 64 * 1024,
  reportMaxBytes: 8 * 1024,
  answerWithinMs: 7_000,
  reportTimeoutMs: 5_000,
});

const performRequestContract = z.fromJSONSchema(performRequestSchema);
const performReportContract = z.fromJSONSchema(performReportSchema);
// The id as the request names it, so a report cannot name an id the node would never have sent.
const performIdContract = z.fromJSONSchema(performRequestSchema.properties.performId);

/**
 * A perform the conversation hands over: the `widget-perform` request exactly as the node words it (`v`, `performId`,
 * `instanceId`, `actionBindingId`, `action`, `input`) and nothing else.
 *
 * @returns {{ ok: true, request: { performId: string, instanceId: string, action: string, input: Record<string, unknown> } } | { ok: false, reason: string }}
 */
export function reviewForwardedPerform(payload) {
  const bytes = jsonBytes(payload);
  if (bytes === undefined || bytes > DETACHED_PERFORM_LIMITS.requestMaxBytes) {
    return { ok: false, reason: `a perform is limited to ${String(DETACHED_PERFORM_LIMITS.requestMaxBytes)} bytes` };
  }
  const checked = performRequestContract.safeParse(payload);
  if (!checked.success) return { ok: false, reason: "the perform does not match the widget-perform contract" };
  const { performId, instanceId, action, input } = checked.data;
  return { ok: true, request: { performId, instanceId, action, input } };
}

/**
 * The detached window's report on a perform: `{ performId, report }`, the report in the contract's shape, at most 8 KiB.
 *
 * @returns {{ ok: true, performId: string, report: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function reviewPerformReport(payload) {
  const fields = reviewRelayFields(payload, ["performId", "report"], "a perform report");
  if (!fields.ok) return fields;
  const bytes = jsonBytes(payload);
  if (bytes === undefined || bytes > DETACHED_PERFORM_LIMITS.reportMaxBytes) {
    return { ok: false, reason: `a perform report is limited to ${String(DETACHED_PERFORM_LIMITS.reportMaxBytes)} bytes` };
  }
  if (!performIdContract.safeParse(payload.performId).success) {
    return { ok: false, reason: "a perform report has to name the perform it answers" };
  }
  const checked = performReportContract.safeParse(payload.report);
  if (!checked.success) return { ok: false, reason: "the report does not match the widget-perform contract" };
  return { ok: true, performId: payload.performId, report: checked.data };
}

/**
 * The performs pushed to one detached window and not yet answered.
 *
 * - `forward(request)` pushes a reviewed perform to the window with `send` and starts its wait. It is refused, with
 *   nothing pushed, as `PERFORM_IN_PROGRESS` for an id already waiting, as `PERFORM_BUSY` with four waiting, and as
 *   `FRAME_NOT_MOUNTED` when the window cannot be sent anything.
 * - `settle(raw)` takes the window's report for an id it is waiting on, and hands it to `report` once. An id it is not
 *   waiting on — never pushed, answered already, or given up on — is refused.
 * - A perform not answered within `answerWithinMs` is reported as no answer: the frame may have done it.
 * - `abandon()`, when the window closes, reports every perform still waiting as no answer.
 *
 * `report(performId, report)` posts to the node; its failure is the node's to time out, and nothing here retries it.
 *
 * @param {{ send: (push: { performId: string, action: string, input: Record<string, unknown> }) => boolean, report: (performId: string, report: Record<string, unknown>) => Promise<unknown>, limits?: typeof DETACHED_PERFORM_LIMITS, timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout } }} input
 */
export function detachedPerforms(input) {
  const limits = input.limits ?? DETACHED_PERFORM_LIMITS;
  const timers = input.timers ?? globalThis;
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const pending = new Map();
  const finish = (performId, report) => {
    const timer = pending.get(performId);
    if (timer === undefined) return false;
    timers.clearTimeout(timer);
    pending.delete(performId);
    void Promise.resolve()
      .then(() => input.report(performId, report))
      .catch(() => undefined);
    return true;
  };
  const refuse = (code, refused) => ({ ok: false, code, refused });
  return {
    forward(request) {
      if (pending.has(request.performId)) return refuse("PERFORM_IN_PROGRESS", "the widget's window is already performing this");
      if (pending.size >= limits.inFlight) {
        return refuse("PERFORM_BUSY", `the widget's window is answering ${String(limits.inFlight)} performs already`);
      }
      const timer = timers.setTimeout(
        () => finish(request.performId, { status: "no-answer", message: "the widget's window did not answer in time" }),
        limits.answerWithinMs,
      );
      pending.set(request.performId, timer);
      let sent;
      try {
        sent = input.send({ performId: request.performId, action: request.action, input: request.input });
      } catch {
        sent = false;
      }
      if (!sent) {
        timers.clearTimeout(timer);
        pending.delete(request.performId);
        return refuse("FRAME_NOT_MOUNTED", "the widget's window closed before it could be asked");
      }
      return { ok: true };
    },
    settle(raw) {
      const reviewed = reviewPerformReport(raw);
      if (!reviewed.ok) return { ok: false, refused: reviewed.reason, code: "RELAY_REFUSED", details: {} };
      if (!finish(reviewed.performId, reviewed.report)) {
        return { ok: false, refused: "the host is not waiting on a report for that perform", code: "PERFORM_NOT_EXPECTED", details: {} };
      }
      return { ok: true };
    },
    abandon() {
      for (const performId of [...pending.keys()]) {
        finish(performId, { status: "no-answer", message: "the widget's window closed before the widget answered" });
      }
    },
  };
}