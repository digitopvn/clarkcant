import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInstance } from "@clarkcant/core";
import { LINE_CHART, TABLE } from "@clarkcant/data-canvas";
import { upsertDataset } from "@clarkcant/storage";

import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { tableExportFilename } from "../src/routes/table-export.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A table's CSV export, through the node's route.
 *
 * The node writes the file from the instance's own dataset: the request carries a view and nothing else. These
 * tests hold it to that, to the owner and the table it belongs to, and to a file a spreadsheet can open without
 * running anything a cell says.
 */

const AT = "2026-09-29T02:00:00.000Z";
const DATASET_ID = "dataset_export_test";

const ROWS = [
  { id: "r1", name: "Đồng Nai", amount: 12, note: "=HYPERLINK(\"http://evil.example\",\"click\")" },
  { id: "r2", name: "Hà Nội", amount: 3, note: "plain" },
  { id: "r3", name: "An Giang", amount: -5, note: "+SUM(A1:A2)" },
  { id: "r4", name: "Huế", amount: 40, note: "say \"hi\", then leave" },
];

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;

function owner(): string {
  return services.runtime.identity.ownerPrincipalId;
}

async function send(path: string, body: unknown, authorized = true): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method: "POST",
    path,
    query: {},
    headers: authorized ? { authorization: `Bearer ${services.runtime.identity.localToken}` } : {},
    body: JSON.stringify(body),
  });
}

function table(props: Record<string, unknown> = {}, ownerPrincipalId = owner()): string {
  return createInstance(services.conductor, {
    definition: TABLE,
    packageDigest: "sha256:table",
    ownerPrincipalId: ownerPrincipalId as never,
    props: {
      title: "Doanh thu theo tỉnh",
      datasetRef: DATASET_ID,
      columns: ["name", { key: "amount", label: "Số tiền", type: "number" }, "note"],
      ...props,
    },
  }).instanceId;
}

const exportOf = (instanceId: string, body: unknown = {}, authorized = true) =>
  send(`/conversations/conv_1/widgets/${instanceId}/export`, body, authorized);

function csvOf(response: GatewayResponse): string {
  expect(response.binary).toBeDefined();
  // `ignoreBOM` keeps the byte order mark in the text, where the tests below expect it.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(response.binary?.bytes);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-table-export-"));
  services = bootNodeServices({ dataDir: dir, label: "table export route test node" });
  deps = { services, now: () => AT as never };
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run("conv_1", services.runtime.identity.nodeId, AT, AT);
  upsertDataset(services.runtime.db, {
    datasetId: DATASET_ID,
    originNodeId: services.runtime.identity.nodeId,
    rowCount: ROWS.length,
    freshness: "live",
    updatedAt: AT as never,
    document: { rows: ROWS },
    ownerPrincipalId: owner(),
  });
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the table export route", () => {
  it("writes the instance's own rows as a CSV attachment, with the view the person asked for", async () => {
    const response = await exportOf(table(), { sort: { column: "amount", direction: "desc" }, query: "a" });

    expect(response.status).toBe(200);
    expect(response.binary).toMatchObject({
      contentType: "text/csv; charset=utf-8",
      cache: "no-store",
      headers: {
        "x-content-type-options": "nosniff",
        "content-disposition": 'attachment; filename="doanh-thu-theo-tinh.csv"',
        "access-control-expose-headers": "content-disposition",
      },
    });
    const csv = csvOf(response);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    // Every row has an "a" in a shown column (Huế's is in its note), so all four, sorted by amount descending.
    expect(csv.slice(1).split("\r\n")).toEqual([
      "name,Số tiền,note",
      'Huế,40,"say ""hi"", then leave"',
      `Đồng Nai,12,"'=HYPERLINK(""http://evil.example"",""click"")"`,
      "Hà Nội,3,plain",
      "An Giang,-5,'+SUM(A1:A2)",
      "",
    ]);
  });

  it("defuses every formula a cell carries, and keeps a negative number a number", async () => {
    const csv = csvOf(await exportOf(table()));
    expect(csv).toContain(`"'=HYPERLINK(`);
    expect(csv).toContain("'+SUM(A1:A2)");
    expect(csv).toContain(",-5,");
    expect(csv).not.toMatch(/(^|[\n,])"?[=+@]/);
  });

  it("filters, and narrows the columns only to ones the table shows", async () => {
    const csv = csvOf(await exportOf(table(), { filters: { id: "r2" }, columns: ["note", "id", "name"] }));
    // `id` is not a column of this table, so asking for it exports nothing extra.
    expect(csv.slice(1)).toBe("note,name\r\nplain,Hà Nội\r\n");
  });

  it("never takes rows or a dataset from the request", async () => {
    upsertDataset(services.runtime.db, {
      datasetId: "dataset_other",
      originNodeId: services.runtime.identity.nodeId,
      rowCount: 1,
      freshness: "live",
      updatedAt: AT as never,
      document: { rows: [{ name: "not this one", amount: 1, note: "" }] },
      ownerPrincipalId: owner(),
    });
    const response = await exportOf(table(), {
      datasetRef: "dataset_other",
      rows: [{ name: "injected", amount: 0, note: "=cmd" }],
    });
    const csv = csvOf(response);
    expect(csv).not.toContain("injected");
    expect(csv).not.toContain("not this one");
    expect(csv).toContain("Đồng Nai");
  });

  it("refuses a caller without the token", async () => {
    const response = await exportOf(table(), {}, false);
    expect(response.status).toBe(401);
    expect(response.binary).toBeUndefined();
  });

  it("answers 404 for an instance that does not exist, including a snapshot's id", async () => {
    for (const id of ["winst_missing", "wsnap_history_copy"]) {
      const response = await exportOf(id);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    }
  });

  it("refuses another principal's table", async () => {
    const response = await exportOf(table({}, "someone_else"));
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(response.binary).toBeUndefined();
  });

  it("refuses to export a widget that is not a table", async () => {
    const chart = createInstance(services.conductor, {
      definition: LINE_CHART,
      packageDigest: "sha256:line",
      ownerPrincipalId: owner() as never,
      props: { datasetRef: DATASET_ID },
    }).instanceId;
    const response = await exportOf(chart);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "NOT_A_TABLE" });
  });

  it("says so when the table's dataset is not available", async () => {
    const response = await exportOf(table({ datasetRef: "dataset_gone" }));
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "DATASET_UNAVAILABLE" });
  });

  it("refuses a malformed view rather than guessing", async () => {
    for (const body of [{ sort: "amount" }, { query: 3 }, { filters: [] }, { columns: [1] }]) {
      const response = await exportOf(table(), body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "INVALID_SCHEMA" });
    }
  });
});

describe("the export's file name", () => {
  it("is plain ASCII from the title, never anything a header could be broken out of", () => {
    expect(tableExportFilename("Doanh thu — Quý 3/2026")).toBe("doanh-thu-quy-3-2026.csv");
    expect(tableExportFilename('a"; filename="evil.exe\r\nx')).toBe("a-filename-evil-exe-x.csv");
    expect(tableExportFilename(undefined)).toBe("table.csv");
    expect(tableExportFilename("—")).toBe("table.csv");
  });
});
