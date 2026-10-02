import { describe, expect, it } from "vitest";

import { MAX_CELLS, cellName, clearRange, createSheet } from "../widgets/main/sheet.js";
import { createStore, readSheetFile, writeTextFile } from "../widgets/main/store.js";

interface Ref {
  id: string;
  mimeType: string;
  name: string;
}

interface StoredFile {
  bytes: Uint8Array;
  final: boolean;
}

/** The host's file broker as the frame sees it, with switches that hold every finalize, or every read, until released. */
function fakeArtifacts() {
  const files = new Map<string, StoredFile>();
  let next = 0;
  let writing = 0;
  let mostAtOnce = 0;
  let creates = 0;
  let held: (() => void)[] = [];
  let hold = false;
  let heldReads: (() => void)[] = [];
  let holdReads = false;
  let failCreates = false;
  const artifacts = {
    create({ mimeType, name }: { mimeType: string; name: string }): Promise<Ref> {
      if (failCreates) return Promise.reject(new Error("ARTIFACT_QUOTA_EXCEEDED"));
      next += 1;
      creates += 1;
      writing += 1;
      mostAtOnce = Math.max(mostAtOnce, writing);
      const ref = { id: `art_${String(next)}`, mimeType, name };
      files.set(ref.id, { bytes: new Uint8Array(), final: false });
      return Promise.resolve(ref);
    },
    write(ref: Ref, chunk: Uint8Array): Promise<Ref> {
      const file = files.get(ref.id);
      if (file === undefined) return Promise.reject(new Error("unknown file"));
      const merged = new Uint8Array(file.bytes.byteLength + chunk.byteLength);
      merged.set(file.bytes);
      merged.set(chunk, file.bytes.byteLength);
      file.bytes = merged;
      return Promise.resolve(ref);
    },
    async finalize(ref: Ref): Promise<Ref> {
      if (hold) await new Promise<void>((resolve) => held.push(resolve));
      const file = files.get(ref.id);
      if (file === undefined) throw new Error("unknown file");
      file.final = true;
      writing -= 1;
      return ref;
    },
    async read(ref: Ref, range: { offset: number; length: number }): Promise<{ bytes: Uint8Array; eof: boolean }> {
      if (holdReads) await new Promise<void>((resolve) => heldReads.push(resolve));
      const file = files.get(ref.id);
      if (file === undefined || !file.final) throw new Error("ARTIFACT_NOT_FOUND");
      const bytes = file.bytes.subarray(range.offset, range.offset + range.length);
      return { bytes, eof: range.offset + bytes.byteLength >= file.bytes.byteLength };
    },
    discard(ref: Ref): Promise<void> {
      return files.delete(ref.id) ? Promise.resolve() : Promise.reject(new Error("unknown file"));
    },
  };
  return {
    artifacts,
    files,
    hold: (on: boolean) => {
      hold = on;
    },
    release: () => {
      const waiting = held;
      held = [];
      for (const resolve of waiting) resolve();
    },
    holdReads: (on: boolean) => {
      holdReads = on;
    },
    releaseReads: () => {
      const waiting = heldReads;
      heldReads = [];
      for (const resolve of waiting) resolve();
    },
    failCreates: (on: boolean) => {
      failCreates = on;
    },
    creates: () => creates,
    mostAtOnce: () => mostAtOnce,
    /** A finished file with this text, as a picked file would be. */
    async put(text: string, name = "picked.csv"): Promise<Ref> {
      return writeTextFile(artifacts, text, "text/csv", name) as Promise<Ref>;
    },
  };
}

/**
 * The host's state for one frame, as the frame session keeps it: view-state keys stay in the frame and are never written
 * to the node, a write is checked against the revision, one write at a time, and the node refuses a state over 16 KiB.
 */
