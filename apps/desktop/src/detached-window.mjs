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
  if (payload.live.kind === "isolated-frame") {
    /*
     * A widget in its own frame cannot run here. Its frame saves state, publishes what it shows and renews its URL
     * through the conversation's credential, and this window holds none — so it would open as a frame that cannot
     * save. Refused here as well as unoffered in the conversation, so no caller can open one.
     */
    return { ok: false, reason: "a widget that runs in its own frame stays in the conversation" };
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
const INTENT_FIELDS = Object.freeze(["instanceRef", "actionBindingId", "expectedRevision", "input"]);

/** @returns {{ ok: true, intent: object } | { ok: false, reason: string }} */
export function reviewDetachedIntent(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "an intent must be an object" };
  }
  const keys = Object.keys(payload);
  const privileged = keys.filter((key) => PRIVILEGED_FIELDS.includes(key));
  if (privileged.length > 0) {
    // A relayed intent carrying a credential is an attempt to act as the host, not to ask it.
    return { ok: false, reason: `an intent may not carry privileged fields: ${privileged.join(", ")}` };
  }
  const unknown = keys.filter((key) => !INTENT_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { ok: false, reason: `an intent carries fields the host does not accept: ${unknown.join(", ")}` };
  }
  if (typeof payload.instanceRef !== "string" || payload.instanceRef === "") {
    return { ok: false, reason: "an intent has to name the instance it acts on" };
  }
  if (typeof payload.actionBindingId !== "string" || payload.actionBindingId === "") {
    return { ok: false, reason: "an intent has to name the binding it invokes" };
  }
  return { ok: true, intent: payload };
}

/**
 * The detached window's lease on the instance it shows.
 *
 * The same numbers as the conversation's own surface (`CLAIM_REFRESH_MS` in `DesktopSurfaces.tsx`): refreshed well
 * inside its lifetime, so one missed refresh does not hand the instance to somebody else.
 */
export const DETACHED_LEASE = Object.freeze({ refreshMs: 30_000, leaseMs: 90_000 });

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
 * @param {{
 *   claim: () => Promise<{ ok: boolean, code?: string, refused?: string }>,
 *   release: () => Promise<unknown>,
 *   onLost: (answer: { ok: false, code?: string, refused?: string }) => void,
 *   isOpen: () => boolean,
 *   refreshMs?: number,
 *   timers?: { setInterval: typeof setInterval, clearInterval: typeof clearInterval },
 * }} input
 * @returns {{ begin: () => Promise<{ ok: boolean, code?: string, refused?: string }>, end: () => Promise<void> }}
 */
export function holdDetachedLease(input) {
  let ended = false;
  /** @type {Promise<unknown> | undefined} */
  let claiming;
  /** @type {{ stop: () => Promise<void> } | undefined} */
  let kept;
  /** @type {Promise<void> | undefined} */
  let ending;
  const begin = async () => {
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
    ending = Promise.allSettled(pending).then(async () => {
      // Nothing was ever claimed, so there is nothing to give back.
      if (claiming === undefined) return;
      try {
        await input.release();
      } catch {
        // A release the node did not hear lapses with the lease; the conversation's own claim says so if it matters.
      }
    });
    return ending;
  };
  return { begin, end };
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
