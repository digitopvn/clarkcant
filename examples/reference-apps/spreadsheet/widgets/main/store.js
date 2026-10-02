/*
 * The sheet's durable side: reading and writing files through `artifacts@1`, the edits made since the sheet's source,
 * and the checkpoint that folds those edits into a file of the widget's own when they outgrow the state.
 *
 * Nothing here touches the page, so the paths that lose data when they go wrong — a checkpoint racing the edits made
 * while it is written, a reload that replays edits over the source — run in unit tests against a fake host.
 */

import { createDelimitedReader, writeDelimited } from "./csv.js";
import { MAX_CELLS, MAX_CELL_CHARS, MAX_COLUMNS, MAX_ROWS, createSheet, parseCellName } from "./sheet.js";

/** One read: the bridge's own ceiling. */
export const CHUNK = 262_144;
/** A file is read no further than this, whatever its rows look like. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;
/** Above this many bytes of state the edits are written to a file instead (the host's ceiling is 16 KiB). */
export const CHECKPOINT_BYTES = 10 * 1024;

const encoder = new globalThis.TextEncoder();

/**
 * A file read into rows, stopping at the sheet's ceiling or at `maxBytes`. A read that stops before the end of the file
 * drops the line it stopped in, and says the file was cut.
 */
export async function readSheetFile(artifacts, ref, delimiter, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_READ_BYTES;
  const chunk = options.chunk ?? CHUNK;
  const reader = createDelimitedReader({
    delimiter,
    maxRows: MAX_ROWS,
    maxColumns: MAX_COLUMNS,
    maxCells: MAX_CELLS,
    maxCellChars: MAX_CELL_CHARS,
  });
  const decoder = new globalThis.TextDecoder();
  let offset = 0;
  let stoppedEarly = false;
  for (;;) {
    const { bytes, eof } = await artifacts.read(ref, { offset, length: Math.min(chunk, maxBytes - offset) });
    offset += bytes.byteLength;
    const full = reader.push(decoder.decode(bytes, { stream: !eof }));
    if (full || eof || bytes.byteLength === 0) break;
    if (offset >= maxBytes) {
      stoppedEarly = true;
      break;
    }
  }
  return reader.finish({ dropPartial: stoppedEarly });
}

/** Text written to a new file in chunks and finalized; the finalized reference. */
export async function writeTextFile(artifacts, text, mimeType, name) {
  const bytes = encoder.encode(text);
  let ref = await artifacts.create({ mimeType, name });
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
    ref = await artifacts.write(ref, bytes.subarray(offset, offset + CHUNK));
  }
  return artifacts.finalize(ref);
}

/** Edits replayed over a sheet, cell by cell; an edit that no longer fits is skipped. */
export function applyEdits(sheet, edits) {
  for (const [name, value] of Object.entries(edits)) {
    const cell = parseCellName(name);
    if (cell !== undefined && typeof value === "string") sheet.set(cell.row, cell.column, value);
  }
}

const NO_CUT = Object.freeze({ rows: false, columns: false, clipped: false });

/** What was cut from the sheet: either side's cuts. */
export function mergeTruncated(a, b) {
  return { rows: a.rows || b.rows, columns: a.columns || b.columns, clipped: a.clipped || b.clipped };
}

export function readTruncated(value) {
  if (typeof value !== "object" || value === null) return { ...NO_CUT };
  return { rows: value.rows === true, columns: value.columns === true, clipped: value.clipped === true };
}

/**
 * The durable state.
 *
 * - `state` is `api.state`, `artifacts` is `api.artifacts` or `undefined` when the host offers no files.
 * - `snapshot()` gives the sheet's raw rows right now, for a checkpoint.
 * - `onRefused()` is told when the host refused a write; `onFailed(error)` when a checkpoint could not be written.
 *
 * Writes go to the host one at a time, in order. A checkpoint runs one at a time too, with at most one more queued
 * behind it: edits made while a checkpoint is written stay in the edit map and are folded into the next one, and the
 * checkpoint removes from the map only the edits its own file holds.
 */
