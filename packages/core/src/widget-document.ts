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
}

/** The policy for a widget document. Returned rather than written as a header so a test can read it. */
export function widgetDocumentPolicy(input: { appOrigin: string; nonce: string }): string {
  return [
    "default-src 'none'",
    // The bundle comes from the app; the widget's own module and styles come from the node that is serving this
    // document, which is what `'self'` means here.
    `script-src 'nonce-${input.nonce}' 'self' ${input.appOrigin}`,
    // Widgets style themselves, and a stylesheet cannot reach the host. Inline styles stay allowed for the same
    // reason they are allowed in the app: they are how a component expresses its own layout.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    /*
     * Nothing. A widget's data arrives over the bridge, so a widget that reaches the network directly is either
     * redundant or trying to leave, and both are better refused than allowed and forgotten.
     */
    "connect-src 'none'",
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
  const bootstrap = [
    `<script type="module" nonce="${input.nonce}">`,
    `import { createWidgetRuntime } from ${JSON.stringify(`${input.appOrigin}/widget-runtime.js`)};`,
    "// The host is `parent`: this document is always the frame, never the window.",
    "const runtime = createWidgetRuntime({",
    "  endpoint: window.parent,",
    "  // Surfaced rather than swallowed: a message the codec refused is the difference between a widget that is",
    "  // quiet and a widget whose messages are not arriving.",
    '  onRejected: (rejection) => window.dispatchEvent(new CustomEvent("clarkcant:rejected", { detail: rejection })),',
    "});",
    "window.clarkcantWidget = runtime;",
    "</script>",
  ].join("\n");

  const closing = input.html.lastIndexOf("</body>");
  return closing === -1 ? `${input.html}\n${bootstrap}\n` : `${input.html.slice(0, closing)}${bootstrap}\n${input.html.slice(closing)}`;
}