function fakeState(
  initial: Record<string, unknown> = {},
  refuse: (patch: Record<string, unknown>) => boolean = () => false,
  gate: (patch: Record<string, unknown>) => Promise<void> | undefined = () => undefined,
) {
  const ephemeral = new Set(["active", "anchor"]);
  let durable: Record<string, unknown> = JSON.parse(JSON.stringify(initial)) as Record<string, unknown>;
  let view: Record<string, unknown> = {};
  let revision = 0;
  let inFlight = false;
  let durableWrites = 0;
  return {
    get: () => ({ ...durable, ...view }),
    revision: () => revision,
    async update(expected: number, patch: Record<string, unknown>): Promise<void> {
      if (inFlight || expected !== revision) throw new Error("STATE_REVISION_STALE");
      const kept = Object.fromEntries(Object.entries(patch).filter(([key]) => !ephemeral.has(key)));
      view = { ...view, ...Object.fromEntries(Object.entries(patch).filter(([key]) => ephemeral.has(key))) };
      if (Object.keys(kept).length === 0) return;
      inFlight = true;
      await Promise.resolve();
      await gate(kept);
      inFlight = false;
      const next = JSON.parse(JSON.stringify({ ...durable, ...kept })) as Record<string, unknown>;
      if (refuse(kept) || new TextEncoder().encode(JSON.stringify(next)).byteLength > 16_384) throw new Error("STATE_TOO_LARGE");
      durable = next;
      revision += 1;
      durableWrites += 1;
    },
    durable: () => durable,
    durableWrites: () => durableWrites,
  };
}

/** Every promise that can move on its own has moved: what is left waits on a gate the test holds. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A sheet, its store and an `edit` that writes a cell the way the widget does. The sheet is loaded from the state's
 * source first, as the widget does on mount, unless `load` is false.
 */
async function harness(
  options: { state?: ReturnType<typeof fakeState>; files?: ReturnType<typeof fakeArtifacts>; checkpointBytes?: number; load?: boolean } = {},
) {
  const state = options.state ?? fakeState();
  const files = options.files ?? fakeArtifacts();
  let sheet = createSheet();
  const failures: unknown[] = [];
  let refusals = 0;
  const store = createStore({
    state,
    artifacts: files.artifacts,
    snapshot: () => sheet.rawRows(),
    checkpointBytes: options.checkpointBytes ?? 600,
    onRefused: () => {
      refusals += 1;
    },
    onFailed: (error: unknown) => failures.push(error),
  });
  const edit = (row: number, column: number, value: string): void => {
    expect(sheet.set(row, column, value)).toBe(true);
    store.record([[cellName(row, column), sheet.raw(row, column)]]);
    store.save();
  };
  if (options.load !== false) sheet = (await store.load()).sheet;
  return {
    state,
    files,
    store,
    edit,
    failures,
    refusals: () => refusals,
    sheet: () => sheet,
    setSheet: (next: ReturnType<typeof createSheet>) => {
      sheet = next;
    },
  };
}

/** What a reload sees: a new store over the state the node kept and the same files, rebuilt from its source. */
async function reload(state: ReturnType<typeof fakeState>, files: ReturnType<typeof fakeArtifacts>) {
  const fresh = createStore({ state: fakeState(state.durable()), artifacts: files.artifacts, snapshot: () => [] });
  return fresh.load();
}

describe("clearing a selection", () => {
  it("clears a 5,000 × 5 sheet in one pass, recorded as one batch", () => {
    const rows = Array.from({ length: 5_000 }, (_, row) => Array.from({ length: 5 }, (_, column) => String(row * 5 + column + 1)));
    const sheet = createSheet(rows);
    expect(sheet.used()).toEqual({ rows: 5_000, columns: 5 });
    const store = createStore({ state: fakeState(), artifacts: undefined, snapshot: () => sheet.rawRows() });

    const started = performance.now();
    const cleared = clearRange(sheet, { top: 0, left: 0, bottom: 4_999, right: 4 });
    store.record(cleared.map((name: string) => [name, ""]));
    const elapsed = performance.now() - started;

    expect(cleared).toHaveLength(MAX_CELLS);
    expect(Object.keys(store.edits())).toHaveLength(MAX_CELLS);
    expect(sheet.used()).toEqual({ rows: 0, columns: 0 });
    // A copy of the edit map per cell took 87 s here; one pass takes milliseconds. The bound leaves room for a slow runner.
    expect(elapsed).toBeLessThan(1_500);
  });
});

