/**
 * The dev host's shell: its state, its accessibility audit, and its markup.
 *
 * The dev host is a browser application, which is why this file is split the way it is. The state model and the
 * accessibility audit are plain functions with no DOM in them, so the behaviour an author relies on — switch the
 * fixture, check 320px, turn on reduced motion, deny a capability, see what the widget published — is testable
 * without a browser. The markup is a thin renderer over that state, and the in-page script only collects facts and
 * forwards actions.
 *
 * That split is not tidiness. A dev host whose logic lived in an inline `<script>` would be verified by nothing at
 * all, and the accessibility checks in particular are the ones most likely to be written as a badge that always
 * says "pass".
 */

export const DEV_VIEWPORTS = ["narrow-320", "conversation", "compact", "expanded"] as const;
export type DevViewport = (typeof DEV_VIEWPORTS)[number];

export const DEV_THEMES = ["dark", "light", "system"] as const;
export type DevTheme = (typeof DEV_THEMES)[number];

/** The widths the standard names, with 320 as the floor rather than an afterthought. */
export const VIEWPORT_WIDTHS: Record<DevViewport, number> = {
  "narrow-320": 320,
  conversation: 480,
  compact: 720,
  expanded: 1024,
};

export interface DevShellState {
  fixture: string;
  viewport: DevViewport;
  theme: DevTheme;
  reducedMotion: boolean;
  offline: boolean;
  readOnly: boolean;
  /** Declared capabilities, and what the simulator has decided for each. */
  capabilities: Record<string, "granted" | "denied">;
}

export interface DevShellAction {
  kind: "fixture" | "viewport" | "theme" | "reduced-motion" | "offline" | "read-only" | "capability";
  value: string | boolean;
}

export function initialState(input: {
  fixtures: readonly string[];
  requestedCapabilities: readonly string[];
}): DevShellState {
  const first = input.fixtures[0] ?? "default";
  return {
    fixture: first,
    viewport: "conversation",
    theme: "system",
    reducedMotion: false,
    offline: false,
    readOnly: false,
    /*
     * Denied by default. A simulator that granted everything would let an author ship a widget that only works
     * when every capability is available, which is the state their users are least likely to be in.
     */
    capabilities: Object.fromEntries(input.requestedCapabilities.map((ref) => [ref, "denied" as const])),
  };
}

export function applyShellAction(
  state: DevShellState,
  action: DevShellAction,
  known: { fixtures: readonly string[]; capabilities: readonly string[] },
): DevShellState {
  switch (action.kind) {
    case "fixture":
      // An unknown fixture is ignored rather than selected: a shell that showed an empty widget for a typo would
      // look like the widget's bug.
      return typeof action.value === "string" && known.fixtures.includes(action.value)
        ? { ...state, fixture: action.value }
        : state;
    case "viewport":
      return typeof action.value === "string" && (DEV_VIEWPORTS as readonly string[]).includes(action.value)
        ? { ...state, viewport: action.value as DevViewport }
        : state;
    case "theme":
      return typeof action.value === "string" && (DEV_THEMES as readonly string[]).includes(action.value)
        ? { ...state, theme: action.value as DevTheme }
        : state;
    case "reduced-motion":
      return { ...state, reducedMotion: action.value === true };
    case "offline":
      return { ...state, offline: action.value === true };
    case "read-only":
      return { ...state, readOnly: action.value === true };
    case "capability": {
      const ref = typeof action.value === "string" ? action.value : "";
      // Only capabilities the package declared: the simulator stands in for what the host would broker, and a host
      // does not broker what the manifest never asked for.
      if (!known.capabilities.includes(ref)) return state;
      const current = state.capabilities[ref] ?? "denied";
      return { ...state, capabilities: { ...state.capabilities, [ref]: current === "granted" ? "denied" : "granted" } };
    }
  }
}

/** The attributes the shell carries, so what the switchers did is visible in the markup as well as on screen. */
export function shellAttributes(state: DevShellState): Record<string, string> {
  return {
    "data-dev-fixture": state.fixture,
    "data-dev-viewport": state.viewport,
    "data-dev-width": String(VIEWPORT_WIDTHS[state.viewport]),
    "data-dev-theme": state.theme,
    "data-dev-reduced-motion": String(state.reducedMotion),
    "data-dev-offline": String(state.offline),
    "data-dev-read-only": String(state.readOnly),
  };
}

/* ------------------------------------------------------------------ a11y */

/**
 * What the accessibility audit is told about the rendered frame.
 *
 * Facts rather than a DOM: the audit is a decision about facts, and keeping it that way is what lets the checks be
 * tested. Collecting the facts needs a browser; deciding what they mean does not.
 */
