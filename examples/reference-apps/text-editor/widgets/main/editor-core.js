/*
 * The text editor's rules, without a DOM.
 *
 * Everything here is a pure function of its arguments, so the decisions that matter — what is unsaved, what is kept
 * across a reload, what Clark is shown, which draft wins when two views of one editor disagree, and which part of a
 * reply may touch the text — are tested without a browser. `main.js` is the frame code that calls them.
 *
 * A file reaches this code only as an ArtifactRef: a name, a type, a size and an opaque id. No function here takes or
 * returns a path, because nothing the host gives a widget has one.
 */

/** Bounds the editor keeps, each named for the host limit it follows. */
export const EDITOR_LIMITS = Object.freeze({
  /** The largest file the editor opens. Larger files are refused before any byte is read. */
  openBytes: 1_048_576,
  /** One read or write: the bridge's own chunk ceiling (`ARTIFACT_BRIDGE_LIMITS.chunkBytes`). */
  chunkBytes: 262_144,
  /**
   * The largest draft kept in widget state, measured as the JSON the host stores. The host keeps at most 16 KiB of
   * state per widget, and the refs and flags beside the draft need room too.
   */
  persistedDraftBytes: 12_288,
  /** What the host keeps of one semantic value (`SEMANTIC_LIMITS.string`), so the excerpt is never cut by the host. */
  excerptChars: 200,
  /** What the host returns of an agent reply. */
  replyChars: 2_000,
});

/** The text types the picker offers. The host's own allowlist still decides what it accepts. */
export const ACCEPTED_TYPES = Object.freeze(["text/plain", "text/markdown", "text/csv", "application/json"]);

/**
 * @typedef {object} FileRef
 * @property {1} v
 * @property {string} artifactId
 * @property {"attachment" | "working" | "finalized" | "external"} kind
 * @property {string} mimeType
 * @property {number} sizeBytes
 * @property {string} name
 * @property {string} [digest]
 */

/**
 * @typedef {object} EditorDocument
 * @property {FileRef} file The file the person opened. Its name and type are what a save offers back.
 * @property {FileRef} base The bytes the saved text was read from: the opened file, then the copy each save wrote.
 * @property {string} savedText The text as last opened or saved.
 * @property {string} draft The text on screen.
 * @property {boolean} baseUnreadable True when the saved text could not be read back, so nothing is known to be saved.
 */

/**
 * @typedef {object} PersistedEditorState
 * @property {FileRef | null} file
 * @property {FileRef | null} base
 * @property {string | null} draft The unsaved draft, or null when there is none or it is too large to keep.
 * @property {boolean} draftTooLarge True when there is an unsaved draft the state cannot hold.
 */

/** @typedef {{ start: number, end: number }} TextSelection */

/** A ref as the host sent it, checked for the fields this code reads; anything else is not a file this editor holds. */
export function isFileRef(value) {
  if (typeof value !== "object" || value === null) return false;
  const ref = /** @type {Record<string, unknown>} */ (value);
  return (
    ref.v === 1 &&
    typeof ref.artifactId === "string" &&
    /^art_[A-Za-z0-9_-]{1,120}$/.test(ref.artifactId) &&
    typeof ref.kind === "string" &&
    ["attachment", "working", "finalized", "external"].includes(ref.kind) &&
    typeof ref.mimeType === "string" &&
    typeof ref.sizeBytes === "number" &&
    Number.isInteger(ref.sizeBytes) &&
    ref.sizeBytes >= 0 &&
    typeof ref.name === "string" &&
    ref.name.length > 0
  );
}

/**
 * Lines as a person counts them: an empty file has none, and a final line break ends the last line rather than
 * starting another.
 *
 * @param {string} text
 */
export function lineCount(text) {
  if (text === "") return 0;
  const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return /(\r\n|\r|\n)$/.test(text) ? breaks : breaks + 1;
}

/**
 * @param {FileRef} file
 * @param {string} text
 * @returns {EditorDocument}
 */
export function openDocument(file, text) {
  return { file, base: file, savedText: text, draft: text, baseUnreadable: false };
}

/**
 * @param {EditorDocument} doc
 * @param {string} draft
 * @returns {EditorDocument}
 */
export function withDraft(doc, draft) {
  return { ...doc, draft };
}

/**
 * The document after a save: the text that was written becomes the saved text, and the copy holding it becomes the
 * base. The draft is left as it is now, so anything typed while the host's save prompt was open is still unsaved.
 *
 * @param {EditorDocument} doc
 * @param {FileRef} savedRef
 * @param {string} savedText
 * @returns {EditorDocument}
 */