describe("checkpoints", () => {
  it("keeps edits made while a checkpoint is written, and a reload shows every one of them", async () => {
    const { state, files, store, edit, sheet, failures } = await harness();
    for (let row = 0; row < 40; row += 1) edit(row, 0, `giá trị ${String(row)}`);
    await store.settled();
    // The edits outgrew the state, so the sheet went to a file of its own and the edits started again.
    expect(state.durable().sourceKind).toBe("checkpoint");
    const first = state.durable().source as Ref;

    files.hold(true);
    for (let row = 0; row < 40; row += 1) edit(row, 1, `sau ${String(row)}`);
    expect(files.creates()).toBe(2);
    // While that one is written: more edits, one of them changing a cell its snapshot already holds.
    edit(100, 2, "trong lúc ghi");
    edit(0, 1, "đổi lần nữa");
    for (let row = 0; row < 40; row += 1) edit(row, 3, `nữa ${String(row)}`);
    await settle();
    // One checkpoint at a time: the edits during it wait for it rather than starting another.
    expect(files.creates()).toBe(2);
    files.hold(false);
    files.release();
    await store.settled();

    expect(files.mostAtOnce()).toBe(1);
    expect(failures).toEqual([]);
    const after = await reload(state, files);
    expect(after.gone).toBe(false);
    for (let row = 0; row < 40; row += 1) {
      expect(after.sheet.raw(row, 0)).toBe(`giá trị ${String(row)}`);
      expect(after.sheet.raw(row, 1)).toBe(row === 0 ? "đổi lần nữa" : `sau ${String(row)}`);
      expect(after.sheet.raw(row, 3)).toBe(`nữa ${String(row)}`);
    }
    expect(after.sheet.raw(100, 2)).toBe("trong lúc ghi");
    expect(after.sheet.rawRows()).toEqual(sheet().rawRows());

    // Each checkpoint discarded the one it superseded: only the current source is left.
    const source = state.durable().source as Ref;
    expect(source.id).not.toBe(first.id);
    expect([...files.files.keys()]).toEqual([source.id]);
  });

  it("writes an edit made while the checkpoint commits, rather than dropping it once the rest fits", async () => {
    let open: () => void = () => undefined;
    let committing = false;
    const state = fakeState({}, () => false, (patch) => {
      if (patch.sourceKind !== "checkpoint" || committing) return undefined;
      committing = true;
      return new Promise<void>((resolve) => {
        open = resolve;
      });
    });
    const { files, store, edit } = await harness({ state });
    for (let row = 0; row < 40; row += 1) edit(row, 0, `giá trị a${String(row)}`);
    await settle();
    // The checkpoint's file is written and its commit is with the host; the edits it holds are still in the map.
    expect(committing).toBe(true);
    edit(41, 0, "lúc ghi nhận");
    open();
    await store.settled();

    const after = await reload(state, files);
    expect(after.sheet.raw(41, 0)).toBe("lúc ghi nhận");
    for (let row = 0; row < 40; row += 1) expect(after.sheet.raw(row, 0)).toBe(`giá trị a${String(row)}`);
    expect(files.files.size).toBe(1);
  });

  it("drops a checkpoint of a sheet replaced while it was written", async () => {
    const { state, files, store, edit, setSheet } = await harness();
    files.hold(true);
    for (let row = 0; row < 40; row += 1) edit(row, 0, `giá trị cũ ${String(row)}`);
    // Held at its finalize, so the pick below lands while it is written.
    await settle();
    expect(files.creates()).toBe(1);

    files.hold(false);
    const ref = await files.put("mới,1\r\n");
    setSheet(createSheet([["mới", "1"]]));
    await store.replaceSource({ source: ref, delimiter: ",", name: "moi.csv", formats: [] });
    files.release();
    await store.settled();

    // The new sheet went to a file of the widget's own straight after the pick.
    const source = state.durable().source as Ref;
    expect(state.durable()).toMatchObject({ sourceKind: "checkpoint", name: "moi.csv", edits: {} });
    // The checkpoint of the old sheet was thrown away: the picked file and the new sheet's own are all that is left.
    expect([...files.files.keys()].sort()).toEqual([ref.id, source.id].sort());
    const after = await reload(state, files);
    expect(after.sheet.rawRows()).toEqual([["mới", "1"]]);
  });

  it("keeps the edits, discards the file and stops when the host refuses the checkpoint", async () => {
    const state = fakeState({}, (patch) => patch.sourceKind === "checkpoint");
    const { files, store, edit, refusals } = await harness({ state });
    for (let row = 0; row < 40; row += 1) edit(row, 0, `giá trị x${String(row)}`);
    await store.settled();

    expect(refusals()).toBeGreaterThan(0);
    expect(Object.keys(store.edits())).toHaveLength(40);
    expect(state.durable().sourceKind).toBeUndefined();
    expect(files.files.size).toBe(0);
  });

  it("checkpoints a sheet cleared to nothing without writing a file, and a reload shows it empty", async () => {
    const files = fakeArtifacts();
    const text = Array.from({ length: 60 }, (_, row) => `dòng ${String(row)},${String(row)}`).join("\r\n");
    const picked = await files.put(`${text}\r\n`);
    const state = fakeState({ source: picked, sourceKind: "picked", delimiter: ",", edits: {} });
    const { store, setSheet, sheet } = await harness({ state, files });
    setSheet((await store.load()).sheet);
    expect(sheet().used()).toEqual({ rows: 60, columns: 2 });

    store.record(clearRange(sheet(), { top: 0, left: 0, bottom: 59, right: 1 }).map((name: string) => [name, ""]));
    store.save();
    await store.settled();

    expect(state.durable()).toMatchObject({ source: null, sourceKind: "checkpoint", edits: {} });
    // The person's own file is theirs: only the widget's checkpoints are ever discarded.
    expect([...files.files.keys()]).toEqual([picked.id]);
    expect((await reload(state, files)).sheet.used()).toEqual({ rows: 0, columns: 0 });
  });

  it("saves an edit to a newly picked sheet asked for while a checkpoint of the old sheet was written", async () => {
    const { state, files, store, edit, setSheet } = await harness();
    files.hold(true);
    for (let row = 0; row < 40; row += 1) edit(row, 0, `giá trị cũ ${String(row)}`);
    // The old sheet's checkpoint is written and held at its finalize.
    await settle();
    expect(files.creates()).toBe(1);

    files.hold(false);
    const ref = await files.put("mới,1\r\n");
    setSheet(createSheet([["mới", "1"]]));
    // The pick commits while the old sheet's checkpoint is still being written, so its own save waits behind it.
    expect(await store.replaceSource({ source: ref, delimiter: ",", name: "moi.csv", formats: [] })).toBe(true);
    // The new sheet edited, more than the state holds, before that checkpoint is done.
    for (let row = 0; row < 40; row += 1) edit(row + 1, 1, `mới ${String(row)}`);
    expect(files.creates()).toBe(2);
    files.release();
    await store.settled();

    const after = await reload(state, files);
    expect(after.gone).toBe(false);
    expect(after.sheet.raw(0, 0)).toBe("mới");
    for (let row = 0; row < 40; row += 1) expect(after.sheet.raw(row + 1, 1)).toBe(`mới ${String(row)}`);
  });

  it("discards the checkpoint a commit superseded, even when a file is picked while that commit is with the host", async () => {
    let open: () => void = () => undefined;
    let commits = 0;
    const state = fakeState({}, () => false, (patch) => {
      if (patch.sourceKind !== "checkpoint") return undefined;
      commits += 1;
      if (commits !== 2) return undefined;
      return new Promise<void>((resolve) => {
        open = resolve;
      });
    });
    const { files, store, edit, setSheet } = await harness({ state });
    for (let row = 0; row < 40; row += 1) edit(row, 0, `giá trị a${String(row)}`);
    await store.settled();
    const first = state.durable().source as Ref;
    expect(state.durable().sourceKind).toBe("checkpoint");

    for (let row = 0; row < 40; row += 1) edit(row, 1, `giá trị b${String(row)}`);
    await settle();
    // The second checkpoint's file is written and its commit is with the host.
    expect(commits).toBe(2);
    const picked = await files.put("mới,1\r\n");
    setSheet(createSheet([["mới", "1"]]));
    const replaced = store.replaceSource({ source: picked, delimiter: ",", name: "moi.csv", formats: [] });
    open();
    expect(await replaced).toBe(true);
    await store.settled();

    // Neither checkpoint of the old sheet is left: only the picked file and the new sheet's own file.
    const source = state.durable().source as Ref;
    expect(files.files.has(first.id)).toBe(false);
    expect([...files.files.keys()].sort()).toEqual([picked.id, source.id].sort());
    expect((await reload(state, files)).sheet.rawRows()).toEqual([["mới", "1"]]);
  });

  it("keeps the record of a write queued behind one the host refused", async () => {
    const state = fakeState({}, (patch) => "formats" in patch);
    const { store, refusals } = await harness({ state });
    const refused = store.persist({ formats: [{ range: "A1", format: "percent" }] });
    const later = store.persist({ name: "sau.csv" });

    expect(await refused).toBe(false);
    expect(await later).toBe(true);
    expect(refusals()).toBe(1);
    // What the store believes is saved is what the host holds: the later write, not the refused one.
    expect(store.saved()).toMatchObject({ name: "sau.csv" });
    expect(store.saved().formats).toBeUndefined();
    expect(state.durable()).toEqual({ name: "sau.csv" });
  });

  it("writes the cursor as view state only, never to the node", async () => {
    const { state, store } = await harness();
    await store.persist({ active: "B2", anchor: "A1" });
    expect(state.durableWrites()).toBe(0);
    expect(state.get()).toMatchObject({ active: "B2", anchor: "A1" });
    expect(state.durable()).toEqual({});
  });
});

