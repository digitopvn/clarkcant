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
]);

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
export function contentSecurityPolicy() {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    // `blob:` because an attachment preview is an object URL the renderer itself created, not a file it may read.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
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
export function reviewIpcCall(event, channel, rendererUrl) {
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
  if (frame.url !== rendererUrl) {
    return {
      allowed: false,
      reason: `the sender is ${frame.url}, not the loaded shell document`,
    };
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
