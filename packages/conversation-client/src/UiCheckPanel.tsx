/**
 * The UI check panel.
 *
 * This is the design system's own inspector, mounted inside the product rather than in a
 * separate storybook. That placement is the point: a specimen page can be perfectly
 * consistent while the shipping screen is not, and the only way to be sure a token is
 * actually reaching a component is to read it back off the live document.
 *
 * It also computes contrast while you look at it. The accessibility claim in
 * `@clarkcant/design-tokens` is measured, so an override that breaks it should say so here
 * rather than being discovered by a user who cannot read the text.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { contrastRatio, AA_NORMAL_TEXT, DARK, LIGHT, type ThemeName } from "@clarkcant/design-tokens";

export interface UiCheckPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Accents worth comparing.
 *
 * The first is the specification's. The second is the saturated indigo this palette
 * replaced, kept so the difference the "quiet chrome" decision makes can be seen rather
 * than argued about.
 */
const ACCENT_CHOICES: { label: string; dark: string; light: string; note: string }[] = [
  { label: "Spec lavender", dark: "#B8AEDC", light: "#6B5FA8", note: "specification" },
  { label: "Previous indigo", dark: "#7C7CF5", light: "#4F46E5", note: "replaced" },
  { label: "Muted sage", dark: "#9BBFAC", light: "#41705A", note: "" },
  { label: "Clay", dark: "#D2A69C", light: "#8E5449", note: "" },
];

const TYPE_SPECIMENS: { token: string; sample: string }[] = [
  { token: "display-xl", sample: "Conversation is the interface" },
  { token: "display-lg", sample: "What would you like to do?" },
  { token: "heading-lg", sample: "A section heading" },
  { token: "heading-md", sample: "A card heading" },
  { token: "body-lg", sample: "Lead paragraph text at the largest body size." },
  { token: "body-md", sample: "Body copy. This is what a message is set in, and the size most text in the product uses." },
  { token: "body-sm", sample: "Dense body copy, used inside cards where space is tighter." },
  { token: "label", sample: "Button and field label" },
  { token: "meta", sample: "11px — timestamps, counts, provenance" },
  { token: "mono-sm", sample: "sha256:9f2c…a41b" },
];

const RADIUS_SPECIMENS: { token: string; use: string }[] = [
  { token: "badge", use: "chips" },
  { token: "button", use: "buttons" },
  { token: "card", use: "compact card" },
  { token: "response", use: "response / composer" },
  { token: "modal", use: "modal" },
  { token: "pill", use: "pills" },
];

const SPACE_STEPS = ["xs", "sm", "md", "lg", "s20", "xl", "xxl", "s40", "s48", "s64", "s80"];

