import { z } from "zod";

import { cardSchemaProblems, clipWithMarker, hiddenCharacterProblem, markHiddenCharacters, oneLineText } from "./text-rules.ts";
import type { SemanticValue } from "./widget-semantic.ts";
import { SNAPSHOT_TEXT_LIMIT } from "./widgets.ts";

/**
 * Area and scatter charts over a dataset, with the fields they plot named rather than guessed.
 *
 * The older line, bar and donut charts plot the first numeric column they find. These two never do: the model names the
 * field on the x axis and each series on the y axis, and a chart whose fields are not in the rows, or whose values are
 * not numbers, is refused before an instance exists, with the reason. One description serves the node and the page:
 * the node checks props and rows with `xyChartProblems` when the model places the chart and checks every view change
 * with `xyChartViewProblems`; the page reads the same props with `readXyChart` and draws only rows that pass.
 *
 * What a person changes on the chart — which series are hidden, which point is selected — is widget state the node
 * holds, changed through one bound view operation (`chart.view`), so what voice and a model read about the chart is
 * what the person is looking at.
 */

export const XY_CHART_KINDS = ["area", "scatter"] as const;
export type XyChartKind = (typeof XY_CHART_KINDS)[number];

export const AREA_CHART_ID = "canvas.area@1";
export const SCATTER_CHART_ID = "canvas.scatter@1";

/** Which kind of chart each definition draws. */
export const XY_CHART_KIND: Readonly<Record<string, XyChartKind>> = {
  [AREA_CHART_ID]: "area",
  [SCATTER_CHART_ID]: "scatter",
};

/** Series one chart may plot: past this, a legend stops being readable and patterns start to repeat. */
export const MAX_CHART_SERIES = 8;
/** Rows one chart plots. A longer dataset is drawn from its first rows, and the chart says how many it left out. */
export const MAX_CHART_POINTS = 500;
export const MAX_FIELD_NAME = 64;
export const MAX_SERIES_LABEL = 60;

/** The one view operation both charts are bound to: it sets the hidden series and the selected point together. */
export const XY_CHART_VIEW_OPERATION = "chart.view";

/**
 * A field name, compared exactly with the rows' keys.
 *
 * Not trimmed or normalised the way a label is: " runs" and "runs" are two different keys in a row, and a chart that
 * quietly matched one to the other would plot a column the model did not name.
 */
const fieldNameSchema = z
  .string()
  .min(1, "is empty")
  .max(MAX_FIELD_NAME, `is longer than ${String(MAX_FIELD_NAME)} characters`)
  .superRefine((value, ctx) => {
    const problem = hiddenCharacterProblem(value);
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
    else if (value.trim() === "") ctx.addIssue({ code: "custom", message: "is only spaces" });
  });

const common = {
  title: oneLineText(200, false).optional(),
  datasetRef: z.string().min(1).max(200),
  x: fieldNameSchema,
  y: z
    .array(fieldNameSchema)
    .min(1, "names no series")
    .max(MAX_CHART_SERIES, `names more than ${String(MAX_CHART_SERIES)} series`),
  labels: z.record(z.string(), oneLineText(MAX_SERIES_LABEL, true)).optional(),
  unit: oneLineText(20, false).optional(),
};

export const areaChartPropsSchema = z.strictObject({ ...common, stacked: z.boolean().optional() });
export const scatterChartPropsSchema = z.strictObject({
  ...common,
  xUnit: oneLineText(20, false).optional(),
  pointLabel: fieldNameSchema.optional(),
});

/** A chart as its props describe it, labels read and defaults filled in. */
export interface XyChart {
  kind: XyChartKind;
  title?: string;
  datasetRef: string;
  x: string;
  y: string[];
  /** What to call a field on the axes, the legend and in words; a field with no label is called by its name. */
  labels: Record<string, string>;
  unit?: string;
  xUnit?: string;
  stacked: boolean;
  pointLabel?: string;
}

type Parsed = { ok: true; chart: XyChart } | { ok: false; problems: string[] };

