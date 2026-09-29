import { describe, expect, it } from "vitest";

import {
  type CompositionGraph,
  MAX_GRAPH_KEYS,
  MAX_GRAPH_LIST,
  MAX_GRAPH_STRING,
  applyGraphEvent,
  checkCompositionGraph,
  graphFeedState,
  graphFeedsReading,
  graphFilterLabels,
  graphSemanticState,
  graphValues,
  implicitSearchGraph,
} from "../src/index.ts";

/**
 * The state and event graph of a composed surface.
 *
 * What matters is that the graph is closed: a rule can only name an event its leaf emits, a step can only write a value
 * its key can hold, and an event that breaks either is refused whole, so the node never keeps half of one.
 */

const SECTIONS = [
  { sectionId: "search-1", definitionId: "canvas.search@1" },
  { sectionId: "choice-1", definitionId: "canvas.choice@1" },
  { sectionId: "list-1", definitionId: "canvas.list@1" },
  { sectionId: "table-1", definitionId: "canvas.table@1" },
  { sectionId: "line-1", definitionId: "canvas.line@1" },
  { sectionId: "metrics-1", definitionId: "canvas.metrics@1" },
  { sectionId: "calendar-1", definitionId: "canvas.calendar@1" },
];

const GRAPH: CompositionGraph = {
  state: {
    query: { type: "string", initial: "" },
    metric: { type: "string", initial: "completed" },
    picked: { type: "string-list", initial: [] },
    firstTwo: { type: "string-list", initial: [] },
    selectedCount: { type: "number", initial: 0 },
    tone: { type: "string", initial: "neutral" },
    open: { type: "boolean", initial: false },
    day: { type: "string", initial: "" },
  },
  on: [
    { sectionId: "search-1", event: "query.change", steps: [{ op: "select-field", key: "query", field: "query" }] },
    {
      sectionId: "choice-1",
      event: "choice.change",
      steps: [
        { op: "select-field", key: "metric", field: "value" },
        { op: "map-field", key: "tone", field: "value", map: { completed: "good" }, fallback: "neutral" },
        { op: "toggle", key: "open" },
      ],
    },
    {
      sectionId: "table-1",
      event: "row.select",
      steps: [
        { op: "select-field", key: "picked", field: "rowIds" },
        { op: "take", key: "firstTwo", field: "rowIds", count: 2 },
        { op: "count", key: "selectedCount", field: "rowIds" },
      ],
    },
    {
      sectionId: "calendar-1",
      event: "date.select",
      steps: [
        { op: "set", key: "day", value: "picked" },
        { op: "copy", key: "day", from: "metric" },
        { op: "append", key: "picked", field: "date" },
      ],
    },
  ],
  feed: [
    { sectionId: "table-1", op: "query", key: "query" },
    { sectionId: "line-1", op: "filter-equals", field: "series", key: "metric" },
    { sectionId: "list-1", op: "filter-equals", field: "title", key: "day" },
  ],
};

const run = (sectionId: string, event: string, payload: unknown, current = graphValues(GRAPH)) => {
  const definitionId = SECTIONS.find((section) => section.sectionId === sectionId)?.definitionId ?? "";
  return applyGraphEvent(GRAPH, current, { sectionId, definitionId, event, payload });
};

