import { describe, expect, it } from "vitest";

import { MIGRATIONS, migrate, openDatabase } from "../src/index.ts";

/**
 * M2: backfilling `grantedCapabilities` onto a `package_generations` row that predates the field.
 *
 * Before this field existed, a generation was activated with whatever its manifest requested, granted outright —
 * there was no narrower policy-derived set, so the row's `document` never carried the key at all. Reading such a
 * row back today, unmigrated, would silently produce `undefined` where code now expects an array — which then
 * brokers *nothing* to a widget that was, under the semantics it actually installed under, entitled to what it
 * asked for. The regression this proves is that migration 22 fixes that up rather than leaving it to fail at
 * read time, using the install plan the generation actually resolved through as the record of what was consented.
 */

describe("migration 22: backfill_generation_granted_capabilities", () => {
  it("backfills a pre-existing generation's grantedCapabilities from its own install plan's requested set", () => {
    const db = openDatabase({ path: ":memory:" });
    // Apply every migration except the one under test, so the fixture rows are written the way a node on the
    // previous schema actually would have: no `grantedCapabilities` key on the generation document at all.
    const before22 = MIGRATIONS.filter((migration) => migration.version < 22);
    migrate(db, before22);

    const requirementKey = "pkg:com.example.calendar@1.2.0";
    db.prepare(
      `INSERT INTO install_plans (plan_id, requirement_key, owner_principal_id, target_node_id, candidate, plan_digest, document, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "plan-1",
      requirementKey,
      "owner-1",
      "node-1",
      "{}",
      "sha256:plan-digest",
      JSON.stringify({ requestedCapabilityRefs: ["project.code.read@1", "project.code.write@1"] }),
      "activated",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:10:00.000Z",
    );

    // A generation document with no `grantedCapabilities` key at all — exactly the shape a pre-migration row had.
    db.prepare(
      `INSERT INTO package_generations (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gen-1",
      "com.example.calendar",
      "1.2.0",
      "sha256:artifact-digest",
      "node-1",
      "codegen-1",
      "2026-01-01T00:05:00.000Z",
      JSON.stringify({ generationId: "gen-1", packageId: "com.example.calendar", version: "1.2.0" }),
    );

    // A second generation with no matching plan row at all (superseded and pruned, or never had one).
    db.prepare(
      `INSERT INTO package_generations (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gen-2",
      "com.example.orphaned",
      "0.1.0",
      "sha256:orphan-digest",
      "node-1",
      "codegen-2",
      "2026-01-01T00:06:00.000Z",
      JSON.stringify({ generationId: "gen-2", packageId: "com.example.orphaned", version: "0.1.0" }),
    );

    const result = migrate(db, MIGRATIONS);
    expect(result.applied).toContain(22);

    const withPlan = db.prepare("SELECT document FROM package_generations WHERE generation_id = ?").get("gen-1") as {
      document: string;
    };
    const withPlanDoc = JSON.parse(withPlan.document) as { grantedCapabilities: readonly string[] };
    expect(withPlanDoc.grantedCapabilities).toEqual(["project.code.read@1", "project.code.write@1"]);

    const withoutPlan = db.prepare("SELECT document FROM package_generations WHERE generation_id = ?").get("gen-2") as {
      document: string;
    };
    const withoutPlanDoc = JSON.parse(withoutPlan.document) as { grantedCapabilities: readonly string[] };
    expect(withoutPlanDoc.grantedCapabilities).toEqual([]);
  });

  it("does not touch a generation that already carries grantedCapabilities", () => {
    const db = openDatabase({ path: ":memory:" });
    const before22 = MIGRATIONS.filter((migration) => migration.version < 22);
    migrate(db, before22);

    db.prepare(
      `INSERT INTO package_generations (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gen-3",
      "com.example.already-migrated",
      "1.0.0",
      "sha256:digest",
      "node-1",
      "codegen-3",
      "2026-01-01T00:07:00.000Z",
      JSON.stringify({ generationId: "gen-3", grantedCapabilities: ["already.granted@1"] }),
    );

    migrate(db, MIGRATIONS);

    const row = db.prepare("SELECT document FROM package_generations WHERE generation_id = ?").get("gen-3") as {
      document: string;
    };
    const doc = JSON.parse(row.document) as { grantedCapabilities: readonly string[] };
    expect(doc.grantedCapabilities).toEqual(["already.granted@1"]);
  });
});