function parsed(kind: XyChartKind, props: unknown): Parsed {
  const result = kind === "area" ? areaChartPropsSchema.safeParse(props) : scatterChartPropsSchema.safeParse(props);
  if (!result.success) return { ok: false, problems: cardSchemaProblems(result.error.issues) };
  const data = result.data as z.infer<typeof areaChartPropsSchema> & z.infer<typeof scatterChartPropsSchema>;
  return {
    ok: true,
    chart: {
      kind,
      ...(data.title === undefined || data.title === "" ? {} : { title: data.title }),
      datasetRef: data.datasetRef,
      x: data.x,
      y: data.y,
      // Without a prototype, so a field called "constructor" or "toString" has no label it did not get from the props.
      labels: Object.assign(Object.create(null) as Record<string, string>, data.labels),
      ...(data.unit === undefined || data.unit === "" ? {} : { unit: data.unit }),
      ...(data.xUnit === undefined || data.xUnit === "" ? {} : { xUnit: data.xUnit }),
      stacked: data.stacked === true,
      ...(data.pointLabel === undefined ? {} : { pointLabel: data.pointLabel }),
    },
  };
}

/**
 * What the props say that their schema cannot: a series named twice, the x field also a series, a point label that is
 * already plotted, a label for nothing.
 */
function staticProblems(chart: XyChart): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const field of chart.y) {
    if (seen.has(field)) problems.push(`"y" names "${field}" twice; each series is named once`);
    seen.add(field);
  }
  if (seen.has(chart.x)) problems.push(`"${chart.x}" is both "x" and a series in "y"; a field is plotted on one axis`);
  if (chart.pointLabel !== undefined && (chart.pointLabel === chart.x || seen.has(chart.pointLabel))) {
    problems.push(`"pointLabel" names "${chart.pointLabel}", which is already plotted; a point is named by a field it is not placed by`);
  }
  const named = new Set([chart.x, ...chart.y, ...(chart.pointLabel === undefined ? [] : [chart.pointLabel])]);
  for (const key of Object.keys(chart.labels)) {
    if (!named.has(key)) problems.push(`"labels" names "${key}", which is not a field this chart plots`);
  }
  return problems;
}

/** The chart its props describe, or `undefined` when the node would refuse them whatever the rows hold. */
export function readXyChart(kind: XyChartKind, props: unknown): XyChart | undefined {
  const result = parsed(kind, props);
  return result.ok && staticProblems(result.chart).length === 0 ? result.chart : undefined;
}

/** What to call a field: its label, or its own name. */
export function xyFieldLabel(chart: XyChart, field: string): string {
  return Object.hasOwn(chart.labels, field) ? (chart.labels[field] ?? field) : field;
}

/**
 * The value a row holds under `field`, read only from the row itself.
 *
 * A dataset's fields are names a person chose, and "constructor" or "toString" is as good a name as "runs": reading
 * `row[field]` handed back the function every object inherits under those names.
 */
export function ownField(row: Readonly<Record<string, unknown>>, field: string): unknown {
  return Object.hasOwn(row, field) ? row[field] : undefined;
}

/* ------------------------------------------------------------------ *
 * The rows
 * ------------------------------------------------------------------ */

/** At most this many row problems in one refusal; the count of the rest is said. */
const MAX_ROW_PROBLEMS = 5;

