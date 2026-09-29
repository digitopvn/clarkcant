/**
 * The document a widget runs inside.
 *
 * A widget's entry is an HTML file the author wrote, and the host has to serve it with two things added and nothing
 * else changed: the bootstrap that gives it a bridge to the host, and a policy that says what it may reach. Both are
 * here rather than in the route because they are the security surface of the whole feature, and a security surface
 * that can only be checked by starting a server is one that gets checked rarely.
 *
 * The policy is written as `default-src 'none'` and then opened deliberately, one directive at a time. Starting from
 * "deny" is the only order in which forgetting a directive fails closed: a policy built by listing what to block
 * fails open on everything nobody thought of.
 */

import { networkOriginProblem } from "@clarkcant/contracts";

export interface WidgetDocumentInput {
  /** The author's entry file, as it is on disk. */
  html: string;
  /**
   * Per response, so the injected script is the only inline script this document may run.
   *
   * Without it the choice is between `'unsafe-inline'` — which would also permit any inline script the widget's own
   * markup contains, which is the thing the sandbox exists to constrain — and no bootstrap at all.
   */
  nonce: string;
  /**
   * Origins the package declared it reaches, from its own manifest.
   *
   * Empty means `connect-src 'none'`, which is the common case and the honest default: a widget's data arrives over
   * the bridge, so reaching the network is a request the package has to make in writing.
   */
  allowedOrigins?: readonly string[];
  /**
   * Where the runtime bundle is served from, as an absolute path on the node.
   *
   * The node, not the app: a sandboxed frame has an opaque origin, so importing this file from another origin is a
   * CORS request that an app serving its own assets has no reason to answer. Everything the frame loads comes from one
   * place, and that place is the node that served the document.
   */
  runtimeUrl?: string;
}

export type FrameAncestorsOutcome =
  | { ok: true; sources: string }
  | { ok: false; code: "CC_APP_ORIGIN_INVALID"; message: string };

/**
 * Who may frame a widget document: the value of `frame-ancestors`.
 *
 * Always `'self'`, the node that serves the document, because the default topology is a node that serves its own
 * interface — directly, or behind a proxy that keeps one origin. `'self'` is resolved by the browser from the URL
 * the document was fetched from, so it needs no knowledge of how the node is reached and trusts nothing a client
 * sent. The previous fallback built this directive from the request's `Host` header, which is client-controlled
 * input deciding who may frame the document.
 *
 * `CC_APP_ORIGIN` adds the one other origin, for an interface served from somewhere else (the Vite dev server, a
 * desktop shell loading a dev renderer). It must be exactly an origin — scheme, host, optional port, nothing else.
 * `new URL(value).origin` both parses and normalises it, so a value with a path, query, credentials, or trailing
 * slash (all of which round-trip through `URL` without becoming equal to the input) is refused rather than
 * silently truncated into the directive. The node checks it once at startup, so a bad value stops the node
 * instead of surfacing as a widget that never loads.
 */
export function resolveFrameAncestors(configured: string | undefined): FrameAncestorsOutcome {
  if (configured === undefined || configured === "") return { ok: true, sources: "'self'" };
  try {
    const url = new URL(configured);
    if (url.origin !== configured || (url.protocol !== "http:" && url.protocol !== "https:")) {
      throw new Error("not a bare http(s) origin");
    }
    return { ok: true, sources: `'self' ${url.origin}` };
  } catch {
    return {
      ok: false,
      code: "CC_APP_ORIGIN_INVALID",
      message: `CC_APP_ORIGIN must be a bare http(s) origin (scheme://host[:port], no path); got ${JSON.stringify(configured)}`,
    };
  }
}

/** The policy for a widget document. Returned rather than written as a header so a test can read it. */
export function widgetDocumentPolicy(input: {
  /** `frame-ancestors` sources, from `resolveFrameAncestors`. */
  frameAncestors: string;
  nonce: string;
  allowedOrigins?: readonly string[];
}): string {
  /*
   * The manifest schema already refuses a malformed origin; this is the second check, at the place the value turns
   * into policy. A package recorded before the schema tightened, or any caller that skipped the schema, still cannot
   * put a wildcard or a directive into `connect-src`: an origin that does not pass is dropped, which narrows the
   * policy rather than failing the document.
   */
  const reachable = (input.allowedOrigins ?? []).filter((origin) => networkOriginProblem(origin) === undefined);
  return [
    "default-src 'none'",
    // The bundle comes from the app; the widget's own module and styles come from the node that is serving this
    // document, which is what `'self'` means here.
    /*
     * `'self'` covers the widget's own module and the runtime bundle, because both are served by the node that served
     * this document. The app origin is deliberately absent: it frames this document, and framing is not running.
     */
    `script-src 'nonce-${input.nonce}' 'self'`,
    // Widgets style themselves, and a stylesheet cannot reach the host. Inline styles stay allowed for the same
    // reason they are allowed in the app: they are how a component expresses its own layout.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    /*
     * Only what the package declared, and nothing when it declared nothing: a widget's data arrives over the bridge,
     * so a widget that reaches the network directly is either redundant or trying to leave, and both are better
     * refused than allowed and forgotten.
     */
    `connect-src ${reachable.length === 0 ? "'none'" : reachable.join(" ")}`,
    `frame-ancestors ${input.frameAncestors}`,
    "base-uri 'none'",
    "form-action 'none'",
    /*
     * The same sandbox the frame element sets, carried by the document itself. The attribute only applies when the
     * document is framed; opened directly in a tab, package code would otherwise run at the node's origin, which is
     * the origin of the interface and its storage. With the directive it runs on an opaque origin either way.
     */
    "sandbox allow-scripts",
  ].join("; ");
}

