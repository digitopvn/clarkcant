import { describe, expect, it } from "vitest";

import { type ConversationId, type Instant, type Principal } from "@clarkcant/contracts";
import { FakePiAdapter, type WorkerBrief } from "@clarkcant/pi-adapter";
import { getDatasetForPrincipal, migrate, openDatabase } from "@clarkcant/storage";

import { createModelTurn, SHOW_VIEW_GUIDELINES, type ViewRequest } from "../src/model-turn.ts";
import {
  MAX_STATED_DATASETS,
  MAX_STATED_ROWS,
  bindStatedRefs,
  keepStatedDataset,
  readStatedData,
  type StatedDatasetInput,
} from "../src/stated-data.ts";

/**
 * Rows a model states for a chart.
 *
 * The bug this answers: a model that had just researched benchmark numbers could not draw them, because every chart
 * read a dataset the node already held. It answered in prose, or wrote a widget package that fetched its own file and
 * failed. These tests hold the path that replaces both: rows passed to `show_view`, kept as saved data, drawn by name.
 */

describe("reading stated rows", () => {
  it("keeps declared columns first and every other field after them", () => {
    const rows = [
      { score: 88.1, model: "A" },
      { model: "B", score: 90, note: null },
    ];
    expect(readStatedData({ scores: { columns: ["model"], rows } })).toEqual({
      ok: true,
      datasets: [{ name: "scores", columns: ["model", "score", "note"], rows }],
    });
  });

  it("takes nothing as no data", () => {
    expect(readStatedData(undefined)).toEqual({ ok: true, datasets: [] });
  });

  it.each([
    ["a list", [], "must be an object"],
    ["a bad name", { "../x": { rows: [{ a: 1 }] } }, "must be 1-64"],
    ["no rows", { s: { rows: [] } }, "non-empty list"],
    ["a row that is not an object", { s: { rows: [1] } }, "rows[0] must be an object"],
    ["an object cell", { s: { rows: [{ a: { b: 1 } }] } }, "rows[0].a must be text"],
    ["an infinite number", { s: { rows: [{ a: Number.POSITIVE_INFINITY }] } }, "finite"],
    ["a column no row has", { s: { columns: ["z"], rows: [{ a: 1 }] } }, "which no row has"],
    // Parsed as a tool's JSON arguments are, so the name is an own field rather than the literal's prototype.
    ["a field named __proto__", JSON.parse('{ "s": { "rows": [{ "__proto__": 1 }] } }') as unknown, "__proto__"],
  ])("refuses %s whole, saying why", (_label, raw, problem) => {
    const read = readStatedData(raw);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.problem).toContain(problem);
  });

  it("refuses more datasets and more rows than a tool call should carry", () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_STATED_DATASETS + 1 }, (_, i) => [`d${String(i)}`, { rows: [{ a: 1 }] }]),
    );
    expect(readStatedData(many).ok).toBe(false);
    const rows = Array.from({ length: MAX_STATED_ROWS + 1 }, (_, i) => ({ a: i }));
    expect(readStatedData({ s: { rows } }).ok).toBe(false);
  });
});

describe("binding a stated name to the kept dataset", () => {
  it("rewrites every datasetRef that uses the name, however deep, and leaves the rest alone", () => {
    const kept = new Map([["scores", "dataset_1"]]);
    const bound = bindStatedRefs(
      {
        datasetRef: "scores",
        layout: { children: [{ props: { datasetRef: "scores" } }, { props: { datasetRef: "other", label: "scores" } }] },
      },
      kept,
    );
    expect(bound).toEqual({
      datasetRef: "dataset_1",
      layout: { children: [{ props: { datasetRef: "dataset_1" } }, { props: { datasetRef: "other", label: "scores" } }] },
    });
  });
});