function shown(value: unknown): string {
  const text = typeof value === "string" ? JSON.stringify(value) : value === undefined ? "missing" : JSON.stringify(value);
  return clipWithMarker(text ?? String(value), 40, "…");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function present(row: Record<string, unknown>, field: string): boolean {
  const value = ownField(row, field);
  return value !== null && value !== undefined;
}

/**
 * One thing wrong with plotting the rows, as data: what kind of problem, the row (counted from 1, as a person counts
 * them), the field and the value it holds.
 *
 * The node says these in English to the model that placed the chart (`xyDataIssueText`); the page says them in the
 * person's language from the same fields, so no sentence is translated by matching its words.
 */
export type XyDataIssue =
  | { code: "missing-field"; field: string; fields: string[] }
  | { code: "not-an-object"; row: number }
  | { code: "no-value"; row: number; field: string }
  | { code: "not-a-number"; row: number; field: string; value: string }
  | { code: "x-number-among-text"; row: number; field: string }
  | { code: "x-text-among-numbers"; row: number; field: string }
  | { code: "x-not-rising"; row: number; field: string; value: string; previousRow: number; previousValue: string }
  | { code: "x-not-placeable"; row: number; field: string; value: string }
  | { code: "negative-stacked"; row: number; field: string; value: string }
  | { code: "stacked-sum-not-finite"; row: number }
  | { code: "not-a-label"; row: number; field: string; value: string }
  | { code: "more"; count: number };

/**
 * Everything wrong with plotting these rows: a named field no row has, a value that is not a number, an x that cannot be
 * placed on its axis.
 *
 * Only the rows the chart draws are read, so a dataset of a million rows costs what its first `MAX_CHART_POINTS` cost.
 * `columns` is the dataset's own list of fields when it has one; with it, an empty dataset can still say that a named
 * field is not one of them.
 */
export function xyChartDataIssues(chart: XyChart, rows: readonly unknown[], columns?: readonly unknown[]): XyDataIssue[] {
  const fields = [chart.x, ...chart.y, ...(chart.pointLabel === undefined ? [] : [chart.pointLabel])];
  const drawn = rows.slice(0, MAX_CHART_POINTS);
  const known = new Set<string>((columns ?? []).filter((column): column is string => typeof column === "string"));
  for (const row of drawn) if (isRecord(row)) for (const key of Object.keys(row)) known.add(key);

  const missing = fields.filter((field) => !known.has(field));
  if (missing.length > 0 && (drawn.length > 0 || known.size > 0)) {
    const list = [...known].slice(0, 12);
    return missing.map((field) => ({ code: "missing-field", field, fields: list }));
  }

  const issues: XyDataIssue[] = [];
  let extra = 0;
  const report = (issue: XyDataIssue): void => {
    if (issues.length < MAX_ROW_PROBLEMS) issues.push(issue);
    else extra += 1;
  };

  let firstKind: "number" | "text" | undefined;
  let previous: { row: number; value: number } | undefined;
  drawn.forEach((row, index) => {
    const at = index + 1;
    if (!isRecord(row)) {
      report({ code: "not-an-object", row: at });
      return;
    }
    const field = chart.x;
    const x = ownField(row, field);
    if (!present(row, field)) {
      report({ code: "no-value", row: at, field });
    } else if (chart.kind === "scatter") {
      if (!finite(x)) report({ code: "not-a-number", row: at, field, value: shown(x) });
    } else if (finite(x)) {
      if (firstKind === "text") report({ code: "x-number-among-text", row: at, field });
      firstKind ??= "number";
      if (previous !== undefined && x <= previous.value) {
        report({ code: "x-not-rising", row: at, field, value: String(x), previousRow: previous.row, previousValue: String(previous.value) });
      }
      previous = { row: at, value: x };
    } else if (typeof x === "string" && x.trim() !== "") {
      if (firstKind === "number") report({ code: "x-text-among-numbers", row: at, field });
      firstKind ??= "text";
    } else {
      report({ code: "x-not-placeable", row: at, field, value: shown(x) });
    }

    for (const series of chart.y) {
      const value = ownField(row, series);
      if (!present(row, series)) report({ code: "no-value", row: at, field: series });
      else if (!finite(value)) report({ code: "not-a-number", row: at, field: series, value: shown(value) });
      else if (chart.kind === "area" && chart.stacked && value < 0) report({ code: "negative-stacked", row: at, field: series, value: String(value) });
    }
    // Each value can be a number while their sum is not: eight values of 1e308 stack past the largest double, and the
    // band drawn from that sum would be a path of NaN.
    if (chart.kind === "area" && chart.stacked) {
      const sum = chart.y.reduce((total, series) => {
        const value = ownField(row, series);
        return finite(value) ? total + value : total;
      }, 0);
      if (!Number.isFinite(sum)) report({ code: "stacked-sum-not-finite", row: at });
    }

    if (chart.pointLabel !== undefined && present(row, chart.pointLabel)) {
      const name = ownField(row, chart.pointLabel);
      if (typeof name !== "string" && !finite(name)) report({ code: "not-a-label", row: at, field: chart.pointLabel, value: shown(name) });
    }
  });
  if (extra > 0) issues.push({ code: "more", count: extra });
  return issues;
}

/** One issue as the node says it to a model: plain English with the row, the field and the value. */
export function xyDataIssueText(issue: XyDataIssue): string {
  if (issue.code === "missing-field") {
    const list = issue.fields.map((field) => `"${field}"`).join(", ");
    return `the dataset has no field "${issue.field}"; its fields are ${list === "" ? "none" : list}`;
  }
  if (issue.code === "more") return `and ${String(issue.count)} more problem(s) in the same rows`;
  const at = `row ${String(issue.row)}`;
  switch (issue.code) {
    case "not-an-object":
      return `${at} is not an object with fields`;
    case "no-value":
      return `${at} has no "${issue.field}"`;
    case "not-a-number":
      return `${at}'s "${issue.field}" is ${issue.value}, not a number`;
    case "x-number-among-text":
      return `${at}'s "${issue.field}" is a number where the rows above hold text; the x values are all numbers or all text`;
    case "x-text-among-numbers":
      return `${at}'s "${issue.field}" is text where the rows above hold numbers; the x values are all numbers or all text`;
    case "x-not-rising":
      return `${at}'s "${issue.field}" (${issue.value}) is not after row ${String(issue.previousRow)}'s (${issue.previousValue}); numbers on the x axis must rise row by row`;
    case "x-not-placeable":
      return `${at}'s "${issue.field}" is ${issue.value}, which is neither a number nor a label`;
    case "negative-stacked":
      return `${at}'s "${issue.field}" is ${issue.value}; a stacked area adds its series, so none of them can be negative`;
    case "stacked-sum-not-finite":
      return `${at}'s series add up to more than a number can hold, and a stacked area draws their sum`;
    case "not-a-label":
      return `${at}'s "${issue.field}" is ${issue.value}, not a label`;
  }
}

/** `xyChartDataIssues` as the sentences the node refuses a placement with. */
export function xyChartDataProblems(chart: XyChart, rows: readonly unknown[], columns?: readonly unknown[]): string[] {
  return xyChartDataIssues(chart, rows, columns).map(xyDataIssueText);
}
/** Everything wrong with these props, then with plotting these rows under them. */
export function xyChartProblems(kind: XyChartKind, props: unknown, rows?: readonly unknown[], columns?: readonly unknown[]): string[] {
  const result = parsed(kind, props);
  if (!result.ok) return result.problems;
  const problems = staticProblems(result.chart);
  if (problems.length > 0 || rows === undefined) return problems;
  return xyChartDataProblems(result.chart, rows, columns);
}

/** One series as it is drawn: its field, what it is called, and one value per point. */
export interface XySeries {
  field: string;
  label: string;
  values: number[];
}

/** The points a chart draws. Index `i` of every list is the same row. */
export interface XyChartData {
  xs: (number | string)[];
  /** Whether the x axis is a number line (always, for a scatter) rather than categories in row order. */
  numericX: boolean;
  /** A scatter point's own label, from `pointLabel`, where its row has one. */
  names: (string | undefined)[];
  series: XySeries[];
  /** Points drawn. */
  shown: number;
  /** Rows in the dataset; more than `shown` when the chart drew only its first rows. */
  total: number;
}

/**
 * The points of rows that passed `xyChartDataProblems`.
 *
 * Text from the rows, an x category or a point's label, carries each hidden character as a visible marker such as
 * `⟨U+202E⟩`: a bidi control applied would reorder the label on screen and in what is read out, and an invisible one
 * would hide inside it.
 *
 * Read defensively anyway, because the page gets the rows over the wire: a value that is not a number is left out as
 * `NaN` rather than drawn as zero, and the caller is expected to have refused such rows already.
 */
export function xyChartData(chart: XyChart, rows: readonly unknown[]): XyChartData {
  const drawn = rows.slice(0, MAX_CHART_POINTS).map((row) => (isRecord(row) ? row : {}));
  const xs = drawn.map((row) => {
    const value = ownField(row, chart.x);
    return finite(value) ? value : typeof value === "string" ? markHiddenCharacters(value).text : "";
  });
  return {
    xs,
    numericX: chart.kind === "scatter" || (xs.length > 0 && xs.every((value) => typeof value === "number")),
    names: drawn.map((row) => {
      const value = chart.pointLabel === undefined ? undefined : ownField(row, chart.pointLabel);
      return typeof value === "string" ? markHiddenCharacters(value).text : finite(value) ? String(value) : undefined;
    }),
    series: chart.y.map((field) => ({
      field,
      label: xyFieldLabel(chart, field),
      values: drawn.map((row) => {
        const value = ownField(row, field);
        return finite(value) ? value : Number.NaN;
      }),
    })),
    shown: drawn.length,
    total: rows.length,
  };
}

/** The lowest and highest of the values that are numbers, or `undefined` when none is. */
export function valueRange(values: readonly number[]): { min: number; max: number } | undefined {
  const real = values.filter((value) => Number.isFinite(value));
  if (real.length === 0) return undefined;
  return { min: Math.min(...real), max: Math.max(...real) };
}

/* ------------------------------------------------------------------ *
 * The view a person set: hidden series and a selected point
 * ------------------------------------------------------------------ */

export interface XyChartView {
  hiddenSeries: string[];
  selected?: { series: string; index: number };
}

const VIEW_KEYS = new Set(["hiddenSeries", "selected"]);

/**
 * Everything wrong with a view a page asks the node to hold.
 *
 * A series hidden must be one of the chart's, at least one stays shown, and a selected point is a point of a shown
 * series that the chart draws. `shown` is how many points the chart draws now.
 */
export function xyChartViewProblems(chart: XyChart, input: unknown, shown: number): string[] {
  if (!isRecord(input)) return ["a chart view is an object with hiddenSeries and selected"];
  const extra = Object.keys(input).filter((key) => !VIEW_KEYS.has(key));
  if (extra.length > 0) return [`a chart view carries hiddenSeries and selected, not ${extra.slice(0, 5).join(", ")}`];

  const problems: string[] = [];
  const hidden = input.hiddenSeries ?? [];
  const hiddenSet = new Set<string>();
  if (!Array.isArray(hidden) || hidden.length > MAX_CHART_SERIES || hidden.some((entry) => typeof entry !== "string")) {
    problems.push(`hiddenSeries is a list of at most ${String(MAX_CHART_SERIES)} series names`);
  } else {
    for (const series of hidden as string[]) {
      if (!chart.y.includes(series)) problems.push(`"${clipWithMarker(series, 64, "…")}" is not a series of this chart`);
      else if (hiddenSet.has(series)) problems.push(`"${series}" is hidden twice`);
      hiddenSet.add(series);
    }
    if (chart.y.every((series) => hiddenSet.has(series))) problems.push("at least one series stays shown");
  }

  const selected = input.selected;
  if (selected !== undefined && selected !== null) {
    if (!isRecord(selected) || Object.keys(selected).some((key) => key !== "series" && key !== "index")) {
      problems.push("a selected point is {series, index}");
    } else if (typeof selected.series !== "string" || !chart.y.includes(selected.series)) {
      problems.push("the selected point is not on a series of this chart");
    } else if (hiddenSet.has(selected.series)) {
      problems.push(`"${selected.series}" is hidden, so none of its points can be selected`);
    } else if (typeof selected.index !== "number" || !Number.isInteger(selected.index)) {
      problems.push("a selected point's index is a whole number");
    } else if (selected.index < 0 || selected.index >= shown) {
      problems.push(`point ${String(selected.index)} is not on this chart, which draws ${String(shown)} point(s)`);
    }
  }
  return problems;
}

/**
 * The view in `state`, read leniently: what no longer fits the chart is dropped rather than refused.
 *
 * Used where the state is shown rather than written — the page and the semantic document — so a view stored before the
 * dataset shrank still draws, without a selection on a point that is gone. Without `shown`, a selection is kept as
 * stored and whoever reads it says whether its point is still there.
 */
export function readXyChartView(chart: XyChart, state: unknown, shown?: number): XyChartView {
  const body = isRecord(state) ? state : {};
  const hidden = Array.isArray(body.hiddenSeries)
    ? [...new Set(body.hiddenSeries.filter((entry): entry is string => typeof entry === "string" && chart.y.includes(entry)))]
    : [];
  const hiddenSeries = hidden.length >= chart.y.length ? [] : hidden;
  const selected = body.selected;
  const keep =
    isRecord(selected) &&
    typeof selected.series === "string" &&
    chart.y.includes(selected.series) &&
    !hiddenSeries.includes(selected.series) &&
    typeof selected.index === "number" &&
    Number.isInteger(selected.index) &&
    selected.index >= 0 &&
    (shown === undefined || selected.index < shown);
  return {
    hiddenSeries,
    ...(keep ? { selected: { series: selected.series as string, index: selected.index as number } } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * What the chart says, as text and as semantic state
 * ------------------------------------------------------------------ */

function withUnit(value: number | string, unit: string | undefined): string {
  return unit === undefined ? String(value) : `${String(value)} ${unit}`;
}

/** One point in words: "Runs at W38: 137 runs", or for a scatter "Runs at Minutes 3.9: 137 (W37)". */
export function xyPointText(chart: XyChart, data: XyChartData, series: string, index: number): string | undefined {
  const line = data.series.find((entry) => entry.field === series);
  const value = line?.values[index];
  const x = data.xs[index];
  if (line === undefined || value === undefined || !Number.isFinite(value) || x === undefined) return undefined;
  const at = chart.kind === "scatter" ? `${xyFieldLabel(chart, chart.x)} ${withUnit(x, chart.xUnit)}` : String(x);
  const name = data.names[index];
  return `${line.label} at ${at}: ${withUnit(value, chart.unit)}${name === undefined ? "" : ` (${name})`}`;
}

function rangeText(label: string, values: readonly number[], unit: string | undefined): string {
  const range = valueRange(values);
  if (range === undefined) return `${label}: no values`;
  return range.min === range.max ? `${label}: ${withUnit(range.min, unit)}` : `${label}: ${String(range.min)} to ${withUnit(range.max, unit)}`;
}

function what(chart: XyChart, labels: readonly string[]): string {
  const xLabel = xyFieldLabel(chart, chart.x);
  return chart.kind === "area"
    ? `${chart.stacked ? "Stacked area" : "Area"} chart of ${labels.join(", ")} by ${xLabel}`
    : `Scatter plot of ${labels.join(", ")} against ${xLabel}`;
}

/**
 * What each axis of a scatter plot measures: the x field and the series on y, each named by its label with its unit.
 *
 * Drawn beside the axes and said in the text alternative and the semantic document, because tick numbers alone ("0 50
 * 100") do not say that x is load in percent and y is latency in milliseconds.
 */
export function xyAxisTitles(chart: XyChart): { x: string; y: string } {
  const titled = (label: string, unit: string | undefined): string => (unit === undefined ? label : `${label} (${unit})`);
  const series = clipWithMarker(chart.y.map((field) => xyFieldLabel(chart, field)).join(", "), MAX_SERIES_LABEL * 2, "…");
  return { x: titled(xyFieldLabel(chart, chart.x), chart.xUnit), y: titled(series, chart.unit) };
}

function axesText(chart: XyChart): string {
  const axes = xyAxisTitles(chart);
  return `x axis: ${axes.x}; y axis: ${axes.y}`;
}

function truncation(data: XyChartData): string {
  return data.total > data.shown ? `the first ${String(data.shown)} of ${String(data.total)} rows` : "";
}

/**
 * The chart as plain text: the text alternative a reader gets when it cannot be drawn, kept with the snapshot.
 *
 * Built from the props and the rows the chart drew when it was placed, so a transcript that outlives the dataset still
 * says what the chart showed.
 */
export function xyChartText(chart: XyChart, data: XyChartData, limit: number = SNAPSHOT_TEXT_LIMIT): string {
  const title = chart.title === undefined ? "" : `${chart.title}: `;
  const described = `${title}${what(chart, data.series.map((series) => series.label))}`;
  const head = chart.kind === "scatter" ? `${described} (${axesText(chart)})` : described;
  if (data.shown === 0) return clipWithMarker(`${head}. No data yet.`, limit);
  const span =
    chart.kind === "scatter"
      ? rangeText(xyFieldLabel(chart, chart.x), data.xs.filter((x): x is number => typeof x === "number"), chart.xUnit)
      : `${String(data.xs[0])} to ${String(data.xs.at(-1))}`;
  const cut = truncation(data);
  return clipWithMarker(
    `${head}, ${String(data.shown)} point(s)${cut === "" ? "" : ` (${cut})`}; ${span}. ` +
      data.series.map((series) => rangeText(series.label, series.values, chart.unit)).join("; ") +
      ".",
    limit,
  );
}

/**
 * What the chart means for voice and `inspect_ui`: the series shown and hidden, the range of each shown one, and the
 * selected point, all from the node's own state and rows.
 *
 * `data` is undefined when the dataset is no longer on the node, and the summary then says so instead of describing
 * points nobody can see.
 */
export function xyChartSemantic(
  chart: XyChart,
  data: XyChartData | undefined,
  view: XyChartView,
): { title?: string; summary: string; values: Record<string, SemanticValue>; selectedIds: string[] } {
  const title = chart.title === undefined ? {} : { title: chart.title };
  const visible = chart.y.filter((field) => !view.hiddenSeries.includes(field));
  const hiddenLabels = view.hiddenSeries.map((field) => xyFieldLabel(chart, field));
  const visibleLabels = visible.map((field) => xyFieldLabel(chart, field));
  const values: Record<string, SemanticValue> = {
    chart: chart.kind,
    x: xyFieldLabel(chart, chart.x),
    series: visibleLabels,
    ...(hiddenLabels.length === 0 ? {} : { hiddenSeries: hiddenLabels }),
    ...(chart.kind === "area" ? { stacked: chart.stacked } : {}),
    ...(chart.unit === undefined ? {} : { unit: chart.unit }),
    ...(chart.kind === "scatter" ? { xAxis: xyAxisTitles(chart).x, yAxis: xyAxisTitles(chart).y } : {}),
  };
  if (data === undefined) {
    return { ...title, summary: `${what(chart, visibleLabels)}; its dataset is not available on this node`, values, selectedIds: [] };
  }

  values.points = data.shown;
  const cut = truncation(data);
  if (cut !== "") values.truncated = cut;
  values.ranges = data.series
    .filter((series) => visible.includes(series.field))
    .map((series) => rangeText(series.label, series.values, chart.unit));
  if (chart.kind === "scatter") {
    values.xRange = rangeText(xyFieldLabel(chart, chart.x), data.xs.filter((x): x is number => typeof x === "number"), chart.xUnit);
  } else if (data.shown > 0) {
    values.xRange = `${String(data.xs[0])} to ${String(data.xs.at(-1))}`;
  }

  const selected = view.selected;
  let selectedIds: string[] = [];
  if (selected !== undefined) {
    const point = selected.index < data.shown ? xyPointText(chart, data, selected.series, selected.index) : undefined;
    values.selectedPoint = point ?? `${xyFieldLabel(chart, selected.series)} point ${String(selected.index + 1)}, which is no longer in the data`;
    if (point !== undefined) selectedIds = [`${selected.series}#${String(selected.index)}`];
  }
  return {
    ...title,
    summary:
      `${what(chart, visibleLabels)}: ${String(data.shown)} point(s)` +
      (cut === "" ? "" : `, ${cut}`) +
      (hiddenLabels.length === 0 ? "" : `; hidden: ${hiddenLabels.join(", ")}`),
    values,
    selectedIds,
  };
}
