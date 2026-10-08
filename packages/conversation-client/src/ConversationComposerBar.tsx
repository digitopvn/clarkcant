import { useRef, type ReactElement, type RefObject } from "react";

import { referenceToken } from "@clarkcant/contracts";

import type { Timeline } from "./api.ts";
import { formatFileSize, type AttachmentChip } from "./attachments.ts";
import { ComposerMirror, useComposerMirror } from "./composer-mirror.tsx";
import { COMPOSER_LISTBOX_ID, ComposerSuggestions, composerOptionId } from "./composer-suggestions.tsx";
import { useT } from "./i18n/locale-context.tsx";
import { latestTurnMetrics, statuslineParts } from "./statusline.ts";
import type { ActiveModel } from "./use-active-model.ts";
import type { ComposerReferencesState } from "./use-composer-references.ts";
import { modelSwitchShortcut } from "./use-model-alias.ts";

export interface ConversationComposerBarProps {
  composerWrap: RefObject<HTMLDivElement | null>;
  composerInput: RefObject<HTMLTextAreaElement | null>;
  attachmentInput: RefObject<HTMLInputElement | null>;
  dragging: boolean;
  setDragging: (dragging: boolean) => void;
  addFiles: (files: readonly File[]) => Promise<void>;
  chips: readonly AttachmentChip[];
  /** The files are still here because a command answered the last message, and commands carry no files. */
  chipsKept?: boolean;
  onRemoveChip: (id: string) => void;
  /** The `/` and `@` picker, and the references chosen with it. */
  references?: ComposerReferencesState;
  draft: string;
  setDraft: (draft: string) => void;
  placeholder: string;
  busy: boolean;
  onSubmit: () => void;
  /** Stops the reply being written. While a reply is being written, Send becomes Stop in the same place. */
  onStop: () => void;
  onOpenVoice: () => void;
  modelAlias: string | undefined;
  modelNote: string;
  /** The model the next turn runs and its thinking level, drawn first on the statusline. */
  activeModel?: ActiveModel | null | undefined;
  error: string | undefined;
  messages: Timeline["messages"];
}

/**
 * The composer: the drop target, attachment chips, the input itself, and the two lines of status
 * beneath it (the active model, and the statusline).
 *
 * Every route a file can enter by — the picker, a drop, a paste — reaches `addFiles`, so the
 * ceiling and mime rules are enforced once rather than three times that could drift apart.
 */