describe("a picked file", () => {
  const sixty = Array.from({ length: 60 }, (_, row) => `dòng ${String(row)},${String(row)}`).join("\r\n");

  it("is written to a file of the widget's own, so the sheet still loads once the picked file can no longer be read", async () => {
    const { state, files, store, setSheet, failures } = await harness();
    const picked = await files.put(`${sixty}\r\n`, "nguon.csv");
    const result = await readSheetFile(files.artifacts, picked, ",");
    setSheet(createSheet(result.rows));
    expect(await store.replaceSource({ source: picked, delimiter: ",", name: "nguon.csv", formats: [], truncated: result.truncated })).toBe(true);
    await store.settled();

    expect(failures).toEqual([]);
    const source = state.durable().source as Ref;
    expect(state.durable()).toMatchObject({ sourceKind: "checkpoint", name: "nguon.csv", edits: {} });
    expect(source.id).not.toBe(picked.id);
    // The picked file's read grant expires after a day; the sheet no longer depends on it.
    files.files.delete(picked.id);
    const after = await reload(state, files);
    expect(after.gone).toBe(false);
    expect(after.sheet.rawRows()).toEqual(result.rows);
  });

  it("tries that write again with the next edit when it could not be written", async () => {
    const { state, files, store, edit, setSheet, failures } = await harness();
    const picked = await files.put(`${sixty}\r\n`, "nguon.csv");
    setSheet(createSheet((await readSheetFile(files.artifacts, picked, ",")).rows));
    files.failCreates(true);
    await store.replaceSource({ source: picked, delimiter: ",", name: "nguon.csv", formats: [] });
    await store.settled();
    expect(failures).toHaveLength(1);
    expect(state.durable()).toMatchObject({ source: picked, sourceKind: "picked" });

    files.failCreates(false);
    edit(0, 2, "một sửa nhỏ");
    await store.settled();
    expect(state.durable()).toMatchObject({ sourceKind: "checkpoint", edits: {} });
    files.files.delete(picked.id);
    const after = await reload(state, files);
    expect(after.sheet.raw(59, 0)).toBe("dòng 59");
    expect(after.sheet.raw(0, 2)).toBe("một sửa nhỏ");
  });
});