describe("checking a graph", () => {
  it("accepts a graph whose every rule, step and feed fits its leaf and its key", () => {
    expect(checkCompositionGraph(GRAPH, SECTIONS)).toEqual([]);
  });

  it("refuses an event a leaf does not emit, and says what it does emit", () => {
    const problems = checkCompositionGraph(
      { state: { q: { type: "string", initial: "" } }, on: [{ sectionId: "search-1", event: "click", steps: [{ op: "set", key: "q", value: "x" }] }], feed: [] },
      SECTIONS,
    );
    expect(problems.join(" | ")).toContain('canvas.search@1 does not emit "click"; it emits query.change');
    const silent = checkCompositionGraph(
      { state: { q: { type: "string", initial: "" } }, on: [{ sectionId: "metrics-1", event: "click", steps: [{ op: "set", key: "q", value: "x" }] }], feed: [] },
      SECTIONS,
    );
    expect(silent.join(" | ")).toContain("it emits nothing a graph can wire");
  });

  it("refuses a state key no one declared, a section the surface lacks, and a rule wired twice", () => {
    const problems = checkCompositionGraph(
      {
        state: { q: { type: "string", initial: "" } },
        on: [
          { sectionId: "search-1", event: "query.change", steps: [{ op: "select-field", key: "missing", field: "query" }] },
          { sectionId: "search-1", event: "query.change", steps: [{ op: "select-field", key: "q", field: "query" }] },
          { sectionId: "search-9", event: "query.change", steps: [{ op: "select-field", key: "q", field: "query" }] },
        ],
        feed: [{ sectionId: "table-9", op: "query", key: "q" }],
      },
      SECTIONS,
    ).join(" | ");
    expect(problems).toContain('names state "missing", which the graph does not declare');
    expect(problems).toContain("is wired twice");
    expect(problems).toContain("on[2] (search-9 query.change) names a section the surface does not have");
    expect(problems).toContain("feed[0] (table-9 query) names a section the surface does not have");
  });

  it("refuses a step that would write what its key cannot hold", () => {
    const problems = checkCompositionGraph(
      {
        state: { n: { type: "number", initial: 0 }, s: { type: "string", initial: "" }, b: { type: "boolean", initial: false } },
        on: [
          {
            sectionId: "table-1",
            event: "row.select",
            steps: [
              { op: "select-field", key: "s", field: "rowIds" },
              { op: "take", key: "n", field: "rowIds", count: 1 },
              { op: "count", key: "s", field: "rowIds" },
              { op: "toggle", key: "s" },
              { op: "copy", key: "n", from: "s" },
              { op: "set", key: "b", value: "yes" },
              { op: "append", key: "n", field: "missing" },
            ],
          },
        ],
        feed: [],
      },
      SECTIONS,
    ).join(" | ");
    expect(problems).toContain('writes a string-list into string "s"');
    expect(problems).toContain('needs "n" to be a string-list; it is number');
    expect(problems).toContain('needs "s" to be a number; it is string');
    expect(problems).toContain('flips "s", which is string, not boolean');
    expect(problems).toContain('copies string "s" into number "n"');
    expect(problems).toContain('writes a value "b" cannot hold: expected boolean, got string');
    expect(problems).toContain('reads "missing", which "row.select" does not carry; it carries rowIds');
  });

  it("refuses a feed a leaf cannot read", () => {
    const problems = checkCompositionGraph(
      {
        state: { q: { type: "string", initial: "" }, n: { type: "number", initial: 0 }, l: { type: "string-list", initial: [] } },
        on: [],
        feed: [
          { sectionId: "line-1", op: "query", key: "q" },
          { sectionId: "line-1", op: "filter-equals", field: "label", key: "q" },
          { sectionId: "table-1", op: "query", key: "n" },
          { sectionId: "table-1", op: "filter-equals", field: "status", key: "l" },
          { sectionId: "metrics-1", op: "query", key: "q" },
        ],
      },
      SECTIONS,
    ).join(" | ");
    expect(problems).toContain("canvas.line@1 has no query to read");
    expect(problems).toContain('canvas.line@1 filters only on series, not "label"');
    expect(problems).toContain('reads number "n" as a query; a query is text');
    expect(problems).toContain("filters on a list; an exact-match filter compares one value");
    expect(problems).toContain("canvas.metrics@1 reads nothing from a graph");
  });

  it("refuses unknown operations, fields a graph does not have, and a graph past its bounds", () => {
    expect(
      checkCompositionGraph({ state: {}, on: [{ sectionId: "search-1", event: "query.change", steps: [{ op: "eval", key: "q", code: "1" }] }], feed: [] }, SECTIONS)
        .length,
    ).toBeGreaterThan(0);
    expect(checkCompositionGraph({ state: {}, on: [], feed: [], script: "run()" }, SECTIONS).join(" | ")).toContain("script");
    const keys = Object.fromEntries(Array.from({ length: MAX_GRAPH_KEYS + 1 }, (_, index) => [`k${String(index)}`, { type: "string", initial: "" }]));
    expect(checkCompositionGraph({ state: keys, on: [], feed: [] }, SECTIONS).join(" | ")).toContain(`at most ${String(MAX_GRAPH_KEYS)}`);
    expect(
      checkCompositionGraph({ state: { q: { type: "string", initial: "x".repeat(MAX_GRAPH_STRING + 1) } }, on: [], feed: [] }, SECTIONS).length,
    ).toBeGreaterThan(0);
  });
});

