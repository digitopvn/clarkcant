/**
 * The token specimens.
 *
 * A readout of what the interface is actually built from: every type size, radius, spacing step,
 * duration and layout measurement, read back off the live document rather than printed from the
 * token objects. That distinction is the whole value — a token that never reaches a component
 * shows up here as missing, whereas printing the token objects would faithfully show a value that
 * nothing on screen is using.
 *
 * Pure by design: it holds no state and changes nothing. Anything a user can *set* belongs in the
 * settings surface; this only reports.
 */

import { type ReactElement } from "react";

const TYPE_SPECIMENS: { token: string; sample: string }[] = [
  { token: "display-xl", sample: "Conversation is the interface" },
  { token: "display-lg", sample: "What would you like to do?" },
  { token: "heading-lg", sample: "A section heading" },
  { token: "heading-md", sample: "A card heading" },
  { token: "body-lg", sample: "Lead paragraph text at the largest body size." },
  {
    token: "body-md",
    sample: "Body copy. This is what a message is set in, and the size most text in the product uses.",
  },
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

const DURATIONS = ["micro", "normal", "panel", "orb"];

const LAYOUT_MEASUREMENTS: { name: string; variable: string }[] = [
  { name: "conversation", variable: "--cc-conversation-max-width" },
  { name: "composer", variable: "--cc-composer-max-width" },
  { name: "top bar", variable: "--cc-topbar-height" },
];

/** Read one custom property off the document. Empty when there is no document to read. */
export function readVar(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function TokenSpecimens(): ReactElement {
  return (
    <>
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
          {DURATIONS.map((name) => (
            <li key={name}>
              <span>{name}</span>
              <span>{readVar(`--cc-motion-${name}`)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="cc-panel-section">
        <h3>Layout</h3>
        <ul className="cc-panel-readout">
          {LAYOUT_MEASUREMENTS.map((item) => (
            <li key={item.variable}>
              <span>{item.name}</span>
              <span>{readVar(item.variable)}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
