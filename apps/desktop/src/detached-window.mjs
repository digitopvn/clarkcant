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

import { createWindowOptions } from "./security.mjs";

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
  "detached:bootstrap",
  "detached:release",
]);

/** The exact fields a detached window may receive. Nothing else, and that is the whole security property. */
const BOOTSTRAP_FIELDS = Object.freeze(["instanceRef", "title", "widgetKind"]);

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
  if (typeof payload.instanceRef !== "string" || payload.instanceRef === "") {
    // A detached window with no instance reference has nothing to show, and an empty frame would read as a widget
    // that failed to load rather than as a request that made no sense.
    return { ok: false, reason: "a detached window needs the instance reference it is a view of" };
  }
  return { ok: true, bootstrap: payload };
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
    ...createWindowOptions(preloadPath),
    ...detachedBounds(parentBounds, workArea),
    title: "ClarkCant — widget",
    // The detached window is a view of one instance; the conversation's own menu belongs to the window that owns
    // the conversation.
    autoHideMenuBar: true,
    fullscreenable: false,
    show: false,
  };
}