/**
 * The author's document, with the bootstrap added.
 *
 * Inserted before `</body>` when there is one, and appended otherwise — a widget whose markup is a bare fragment
 * still gets a bridge, because "your HTML was not well-formed" is not a reason for the bridge to be missing without
 * anything saying so.
 */
export function widgetDocument(input: WidgetDocumentInput): string {
  const runtimeUrl = input.runtimeUrl ?? "/widget-runtime.js";
  const bootstrap = [
    `<script type="module" nonce="${input.nonce}">`,
    /*
     * The endpoint is the widget's own window for listening and its parent for sending, and the split is not a
     * detail: a sandboxed frame has an opaque origin, so `window.parent` is cross-origin and only `postMessage` may be
     * called on it. Passing `window.parent` as the whole endpoint — which this did — throws a SecurityError on
     * `addEventListener` before the runtime exists, and the frame then sits there looking healthy with no bridge.
     */
    "const endpoint = {",
    '  postMessage: (message) => window.parent.postMessage(message, "*"),',
    '  addEventListener: (type, listener) => window.addEventListener(type, listener),',
    '  removeEventListener: (type, listener) => window.removeEventListener(type, listener),',
    "};",
    /*
     * What the host says before the runtime exists is buffered here, synchronously, in the order it arrived.
     *
     * The runtime starts listening when it is created, and it is created inside the dynamic import below — which
     * resolves after the document's `load`. The host posts `init` on `load`, and whatever it has to say next right
     * behind it (which of the widget's service-backed actions can run, for one), so those messages can arrive before
     * there is anything to receive them. Keeping only `init` left the frame initialized but never told the rest: a
     * widget whose service was already running kept waiting to hear so. Registering the listener during module
     * evaluation and replaying everything that arrived, in order, closes the gap. It is the frame's own glue and not
     * a second protocol: the runtime reads the replayed messages exactly as it would have read the originals, and the
     * buffer is bounded because a host that says more than this before the runtime loads is not one to keep up with.
     */
    "const pending = [];",
    "const buffer = (event) => {",
    '  if (event.data !== null && typeof event.data === "object" && pending.length < 64) pending.push(event.data);',
    "};",
    'window.addEventListener("message", buffer);',
    /*
     * A **dynamic** import, and that word is the whole fix.
     *
     * A static `import` at the top of a module is fetched before any of the module runs, so when that fetch fails —
     * and from an opaque-origin frame every fetch is cross-origin — the module never executes at all and nothing says
     * why. The frame sat there with no bridge and no error, which is indistinguishable from a widget that has not
     * loaded yet. This catches the failure and puts the reason on the page, because "the bridge did not start" is
     * something the person looking at it can act on and something a test can see.
     */
    `void import(${JSON.stringify(runtimeUrl)})`,
    "  .then(({ createWidgetRuntime }) => {",
    "    try {",
    "const runtime = createWidgetRuntime({",
    "  endpoint,",
    "  // Surfaced rather than swallowed: a message the codec refused is the difference between a widget that is",
    "  // quiet and a widget whose messages are not arriving.",
    '  onRejected: (rejection) => window.dispatchEvent(new CustomEvent("clarkcant:rejected", { detail: rejection })),',
    "});",
    "window.clarkcantWidget = runtime;",
    'window.removeEventListener("message", buffer);',
    'for (const message of pending) window.postMessage(message, "*");',
    "    } catch (error) {",
    "      window.__clarkcantBridgeError = String(error && error.message ? error.message : error);",
    "    }",
    "  })",
    "  .catch((error) => {",
    "    window.__clarkcantBridgeError = String(error && error.message ? error.message : error);",
    "  });",
    "</script>",
  ].join("\n");

  const closing = input.html.lastIndexOf("</body>");
  return closing === -1 ? `${input.html}\n${bootstrap}\n` : `${input.html.slice(0, closing)}${bootstrap}\n${input.html.slice(closing)}`;
}
