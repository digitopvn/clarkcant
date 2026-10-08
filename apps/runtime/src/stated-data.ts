import { type Instant, MAX_CHART_POINTS } from "@clarkcant/contracts";
import { type Database, upsertDataset } from "@clarkcant/storage";

/**
 * Rows a model states for a view, kept as a dataset the person owns.
 *
 * A chart or a table draws a dataset by reference, so a large result never enters the transcript and freshness is said
 * next to the view. That left one honest question unanswered: where does a dataset come from when the numbers are ones
 * the model has just gathered, from a page it read or a comparison it was asked for? Nowhere, before this — so the
 * model answered in prose, or wrote a widget package to draw a bar chart. `show_view` now takes those rows under a name,
 * the node keeps them as a dataset labelled as saved data (never live), and every `datasetRef` in the props that uses
 * the name is pointed at it.
 *
 * Bounded, because a stated dataset is something a model wrote into a tool call: a few hundred rows of plain values,
 * not a result set. Anything larger belongs to a capability that reads it where it lives.
 */

export const MAX_STATED_DATASETS = 8;
export const MAX_STATED_ROWS = MAX_CHART_POINTS;
export const MAX_STATED_COLUMNS = 32;
export const MAX_STATED_TEXT = 500;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const COLUMN_LIMIT = 64;

export type StatedCell = string | number | boolean | null;

export interface StatedDataset {
  name: string;
  columns: string[];
  rows: Record<string, StatedCell>[];
}

/** What the node is asked to keep: one stated dataset, for the person whose turn stated it. */
export interface StatedDatasetInput {
  principalId: string;
  dataset: StatedDataset;
}

export type StatedDataOutcome = { ok: true; datasets: StatedDataset[] } | { ok: false; problem: string };

/** The JSON Schema the model sees for `data`. */
export const STATED_DATA_SCHEMA: Record<string, unknown> = {
  type: "object",
  description:
    `Rows you gathered, under a name of your choosing ({"<name>":{"rows":[{...}],"columns"?:[...]}}). Each name is kept ` +
    `as a dataset; put the same name in props.datasetRef to draw it, in a chart, a table or a calendar shown on its own. Up to ` +
    `${String(MAX_STATED_DATASETS)} names, ${String(MAX_STATED_ROWS)} rows and ${String(MAX_STATED_COLUMNS)} fields each; ` +
    `a value is text, a number, true/false or null. Numbers must be JSON numbers, never text like "12%".`,
  maxProperties: MAX_STATED_DATASETS,
  additionalProperties: {
    type: "object",
    required: ["rows"],
    properties: {
      columns: { type: "array", items: { type: "string" }, maxItems: MAX_STATED_COLUMNS },
      rows: { type: "array", items: { type: "object" }, minItems: 1, maxItems: MAX_STATED_ROWS },
    },
  },
};

/**
 * Read the `data` argument, or say exactly what does not fit.
 *
 * Refused whole rather than trimmed: a chart drawn from half the rows a model meant to show is a wrong chart, and the
 * model can correct the call in the same turn when it reads why.
 */
export function readStatedData(raw: unknown): StatedDataOutcome {
  if (raw === undefined) return { ok: true, datasets: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: "data must be an object of named datasets" };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_STATED_DATASETS) {
    return { ok: false, problem: `data names ${String(entries.length)} datasets; at most ${String(MAX_STATED_DATASETS)}` };
  }
  const datasets: StatedDataset[] = [];
  for (const [name, value] of entries) {
    if (!NAME.test(name)) {
      return { ok: false, problem: `data name "${name.slice(0, 80)}" must be 1-64 letters, digits, "_", "-" or "."` };
    }
    const read = readOne(name, value);
    if (typeof read === "string") return { ok: false, problem: read };
    datasets.push(read);
  }
  return { ok: true, datasets };
}