export function ConversationComposerBar({
  composerWrap,
  composerInput,
  attachmentInput,
  dragging,
  setDragging,
  addFiles,
  chips,
  chipsKept = false,
  onRemoveChip,
  references,
  draft,
  setDraft,
  placeholder,
  busy,
  onSubmit,
  onStop,
  onOpenVoice,
  modelAlias,
  modelNote,
  activeModel,
  error,
  messages,
}: ConversationComposerBarProps): ReactElement {
  const t = useT();
  const mirror = useRef<HTMLDivElement>(null);
  useComposerMirror(composerInput, mirror, draft);
  return (
    <div
      className="cc-composer-wrap"
      ref={composerWrap}
      data-composer-drop={dragging ? "true" : "false"}
      onDragOver={(event) => {
        // `preventDefault` is what makes this element a drop target at all: without it the browser opens
        // the dropped file and the conversation is gone, which reads as the app having crashed.
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void addFiles([...event.dataTransfer.files]);
      }}
      onKeyDown={(event) => {
        // Escape stops a reply from anywhere in the composer, the button included. Only while one is being written,
        // so an idle Escape is left to whatever else listens for it.
        if (event.key === "Escape" && busy) {
          event.preventDefault();
          onStop();
        }
      }}
      onPaste={(event) => {
        const pasted = [...event.clipboardData.files];
        // Text paste stays the browser's business; only a file is intercepted.
        if (pasted.length === 0) return;
        event.preventDefault();
        void addFiles(pasted);
      }}
    >
      {references === undefined || references.live.length === 0 ? null : (
        // What the message will carry besides its text, beside the files: the same row a person already reads before
        // sending. Removing a chip also takes its token out of the draft, so the two never disagree.
        <ul className="cc-tray" data-reference-chips="true" aria-label={t("composer.references.chips")}>
          {references.live.map((entry) => (
            <li
              key={entry.key}
              className="cc-tray-chip"
              data-reference-chip={entry.ref.label}
              data-reference-kind={entry.ref.kind}
            >
              <span className="cc-chip-name">{referenceToken(entry.ref)}</span>
              <button
                type="button"
                className="cc-chip-remove"
                aria-label={t("composer.references.remove").replace("{label}", referenceToken(entry.ref))}
                data-reference-remove={entry.ref.label}
                onClick={() => references.remove(entry.key)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {chips.length === 0 ? null : (
        <ul className="cc-tray" data-attachment-chips="true">
          {chips.map((chip) => (
            <li key={chip.id} className="cc-tray-chip" data-attachment-chip={chip.filename} data-attachment-state={chip.state}>
              <span className="cc-chip-name">{chip.filename}</span>
              <span className="cc-chip-size">{formatFileSize(chip.sizeBytes)}</span>
              {/* The node's own sentence, shown where the file is: a refusal the person cannot read is
                  indistinguishable from a click that did nothing. */}
              {chip.state === "failed" ? <span className="cc-chip-reason">{chip.reason}</span> : null}
              <button
                type="button"
                className="cc-chip-remove"
                aria-label={t("composer.attachments.remove").replace("{name}", chip.filename)}
                data-attachment-remove={chip.id}
                onClick={() => onRemoveChip(chip.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* Beside the files it is about, so they are not mistaken for ones the last message carried. */}
      {chipsKept && chips.length > 0 ? (
        <p className="cc-tray-note" role="status" data-attachments-kept="true">
          {t("composer.attachments.keptForCommand")}
        </p>
      ) : null}
      {/* The ring, drawn under the composer so the light travels around its edge rather than across it. */}
      <div className="cc-composer-shell">
        <span className="cc-composer-glow" aria-hidden="true" />
        {references === undefined ? null : <ComposerSuggestions state={references} />}
        <form
          className="cc-composer"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <input
            ref={attachmentInput}
            type="file"
            multiple
            hidden
            data-attachment-input="true"
            onChange={(event) => {
              const chosen = [...(event.target.files ?? [])];
              // Cleared so choosing the same file twice in a row still fires a change event, which is what
              // a person does after removing a chip by mistake.
              event.target.value = "";
              void addFiles(chosen);
            }}
          />
          <button
            type="button"
            className="cc-icon-btn"
            aria-label={t("composer.attach")}
            title={t("composer.attach")}
            data-attachment-open="true"
            onClick={() => attachmentInput.current?.click()}
          >
            +
          </button>
          <div className="cc-composer-field">
            <ComposerMirror draft={draft} mirror={mirror} />
            <textarea
              ref={composerInput}
              value={draft}
              aria-label={t("composer.input")}
              // The typed placeholder, and the plain one as soon as there is nothing to type — which
              // is also what a reduced-motion user sees, unchanged.
              placeholder={placeholder === "" ? t("composer.placeholder") : placeholder}
              rows={1}
              data-composer="true"
              // The picker is a listbox this field controls, so focus stays where the person is typing.
              {...(references === undefined ? {} : { role: "combobox", "aria-autocomplete": "list" as const, "aria-expanded": references.open, "aria-controls": COMPOSER_LISTBOX_ID })}
              {...(references?.open === true && references.suggestions.length > 0
                ? { "aria-activedescendant": composerOptionId(references.activeIndex) }
                : {})}
              onChange={(event) => {
                setDraft(event.target.value);
                references?.track(event.currentTarget);
              }}
              onSelect={(event) => references?.track(event.currentTarget)}
              onBlur={references?.leave}
              onCompositionStart={() => references?.setComposing(true)}
              onCompositionEnd={(event) => {
                references?.setComposing(false);
                references?.track(event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (references?.onKeyDown(event) === true) return;
                // An input method still composing a word takes its own Enter to finish it; that is not a send.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
            />
          </div>
          <button
            type="button"
            className="cc-icon-btn"
            aria-label={t("composer.voice")}
            title={t("composer.voice")}
            data-voice-open="true"
            onClick={onOpenVoice}
          >
            ◉
          </button>
          {busy ? (
            <button
              type="button"
              className="cc-icon-btn"
              aria-label={t("composer.stop")}
              title={t("composer.stop")}
              data-stop="true"
              onClick={onStop}
            >
              ■
            </button>
          ) : (
            <button
              type="submit"
              className="cc-icon-btn"
              aria-label={t("composer.send")}
              disabled={draft.trim() === "" || chips.some((chip) => chip.state === "checking")}
              data-send="true"
            >
              ↑
            </button>
          )}
        </form>
      </div>
      {/*
        The model this conversation will continue on.

        Beside the composer because that is where the question is asked, and showing the alias rather than the
        provider and model id because that is what the person named it. The note under it is what the last press
        said — including that it applies to the next generation, which is the part a label alone would hide.
      */}
      {modelAlias !== undefined && (
        <div className="cc-model-switch" data-model-label={modelAlias}>
          <span className="cc-freshness">model: {modelAlias}</span>
          <span className="cc-freshness" data-model-note={modelNote === "" ? "shortcut" : "true"}>
            {modelNote === ""
              ? t("shell.model.switchHint").replace(
                  "{shortcut}",
                  modelSwitchShortcut(typeof navigator === "undefined" ? undefined : navigator.platform),
                )
              : modelNote}
          </span>
        </div>
      )}
      {/*
        A statusline, not a motto.

        This line used to hold a slogan and a keyboard hint, in the one place a harness reports itself: what
        the session has spent, how full its context is, how much came back from the cache, what it has cost.
        The numbers are the newest turn's, so a turn that reported nothing cannot wipe what the last real
        one said.
      */}
      <div className="cc-hint" data-statusline={error === undefined ? "true" : "false"}>
        {error === undefined ? (
          statuslineParts({ ...(activeModel === undefined || activeModel === null ? {} : { model: activeModel }), metrics: latestTurnMetrics(messages) }, t).map((part) => (
            <span key={part} className="cc-statusline-part">
              {part}
            </span>
          ))
        ) : (
          <span role="alert" data-send-error="true">{error}</span>
        )}
      </div>
    </div>
  );
}
