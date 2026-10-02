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

  it("recognizes its own write coming back while the person kept typing, rather than calling it a conflict", () => {
    // The person paused, the draft "mine" was sent at revision 4, and they typed on before the host committed it.
    const typedOn = { ...base, draft: "mine, and more" };
    const pending = { state: mine, expectedRevision: 4 };
    expect(editor.reconcileState({ local: typedOn, synced: base, incoming: mine, revision: 5, pending })).toBe("echo");
    // Without knowing its own write, the same commit looked like another view's change.
    expect(editor.reconcileState({ local: typedOn, synced: base, incoming: mine, revision: 5 })).toBe("conflict");
  });

  it("still asks when another view's write lands while this one is pending", () => {
    const typedOn = { ...base, draft: "mine, and more" };
    const pending = { state: mine, expectedRevision: 4 };
    expect(editor.reconcileState({ local: typedOn, synced: base, incoming: theirs, revision: 5, pending })).toBe("conflict");
    // A commit no newer than the one written against is not this view's.
    expect(editor.reconcileState({ local: typedOn, synced: base, incoming: mine, revision: 4, pending })).toBe("conflict");
  });

  it("always adopts in a view with no document open, which has no draft of its own to keep", () => {
    // A reload whose saved copy could not be read shows no document, while `synced` still names the file.
    const empty = editor.persistedState(undefined);
    const fromOther = { ...base, draft: "typed in the other view" };
    expect(editor.reconcileState({ local: empty, synced: base, incoming: fromOther, documentOpen: false })).toBe("adopt");
    expect(editor.reconcileState({ local: empty, synced: base, incoming: { ...base, base: copy }, documentOpen: false })).toBe("adopt");
    expect(editor.reconcileState({ local: empty, synced: base, incoming: empty, documentOpen: false })).toBe("unchanged");
  });
});