describe("before the sheet has loaded", () => {
  it("saves nothing, so an edit typed into the sheet shown while loading cannot replace the saved one", async () => {
    const files = fakeArtifacts();
    const text = Array.from({ length: 60 }, (_, row) => `dòng ${String(row)},${String(row)}`).join("\r\n");
    const saved = await files.put(`${text}\r\n`, "sheet-checkpoint.csv");
    // Edits close to the threshold, as they build up between checkpoints.
    const kept: Record<string, string> = {};
    for (let row = 0; row < 12; row += 1) kept[cellName(row, 2)] = `đã sửa ${String(row)}`;
    const state = fakeState({ source: saved, sourceKind: "checkpoint", delimiter: ",", edits: kept });
    files.holdReads(true);
    const { store, edit, setSheet } = await harness({ state, files, load: false });
    const loading = store.load();
    await settle();

    // Typed into the empty sheet shown while the source loads, enough that a save would need a checkpoint.
    for (let row = 0; row < 20; row += 1) edit(row, 3, `sớm ${String(row)}`);
    await store.settled();
    expect(files.creates()).toBe(1);
    expect(state.durableWrites()).toBe(0);
    expect(files.files.has(saved.id)).toBe(true);

    files.holdReads(false);
    files.releaseReads();
    const loaded = await loading;
    expect(loaded.gone).toBe(false);
    setSheet(loaded.sheet);
    edit(70, 0, "sau khi tải");
    await store.settled();

    const after = await reload(state, files);
    expect(after.gone).toBe(false);
    for (let row = 0; row < 60; row += 1) expect(after.sheet.raw(row, 0)).toBe(`dòng ${String(row)}`);
    for (let row = 0; row < 12; row += 1) expect(after.sheet.raw(row, 2)).toBe(`đã sửa ${String(row)}`);
    for (let row = 0; row < 20; row += 1) expect(after.sheet.raw(row, 3)).toBe(`sớm ${String(row)}`);
    expect(after.sheet.raw(70, 0)).toBe("sau khi tải");
  });

  it("never saves over a source that could not be read, and a file picked after it is saved as usual", async () => {
    const files = fakeArtifacts();
    const lost = { id: "art_unreadable", mimeType: "text/csv", name: "sheet-checkpoint.csv" };
    const state = fakeState({ source: lost, sourceKind: "checkpoint", delimiter: ",", edits: { A2: "5" } });
    const { store, edit, setSheet } = await harness({ state, files, load: false });
    const loaded = await store.load();
    expect(loaded.gone).toBe(true);
    expect(String(loaded.error)).toContain("ARTIFACT_NOT_FOUND");

    setSheet(loaded.sheet);
    for (let row = 0; row < 40; row += 1) edit(row, 1, `không lưu ${String(row)}`);
    await store.settled();
    expect(files.creates()).toBe(0);
    expect(state.durableWrites()).toBe(0);
    expect(state.durable()).toMatchObject({ source: lost, sourceKind: "checkpoint", edits: { A2: "5" } });

    const picked = await files.put("mới,1\r\n");
    setSheet(createSheet([["mới", "1"]]));
    expect(await store.replaceSource({ source: picked, delimiter: ",", name: "moi.csv", formats: [] })).toBe(true);
    await store.settled();
    expect(state.durable()).toMatchObject({ sourceKind: "checkpoint", name: "moi.csv", edits: {} });
    expect((await reload(state, files)).sheet.rawRows()).toEqual([["mới", "1"]]);
  });

  it("does not hand back a sheet that finished loading after a picked file replaced it", async () => {
    const files = fakeArtifacts();
    const old = await files.put("cũ,1\r\n", "cu.csv");
    const state = fakeState({ source: old, sourceKind: "picked", delimiter: ",", edits: { B1: "2" } });
    files.holdReads(true);
    const { store, setSheet } = await harness({ state, files, load: false });
    const loading = store.load();
    await settle();

    const picked = await files.put("mới,1\r\n", "moi.csv");
    setSheet(createSheet([["mới", "1"]]));
    expect(await store.replaceSource({ source: picked, delimiter: ",", name: "moi.csv", formats: [] })).toBe(true);
    files.holdReads(false);
    files.releaseReads();
    const loaded = await loading;
    expect(loaded.superseded).toBe(true);
    await store.settled();

    expect((await reload(state, files)).sheet.rawRows()).toEqual([["mới", "1"]]);
  });
});

