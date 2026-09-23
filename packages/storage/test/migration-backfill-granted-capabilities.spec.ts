import { describe, expect, it } from "vitest";

import { MIGRATIONS, migrate, openDatabase } from "../src/index.ts";

/**
 * N4: marking a `package_generations` row that predates `grantedCapabilities` rather than guessing at a value.
 *
 * Before this field existed, a generation was activated with whatever its manifest requested, granted outright —
 * there was no narrower policy-derived set, so the row's `document` never carried the key at all. Reading such a
 * row back today, unmigrated, would silently produce `undefined` where code now expects an array or an explicit
 * "not yet resolved" marker. Migration 22 marks it `null` rather than backfilling a guess from `install_plans`
 * (the plan row a generation resolved through is prunable and may already be gone, or may belong to a different
 * consent than the one that actually activated this generation) — the null is resolved lazily, once, by
 * `resolveGenerationGrantedCapabilities` in the runtime, from the package's own manifest.
 */

describe("migration 22: mark_generation_granted_capabilities_unresolved", () => {
  it("marks a pre-existing generation's grantedCapabilities null rather than backfilling a guess", () => {
    const db = openDatabase({ path: ":memory:" });
    // Apply every migration except the one under test, so the fixture row is written the way a node on the
    // previous schema actually would have: no `grantedCapabilities` key on the generation document at all.
    const before22 = MIGRATIONS.filter((migration) => migration.version < 22);
    migrate(db, before22);

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

    const result = migrate(db, MIGRATIONS);
    expect(result.applied).toContain(22);

    const row = db.prepare("SELECT document FROM package_generations WHERE generation_id = ?").get("gen-1") as {
      document: string;
    };
    const doc = JSON.parse(row.document) as { grantedCapabilities: unknown };
    expect(doc.grantedCapabilities).toBeNull();
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

  it("does not touch a generation already marked null (idempotent re-run)", () => {
    const db = openDatabase({ path: ":memory:" });
    const before22 = MIGRATIONS.filter((migration) => migration.version < 22);
    migrate(db, before22);

    db.prepare(
      `INSERT INTO package_generations (generation_id, package_id, version, digest, node_id, code_generation, activated_at, document)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gen-4",
      "com.example.already-marked",
      "1.0.0",
      "sha256:digest",
      "node-1",
      "codegen-4",
      "2026-01-01T00:08:00.000Z",
      JSON.stringify({ generationId: "gen-4", grantedCapabilities: null }),
    );

    migrate(db, MIGRATIONS);

    const row = db.prepare("SELECT document FROM package_generations WHERE generation_id = ?").get("gen-4") as {
      document: string;
    };
    const doc = JSON.parse(row.document) as { grantedCapabilities: unknown };
    expect(doc.grantedCapabilities).toBeNull();
  });
});
