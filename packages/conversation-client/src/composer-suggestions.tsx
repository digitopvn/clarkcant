import type { ReactElement } from "react";

import { COMPOSER_REFERENCES_MAX, type ComposerSuggestion } from "@clarkcant/contracts";

import { useT } from "./i18n/locale-context.tsx";
import type { MessageKey } from "./i18n/messages.ts";
import type { ComposerReferencesState } from "./use-composer-references.ts";

export const COMPOSER_LISTBOX_ID = "cc-composer-references";

export function composerOptionId(index: number): string {
  return `${COMPOSER_LISTBOX_ID}-${index}`;
}

const KIND_LABEL: Record<ComposerSuggestion["kind"], MessageKey> = {
  skill: "composer.references.kind.skill",
  project: "composer.references.kind.project",
  file: "composer.references.kind.file",
  folder: "composer.references.kind.folder",
  "mcp-server": "composer.references.kind.service",
  conversation: "composer.references.kind.conversation",
  "background-work": "composer.references.kind.work",
  notice: "composer.references.kind.notice",
  command: "composer.references.kind.command",
};

/**
 * The rows the composer offers after `/` or `@`, drawn right above the input.
 *
 * A listbox the textarea controls, so focus never leaves what the person is typing into: arrows move the active row,
 * Enter adds it, Tab goes into a project or folder, Escape closes the list and leaves the draft as it was. A row that
 * cannot be chosen stays visible with the reason, because a thing that vanished from the list reads as a thing that
 * was never there.
 */
export function ComposerSuggestions({ state }: { state: ComposerReferencesState }): ReactElement | null {
  const t = useT();
  if (!state.open || state.trigger === undefined) return null;
  const { suggestions, activeIndex, trigger } = state;
  const status = state.failed !== undefined
    ? t("composer.references.failed").replace("{reason}", state.failed)
    : state.full
      ? t("composer.references.full").replace("{max}", String(COMPOSER_REFERENCES_MAX))
      : suggestions.length === 0
        ? state.loading
          ? t("composer.references.loading")
          : t(trigger.trigger === "/" ? "composer.references.emptySkills" : "composer.references.empty")
        : undefined;

  return (
    <div className="cc-reference-picker" data-reference-picker={trigger.trigger}>
      <ul
        className="cc-reference-list"
        id={COMPOSER_LISTBOX_ID}
        role="listbox"
        aria-label={t(trigger.trigger === "/" ? "composer.references.skillsLabel" : "composer.references.mentionLabel")}
      >
        {suggestions.map((row, index) => {
          const opens = row.kind === "project" || row.kind === "folder";
          const disabledReason = row.kind === "command" ? undefined : row.disabledReason;
          const disabled = disabledReason !== undefined;
          return (
            <li
              key={row.key}
              id={composerOptionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={disabled}
              className="cc-reference-option"
              data-reference-option={row.label}
              data-reference-kind={row.kind}
              data-active={index === activeIndex ? "true" : "false"}
              // Mouse-down rather than click, and default prevented: the textarea keeps focus, so the caret the row
              // replaces is still where it was.
              onMouseDown={(event) => {
                event.preventDefault();
                state.choose(index, "pick");
              }}
              onMouseEnter={() => state.setActiveIndex(index)}
            >
              <span className="cc-reference-kind">{t(KIND_LABEL[row.kind])}</span>
              <span className="cc-reference-label">{row.trigger === "/" ? `/${row.label}` : row.label}</span>
              {disabled ? (
                <span className="cc-reference-note" data-reference-disabled="true">
                  {disabledReason}
                </span>
              ) : row.note === undefined ? null : (
                <span className="cc-reference-note">{row.note}</span>
              )}
              {opens && !disabled ? (
                <button
                  type="button"
                  className="cc-reference-open"
                  tabIndex={-1}
                  aria-label={t("composer.references.open").replace("{label}", row.label)}
                  title={t("composer.references.open").replace("{label}", row.label)}
                  data-reference-open={row.label}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    state.choose(index, "open");
                  }}
                >
                  ›
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {status === undefined ? (
        <p className="cc-reference-hint" aria-hidden="true">
          {t(trigger.trigger === "@" ? "composer.references.hintMention" : "composer.references.hint")}
        </p>
      ) : (
        <p className="cc-reference-status" role="status" data-reference-status="true">
          {status}
        </p>
      )}
    </div>
  );
}
