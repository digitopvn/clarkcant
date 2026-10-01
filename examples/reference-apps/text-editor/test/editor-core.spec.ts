import { describe, expect, it } from "vitest";
// The editor's rules are plain JavaScript, served to the frame as they are; their types come from JSDoc.
import * as editor from "../widgets/main/editor-core.js";

/** @see FileRef in editor-core.js */
type FileRef = Parameters<typeof editor.openDocument>[0];

const picked: FileRef = { v: 1, artifactId: "art_picked", kind: "external", mimeType: "text/plain", sizeBytes: 12, name: "notes.txt" };
const copy: FileRef = { v: 1, artifactId: "art_copy", kind: "finalized", mimeType: "text/plain", sizeBytes: 14, name: "notes.txt", digest: "sha256:aa" };

describe("lines and the unsaved state", () => {
  it("counts lines as a person does", () => {
    expect(editor.lineCount("")).toBe(0);
    expect(editor.lineCount("one")).toBe(1);
    expect(editor.lineCount("one\n")).toBe(1);
    expect(editor.lineCount("one\ntwo")).toBe(2);
    expect(editor.lineCount("one\r\ntwo\r\n")).toBe(2);
    expect(editor.lineCount("\n\n")).toBe(2);
  });

  it("is unsaved only when the draft differs from what was last opened or saved", () => {
    const opened = editor.openDocument(picked, "hello world\n");
    expect(editor.isDirty(undefined)).toBe(false);
    expect(editor.isDirty(opened)).toBe(false);
    const edited = editor.withDraft(opened, "hello there\n");
    expect(editor.isDirty(edited)).toBe(true);
    expect(editor.isDirty(editor.withDraft(edited, "hello world\n"))).toBe(false);
  });

  it("keeps a draft typed during a save unsaved, and makes the saved copy the new base", () => {
    const edited = editor.withDraft(editor.openDocument(picked, "a"), "ab");
    const saved = editor.markSaved(editor.withDraft(edited, "abc"), copy, "ab");
    expect(saved.base).toEqual(copy);
    expect(saved.file).toEqual(picked);
    expect(editor.isDirty(saved)).toBe(true);
    expect(editor.isDirty(editor.markSaved(edited, copy, "ab"))).toBe(false);
  });

  it("treats a draft whose saved copy cannot be read back as unsaved", () => {
    const doc = { file: picked, base: copy, savedText: "", draft: "", baseUnreadable: true };
    expect(editor.isDirty(doc)).toBe(true);
  });
});

describe("what widget state keeps", () => {
  it("keeps the file and base, and the draft only while it is unsaved", () => {
    const opened = editor.openDocument(picked, "text");
    expect(editor.persistedState(undefined)).toEqual({ file: null, base: null, draft: null, draftTooLarge: false });
    expect(editor.persistedState(opened)).toEqual({ file: picked, base: picked, draft: null, draftTooLarge: false });
    expect(editor.persistedState(editor.withDraft(opened, "text!"))).toEqual({
      file: picked,
      base: picked,
      draft: "text!",
      draftTooLarge: false,
    });
  });

  it("flags a draft too large for the state rather than keeping a cut copy of it", () => {
    const big = "é".repeat(editor.EDITOR_LIMITS.persistedDraftBytes);
    const state = editor.persistedState(editor.withDraft(editor.openDocument(picked, ""), big));
    expect(state.draft).toBeNull();
    expect(state.draftTooLarge).toBe(true);
    // The whole state, file refs included, stays inside the host's 16 KiB with the largest draft it keeps.
    const largest = "x".repeat(editor.EDITOR_LIMITS.persistedDraftBytes - 2);
    const kept = editor.persistedState(editor.withDraft(editor.openDocument(picked, ""), largest));
    expect(kept.draft).toBe(largest);
    expect(new TextEncoder().encode(JSON.stringify(kept)).byteLength).toBeLessThanOrEqual(16 * 1024);
  });

  it("reads malformed state as an empty editor", () => {
    expect(editor.readPersistedState({}).file).toBeNull();
    expect(editor.readPersistedState({ file: { artifactId: "art_x" }, draft: "x" })).toEqual({
      file: null,
      base: null,
      draft: null,
      draftTooLarge: false,
    });
    expect(editor.readPersistedState({ file: { ...picked, artifactId: "/home/me/notes.txt" } }).file).toBeNull();
    expect(editor.readPersistedState({ file: picked, draft: "d" })).toEqual({ file: picked, base: picked, draft: "d", draftTooLarge: false });
  });
});

describe("two views of one editor", () => {
  const base = editor.persistedState(editor.openDocument(picked, "x"));
  const mine = { ...base, draft: "mine" };
  const theirs = { ...base, draft: "theirs" };

  it("adopts another view's change when this one has nothing unsent", () => {
    expect(editor.reconcileState({ local: base, synced: base, incoming: theirs })).toBe("adopt");
  });

  it("keeps this view's newer edit when the host still holds what was last synced", () => {
    expect(editor.reconcileState({ local: mine, synced: base, incoming: base })).toBe("keep");
  });

  it("asks the person when both changed", () => {
    expect(editor.reconcileState({ local: mine, synced: base, incoming: theirs })).toBe("conflict");
  });

  it("does nothing when the host holds what is shown", () => {
    expect(editor.reconcileState({ local: mine, synced: base, incoming: mine })).toBe("unchanged");
  });
});

