/**
 * Desktop shell security policy.
 *
 * Plain JavaScript with no dependencies, kept separate from `main.mjs` so the policy can be
 * tested in Node without launching Electron. A window's security posture is the one thing in
 * this app that must be checked on every change rather than observed once in a screenshot, and
 * a policy that can only be verified by opening a GUI is a policy that stops being verified.
 *
 * The posture is fixed: no Node in the renderer, context isolation on, a sandbox, a CSP, a
 * channel allowlist, top-frame-only IPC, and named bridge methods instead of a generic
 * transport. A generic `invoke(channel, ...args)` bridge would hand the renderer the whole
 * allowlist at once and make the allowlist decorative.
 */

/** Channels the main process will answer. Anything else is refused, not ignored. */
export const IPC_CHANNELS = Object.freeze([
  "desktop:openExternal",
  "desktop:notify",
  "desktop:pickDirectory",
  "desktop:requestCredential",
  "desktop:setKeepRunning",
  "desktop:getStatus",
  "desktop:getSession",
  "desktop:setCompactMode",
  /*
   * The window's named modes, one channel each rather than one channel taking an operation name.
   *
   * A single `desktop:window` channel with a verb argument would put the allowlist's decision inside the
   * payload, where review cannot see it: the allowlist is a list of what this window may do, and "resize" and
   * "focus" are different things to permit. The renderer asks for a mode by name, and the main process decides
   * what that means.
   */
  "desktop:setWindowMode",
  "desktop:resizeWindowPreset",
  "desktop:restoreWindow",
  "desktop:focusWindow",
  /*
   * The detached widget window's channels.
   *
   * On the allowlist, and still not reachable by the shell: `reviewIpcCall` decides which *document* may use which
   * channel, so being listed here is permission to be asked, not permission for any window to ask. Two of these are
   * the conversation's verbs and two are the detached window's own, because detaching is an act of the conversation
   * while asking for a bootstrap is only a detached window's business.
   */
  "desktop:detachWidget",
  "desktop:attachWidget",
  "detached:bootstrap",
  "detached:intent",
  "detached:release",
]);

/**
 * The channels only a detached window may use.
 *
 * Named as a second list rather than derived, because the split is the security property: a shell that could ask
 * for a detached bootstrap could read a widget's composition without owning it, and a detached window that could
 * call `desktop:getSession` would hold the token this design exists to keep away from it.
 */
export const DETACHED_WINDOW_CHANNELS = Object.freeze(["detached:bootstrap", "detached:intent", "detached:release"]);

/**
 * Schemes `openExternal` will hand to the OS.
 *
 * HTTPS only. `file:` opens local content, `javascript:` and `data:` execute in a document
 * context, and a custom scheme can launch an installed handler — all three turn a "show this
 * link" call into a code path, so none of them are reachable from renderer input.
 */
const ALLOWED_EXTERNAL_PROTOCOLS = Object.freeze(["https:"]);

