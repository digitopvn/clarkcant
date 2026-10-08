import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Instant, normalizeSemanticDoc } from "@clarkcant/contracts";

import { openDatabase, type Database } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import {
  getWidgetSemantic,
  listTouchedWidgets,
  recordWidgetProposal,
  recordWidgetSemantic,
  touchWidgetSemantic,
} from "../src/repositories/widget-semantic.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/**
 * The touched-widget record a model turn reads.
 *
 * What a turn relies on without checking: that the revision moves only when the meaning did, and that a conversation
 * reads its own widgets, newest first.
 */
let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-widget-semantic-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
});

afterEach(async () => {
  db.close();
  await removeTestDirectory(dir);
});

const at = (second: number) => `2026-09-29T10:00:${String(second).padStart(2, "0")}.000Z` as Instant;
const doc = (series: string) =>
  normalizeSemanticDoc({ instanceId: "i1", definitionId: "canvas.overview@1", summary: "s", values: { series } });

describe("widget semantic state", () => {
  it("moves the revision only when the digest changes", () => {
    touchWidgetSemantic(db, { instanceId: "i1", conversationId: "c1", at: at(1) });
    expect(getWidgetSemantic(db, "i1")?.revision).toBe(0);
    expect(recordWidgetSemantic(db, { instanceId: "i1", document: doc("a"), digest: "d-a", at: at(2) })).toBe(1);
    expect(recordWidgetSemantic(db, { instanceId: "i1", document: doc("a"), digest: "d-a", at: at(3) })).toBe(1);
    expect(recordWidgetSemantic(db, { instanceId: "i1", document: doc("b"), digest: "d-b", at: at(4) })).toBe(2);
    expect(getWidgetSemantic(db, "i1")?.document?.values).toEqual({ series: "b" });
  });

  it("lists a conversation's widgets newest first, and only that conversation's", () => {
    touchWidgetSemantic(db, { instanceId: "i1", conversationId: "c1", at: at(1) });
    touchWidgetSemantic(db, { instanceId: "i2", conversationId: "c1", at: at(2) });
    touchWidgetSemantic(db, { instanceId: "i3", conversationId: "c2", at: at(3) });
    touchWidgetSemantic(db, { instanceId: "i1", conversationId: "c1", at: at(4) });
    expect(listTouchedWidgets(db, "c1", 10).map((row) => row.instanceId)).toEqual(["i1", "i2"]);
    expect(listTouchedWidgets(db, "c1", 1).map((row) => row.instanceId)).toEqual(["i1"]);
    expect(listTouchedWidgets(db, "c2", 10).map((row) => row.instanceId)).toEqual(["i3"]);
  });

  it("keeps a frame's proposal apart from the document the host builds", () => {
    recordWidgetProposal(db, { instanceId: "i1", conversationId: "c1", proposal: { summary: "3 rows picked" }, at: at(1) });
    const row = getWidgetSemantic(db, "i1");
    expect(row?.proposal).toEqual({ summary: "3 rows picked" });
    expect(row?.document).toBeUndefined();
    expect(row?.revision).toBe(0);
  });
});