function readVar(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function UiCheckPanel({ open, onClose }: UiCheckPanelProps) {
  const [theme, setTheme] = useState<ThemeName>("dark");
  const [accentIndex, setAccentIndex] = useState(0);
  // Bumped after a theme or accent change so the readouts re-read the computed values
  // instead of reporting the ones from before the change.
  const [revision, setRevision] = useState(0);

  const applyTheme = useCallback((next: ThemeName) => {
    // The installed sheet already carries both themes, so switching is only a matter of which
    // one the root selects. Calling `installStyles` here would also work, but it lives in this
    // package's entry point, and importing it would make the entry point import this file
    // import the entry point.
    document.documentElement.dataset.ccTheme = next;
    setTheme(next);
    setRevision((n) => n + 1);
  }, []);

  const applyAccent = useCallback(
    (index: number) => {
      const choice = ACCENT_CHOICES[index]!;
      const root = document.documentElement;
      const value = theme === "dark" ? choice.dark : choice.light;
      root.style.setProperty("--cc-accent", value);
      // The label colour is chosen, not assumed: a pale accent needs dark text on it and a
      // saturated one needs light, and picking wrong is the classic unreadable-button bug.
      const tokens = theme === "dark" ? DARK : LIGHT;
      root.style.setProperty(
        "--cc-on-accent",
        contrastRatio("#ffffff", value) >= contrastRatio(tokens.canvas, value) ? "#ffffff" : tokens.canvas,
      );
      setAccentIndex(index);
      setRevision((n) => n + 1);
    },
    [theme],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Re-read the accent when the theme changes, so switching theme does not leave the
  // other theme's accent painted over the new one.
  useEffect(() => {
    if (!open) return;
    const choice = ACCENT_CHOICES[accentIndex]!;
    const root = document.documentElement;
    const value = theme === "dark" ? choice.dark : choice.light;
    const tokens = theme === "dark" ? DARK : LIGHT;
    root.style.setProperty("--cc-accent", value);
    root.style.setProperty(
      "--cc-on-accent",
      contrastRatio("#ffffff", value) >= contrastRatio(tokens.canvas, value) ? "#ffffff" : tokens.canvas,
    );
    setRevision((n) => n + 1);
  }, [open, theme, accentIndex]);

  const readouts = useMemo(() => {
    void revision;
    const accent = readVar("--cc-accent");
    const card = readVar("--cc-card");
    const canvas = readVar("--cc-canvas");
    const muted = readVar("--cc-text-muted");
    const tertiary = readVar("--cc-text-tertiary");
    const onAccent = readVar("--cc-on-accent");
    const pairs = [
      { what: "label on accent", foreground: onAccent, background: accent },
      { what: "body text on card", foreground: readVar("--cc-text"), background: card },
      { what: "caption text on card", foreground: muted, background: card },
      { what: "tertiary text on canvas", foreground: tertiary, background: canvas },
    ];
    return pairs
      .filter((pair) => pair.foreground !== "" && pair.background !== "")
      .map((pair) => ({ ...pair, ratio: contrastRatio(pair.foreground, pair.background) }));
  }, [revision]);

  if (!open) return null;

  return (
    <>
      <div className="cc-panel-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="cc-panel" role="dialog" aria-modal="true" aria-labelledby="cc-panel-title">
        <header className="cc-panel-head">
          <h2 id="cc-panel-title">UI Check</h2>
          <button type="button" className="cc-icon-btn" onClick={onClose} aria-label="Đóng bảng UI Check">
            ✕
          </button>
        </header>

        <div className="cc-panel-body">
          <section className="cc-panel-section">
            <h3>Theme</h3>
            <div className="cc-panel-row">
              {(["dark", "light"] as ThemeName[]).map((name) => (
                <button
                  key={name}
                  type="button"
                  className="cc-badge"
                  aria-pressed={theme === name}
                  data-selected={theme === name}
                  onClick={() => applyTheme(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </section>

          <section className="cc-panel-section">
            <h3>Accent</h3>
            <div className="cc-panel-row">
              {ACCENT_CHOICES.map((choice, index) => (
                <button
                  key={choice.label}
                  type="button"
                  className="cc-swatch"
                  aria-pressed={accentIndex === index}
                  aria-label={`${choice.label}${choice.note ? ` (${choice.note})` : ""}`}
                  onClick={() => applyAccent(index)}
                  style={{ background: theme === "dark" ? choice.dark : choice.light }}
                />
              ))}
            </div>
            <p className="cc-panel-note">{ACCENT_CHOICES[accentIndex]!.label} — {ACCENT_CHOICES[accentIndex]!.note || "alternative"}</p>
          </section>

          <section className="cc-panel-section">
            <h3>Contrast, measured live</h3>
            <ul className="cc-panel-readout">
              {readouts.map((row) => (
                <li key={row.what} data-pass={row.ratio >= AA_NORMAL_TEXT}>
                  <span>{row.what}</span>
                  <span>
                    {row.ratio.toFixed(2)}:1 {row.ratio >= AA_NORMAL_TEXT ? "✓" : "✗ below 4.5"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="cc-panel-section">
            <h3>Type scale</h3>
            {TYPE_SPECIMENS.map((item) => (
              <p
                key={item.token}
                className="cc-specimen"
                style={{ fontSize: `var(--cc-text-${item.token})`, lineHeight: `var(--cc-leading-${item.token})` }}
              >
                {item.sample}
                <span className="cc-specimen-token">--cc-text-{item.token}</span>
              </p>
            ))}
          </section>

          <section className="cc-panel-section">
            <h3>Radius</h3>
            <div className="cc-panel-row">
              {RADIUS_SPECIMENS.map((item) => (
                <div key={item.token} className="cc-radius-demo" style={{ borderRadius: `var(--cc-radius-${item.token})` }}>
                  <code>{item.token}</code>
                  <span>{item.use}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="cc-panel-section">
            <h3>Spacing</h3>
            <ul className="cc-panel-space">
              {SPACE_STEPS.map((step) => (
                <li key={step}>
                  <code>{step}</code>
                  <span className="cc-space-bar" style={{ width: `var(--cc-space-${step})` }} />
                  <span className="cc-space-value">{readVar(`--cc-space-${step}`)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="cc-panel-section">
            <h3>Motion</h3>
            <ul className="cc-panel-readout">
              <li><span>micro</span><span>{readVar("--cc-motion-micro")}</span></li>
              <li><span>normal</span><span>{readVar("--cc-motion-normal")}</span></li>
              <li><span>panel</span><span>{readVar("--cc-motion-panel")}</span></li>
              <li><span>orb</span><span>{readVar("--cc-motion-orb")}</span></li>
            </ul>
          </section>

          <section className="cc-panel-section">
            <h3>Layout</h3>
            <ul className="cc-panel-readout">
              <li><span>conversation</span><span>{readVar("--cc-conversation-max-width")}</span></li>
              <li><span>composer</span><span>{readVar("--cc-composer-max-width")}</span></li>
              <li><span>top bar</span><span>{readVar("--cc-topbar-height")}</span></li>
            </ul>
          </section>
        </div>
      </aside>
    </>
  );
}
