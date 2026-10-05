/**
 * The device pairing panel.
 *
 * Pairing is blocked behind an external gate: it needs two independent hosts, and this node has
 * only itself. The panel says what pairing is for, what it needs, and what would unblock it.
 *
 * It deliberately does not render a code to type into another machine. A pairing code that no
 * second host can accept is a credential-shaped thing that does nothing, and showing one would
 * imply a capability the node does not have.
 */

import { type ReactElement } from "react";

import { readableInstant } from "./blocks.tsx";
import type { MessageKey } from "./i18n/messages.ts";

export interface DevicePairingPanelProps {
  /** The node's own identifier, so the user can see which node is asking. */
  nodeId: string;
  nodeLabel: string;
  /** What an operator has to do. */
  unblockedBy: string;
  /** Nodes already paired, if any. Empty on a single-node install. */
  pairedNodes?: { nodeId: string; label: string; lastSeenAt: string }[];
  /** The interface language, for when a paired node was last seen. */
  locale?: string;
  /**
   * Passed in explicitly rather than read via `useT()`: this panel is exercised by plain function calls in
   * unit tests with no `LocaleProvider` mounted, so the translator has to arrive as data rather than through
   * a hook.
   */
  t: (key: MessageKey) => string;
}

export function DevicePairingPanel({
  nodeId,
  nodeLabel,
  unblockedBy,
  pairedNodes = [],
  locale = "vi",
  t,
}: DevicePairingPanelProps): ReactElement {
  return (
    <section className="cc-card" data-host-card="pairing" data-owner="host" data-paired-count={pairedNodes.length}>
      <header className="cc-card-head">
        <span className="cc-card-title">{t("settings.pairing.title")}</span>
        <span className="cc-badge" data-tone={pairedNodes.length === 0 ? "warn" : "ok"}>
          {pairedNodes.length === 0
            ? t("settings.pairing.unpaired")
            : `${pairedNodes.length} ${t("settings.pairing.pairedSuffix")}`}
        </span>
      </header>
      <div className="cc-card-body">
        <dl className="cc-fields">
          <dt>{t("settings.pairing.thisNode")}</dt>
          <dd>{nodeLabel}</dd>
          <dt>{t("settings.pairing.unblockedByLabel")}</dt>
          <dd data-pairing-unblocked-by="true">{unblockedBy}</dd>
        </dl>
        {pairedNodes.length === 0 ? (
          // The honest reason, in the product's own words rather than a generic "unavailable".
          <p className="cc-freshness" style={{ margin: 0 }} data-pairing-blocked="true">
            {t("settings.pairing.blocked")}
          </p>
        ) : (
          <ul className="cc-root-list">
            {pairedNodes.map((node) => (
              <li key={node.nodeId} data-paired-node={node.nodeId}>
                <span className="cc-setting-text">
                  <span className="cc-setting-label">{node.label}</span>
                  <code className="cc-setting-desc">{node.nodeId}</code>
                </span>
                <span className="cc-freshness">{readableInstant(node.lastSeenAt, locale)}</span>
              </li>
            ))}
          </ul>
        )}
        {/* The id is what a bug report or a second machine needs, not what a person reads to know which machine this is. */}
        <details className="cc-text-alt" data-pairing-references="true">
          <summary>{t("inbox.capability.details")}</summary>
          <code data-pairing-node-id="true">{nodeId}</code>
        </details>
      </div>
    </section>
  );
}