describe("reopening after a reload", () => {
  const persisted = { file: picked, base: copy, draft: null, draftTooLarge: false };

  it("lays the unsaved draft over the saved text read back", () => {
    expect(editor.restoreDocument({ ...persisted, draft: "edited" }, "saved")).toEqual({
      file: picked,
      base: copy,
      savedText: "saved",
      draft: "edited",
      baseUnreadable: false,
    });
    expect(editor.isDirty(editor.restoreDocument(persisted, "saved"))).toBe(false);
  });

  it("keeps an unsaved draft when the saved text cannot be read back, marked unsaved", () => {
    const doc = editor.restoreDocument({ ...persisted, draft: "edited" }, undefined);
    expect(doc?.draft).toBe("edited");
    expect(editor.isDirty(doc)).toBe(true);
  });

  it("shows no document, rather than an empty one, when the saved text cannot be read and there is no draft", () => {
    expect(editor.restoreDocument(persisted, undefined)).toBeUndefined();
    expect(editor.restoreDocument({ file: null, base: null, draft: null, draftTooLarge: false }, "x")).toBeUndefined();
  });

  /**
   * A view as `main.js` drives it: loads read the saved copy and may finish in any order, and committed state is offered
   * to the load order before it is reconciled. Each read waits until the test answers it.
   */
  function reloadedView(restored: typeof persisted) {
    const loads = editor.createLoadOrder<{ state: typeof persisted; revision: number }>();
    const reads: { base: string; answer: (text: string) => void }[] = [];
    let doc: ReturnType<typeof editor.restoreDocument>;
    let synced = restored;
    const load = async (state: typeof persisted) => {
      const current = loads.begin();
      const text = await new Promise<string>((answer) => reads.push({ base: state.base?.artifactId ?? "", answer }));
      if (!current()) return false;
      doc = editor.restoreDocument(state, text);
      return true;
    };
    const onState = async (state: typeof persisted, revision: number) => {
      if (!loads.offer({ state, revision })) return;
      const decision = editor.reconcileState({ local: editor.persistedState(doc), synced, incoming: state, revision, documentOpen: doc !== undefined });
      if (decision === "adopt") {
        synced = state;
        await load(state);
      }
    };
    const restore = (async () => {
      await load(restored);
      const held = loads.finishRestore();
      if (held !== undefined) await onState(held.state, held.revision);
    })();
    return { reads, onState, restore, doc: () => doc, restoring: () => loads.restoring() };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const newerCopy: FileRef = { ...copy, artifactId: "art_copy_2", digest: "sha256:bb" };

  it("holds what another view commits during the first restore, and takes it once the restore has finished", async () => {
    const view = reloadedView(persisted);
    expect(view.restoring()).toBe(true);
    // Another view saves while this one is still reading its saved copy.
    void view.onState({ ...persisted, base: newerCopy }, 2);
    await tick();
    // Held, not loaded alongside: only the restore is reading.
    expect(view.reads.map((read) => read.base)).toEqual(["art_copy"]);

    view.reads[0]?.answer("old text");
    await tick();
    expect(view.restoring()).toBe(false);
    expect(view.reads.map((read) => read.base)).toEqual(["art_copy", "art_copy_2"]);
    view.reads[1]?.answer("new text");
    await view.restore;
    expect(view.doc()?.base).toEqual(newerCopy);
    expect(view.doc()?.draft).toBe("new text");
  });

  it("drops a load that finishes after a newer one began, so older text never replaces newer", () => {
    const loads = editor.createLoadOrder();
    const older = loads.begin();
    const newer = loads.begin();
    // The newer, shorter read finished first and was applied; the older one finishing later is stale.
    expect(newer()).toBe(true);
    expect(older()).toBe(false);
    // Opening a file is a newer document too.
    loads.begin();
    expect(newer()).toBe(false);
  });

  it("takes committed state at once after the restore has finished", async () => {
    const view = reloadedView(persisted);
    await tick();
    view.reads[0]?.answer("saved");
    await view.restore;
    expect(view.restoring()).toBe(false);
    void view.onState({ ...persisted, base: newerCopy }, 3);
    await tick();
    expect(view.reads.map((read) => read.base)).toEqual(["art_copy", "art_copy_2"]);
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
      selectedText: "beta",
    });
  });

  it("bounds the excerpt to what the host keeps, in the host's units, and marks the cut", () => {
    const text = "a".repeat(500);
    const proposal = editor.semanticProposal(editor.openDocument(picked, text), { start: 0, end: 500 });
    const excerpt = String(proposal.values.selectedText);
    expect(excerpt).toHaveLength(editor.EDITOR_LIMITS.excerptChars);
    expect(excerpt.endsWith("…")).toBe(true);
    const emoji = "😀".repeat(150);
    const astral = String(editor.semanticProposal(editor.openDocument(picked, emoji), { start: 0, end: emoji.length }).values.selectedText);
    expect(astral.length).toBeLessThanOrEqual(editor.EDITOR_LIMITS.excerptChars);
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

  it("measures the bound in the host's UTF-16 units, so astral text the host would cut is refused", () => {
    const emoji = "😀".repeat(150);
    expect(Array.from(emoji)).toHaveLength(150);
    expect(editor.askableSelection(editor.openDocument(picked, emoji), { start: 0, end: emoji.length })).toEqual({ ok: false, reason: "too-long" });
    const fits = "😀".repeat(100);
    expect(editor.askableSelection(editor.openDocument(picked, fits), { start: 0, end: fits.length })).toMatchObject({ ok: true, text: fits });
  });

  it("refuses a selection the host would flatten onto one line, so a reply cannot drop its line breaks", () => {
    const lines = editor.openDocument(picked, "line one\nline two");
    expect(editor.askableSelection(lines, { start: 0, end: 17 })).toEqual({ ok: false, reason: "one-line" });
    const tabbed = editor.openDocument(picked, "a\tb");
    expect(editor.askableSelection(tabbed, { start: 0, end: 3 })).toEqual({ ok: false, reason: "one-line" });
    const spaced = editor.openDocument(picked, "a  b");
    expect(editor.askableSelection(spaced, { start: 0, end: 4 })).toEqual({ ok: false, reason: "one-line" });
  });

  it("refuses a selection with hidden characters or unusual spaces, which Clark would read as plain spaces", () => {
    const hidden = editor.openDocument(picked, "pay\u200Bment");
    expect(editor.askableSelection(hidden, { start: 0, end: 8 })).toEqual({ ok: false, reason: "hidden" });
    for (const text of ["100\u00A0km", "\u6771\u4EAC\u3000\u99C5"]) {
      expect(editor.askableSelection(editor.openDocument(picked, text), { start: 0, end: text.length })).toEqual({ ok: false, reason: "hidden" });
    }
  });

  it("refuses a selection with text the host redacts as possibly private, and says so apart from hidden characters", () => {
    for (const text of [
      "use sk-abcdefgh12345678 here",
      "write to an@example.com today",
      "pay 1 234 567 890 \u0111\u1ED3ng",
      "see C:\\Users\\an\\notes.txt",
    ]) {
      expect(editor.askableSelection(editor.openDocument(picked, text), { start: 0, end: text.length })).toEqual({ ok: false, reason: "redacted" });
    }
  });

  it("never refuses text the host passes on unchanged", () => {
    // Text that merely looks close to a redacted shape is still asked about when the host would leave it alone.
    for (const text of ["call 12 34 56", "art_123 and [redacted]", "C:\\Temp\\x", "an@b"]) {
      expect(editor.hostSemanticText(text, editor.EDITOR_LIMITS.excerptChars)).toBe(text);
      expect(editor.askableSelection(editor.openDocument(picked, text), { start: 0, end: text.length })).toMatchObject({ ok: true, text });
    }
  });

  it("leaves the spaces at the ends out of the range rather than refusing them", () => {
    // A double-click often selects the space after a word; the host trims it, so the asked range does too.
    expect(editor.askableSelection(doc, { start: 10, end: 22 })).toEqual({ ok: true, start: 11, end: 22, text: "change that" });
  });

  it("asks only about text the host passes on unchanged", () => {
    for (const text of ["change that", "Xin chào, thế giới!", "😀 smile", "a.b-c_d"]) {
      expect(editor.hostSemanticText(text, editor.EDITOR_LIMITS.excerptChars)).toBe(text);
    }
  });

  it("takes the one fenced block of a reply as the replacement", () => {
    expect(editor.extractReplacement('Here it is, from "change that":\n```text\nCHANGE THAT\n```\nDone.')).toBe("CHANGE THAT");
    expect(editor.extractReplacement("```\nline one\nline two\n```")).toBe("line one\nline two");
  });

  it("proposes nothing for a reply that is not one closed fenced block", () => {
    expect(editor.extractReplacement("  better words \n")).toBeUndefined();
    expect(editor.extractReplacement("I cannot rewrite that.")).toBeUndefined();
    // Cut open by the host's bound: the block never closes.
    expect(editor.extractReplacement("Sure here:\n```text\nPARTIAL")).toBeUndefined();
    expect(editor.extractReplacement("```\none\n```\nor\n```\ntwo\n```")).toBeUndefined();
    expect(editor.extractReplacement("   ")).toBeUndefined();
    expect(editor.extractReplacement("```\n\n```")).toBeUndefined();
    expect(editor.extractReplacement(undefined)).toBeUndefined();
    expect(editor.extractReplacement(42)).toBeUndefined();
  });

  it("removes invisible and control characters, keeping line breaks and tabs", () => {
    expect(editor.extractReplacement("```\na\u0007b\u200Bc\u202Ed\uFEFFe\tf\r\ng\n```")).toBe("abcde\tf\ng");
  });

  it("proposes nothing for a reply longer than the host returns, which may have been cut", () => {
    const block = "```\nfine\n```";
    expect(editor.extractReplacement(block + "z".repeat(editor.EDITOR_LIMITS.replyChars))).toBeUndefined();
    expect(editor.extractReplacement(block + "z".repeat(editor.EDITOR_LIMITS.replyChars - block.length))).toBe("fine");
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
