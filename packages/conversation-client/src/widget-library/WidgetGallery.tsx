import { type ReactElement } from "react";

import type { WidgetCatalogEntry } from "@clarkcant/widget-catalog";

import { useT } from "../i18n/locale-context.tsx";
import { WidgetPreview } from "./WidgetPreview.tsx";

/**
 * The gallery.
 *
 * Two decisions are visible here.
 *
 * **Media and embeds are not mounted in the grid.** The production renderers for YouTube and video
 * create an `<iframe>` and a `<video>`; a grid that mounted every card at once would issue requests to
 * a third party and load media merely because somebody opened a catalogue. Those cards show the
 * widget's own text alternative and say the live view is one step away.
 *
 * **The card is a button.** Pointer, keyboard and voice all reach the same `select` action, and hover
 * reveals nothing that is not also reachable by focus.
 */

/** Definitions whose renderer reaches outside the document, so a grid is the wrong place to draw them. */
const EMBEDDED_DEFINITION_IDS: readonly string[] = [
  "canvas.youtube@1",
  "canvas.video@1",
  "canvas.image@1",
  "canvas.carousel@1",
  "canvas.gallery@1",
];

export function isEmbeddedPreview(definitionId: string): boolean {
  return EMBEDDED_DEFINITION_IDS.includes(definitionId);
}

export interface WidgetGalleryProps {
  entries: readonly WidgetCatalogEntry[];
  onSelect: (cardId: string) => void;
}

export function WidgetGallery({ entries, onSelect }: WidgetGalleryProps): ReactElement {
  const t = useT();
  if (entries.length === 0) {
    return (
      <p className="cc-widget-library-empty" data-widget-library-empty="true" role="status">
        {t("widgets.gallery.noMatches")}
      </p>
    );
  }

  return (
    <ul className="cc-widget-grid" data-widget-grid="true">
      {entries.map((entry) => {
        const fixture = entry.fixtures[0];
        return (
          <li key={entry.cardId} className="cc-widget-card">
            <button
              type="button"
              className="cc-widget-card-btn"
              onClick={() => onSelect(entry.cardId)}
              aria-label={t("widgets.gallery.cardAria")
                .replace("{name}", entry.displayName)
                .replace("{description}", entry.description)}
              data-widget-card={entry.cardId}
            >
              <span className="cc-widget-card-preview">
                {fixture === undefined ? (
                  <span className="cc-widget-preview-missing" data-widget-preview-missing={entry.cardId}>
                    {t("widgets.gallery.noFixture")}
                  </span>
                ) : isEmbeddedPreview(entry.definition.id) ? (
                  // The text alternative the renderer itself would show, without the embed.
                  <span className="cc-widget-card-text" data-widget-preview-deferred={entry.cardId}>
                    {entry.definition.textFallback}
                  </span>
                ) : (
                  <WidgetPreview entry={entry} fixture={fixture} />
                )}
              </span>
              <span className="cc-widget-card-meta">
                <span className="cc-widget-card-name">{entry.displayName}</span>
                <span className="cc-widget-card-family">{entry.family}</span>
                <span className="cc-widget-card-desc">{entry.description}</span>
                <span className="cc-widget-card-source">
                  {entry.source === "builtin"
                    ? t("widgets.gallery.sourceBuiltin")
                    : entry.source === "installed"
                      ? t("widgets.gallery.sourceInstalled")
                      : t("widgets.gallery.sourceLocal")}
                  {entry.status === "experimental" ? t("widgets.gallery.experimentalSuffix") : ""}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
