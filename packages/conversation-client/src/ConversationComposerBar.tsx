import type { ReactElement, RefObject } from "react";

import type { Timeline } from "./api.ts";
import { formatFileSize, type AttachmentChip } from "./attachments.ts";
import { useT } from "./i18n/locale-context.tsx";
import { latestTurnMetrics, statuslineParts } from "./statusline.ts";

export interface ConversationComposerBarProps {
  composerWrap: RefObject<HTMLDivElement | null>;
  composerInput: RefObject<HTMLTextAreaElement | null>;
  attachmentInput: RefObject<HTMLInputElement | null>;
  dragging: boolean;
  setDragging: (dragging: boolean) => void;
  addFiles: (files: readonly File[]) => Promise<void>;
  chips: readonly AttachmentChip[];
  onRemoveChip: (id: string) => void;
  draft: string;
  setDraft: (draft: string) => void;
  placeholder: string;
  busy: boolean;
  onSubmit: () => void;
  onOpenVoice: () => void;
  modelAlias: string | undefined;
  modelNote: string;
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
  onRemoveChip,
  draft,
  setDraft,
  placeholder,
  busy,
  onSubmit,
  onOpenVoice,
  modelAlias,
  modelNote,
  error,
  messages,
}: ConversationComposerBarProps): ReactElement {
  const t = useT();
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
      onPaste={(event) => {
        const pasted = [...event.clipboardData.files];
        // Text paste stays the browser's business; only a file is intercepted.
        if (pasted.length === 0) return;
        event.preventDefault();
        void addFiles(pasted);
      }}
    >
      {/* The ring, drawn under the composer so the light travels around its edge rather than across it. */}
      <div className="cc-composer-shell">
        <span className="cc-composer-glow" aria-hidden="true" />
        {chips.length === 0 ? null : (
          <ul className="cc-chip-row" data-attachment-chips="true">
            {chips.map((chip) => (
              <li key={chip.id} className="cc-chip" data-attachment-chip={chip.filename} data-attachment-state={chip.state}>
                <span className="cc-chip-name">{chip.filename}</span>
                <span className="cc-chip-size">{formatFileSize(chip.sizeBytes)}</span>
                {/* The node's own sentence, shown where the file is: a refusal the person cannot read is
                    indistinguishable from a click that did nothing. */}
                {chip.state === "failed" ? <span className="cc-chip-reason">{chip.reason}</span> : null}
                <button
                  type="button"
                  className="cc-chip-remove"
                  aria-label={`Bỏ ${chip.filename}`}
                  data-attachment-remove={chip.id}
                  onClick={() => onRemoveChip(chip.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
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
          <textarea
            ref={composerInput}
            value={draft}
            aria-label={t("composer.input")}
            // The typed placeholder, and the plain one as soon as there is nothing to type — which
            // is also what a reduced-motion user sees, unchanged.
            placeholder={placeholder === "" ? t("composer.placeholder") : placeholder}
            rows={1}
            data-composer="true"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
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
          <button
            type="submit"
            className="cc-icon-btn"
            aria-label={t("composer.send")}
            disabled={busy || draft.trim() === ""}
            data-send="true"
          >
            ↑
          </button>
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
          <span className="cc-freshness" data-model-note="true">
            {modelNote === "" ? "⌘] để đổi" : modelNote}
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
          statuslineParts({ metrics: latestTurnMetrics(messages) }).map((part) => (
            <span key={part} className="cc-statusline-part">
              {part}
            </span>
          ))
        ) : (
          <span>{error}</span>
        )}
      </div>
    </div>
  );
}