describe("loading a source", () => {
  it("says a checkpoint that does not load whole was cut, and replays the edits over it", async () => {
    const files = fakeArtifacts();
    const rows = Array.from({ length: 5_200 }, (_, row) => `${String(row)},x`).join("\r\n");
    const ref = await files.put(`${rows}\r\n`, "sheet-checkpoint.csv");
    const state = fakeState({ source: ref, sourceKind: "checkpoint", delimiter: ",", edits: { B1: "đã sửa" } });
    const store = createStore({ state, artifacts: files.artifacts, snapshot: () => [] });

    const loaded = await store.load();

    expect(loaded.truncated.rows).toBe(true);
    expect(loaded.sheet.used()).toEqual({ rows: 5_000, columns: 2 });
    expect(loaded.sheet.raw(0, 1)).toBe("đã sửa");
  });

  it("keeps the edits on an empty sheet when the source is gone", async () => {
    const files = fakeArtifacts();
    const state = fakeState({ source: { id: "art_gone", mimeType: "text/csv", name: "x.csv" }, sourceKind: "picked", edits: { A2: "5" } });
    const loaded = await createStore({ state, artifacts: files.artifacts, snapshot: () => [] }).load();
    expect(loaded.gone).toBe(true);
    expect(loaded.sheet.raw(1, 0)).toBe("5");
  });

  it("loads a ragged file only as far as its rectangle fits, so every cell inside it can still be edited", async () => {
    const files = fakeArtifacts();
    const wide = Array.from({ length: 64 }, (_, column) => `c${String(column)}`).join(",");
    const narrow = Array.from({ length: 4_999 }, (_, row) => `r${String(row)}`);
    const ref = await files.put(`${[wide, ...narrow].join("\n")}\n`);

    const result = await readSheetFile(files.artifacts, ref, ",");
    const sheet = createSheet(result.rows);

    expect(result.truncated.rows).toBe(true);
    const size = sheet.used();
    expect(size.columns).toBe(64);
    expect(size.rows * size.columns).toBeLessThanOrEqual(MAX_CELLS);
    expect(sheet.set(0, 0, "y")).toBe(true);
    expect(sheet.set(1, 1, "x")).toBe(true);
  });

  it("drops the line a read stopped in at the byte limit, and says the file was cut", async () => {
    const files = fakeArtifacts();
    const lines = Array.from({ length: 200 }, (_, row) => `${String(row).padStart(5, "0")},${"chữ dài ".repeat(4)}`);
    const ref = await files.put(`${lines.join("\r\n")}\r\n`);

    const result = await readSheetFile(files.artifacts, ref, ",", { maxBytes: 1_000, chunk: 300 });

    expect(result.truncated.rows).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const [index, row] of result.rows.entries()) expect(row).toEqual(lines[index]?.split(","));
  });

  it("says the file was cut when the byte limit falls exactly on a line end", async () => {
    const files = fakeArtifacts();
    // Twelve bytes a line, so ten lines end exactly at 120 bytes; at 119 the limit falls between "\r" and "\n".
    const lines = Array.from({ length: 50 }, (_, row) => `${String(row).padStart(5, "0")},abcd`);
    for (const [ending, maxBytes] of [["\n", 120], ["\r\n", 119]] as const) {
      const text = `${lines.map((line) => `${line}${ending === "\n" ? " " : ""}`).join(ending)}${ending}`;
      const ref = await files.put(text);

      const result = await readSheetFile(files.artifacts, ref, ",", { maxBytes });

      expect(result.truncated.rows, JSON.stringify(ending)).toBe(true);
      expect(result.rows).toHaveLength(10);
      expect(result.rows[9]?.[0]).toBe("00009");
    }
  });
});