export interface FrameFacts {
  /** Elements a keyboard can reach, in order, with whether the focus ring is visible. */
  tabbable: readonly { name: string; focusVisible: boolean }[];
  /** Interactive elements and their rendered size in CSS pixels. */
  targets: readonly { name: string; width: number; height: number }[];
  /** Images and whether each has a text alternative. */
  images: readonly { src: string; alt: string }[];
  /** Whether the frame's text was rendered over an animated background. */
  textOverMotion: boolean;
  /** Whether anything in the frame animates with a zero duration. */
  zeroDurationAnimation: boolean;
  /** The text alternative the definition declares. */
  declaredTextFallback: string;
}

export interface A11yFinding {
  id: string;
  severity: "error" | "warning";
  message: string;
}

/**
 * Audit the frame.
 *
 * The checks are the ones this project has rules about, and two of them are here because they are the two a
 * reviewer cannot see: a zero-duration infinite spinner is a bug rather than a reduced-motion implementation, and
 * text over an animated background is unreadable for exactly the people the animation was meant to help.
 */
export function auditFrame(facts: FrameFacts, state: { reducedMotion: boolean }): A11yFinding[] {
  const findings: A11yFinding[] = [];

  const unreachable = facts.tabbable.filter((element) => !element.focusVisible);
  if (unreachable.length > 0) {
    findings.push({
      id: "focus-visible",
      severity: "error",
      message: `focus is not visible on: ${unreachable.map((element) => element.name).join(", ")}`,
    });
  }
  if (facts.tabbable.length === 0) {
    // A frame with nothing focusable is fine only if it has nothing interactive, which the fact set cannot say.
    findings.push({
      id: "no-tab-stops",
      severity: "warning",
      message: "nothing in the frame is reachable by keyboard; confirm it has no interactive elements",
    });
  }

  const small = facts.targets.filter((target) => target.width < 24 || target.height < 24);
  if (small.length > 0) {
    findings.push({
      id: "target-size",
      severity: "error",
      message: `touch targets under 24px: ${small.map((target) => `${target.name} (${String(target.width)}x${String(target.height)})`).join(", ")}`,
    });
  }

  const noAlt = facts.images.filter((image) => image.alt.trim() === "");
  if (noAlt.length > 0) {
    findings.push({
      id: "image-alt",
      severity: "error",
      message: `images without a text alternative: ${noAlt.map((image) => image.src).join(", ")}`,
    });
  }

  if (facts.textOverMotion) {
    findings.push({
      id: "text-over-motion",
      severity: "error",
      message: "text is rendered over an animated background; readability has to win",
    });
  }
  if (facts.zeroDurationAnimation) {
    // The rule is explicit: this is a bug, not a reduced-motion implementation.
    findings.push({
      id: "zero-duration-animation",
      severity: "error",
      message: "an animation has a zero duration; that is a bug rather than reduced motion",
    });
  }
  if (state.reducedMotion && facts.tabbable.length > 0 && facts.tabbable.some((element) => !element.focusVisible)) {
    findings.push({
      id: "reduced-motion-focus",
      severity: "warning",
      message: "reduced motion is on and focus is still not visible",
    });
  }
  if (facts.declaredTextFallback.trim() === "") {
    findings.push({
      id: "text-fallback",
      severity: "error",
      message: "no text fallback is declared, so a reader who cannot see the frame gets nothing",
    });
  }

  return findings;
}

/* ----------------------------------------------------------------- shell */

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export interface ShellInput {
  packageId: string;
  definitionId: string;
  fixtures: readonly string[];
  requestedCapabilities: readonly string[];
  entryUrl: string;
  definition: { textFallback: string; semanticDescription: string };
}

/**
 * The shell markup.
 *
 * The in-page script collects facts from the frame and forwards control changes; every decision it might make is a
 * function in this file instead. The frame is sandboxed with an opaque origin and no `allow-same-origin`, which is
 * the same policy the host applies — a dev host that relaxed it would let an author ship something that only works
 * in development.
 */
