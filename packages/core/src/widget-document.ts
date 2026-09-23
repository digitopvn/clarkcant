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

export interface WidgetDocumentInput {
  /** The author's entry file, as it is on disk. */
  html: string;
  /**
   * Where the app — and therefore the runtime bundle — is served from.
   *
   * Also the only origin allowed to frame this document. A widget document is not a page to be embedded anywhere;
   * it is one surface of one conversation.
   */
  appOrigin: string;
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

export type AppOriginOutcome =
  | { ok: true; origin: string }
  | { ok: false; code: "CC_APP_ORIGIN_INVALID" | "HOST_HEADER_INVALID"; message: string };

/**
 * Where `frame-ancestors` in a widget document's policy points.
 *
 * `CC_APP_ORIGIN`, when set, must be exactly an origin — scheme, host, optional port, nothing else. `new
 * URL(value).origin` both parses and normalises it, so a value with a path, query, credentials, or trailing
 * slash (all of which round-trip through `URL` without becoming equal to the input) is rejected rather than
 * silently truncated into the directive.
 *
 * Without the variable set, the previous behaviour trusted the request's own `Host` header unchecked: a header a
 * client controls, fed straight into a CSP directive that says who may frame this document. A request naming a
 * `Host` with a scheme, a path, or characters `URL` cannot parse as a bare `host[:port]` is refused rather than
 * served with a directive built from whatever arrived — refusing to serve is the fail-closed choice for a value
 * this function cannot make sense of.
 */
export function resolveAppOrigin(input: {
  configured: string | undefined;
  /** Node's HTTP headers type allows a header to repeat; only the first value is ever meaningful for `Host`. */
  hostHeader: string | string[] | undefined;
}): AppOriginOutcome {
  if (input.configured !== undefined && input.configured !== "") {
    try {
      const url = new URL(input.configured);
      if (url.origin !== input.configured || (url.protocol !== "http:" && url.protocol !== "https:")) {
        throw new Error("not a bare http(s) origin");
      }
      return { ok: true, origin: url.origin };
    } catch {
      return {
        ok: false,
        code: "CC_APP_ORIGIN_INVALID",
        message: `CC_APP_ORIGIN must be a bare http(s) origin (scheme://host[:port], no path); got ${JSON.stringify(input.configured)}`,
      };
    }
  }

  const host = Array.isArray(input.hostHeader) ? input.hostHeader[0] : input.hostHeader;
  // No `Host` at all is not attacker input — there is nothing to have injected — so it falls back to a fixed,
  // known-safe local origin rather than being refused. Refusing only starts once a `Host` value actually arrived
  // and turned out not to be a bare `host[:port]`.
  if (host === undefined || host === "") {
    return { ok: true, origin: "http://127.0.0.1" };
  }
  try {
    // A bare `host[:port]` has no scheme of its own, so it is parsed as the host component of a URL rather than
    // as a URL itself; anything that does not survive that round-trip (a scheme, a path, whitespace, control
    // characters) is not a value this function will turn into a CSP directive.
    const probe = new URL(`http://${host}`);
    if (probe.host !== host || probe.pathname !== "/" || probe.search !== "" || probe.username !== "" || probe.password !== "") {
      throw new Error("not a bare host[:port]");
    }
    return { ok: true, origin: `http://${host}` };
  } catch {
    return {
      ok: false,
      code: "HOST_HEADER_INVALID",
      message: `the request's Host header is not a bare host[:port] and CC_APP_ORIGIN is not configured; got ${JSON.stringify(host)}`,
    };
  }
}

/** The policy for a widget document. Returned rather than written as a header so a test can read it. */
export function widgetDocumentPolicy(input: { appOrigin: string; nonce: string; allowedOrigins?: readonly string[] }): string {
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
    `connect-src ${(input.allowedOrigins ?? []).length === 0 ? "'none'" : (input.allowedOrigins ?? []).join(" ")}`,
    `frame-ancestors ${input.appOrigin}`,
    "base-uri 'none'",
    "form-action 'none'",
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
     * The host's `init` is buffered here, synchronously, because of an ordering problem this code created.
     *
     * The runtime starts listening when it is created, and it is created inside the dynamic import below — which
     * resolves after the document's `load`. The host posts `init` on `load`, so the message can arrive before there is
     * anything to receive it: the frame then waits for a handshake it already missed, shows `loading` forever, and
     * reports nothing. Registering the listener during module evaluation and replaying what arrived closes that gap.
     * It is the frame's own glue and not a second protocol, and `init` is idempotent on the runtime side, so a replay
     * that turns out to be unnecessary does nothing.
     */
    "let pendingInit = null;",
    "const bufferInit = (event) => {",
    '  if (event.data !== null && typeof event.data === "object" && event.data.kind === "init") pendingInit = event.data;',
    "};",
    'window.addEventListener("message", bufferInit);',
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
    'window.removeEventListener("message", bufferInit);',
    'if (pendingInit !== null) window.postMessage(pendingInit, "*");',
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
