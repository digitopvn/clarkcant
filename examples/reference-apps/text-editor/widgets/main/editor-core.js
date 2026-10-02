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
  /**
   * What the host keeps of one semantic value (`SEMANTIC_LIMITS.string`), in UTF-16 units as the host measures it, so
   * the excerpt is never cut by the host.
   */
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

/**
 * The document a reload shows, from persisted state and the saved text read back through `base`.
 *
 * When the saved text cannot be read back (`savedText` undefined: the grant lapsed, or the copy is gone), an unsaved
 * draft is still the person's and is shown, marked unsaved. Without a draft there is nothing to show: an empty text area
 * would be presented as the document, and saving it would write an empty file over the original. So there is no
 * document, and the editor says why.
 *
 * @param {PersistedEditorState} persisted
 * @param {string | undefined} savedText
 * @returns {EditorDocument | undefined}
 */
export function restoreDocument(persisted, savedText) {
  if (persisted.file === null || persisted.base === null) return undefined;
  if (savedText === undefined) {
    if (persisted.draft === null) return undefined;
    return { file: persisted.file, base: persisted.base, savedText: "", draft: persisted.draft, baseUnreadable: true };
  }
  return withDraft({ ...openDocument(persisted.file, savedText), base: persisted.base }, persisted.draft ?? savedText);
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
 * @typedef {object} PendingWrite
 * @property {PersistedEditorState} state What this view asked the host to commit.
 * @property {number} expectedRevision The revision it was written against; the commit lands after it.
 */

/**
 * What to do with committed state the host sent, given what this view holds and what it last knew the host held.
 *
 * - `unchanged`: the host holds what this view shows.
 * - `echo`: the host committed this view's own write. The person may have typed since, which is not a conflict: that
 *   newer text is simply not written yet. The SDK delivers the commit before the write's promise resolves, so without
 *   the pending write this would look like another view's change.
 * - `adopt`: another view changed it and this one has nothing unsent, so this view takes the change.
 * - `keep`: the host still holds what this view last synced, so this view's newer edit is simply not written yet.
 * - `conflict`: both changed. Neither is thrown away; the person chooses.
 *
 * @param {{
 *   local: PersistedEditorState,
 *   synced: PersistedEditorState,
 *   incoming: PersistedEditorState,
 *   revision?: number,
 *   pending?: PendingWrite | undefined,
 * }} input
 * @returns {"unchanged" | "echo" | "adopt" | "keep" | "conflict"}
 */
export function reconcileState({ local, synced, incoming, revision, pending }) {
  if (sameState(incoming, local)) return "unchanged";
  if (pending !== undefined && typeof revision === "number" && revision > pending.expectedRevision && sameState(incoming, pending.state)) {
    return "echo";
  }
  if (sameState(local, synced)) return "adopt";
  if (sameState(incoming, synced)) return "keep";
  return "conflict";
}

function clipChars(text, max) {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/** Cut as the host cuts: in UTF-16 units, the last one given to the mark. */
function clipUnits(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The secret shapes the host redacts from a widget's words before a model reads them (`SECRET_SHAPES` in the host's
 * redaction module), in the same order. A frame cannot import host code, so they are restated here; the package's tests
 * compare this list with the host's, so a change there fails here rather than drifting.
 */
export const HOST_SECRET_PATTERNS = Object.freeze([
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/g,
  /\b(?:sk|pk|rk|ghp|gho|npm|xox[baprs]|api|key|token|secret)[-_][A-Za-z0-9._-]{8,}\b/gi,
  /(?:access_token|refresh_token|client_secret|api[_-]?key|password)"?\s*[:=]\s*"?[^"\s,}]{6,}/gi,
  /(?<![A-Za-z0-9+/._~-])\b[A-Za-z0-9+/]{32,}={0,2}\b/g,
  /\b[A-Za-z0-9+]{32,}={0,2}\b/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /(?:\/Users\/|\/home\/|\/private\/var\/)[A-Za-z0-9._\-/]+/g,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._\\-]+/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:\+?\d[\s-]?){9,}\b/g,
]);

/**
 * A string as the model reads it once the host has taken it from the semantic document (`cleanSemanticText`): control
 * and invisible characters, line breaks and tabs included, become spaces; runs of whitespace collapse to one; the ends
 * are trimmed; anything secret-shaped becomes `[redacted]`; and it is cut at `max` UTF-16 units.
 *
 * @param {string} text
 * @param {number} max
 */
export function hostSemanticText(text, max) {
  let cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  for (const pattern of HOST_SECRET_PATTERNS) cleaned = cleaned.replace(new RegExp(pattern.source, pattern.flags), "[redacted]");
  return clipUnits(cleaned, max);
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
  const values = { open: true, file: clipUnits(doc.file.name, EDITOR_LIMITS.excerptChars), lines, dirty };
  if (range.end > range.start) {
    values.selectionStart = range.start;
    values.selectionEnd = range.end;
    values.selectedChars = Array.from(selected).length;
    values.selectedText = clipUnits(selected.trim(), EDITOR_LIMITS.excerptChars);
  }
  return { summary, selectedIds: range.end > range.start ? [`chars:${String(range.start)}-${String(range.end)}`] : [], values };
}

/**
 * Whether the selection can be sent to Clark, and why not when it cannot.
 *
 * Clark reads the selection from the host's copy of the semantic document, which the host cleans before a model sees
 * it (`hostSemanticText`). A reply is applied to the selected range, so that range must hold exactly the text Clark
 * read; any selection the host would change is refused here with the reason rather than sent:
 *
 * - `too-long`: over 200 UTF-16 units, so the host would cut it;
 * - `one-line`: line breaks, tabs or repeated spaces, which the host flattens to single spaces, so a one-line reply
 *   would replace text whose layout Clark never saw;
 * - `hidden`: invisible or control characters, or something secret-shaped the host redacts.
 *
 * Whitespace at the ends is left out of the range rather than refused: the host trims it, and a double-click often
 * selects the space after a word.
 *
 * @param {EditorDocument | undefined} doc
 * @param {TextSelection} selection
 * @returns {{ ok: true, start: number, end: number, text: string } | { ok: false, reason: "no-file" | "empty" | "too-long" | "one-line" | "hidden" }}
 */
export function askableSelection(doc, selection) {
  if (doc === undefined) return { ok: false, reason: "no-file" };
  const range = clampSelection(doc.draft, selection);
  const raw = doc.draft.slice(range.start, range.end);
  if (raw.trim() === "") return { ok: false, reason: "empty" };
  const start = range.start + (raw.length - raw.trimStart().length);
  const end = range.end - (raw.length - raw.trimEnd().length);
  const text = doc.draft.slice(start, end);
  if (text.length > EDITOR_LIMITS.excerptChars) return { ok: false, reason: "too-long" };
  if (hostSemanticText(text, EDITOR_LIMITS.excerptChars) !== text) {
    return { ok: false, reason: /[\r\n\t\v\f]| {2}/u.test(text) ? "one-line" : "hidden" };
  }
  return { ok: true, start, end, text };
}

/**
 * The replacement a reply proposes, or undefined when it proposes none.
 *
 * A reply is untrusted text, and only a well-formed one is a proposal: within the bound the host keeps (a longer one
 * may have been cut), holding exactly one closed fenced block, which is the replacement. A sentence around the block is
 * allowed, because a model asked for a fenced block often adds one. Anything else (no fence, a fence the bound cut
 * open, two blocks) is Clark talking, not a replacement, and is shown as such. Control characters other than line
 * breaks and tabs are removed from the block, so nothing invisible reaches the text without the person seeing it.
 *
 * @param {unknown} output
 * @returns {string | undefined}
 */
export function extractReplacement(output) {
  if (typeof output !== "string" || output.length > EDITOR_LIMITS.replyChars) return undefined;
  if ((output.match(/```/g) ?? []).length !== 2) return undefined;
  const fenced = /```[^\n`]*\n([\s\S]*?)\n?```/.exec(output);
  if (fenced === null) return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = (fenced[1] ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu, "");
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