describe("applying an event", () => {
  it("runs every step of a rule in order and says which keys changed", () => {
    const outcome = run("choice-1", "choice.change", { value: "created" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.values.metric).toBe("created");
    expect(outcome.values.tone).toBe("neutral");
    expect(outcome.values.open).toBe(true);
    expect(outcome.changed.sort()).toEqual(["metric", "open"]);

    const mapped = run("choice-1", "choice.change", { value: "completed" }, outcome.values);
    expect(mapped.ok && mapped.values.tone).toBe("good");
    expect(mapped.ok && mapped.values.open).toBe(false);
  });

  it("selects, takes and counts a list an event carries", () => {
    const outcome = run("table-1", "row.select", { rowIds: ["a", "b", "c"] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.values.picked).toEqual(["a", "b", "c"]);
    expect(outcome.values.firstTwo).toEqual(["a", "b"]);
    expect(outcome.values.selectedCount).toBe(3);
  });

  it("sets, copies and appends", () => {
    const outcome = run("calendar-1", "date.select", { date: "2026-09-29" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // `set` then `copy` into the same key: the later step wins, so the order of steps is the order they run.
    expect(outcome.values.day).toBe("completed");
    expect(outcome.values.picked).toEqual(["2026-09-29"]);
    const again = run("calendar-1", "date.select", { date: "2026-09-29" }, outcome.values);
    expect(again.ok && again.values.picked).toEqual(["2026-09-29"]);
  });

  it("refuses an event that is not wired, carries a field it should not, or lacks one it needs", () => {
    expect(run("list-1", "selection.change", { selected: [] })).toMatchObject({ ok: false, problem: expect.stringContaining("is not wired") });
    expect(run("search-1", "query.change", { query: "a", extra: 1 })).toMatchObject({ ok: false, problem: expect.stringContaining("does not carry extra") });
    expect(run("search-1", "query.change", {})).toMatchObject({ ok: false, problem: expect.stringContaining('is missing "query"') });
    expect(run("search-1", "query.change", { query: 5 })).toMatchObject({ ok: false, problem: expect.stringContaining("should be text") });
    expect(run("search-1", "query.change", "acme")).toMatchObject({ ok: false, problem: "the event carries no fields" });
    // A section that exists but is a different definition from the one it claims to be is not wired either.
    expect(applyGraphEvent(GRAPH, graphValues(GRAPH), { sectionId: "search-1", definitionId: "canvas.table@1", event: "query.change", payload: { query: "a" } }).ok).toBe(false);
  });

  it("refuses the whole event when one step would write what its key cannot hold", () => {
    // `value` from a choice can be text or a list, so only the event itself shows which: a list into a string key is refused,
    // and nothing the earlier steps wrote is kept.
    const before = graphValues(GRAPH);
    const outcome = run("choice-1", "choice.change", { value: ["created", "completed"] }, before);
    expect(outcome.ok).toBe(false);
    expect(before.metric).toBe("completed");
    const long = run("search-1", "query.change", { query: "x".repeat(MAX_GRAPH_STRING + 1) });
    expect(long.ok).toBe(false);
    const many = run("table-1", "row.select", { rowIds: Array.from({ length: MAX_GRAPH_LIST + 1 }, (_, index) => `r${String(index)}`) });
    // The table may carry many rows, but "picked" holds at most MAX_GRAPH_LIST of them.
    expect(many.ok).toBe(false);
  });
});

describe("feeding leaves and reading values", () => {
  it("gives each leaf only what the graph feeds it, and a source leaf its own value back", () => {
    const values = { ...graphValues(GRAPH), query: "acme", metric: "created" };
    expect(graphFeedState(GRAPH, values, SECTIONS[3] as never)).toEqual({ query: "acme" });
    expect(graphFeedState(GRAPH, values, SECTIONS[4] as never)).toEqual({ filters: { series: "created" } });
    // An empty value filters nothing, so a cleared control shows everything again.
    expect(graphFeedState(GRAPH, values, SECTIONS[2] as never)).toEqual({ filters: {} });
    expect(graphFeedState(GRAPH, values, SECTIONS[0] as never)).toEqual({ query: "acme" });
    expect(graphFeedState(GRAPH, values, SECTIONS[1] as never)).toEqual({ value: "created" });
    expect(graphFeedState(undefined, values, SECTIONS[3] as never)).toEqual({});
    expect(graphFeedsReading(GRAPH, ["metric"]).map((feed) => feed.sectionId)).toEqual(["line-1"]);
  });

  it("names a filter by the option a choice set it with, and by its value otherwise", () => {
    const withOptions = SECTIONS.map((entry) =>
      entry.sectionId === "choice-1" ? { ...entry, props: { options: [{ value: "created", label: "Việc tạo" }] } } : entry,
    );
    const values = { ...graphValues(GRAPH), metric: "created", day: "2026-09-29" };
    expect(graphFilterLabels(GRAPH, values, withOptions, { sectionId: "line-1" })).toEqual({ series: "Việc tạo" });
    // The list filters on a key a calendar wrote, not a choice, so it keeps the value itself.
    expect(graphFilterLabels(GRAPH, values, withOptions, { sectionId: "list-1" })).toEqual({});
    expect(graphFilterLabels(GRAPH, { ...values, metric: "unknown" }, withOptions, { sectionId: "line-1" })).toEqual({});
  });

  it("uses a stored value only while it still fits its key", () => {
    expect(graphValues(GRAPH, { query: "kept", metric: 7, extra: "ignored" })).toMatchObject({ query: "kept", metric: "completed" });
    expect(graphValues(GRAPH, "not a record").query).toBe("");
    expect(Object.keys(graphValues(GRAPH, { extra: "ignored" }))).not.toContain("extra");
  });

  it("describes the values for an agent turn, and nothing when there is no state", () => {
    const semantic = graphSemanticState(GRAPH, { query: "acme" });
    expect(semantic?.values.query).toBe("acme");
    expect(semantic?.summary).toContain('query = "acme"');
    expect(graphSemanticState(undefined)).toBeUndefined();
    expect(graphSemanticState({ state: {}, on: [], feed: [] })).toBeUndefined();
  });

  it("gives a search box placed without a graph the graph it always had: it narrows every table", () => {
    const graph = implicitSearchGraph([
      { sectionId: "search-1", definitionId: "canvas.search@1", props: { query: "start" } },
      { sectionId: "table-1", definitionId: "canvas.table@1" },
      { sectionId: "table-2", definitionId: "canvas.table@1" },
    ]);
    expect(graph?.state.query?.initial).toBe("start");
    expect(graph?.feed.map((feed) => feed.sectionId)).toEqual(["table-1", "table-2"]);
    expect(checkCompositionGraph(graph, [
      { sectionId: "search-1", definitionId: "canvas.search@1" },
      { sectionId: "table-1", definitionId: "canvas.table@1" },
      { sectionId: "table-2", definitionId: "canvas.table@1" },
    ])).toEqual([]);
    expect(implicitSearchGraph([{ sectionId: "search-1", definitionId: "canvas.search@1" }])).toBeUndefined();
  });
});
