import type { CSSProperties, ReactElement, RefObject } from "react";

import type { Suggestion } from "@clarkcant/contracts";
import { useT } from "./i18n/locale-context.tsx";
import type { MessageKey } from "./i18n/messages.ts";
import type { HeroPhase } from "./use-hero-orb-layout.ts";

/**
 * The four things the empty state offers.
 *
 * Four, and every one of them actually runs. The first three reach a scripted recipe over the
 * sample dataset, so they work with no provider configured; the fourth is an ordinary message and
 * needs a model to answer it. Nothing here is a label that looks like a feature — a chip that sends
 * a message nobody can handle teaches the user that the app is broken rather than that a model is
 * missing, and the fourth chip says which of those is true.
 */
/**
 * The static suggestion chips, with their `text` fixed regardless of UI language.
 *
 * `text` is the message the chip actually sends — a scripted recipe trigger for the sample-data
 * chips — so it stays as written rather than following the interface language: translating it
 * would silently break the recipe match. Only `label`/`detail`, the visible chrome, are looked up
 * per locale by `suggestionsFor`.
 */
function suggestionsFor(t: (key: MessageKey) => string) {
  return [
    // `demo: true` is what makes these chips the only way a scripted sample runs: the label says the data is sample
    // data, and the flag is what the node reads to decide whether a scripted reply is allowed at all.
    { label: t("shell.hero.suggestion1Label"), text: "cho tui xem biểu đồ", detail: t("shell.hero.sampleDataDetail"), demo: true },
    { label: t("shell.hero.suggestion2Label"), text: "tạo note nhanh cho tui", detail: t("shell.hero.sampleDataDetail"), demo: true },
    { label: t("shell.hero.suggestion3Label"), text: "cho tui xem bảng dữ liệu", detail: t("shell.hero.sampleDataDetail"), demo: true },
    { label: t("shell.hero.suggestion4Label"), text: "chào bạn, bạn làm được gì?", detail: t("shell.hero.needsModelDetail"), demo: false },
  ] as const;
}

export interface ConversationHeroEmptyStateProps {
  heroPhase: HeroPhase;
  heroOrb: RefObject<HTMLDivElement | null>;
  needsModel: boolean | undefined;
  onOpenSettings: () => void;
  dynamicSuggestions: readonly Suggestion[];
  onSend: (text: string, options?: { demo?: boolean }) => void;
}

/**
 * The start screen: an orb anchor, the setup card when there is no model, and the suggestion
 * chips — the node's own dynamic set when it has one, the four written ones otherwise.
 *
 * Stays mounted while it leaves, out of the flow, so its chips can go one at a time: unmounting it
 * with the message that replaced it would take all four with it in the same frame, which is a
 * disappearance rather than an exit.
 */
export function ConversationHeroEmptyState({
  heroPhase,
  heroOrb,
  needsModel,
  onOpenSettings,
  dynamicSuggestions,
  onSend,
}: ConversationHeroEmptyStateProps): ReactElement | null {
  const t = useT();
  if (heroPhase === "gone") return null;
  const staticSuggestions = suggestionsFor(t);
  return (
    <div className="cc-empty" data-leaving={heroPhase === "leaving" ? "true" : "false"}>
      {/*
        Where the orb goes while the start screen is up. The orb itself is drawn in the layer
        behind the composer, and this is the space it is measured against — which is why it is
        reserved rather than drawn: the same element has to be able to be in two places, and
        only one of them can be a layout child.
      */}
      <div className="cc-hero-orb" ref={heroOrb} aria-hidden="true" />
      {needsModel === true ? (
        <div className="cc-card cc-setup-card" data-needs-model="true" role="status">
          <div className="cc-setting-text">
            <span className="cc-setting-label">{t("shell.hero.noModelTitle")}</span>
            <span className="cc-setting-desc">{t("shell.hero.noModelDesc")}</span>
          </div>
          {/* The control that leads there, rather than a sentence that only describes the gap. */}
          <button type="button" className="cc-chip" data-open-model-settings="true" onClick={onOpenSettings}>
            {t("shell.hero.openSettings")}
          </button>
        </div>
      ) : null}
      <h1>{t("shell.hero.heading")}</h1>
      <p>{t("shell.hero.subheading")}</p>
      {/*
        Two rows, not one row with two shapes in it. What the node offers is what the person was
        actually doing, and it is only shown when there is some; the four written chips are the floor,
        and saying so in the markup is what lets a test tell an empty node from a broken one.
      */}
      {dynamicSuggestions.length > 0 ? (
        <div className="cc-chip-row" data-suggestion-count={dynamicSuggestions.length}>
          {dynamicSuggestions.map((suggestion, index) => (
            <button
              key={suggestion.suggestionId}
              type="button"
              className="cc-chip"
              data-suggestion={suggestion.text}
              data-suggestion-source={suggestion.source}
              data-suggestion-source-label={suggestion.sourceLabel}
              style={{ "--cc-chip-index": index } as CSSProperties}
              aria-label={`${suggestion.label} — ${suggestion.sourceLabel}`}
              onClick={() => onSend(suggestion.text)}
            >
              <span className="cc-chip-label">{suggestion.label}</span>
              <span className="cc-chip-detail">{suggestion.sourceLabel}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="cc-chip-row" data-suggestion-count={staticSuggestions.length} data-suggestion-static="true">
          {staticSuggestions.map((suggestion, index) => (
            <button
              key={suggestion.text}
              type="button"
              className="cc-chip"
              data-suggestion={suggestion.text}
              data-suggestion-detail={suggestion.detail}
              style={{ "--cc-chip-index": index } as CSSProperties}
              // The detail is in the accessible name as well as visible text, because a person
              // using a screen reader has the same question about which chips need a model.
              aria-label={`${suggestion.label} — ${suggestion.detail}`}
              onClick={() => onSend(suggestion.text, { demo: suggestion.demo === true })}
            >
              <span className="cc-chip-label">{suggestion.label}</span>
              <span className="cc-chip-detail">{suggestion.detail}</span>
            </button>
          ))}
        </div>
      )}
      <p className="cc-freshness">{t("shell.hero.footerNote")}</p>
    </div>
  );
}