/** @returns {{ ok: true, url: string } | { ok: false, reason: string }} */
export function normalizeExternalUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "the URL must be a non-empty string" };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: `not a parseable URL: ${raw}` };
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.includes(parsed.protocol)) {
    return {
      ok: false,
      reason: `scheme ${parsed.protocol} is not allowed; only https is opened externally`,
    };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Content Security Policy for the shell document.
 *
 * `script-src 'self'` with no `unsafe-inline` and no `unsafe-eval`: a page that cannot load
 * remote script or evaluate strings cannot be turned into an execution primitive by injected
 * text.
 */
/**
 * The window's content security policy.
 *
 * Called with nothing it produces the posture document's policy, unchanged. Given origins it widens exactly two
 * directives: the document may run the application's own scripts and styles, and it may reach the node. The
 * node is what makes this necessary - the shell document is local, but the client it loads lives on the node
 * and speaks to it over http and a websocket on the same origin, and `connect-src 'self'` on a local document
 * names neither.
 */
export function contentSecurityPolicy(input = {}) {
  const app = originOf(input.appOrigin);
  const node = originOf(input.nodeOrigin);
  const dev = originOf(input.devOrigin);

  return [
    "default-src 'none'",
    `script-src ${sources(["'self'", app, dev])}`,
    `style-src ${sources(["'self'", app, dev])}`,
    // `blob:` because an attachment preview is an object URL the renderer itself created, not a file it may read.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${sources(["'self'", app, node, dev], { webSockets: true })}`,
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * The origin of a URL, or nothing when it is not one.
 *
 * Never throws: this runs while a window is being created, and a malformed origin should narrow the policy
 * rather than fail the window. A `file:` document reports the origin `null`, which is already covered by
 * `'self'`, so it too answers nothing.
 */
function originOf(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    return url.origin === "null" ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

/**
 * A policy source list, in the order given and without repeats.
 *
 * A page allowed to reach the node over http is allowed to reach it over `ws:` as well: the voice session is a
 * websocket on that same origin, and `http://host:port` does not imply it.
 */
function sources(origins, options = {}) {
  const seen = new Set();
  for (const origin of origins) {
    if (origin === undefined) continue;
    seen.add(origin);
    if (options.webSockets === true && origin !== "'self'") seen.add(origin.replace(/^http/, "ws"));
  }
  return [...seen].join(" ");
}

/**
 * `webPreferences` for the shell window.
 *
 * `sandbox: true` is set alongside `contextIsolation` deliberately: context isolation separates
 * the worlds, and the sandbox removes the renderer's access to Node primitives underneath them.
 * Either alone leaves the other as the only thing between a renderer bug and the host.
 */
export function createWindowOptions(preloadPath) {
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    throw new Error("createWindowOptions needs an absolute preload path");
  }
  return {
    preload: preloadPath,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    spellcheck: false,
  };
}

/**
 * Decide whether an IPC call may be answered.
 *
 * Three checks, each closing a different route: the channel must be on the allowlist, the
 * sender must be the top frame, and the sender must be the document this shell actually loaded.
 * The `parent !== null` check is what stops a widget iframe from reaching host methods it was
 * never granted.
 *
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
export function reviewIpcCall(event, channel, rendererUrl, detachedUrl) {
  if (!IPC_CHANNELS.includes(channel)) {
    return { allowed: false, reason: `channel ${String(channel)} is not on the allowlist` };
  }
  const frame = event?.senderFrame;
  if (frame === null || frame === undefined) {
    return { allowed: false, reason: "the sender frame no longer exists" };
  }
  if (frame.parent !== null && frame.parent !== undefined) {
    return { allowed: false, reason: "the call came from a nested frame, not the shell document" };
  }

  /*
   * Which document is asking decides what it may ask for.
   *
   * The detached window is served from the same origin, so "is this our origin" would let either window call
   * either set of channels — and those sets are not interchangeable: `desktop:getSession` hands out the local
   * token, which is the one thing the detached window must never hold, while `detached:bootstrap` hands out a
   * widget's composition, which the shell has no reason to request for a window it is not showing.
   */
  const selfChannels = DETACHED_WINDOW_CHANNELS;
  if (detachedUrl !== undefined && frame.url === detachedUrl) {
    if (!selfChannels.includes(channel)) {
      return { allowed: false, reason: `a detached window may not call ${String(channel)}` };
    }
    return { allowed: true };
  }
  if (frame.url !== rendererUrl) {
    return {
      allowed: false,
      reason: `the sender is ${frame.url}, not the loaded shell document`,
    };
  }
  if (selfChannels.includes(channel)) {
    return { allowed: false, reason: `${String(channel)} belongs to a detached window, not the shell` };
  }
  return { allowed: true };
}

/**
 * A credential request as the host will accept it.
 *
 * The purpose is required because a prompt with no stated reason cannot be consented to
 * meaningfully; an empty purpose would render as a dialog asking for a secret and explaining
 * nothing.
 */
export function reviewCredentialRequest(input) {
  if (input === null || typeof input !== "object") {
    return { allowed: false, reason: "the credential request must be an object" };
  }
  const requestId = input.requestId;
  const purpose = input.purpose;
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
    return { allowed: false, reason: "requestId must be a string of 1 to 128 characters" };
  }
  if (typeof purpose !== "string" || purpose.trim().length < 8 || purpose.length > 300) {
    return {
      allowed: false,
      reason: "purpose must explain what the secret is for, in at least 8 characters",
    };
  }
  return { allowed: true };
}