describe("what Clark is shown", () => {
  it("describes an empty editor", () => {
    expect(editor.semanticProposal(undefined, { start: 0, end: 0 })).toEqual({
      summary: "Text editor with no file open.",
      selectedIds: [],
      values: { open: false },
    });
  });

  it("names the file, its lines, whether it is unsaved and the selection", () => {
    const doc = editor.withDraft(editor.openDocument(picked, "alpha\nbeta\n"), "alpha\nbeta\ngamma\n");
    const proposal = editor.semanticProposal(doc, { start: 11, end: 6 });
    expect(proposal.summary).toBe("Editing notes.txt: 3 lines, with unsaved changes.");
    expect(proposal.selectedIds).toEqual(["chars:6-11"]);
    expect(proposal.values).toEqual({
      open: true,
      file: "notes.txt",
      lines: 3,
      dirty: true,
      selectionStart: 6,
      selectionEnd: 11,
      selectedChars: 5,
      selectedText: "beta\n",
    });
  });

  it("bounds the excerpt to what the host keeps and marks the cut", () => {
    const text = "a".repeat(500);
    const proposal = editor.semanticProposal(editor.openDocument(picked, text), { start: 0, end: 500 });
    const excerpt = String(proposal.values.selectedText);
    expect(Array.from(excerpt)).toHaveLength(editor.EDITOR_LIMITS.excerptChars);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("clamps a stale selection to the text", () => {
    expect(editor.clampSelection("abc", { start: 9, end: -2 })).toEqual({ start: 0, end: 3 });
    expect(editor.clampSelection("abc", { start: Number.NaN, end: 2 })).toEqual({ start: 0, end: 2 });
  });
});

describe("asking Clark to change the selection", () => {
  const doc = editor.openDocument(picked, "keep this, change that.");

  it("asks only about a non-empty selection Clark can read whole", () => {
    expect(editor.askableSelection(undefined, { start: 0, end: 1 })).toEqual({ ok: false, reason: "no-file" });
    expect(editor.askableSelection(doc, { start: 3, end: 3 })).toEqual({ ok: false, reason: "empty" });
    expect(editor.askableSelection(editor.openDocument(picked, "  \n "), { start: 0, end: 4 })).toEqual({ ok: false, reason: "empty" });
    const long = editor.openDocument(picked, "b".repeat(201));
    expect(editor.askableSelection(long, { start: 0, end: 201 })).toEqual({ ok: false, reason: "too-long" });
    expect(editor.askableSelection(doc, { start: 11, end: 22 })).toEqual({ ok: true, start: 11, end: 22, text: "change that" });
  });

  it("takes the first fenced block of a reply as the replacement", () => {
    expect(editor.extractReplacement('Here it is, from "change that":\n```text\nCHANGE THAT\n```\nDone.')).toBe("CHANGE THAT");
    expect(editor.extractReplacement("```\nline one\nline two\n```")).toBe("line one\nline two");
  });

  it("takes the whole reply when it has no fence, and none when it is empty", () => {
    expect(editor.extractReplacement("  better words \n")).toBe("better words");
    expect(editor.extractReplacement("   ")).toBeUndefined();
    expect(editor.extractReplacement("```\n\n```")).toBeUndefined();
    expect(editor.extractReplacement(undefined)).toBeUndefined();
    expect(editor.extractReplacement(42)).toBeUndefined();
  });

  it("removes invisible and control characters, keeping line breaks and tabs", () => {
    expect(editor.extractReplacement("a\u0007b​c‮d﻿e\tf\r\ng")).toBe("abcde\tf\ng");
  });

  it("reads at most the bounded reply", () => {
    const reply = "z".repeat(5_000);
    expect(editor.extractReplacement(reply)).toHaveLength(editor.EDITOR_LIMITS.replyChars);
  });

  it("replaces the asked range and selects the new text", () => {
    const applied = editor.applyReplacement(doc, { start: 11, end: 22, text: "change that" }, "CHANGED");
    expect(applied).toEqual({
      ok: true,
      doc: { ...doc, draft: "keep this, CHANGED." },
      selection: { start: 11, end: 18 },
    });
    if (applied.ok) expect(editor.isDirty(applied.doc)).toBe(true);
  });

  it("refuses to replace text that changed while Clark answered", () => {
    const edited = editor.withDraft(doc, "keep this, chnage that.");
    expect(editor.applyReplacement(edited, { start: 11, end: 22, text: "change that" }, "CHANGED")).toEqual({
      ok: false,
      reason: "changed",
    });
  });
});

describe("bytes", () => {
  it("splits bytes into chunks no larger than one bridge write", () => {
    const bytes = new Uint8Array(editor.EDITOR_LIMITS.chunkBytes * 2 + 5);
    const chunks = editor.chunksOf(bytes);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([editor.EDITOR_LIMITS.chunkBytes, editor.EDITOR_LIMITS.chunkBytes, 5]);
    expect(editor.chunksOf(new Uint8Array(0))).toEqual([]);
    expect(() => editor.chunksOf(bytes, 0)).toThrow(RangeError);
  });

  it("decodes UTF-8 split across chunks and refuses bytes that are not text", () => {
    const encoded = new TextEncoder().encode("Tiếng Việt");
    expect(editor.decodeText([encoded.subarray(0, 3), encoded.subarray(3)])).toBe("Tiếng Việt");
    expect(editor.decodeText([new Uint8Array([0xff, 0xfe, 0x00])])).toBeUndefined();
    expect(editor.decodeText([])).toBe("");
  });

  it("offers only text types to the picker", () => {
    expect(editor.ACCEPTED_TYPES.every((type) => /^(text\/|application\/json$)/.test(type))).toBe(true);
    expect(editor.isFileRef(picked)).toBe(true);
    expect(editor.isFileRef({ ...picked, v: 2 })).toBe(false);
  });
});
