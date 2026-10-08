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
 */
export const RELAY_LIMITS = Object.freeze({
  inFlight: 8,
  "frame.read": Object.freeze({ burst: 10, refillPerSecond: 1 }),
  "state.save": Object.freeze({ maxBytes: 256 * 1024, burst: 20, refillPerSecond: 5 }),
  "semantic.publish": Object.freeze({ maxBytes: 16 * 1024, burst: 10, refillPerSecond: 4, timeoutMs: 10_000 }),
  intent: Object.freeze({ maxBytes: 64 * 1024, burst: 10, refillPerSecond: 2, inFlight: 4 }),
  "dev.session": Object.freeze({ burst: 5, refillPerSecond: 1 }),
});

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
    const limit = limits[verb];
    if (limit === undefined || typeof limit !== "object") {
      return { ok: false, refused: `the host relays no verb called ${String(verb)}`, code: "RELAY_UNKNOWN" };
    }
    const at = now();
    const bucket = buckets.get(verb) ?? { tokens: limit.burst, at, inFlight: 0 };
    bucket.tokens = Math.min(limit.burst, bucket.tokens + (Math.max(0, at - bucket.at) / 1000) * limit.refillPerSecond);
    bucket.at = at;
    buckets.set(verb, bucket);
    if (inFlight >= limits.inFlight || (limit.inFlight !== undefined && bucket.inFlight >= limit.inFlight)) {
      return { ok: false, refused: "the host is still relaying earlier calls; try again shortly", code: "RELAY_BUSY" };
    }
    if (bucket.tokens < 1) {
      return {
        ok: false,
        refused: `at most ${String(limit.refillPerSecond)} ${verb} calls a second, after a burst of ${String(limit.burst)}`,
        code: "RELAY_RATE_LIMITED",
      };
    }
    bucket.tokens -= 1;
    bucket.inFlight += 1;
    inFlight += 1;
    let settled = false;
    return {
      ok: true,
      done: () => {
        if (settled) return;
        settled = true;
        bucket.inFlight -= 1;
        inFlight -= 1;
      },
    };
  };
  return { take };
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
 * - closing the window, for whatever reason, ends the lease, and the conversation is told to take the widget back only
 *   once that has settled or its bound has passed (`onEnded`). `released` settles at the same moment, so quitting can
 *   wait for it.
 *
 * @param {{
 *   window: { on: (event: "closed", listener: () => void) => unknown, close: () => void, isDestroyed: () => boolean },
 *   isCurrent: () => boolean,
 *   claim: () => Promise<{ ok: boolean, code?: string, refused?: string }>,
 *   release: () => Promise<unknown>,
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
    void lease.end().then(() => {
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