describe("keeping stated rows", () => {
  it("saves them for the person as saved data, never live and never sample", () => {
    const db = openDatabase({ path: ":memory:", enableWal: false });
    migrate(db);
    try {
      const datasetId = keepStatedDataset(
        { db, nodeId: "n1", newId: () => "dataset_stated", now: () => "2026-10-08T00:00:00.000Z" as Instant },
        { principalId: "p_owner", dataset: { name: "scores", columns: ["model", "score"], rows: [{ model: "A", score: 1 }] } },
      );
      expect(datasetId).toBe("dataset_stated");
      const stored = getDatasetForPrincipal(db, datasetId, "p_owner");
      expect(stored?.freshness).toBe("cached");
      expect(stored?.document).toEqual({ columns: ["model", "score"], rows: [{ model: "A", score: 1 }] });
      // The rows are the person's own; nobody else on the node reads them.
      expect(getDatasetForPrincipal(db, datasetId, "p_someone_else")).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

class RecordingAdapter extends FakePiAdapter {
  readonly briefs: WorkerBrief[] = [];

  override async createWorkerSession(brief: WorkerBrief): ReturnType<FakePiAdapter["createWorkerSession"]> {
    this.briefs.push(brief);
    return super.createWorkerSession(brief);
  }
}

const PRINCIPAL: Principal = { principalId: "p_owner" as Principal["principalId"], kind: "user", nodeId: "n1" as Principal["nodeId"] };
const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;

async function chartTool(keep?: (input: StatedDatasetInput) => string) {
  const built: ViewRequest[] = [];
  const adapter = new RecordingAdapter({ script: ["ok"] });
  const turn = await createModelTurn({
    env: ENV,
    cwd: process.cwd(),
    adapter,
    views: () => [
      {
        id: "canvas.bar@1",
        label: "Bar chart",
        build: (input) => {
          built.push(input);
          return { type: "evidence", kind: "test-output", summary: "chart", verdict: "verified" };
        },
      },
    ],
    datasetRefs: () => ["dataset_fixture_usage"],
    ...(keep === undefined ? {} : { keepStatedDataset: keep }),
  });
  await turn!.answer({ conversationId: "c1" as ConversationId, principal: PRINCIPAL, text: "so sánh", messageId: "msg_1" });
  return { tool: (adapter.briefs[0]!.customTools ?? [])[0]!, built };
}

function parameterNames(tool: { parameters: unknown }): string[] {
  return Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);
}

describe("show_view draws rows the model passes", () => {
  it("tells the model when to reach for a view, so a comparison is drawn without being asked", async () => {
    const { tool } = await chartTool(() => "dataset_x");
    expect(tool.promptGuidelines).toEqual(SHOW_VIEW_GUIDELINES);
    expect(SHOW_VIEW_GUIDELINES.join(" ")).toContain("without being asked");
    expect(parameterNames(tool)).toContain("data");
  });

  it("keeps the rows for the person and points the chart at them", async () => {
    const kept: StatedDatasetInput[] = [];
    const { tool, built } = await chartTool((input) => {
      kept.push(input);
      return "dataset_kept";
    });
    const rows = [
      { model: "A", score: 71.2 },
      { model: "B", score: 64 },
    ];
    const result = await tool.execute({
      view: "canvas.bar@1",
      props: { datasetRef: "bench", series: ["score"] },
      data: { bench: { rows } },
    });
    expect(result.text).toContain("saved data");
    expect(kept).toEqual([{ principalId: "p_owner", dataset: { name: "bench", columns: ["model", "score"], rows } }]);
    expect(built[0]!.props).toEqual({ datasetRef: "dataset_kept", series: ["score"] });
  });

  it("refuses rows it cannot keep, and builds nothing", async () => {
    const { tool, built } = await chartTool(() => "dataset_kept");
    const result = await tool.execute({
      view: "canvas.bar@1",
      props: { datasetRef: "bench" },
      data: { bench: { rows: [{ score: "12%" }, { score: {} }] } },
    });
    expect(result.text).toContain("was not shown");
    expect(built).toEqual([]);
  });

  it("refuses rows for a composed layout, whose leaves draw the host's own rows, and keeps nothing", async () => {
    const kept: StatedDatasetInput[] = [];
    const { tool, built } = await chartTool((input) => {
      kept.push(input);
      return "dataset_kept";
    });
    const result = await tool.execute({
      view: "canvas.bar@1",
      props: { layout: { children: [{ props: { datasetRef: "bench" } }] } },
      data: { bench: { rows: [{ a: 1 }] } },
    });
    expect(result.text).toContain("not in a composed layout");
    expect(kept).toEqual([]);
    expect(built).toEqual([]);
  });

  it("says the rows could not be kept when the node fails to save them, and builds nothing", async () => {
    const { tool, built } = await chartTool(() => {
      throw new Error("disk full");
    });
    const result = await tool.execute({ view: "canvas.bar@1", props: { datasetRef: "bench" }, data: { bench: { rows: [{ a: 1 }] } } });
    expect(result.text).toContain("could not be kept: disk full");
    expect(built).toEqual([]);
  });

  it("offers no data where the node keeps none, and refuses data passed anyway", async () => {
    const { tool, built } = await chartTool();
    expect(parameterNames(tool)).not.toContain("data");
    const result = await tool.execute({ view: "canvas.bar@1", data: { bench: { rows: [{ a: 1 }] } } });
    expect(result.text).toContain("keeps no stated data");
    expect(built).toEqual([]);
  });
});