export function markSaved(doc, savedRef, savedText) {
  return { ...doc, base: savedRef, savedText, baseUnreadable: false };
}

/** @param {EditorDocument | undefined} doc */
export function isDirty(doc) {
  if (doc === undefined) return false;
  return doc.baseUnreadable || doc.draft !== doc.savedText;
}

/** Bytes of a string as UTF-8. */
export function utf8Bytes(text) {
  return new globalThis.TextEncoder().encode(text).byteLength;
}

/**
 * What the editor keeps in widget state: which file, which saved bytes, and the unsaved draft when it fits.
 *
 * A draft too large for the state is not cut: a cut draft restored after a reload would look like the person's text
 * and be missing its end. It is left out and flagged, so the editor can say it was not kept.
 *
 * @param {EditorDocument | undefined} doc
 * @returns {PersistedEditorState}
 */
export function persistedState(doc) {
  if (doc === undefined) return { file: null, base: null, draft: null, draftTooLarge: false };
  const dirty = isDirty(doc);
  const fits = utf8Bytes(JSON.stringify(doc.draft)) <= EDITOR_LIMITS.persistedDraftBytes;
  return {
    file: doc.file,
    base: doc.base,
    draft: dirty && fits ? doc.draft : null,
    draftTooLarge: dirty && !fits,
  };
}

/**
 * Widget state as the host sent it, read into the persisted shape. Anything malformed reads as an empty editor rather
 * than as a file the editor cannot account for.
 *
 * @param {Record<string, unknown>} state
 * @returns {PersistedEditorState}
 */
export function readPersistedState(state) {
  const file = isFileRef(state.file) ? /** @type {FileRef} */ (state.file) : null;
  const base = file !== null && isFileRef(state.base) ? /** @type {FileRef} */ (state.base) : file;
  return {
    file,
    base,
    draft: file !== null && typeof state.draft === "string" ? state.draft : null,
    draftTooLarge: file !== null && state.draftTooLarge === true,
  };
}

function sameState(a, b) {
  return (
    (a.file?.artifactId ?? null) === (b.file?.artifactId ?? null) &&
    (a.base?.artifactId ?? null) === (b.base?.artifactId ?? null) &&
    a.draft === b.draft &&
    a.draftTooLarge === b.draftTooLarge
  );
}

/**
 * What to do with committed state the host sent, given what this view holds and what it last knew the host held.
 *
 * - `unchanged`: the host holds what this view shows.
 * - `adopt`: another view changed it and this one has nothing unsent, so this view takes the change.
 * - `keep`: the host still holds what this view last synced, so this view's newer edit is simply not written yet.
 * - `conflict`: both changed. Neither is thrown away; the person chooses.
 *
 * @param {{ local: PersistedEditorState, synced: PersistedEditorState, incoming: PersistedEditorState }} input
 * @returns {"unchanged" | "adopt" | "keep" | "conflict"}
 */
export function reconcileState({ local, synced, incoming }) {
  if (sameState(incoming, local)) return "unchanged";
  if (sameState(local, synced)) return "adopt";
  if (sameState(incoming, synced)) return "keep";
  return "conflict";
}