function readOne(name: string, value: unknown): StatedDataset | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return `data.${name} must be {"rows":[...]}`;
  const record = value as Record<string, unknown>;
  const rows = record.rows;
  if (!Array.isArray(rows) || rows.length === 0) return `data.${name}.rows must be a non-empty list of rows`;
  if (rows.length > MAX_STATED_ROWS) {
    return `data.${name} has ${String(rows.length)} rows; at most ${String(MAX_STATED_ROWS)}`;
  }
  const seen: string[] = [];
  const kept: Record<string, StatedCell>[] = [];
  for (const [index, row] of rows.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return `data.${name}.rows[${String(index)}] must be an object`;
    const cells: Record<string, StatedCell> = {};
    for (const [field, cell] of Object.entries(row as Record<string, unknown>)) {
      if (field === "" || field.length > COLUMN_LIMIT) return `data.${name} has a field name that is empty or longer than ${String(COLUMN_LIMIT)}`;
      // A row is a plain object, where this one name would set the prototype instead of keeping a value.
      if (field === "__proto__") return `data.${name} has a field named __proto__, which a row cannot keep`;
      if (!seen.includes(field)) {
        seen.push(field);
        if (seen.length > MAX_STATED_COLUMNS) return `data.${name} has more than ${String(MAX_STATED_COLUMNS)} fields`;
      }
      const problem = cellProblem(cell);
      if (problem !== undefined) return `data.${name}.rows[${String(index)}].${field} ${problem}`;
      cells[field] = cell as StatedCell;
    }
    kept.push(cells);
  }
  const declared = record.columns;
  let columns = seen;
  if (declared !== undefined) {
    if (!Array.isArray(declared) || declared.some((column) => typeof column !== "string")) {
      return `data.${name}.columns must be a list of field names`;
    }
    const missing = (declared as string[]).filter((column) => !seen.includes(column));
    if (missing.length > 0) return `data.${name}.columns names ${missing.join(", ")}, which no row has`;
    // The declared order first, then any field the rows have that the list left out: nothing a row holds is hidden.
    columns = [...(declared as string[]), ...seen.filter((column) => !(declared as string[]).includes(column))];
  }
  return { name, columns, rows: kept };
}

function cellProblem(cell: unknown): string | undefined {
  if (cell === null || typeof cell === "boolean") return undefined;
  if (typeof cell === "number") return Number.isFinite(cell) ? undefined : "is not a finite number";
  if (typeof cell === "string") return cell.length > MAX_STATED_TEXT ? `is longer than ${String(MAX_STATED_TEXT)} characters` : undefined;
  return "must be text, a number, true/false or null";
}

/**
 * Keep one stated dataset for the person, and return its reference.
 *
 * Labelled `cached` — "saved data" in the interface — because that is what it is: a snapshot the model collected, which
 * nothing refreshes. Never `live`, and never `sample`: the numbers are real ones the model gathered, and a chart over
 * them must neither claim to be current nor be dismissed as made up.
 */
export function keepStatedDataset(
  deps: { db: Database; nodeId: string; newId: (prefix: string) => string; now: () => Instant },
  input: StatedDatasetInput,
): string {
  const datasetId = deps.newId("dataset");
  upsertDataset(deps.db, {
    datasetId,
    originNodeId: deps.nodeId,
    rowCount: input.dataset.rows.length,
    freshness: "cached",
    updatedAt: deps.now(),
    document: { columns: input.dataset.columns, rows: input.dataset.rows },
    ownerPrincipalId: input.principalId,
  });
  return datasetId;
}

/**
 * The props with every `datasetRef` that names a stated dataset pointed at the one the node kept.
 *
 * Walked through the whole tree because a layout keeps its leaves' props several levels down; any other value, and a
 * `datasetRef` naming something else, is left exactly as the model wrote it.
 */
export function bindStatedRefs(value: unknown, kept: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => bindStatedRefs(item, kept));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      key === "datasetRef" && typeof item === "string" && kept.has(item) ? kept.get(item) : bindStatedRefs(item, kept),
    ]),
  );
}