export function renderShell(input: ShellInput, state: DevShellState): string {
  const attributes = Object.entries(shellAttributes(state))
    .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
    .join(" ");

  const fixtureButtons = input.fixtures
    .map(
      (name) =>
        `<button type="button" data-dev-action="fixture" data-dev-value="${escapeHtml(name)}"` +
        `${state.fixture === name ? ' data-dev-selected="true"' : ""}>${escapeHtml(name)}</button>`,
    )
    .join("\n        ");

  const viewportButtons = DEV_VIEWPORTS.map(
    (name) =>
      `<button type="button" data-dev-action="viewport" data-dev-value="${name}"` +
      `${state.viewport === name ? ' data-dev-selected="true"' : ""}>${name} (${String(VIEWPORT_WIDTHS[name])}px)</button>`,
  ).join("\n        ");

  const themeButtons = DEV_THEMES.map(
    (name) =>
      `<button type="button" data-dev-action="theme" data-dev-value="${name}"` +
      `${state.theme === name ? ' data-dev-selected="true"' : ""}>${name}</button>`,
  ).join("\n        ");

  const toggles = (
    [
      ["reduced-motion", "reduced motion", state.reducedMotion],
      ["offline", "offline", state.offline],
      ["read-only", "read-only", state.readOnly],
    ] as const
  )
    .map(
      ([kind, label, on]) =>
        `<label><input type="checkbox" data-dev-action="${kind}"${on ? " checked" : ""} /> ${label}</label>`,
    )
    .join("\n        ");

  const capabilityRows =
    input.requestedCapabilities.length === 0
      ? "<p>This widget requests no capabilities.</p>"
      : input.requestedCapabilities
          .map((ref) => {
            const granted = state.capabilities[ref] === "granted";
            return (
              `<label><input type="checkbox" data-dev-action="capability" data-dev-value="${escapeHtml(ref)}"` +
              `${granted ? " checked" : ""} /> ${escapeHtml(ref)} — ${granted ? "granted" : "denied"}</label>`
            );
          })
          .join("\n        ");

  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>dev — ${escapeHtml(input.definitionId)}</title>
    <style>
      :root { color-scheme: dark light; --bg: #0b0b0c; --fg: #f4f4f5; --muted: #a1a1aa; --line: #27272a; }
      [data-dev-theme="light"] { --bg: #fafafa; --fg: #18181b; --muted: #52525b; --line: #e4e4e7; }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
      header, aside { padding: 12px; border-bottom: 1px solid var(--line); }
      main { display: grid; grid-template-columns: 1fr 360px; min-height: 100vh; }
      .stage { padding: 16px; }
      .frame-holder { width: var(--frame-width, 480px); max-width: 100%; border: 1px solid var(--line); }
      iframe { width: 100%; height: 420px; border: 0; background: #fff; display: block; }
      button { background: transparent; color: inherit; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; cursor: pointer; }
      button[data-dev-selected="true"] { border-color: currentColor; }
      button:focus-visible, input:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }
      aside { border-left: 1px solid var(--line); border-bottom: 0; display: grid; gap: 16px; align-content: start; }
      aside section { display: grid; gap: 6px; }
      h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0; }
      pre { margin: 0; padding: 8px; border: 1px solid var(--line); border-radius: 6px; max-height: 180px; overflow: auto; font-size: 12px; }
      .row { display: flex; flex-wrap: wrap; gap: 6px; }
      [data-dev-findings] li { margin-bottom: 4px; }
      [data-dev-findings] li[data-severity="error"] { color: #fca5a5; }
    </style>
  </head>
  <body ${attributes}>
    <header>
      <strong>${escapeHtml(input.packageId)}</strong> · <code>${escapeHtml(input.definitionId)}</code>
      <div class="row" style="margin-top: 8px">
        ${fixtureButtons}
      </div>
      <div class="row" style="margin-top: 6px">
        ${viewportButtons}
      </div>
      <div class="row" style="margin-top: 6px">
        ${themeButtons}
      </div>
      <div class="row" style="margin-top: 6px">
        ${toggles}
      </div>
    </header>
    <main>
      <div class="stage">
        <div class="frame-holder">
          <!--
            An opaque origin and no allow-same-origin, the same policy the host applies. A dev host that relaxed it
            would let an author ship a widget that only works in development.
          -->
          <iframe
            data-dev-frame
            title="${escapeHtml(input.definition.textFallback)}"
            sandbox="allow-scripts"
            src="${escapeHtml(input.entryUrl)}"
          ></iframe>
        </div>
        <p data-dev-semantic-description>${escapeHtml(input.definition.semanticDescription)}</p>
      </div>
      <aside>
        <section>
          <h2>Semantic</h2>
          <pre data-dev-semantic>chưa publish gì</pre>
        </section>
        <section>
          <h2>Action log</h2>
          <pre data-dev-log></pre>
        </section>
        <section>
          <h2>Capability simulator</h2>
          ${capabilityRows}
        </section>
        <section>
          <h2>Accessibility</h2>
          <ul data-dev-findings></ul>
          <button type="button" data-dev-action="a11y-audit">Kiểm tra lại</button>
        </section>
      </aside>
    </main>
    <script type="module" src="/dev/shell.js"></script>
  </body>
</html>
`;
}