function clipChars(text, max) {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/**
 * A selection inside the text, ordered and clamped, so a stale range from before an edit cannot point past the end.
 *
 * @param {string} text
 * @param {TextSelection} selection
 * @returns {TextSelection}
 */
export function clampSelection(text, selection) {
  const clamp = (value) => Math.max(0, Math.min(text.length, Number.isInteger(value) ? value : 0));
  const a = clamp(selection.start);
  const b = clamp(selection.end);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/**
 * What the editor tells the host it shows: a summary, the selected range as an id, and a few values.
 *
 * The excerpt is bounded here to what the host keeps, so the model reads either the whole selection or a cut that says
 * it is one. The host cleans and bounds all of it again and marks it as the widget's own words.
 *
 * @param {EditorDocument | undefined} doc
 * @param {TextSelection} selection
 * @returns {{ summary: string, selectedIds: string[], values: Record<string, string | number | boolean> }}
 */
export function semanticProposal(doc, selection) {
  if (doc === undefined) {
    return { summary: "Text editor with no file open.", selectedIds: [], values: { open: false } };
  }
  const lines = lineCount(doc.draft);
  const dirty = isDirty(doc);
  const range = clampSelection(doc.draft, selection);
  const selected = doc.draft.slice(range.start, range.end);
  const summary = `Editing ${clipChars(doc.file.name, 120)}: ${String(lines)} line${lines === 1 ? "" : "s"}${dirty ? ", with unsaved changes" : ", saved"}.`;
  /** @type {Record<string, string | number | boolean>} */
  const values = { open: true, file: clipChars(doc.file.name, EDITOR_LIMITS.excerptChars), lines, dirty };
  if (range.end > range.start) {
    values.selectionStart = range.start;
    values.selectionEnd = range.end;
    values.selectedChars = Array.from(selected).length;
    values.selectedText = clipChars(selected, EDITOR_LIMITS.excerptChars);
  }
  return { summary, selectedIds: range.end > range.start ? [`chars:${String(range.start)}-${String(range.end)}`] : [], values };
}

/**
 * Whether the selection can be sent to Clark, and why not when it cannot.
 *
 * Clark reads the selection from the host's copy of the semantic document, which keeps at most 200 characters of one
 * value. A longer selection would reach Clark cut, and a rewrite of a cut selection would replace text Clark never
 * saw, so it is refused here with the reason rather than sent.
 *
 * @param {EditorDocument | undefined} doc
 * @param {TextSelection} selection
 * @returns {{ ok: true, start: number, end: number, text: string } | { ok: false, reason: "no-file" | "empty" | "too-long" }}
 */
export function askableSelection(doc, selection) {
  if (doc === undefined) return { ok: false, reason: "no-file" };
  const range = clampSelection(doc.draft, selection);
  const text = doc.draft.slice(range.start, range.end);
  if (text.trim() === "") return { ok: false, reason: "empty" };
  if (Array.from(text).length > EDITOR_LIMITS.excerptChars) return { ok: false, reason: "too-long" };
  return { ok: true, start: range.start, end: range.end, text };
}

/**
 * The replacement a reply proposes, or undefined when it proposes none.
 *
 * A reply is untrusted text. The first fenced block is the replacement when there is one, because a model asked for a
 * fenced block often adds a sentence around it; otherwise the whole reply is. It is bounded, and control characters
 * other than line breaks and tabs are removed, so nothing invisible reaches the text without the person seeing it.
 *
 * @param {unknown} output
 * @returns {string | undefined}
 */
export function extractReplacement(output) {
  if (typeof output !== "string") return undefined;
  const bounded = output.slice(0, EDITOR_LIMITS.replyChars);
  const fenced = /```[^\n`]*\n([\s\S]*?)\n?```/.exec(bounded);
  const candidate = fenced === null ? bounded.trim() : (fenced[1] ?? "");
  // eslint-disable-next-line no-control-regex
  const cleaned = candidate.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu, "");
  return cleaned.trim() === "" ? undefined : cleaned;
}

/**
 * Put an accepted replacement in place of the range Clark was asked about — only if that range still holds the text
 * Clark was shown. Text that changed while Clark answered is not overwritten with an answer to a different question.
 *
 * @param {EditorDocument} doc
 * @param {{ start: number, end: number, text: string }} asked
 * @param {string} replacement
 * @returns {{ ok: true, doc: EditorDocument, selection: TextSelection } | { ok: false, reason: "changed" }}
 */
export function applyReplacement(doc, asked, replacement) {
  if (doc.draft.slice(asked.start, asked.end) !== asked.text) return { ok: false, reason: "changed" };
  const draft = `${doc.draft.slice(0, asked.start)}${replacement}${doc.draft.slice(asked.end)}`;
  return { ok: true, doc: withDraft(doc, draft), selection: { start: asked.start, end: asked.start + replacement.length } };
}

/**
 * Bytes in chunks no larger than one bridge write.
 *
 * @param {Uint8Array} bytes
 * @param {number} [size]
 * @returns {Uint8Array[]}
 */
export function chunksOf(bytes, size = EDITOR_LIMITS.chunkBytes) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("a chunk size is a positive integer");
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) chunks.push(bytes.subarray(offset, offset + size));
  return chunks;
}

/**
 * Text from the bytes of a file, or undefined when they are not UTF-8: a file that is not text is refused rather than
 * shown with replacement characters a save would then write back.
 *
 * @param {readonly Uint8Array[]} parts
 * @returns {string | undefined}
 */
export function decodeText(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  try {
    return new globalThis.TextDecoder("utf-8", { fatal: true }).decode(all);
  } catch {
    return undefined;
  }
}