export function createStore(options) {
  const { state, artifacts, snapshot } = options;
  const checkpointBytes = options.checkpointBytes ?? CHECKPOINT_BYTES;
  const onRefused = options.onRefused ?? (() => undefined);
  const onFailed = options.onFailed ?? (() => undefined);

  let saved = { ...state.get() };
  const initial = saved.edits;
  /** Owned here and changed in place, so recording a batch costs the batch, not the map. */
  let edits = typeof initial === "object" && initial !== null && !Array.isArray(initial) ? { ...initial } : {};
  let writes = Promise.resolve();
  /** Bumped when the sheet's source is replaced, so a checkpoint of the old sheet never lands on the new one. */
  let generation = 0;
  let running;
  let queued = false;

  const bytesOf = (value) => encoder.encode(JSON.stringify(value)).byteLength;

  /** A write, after the ones before it. Resolves true once the host committed it, false when it refused. */
  const persist = (patch) => {
    saved = { ...saved, ...patch };
    const result = writes.then(
      () => state.update(state.revision(), patch).then(
        () => true,
        () => {
          // What the host holds is what is true; the edits in memory are kept and go out with the next write.
          saved = { ...state.get() };
          onRefused();
          return false;
        },
      ),
    );
    writes = result.then(() => undefined);
    return result;
  };

  const fitsInState = () => bytesOf({ ...saved, edits }) <= checkpointBytes;

  /** One checkpoint; true when its file became the sheet's source. */
  const checkpointOnce = async () => {
    const started = generation;
    const taken = { ...edits };
    const rows = snapshot();
    // An empty sheet needs no file: its source is none.
    const ref = rows.length === 0 ? null : await writeTextFile(artifacts, writeDelimited(rows, ",", { neutralize: false }), "text/csv", "sheet-checkpoint.csv");
    const drop = () => (ref === null ? Promise.resolve() : artifacts.discard(ref).catch(() => undefined));
    if (started !== generation) {
      // The sheet was replaced while this was written: this file holds a sheet nobody has any more.
      await drop();
      return false;
    }
    // Edits made since the snapshot are not in the file: they stay, and are saved with the new source.
    const rest = {};
    for (const [name, value] of Object.entries(edits)) if (!(name in taken) || taken[name] !== value) rest[name] = value;
    // The file this one supersedes is read now, not when the checkpoint started: an earlier checkpoint may have landed.
    const previous = saved.sourceKind === "checkpoint" ? saved.source : undefined;
    const committed = await persist({ source: ref, sourceKind: "checkpoint", delimiter: ",", edits: rest });
    if (!committed) {
      await drop();
      return false;
    }
    // A file picked while this was committing replaced it, and discards it as the source it superseded.
    if (started !== generation) return false;
    // Only what the file holds leaves the map; an edit changed again since the snapshot stays.
    for (const [name, value] of Object.entries(taken)) if (edits[name] === value) delete edits[name];
    if (previous !== undefined && previous !== null) await artifacts.discard(previous).catch(() => undefined);
    return true;
  };

  /**
   * Run checkpoints until the edits fit the state again. A save asked for while one runs only sets `queued`; the loop
   * then saves once more, in the state when the edits fit by now, through another checkpoint when they do not. A
   * checkpoint that fails or is refused ends the loop: the edits stay in memory and the next edit tries again.
   */
  const checkpoint = () => {
    if (running !== undefined) {
      queued = true;
      return running;
    }
    running = (async () => {
      try {
        let more = true;
        while (more) {
          queued = false;
          if (fitsInState()) await persist({ edits: { ...edits } });
          else if (!(await checkpointOnce())) break;
          more = queued;
        }
      } catch (error) {
        onFailed(error);
      } finally {
        running = undefined;
        queued = false;
      }
    })();
    return running;
  };

  /** Save the edits: in the state when they fit, through a checkpoint when they do not. */
  const save = () => {
    if (fitsInState() || artifacts === undefined) {
      void persist({ edits: { ...edits } });
      return;
    }
    void checkpoint();
  };

  return {
    saved: () => saved,
    edits: () => edits,
    persist,
    save,
    /** Cell values written to the sheet, as `[name, raw]` pairs, recorded in one pass. */
    record(changes) {
      for (const [name, value] of changes) edits[name] = value;
    },
    /**
     * The sheet's source replaced by a file just picked: the edits start again, and a checkpoint of the old sheet, one
     * in flight included, is dropped.
     */
    async replaceSource(patch) {
      generation += 1;
      queued = false;
      edits = {};
      const previous = saved.sourceKind === "checkpoint" ? saved.source : undefined;
      const committed = await persist({ ...patch, sourceKind: "picked", edits: {} });
      if (committed && previous !== undefined && previous !== null && artifacts !== undefined) {
        await artifacts.discard(previous).catch(() => undefined);
      }
      return committed;
    },
    /**
     * The sheet rebuilt from its source and the edits since. `gone` is true when the source could not be read; the edits
     * are applied to an empty sheet then. `truncated` says what of the source did not load.
     */
    async load() {
      const source = saved.source;
      let sheet = createSheet();
      let truncated = readTruncated(saved.truncated);
      let gone = false;
      if (source !== undefined && source !== null && artifacts !== undefined) {
        try {
          const result = await readSheetFile(artifacts, source, saved.delimiter === "\t" ? "\t" : ",");
          sheet = createSheet(result.rows);
          truncated = mergeTruncated(truncated, result.truncated);
        } catch {
          gone = true;
        }
      }
      applyEdits(sheet, edits);
      return { sheet, truncated, gone };
    },
    /** Resolves once no checkpoint is running and every write has been answered. */
    async settled() {
      while (running !== undefined) await running;
      await writes;
    },
  };
}
