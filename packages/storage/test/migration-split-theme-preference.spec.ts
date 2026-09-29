import { describe, expect, it } from "vitest";

import { MIGRATIONS, migrate, openDatabase, type Database } from "../src/index.ts";

/**
 * Carrying the stored theme choice into the colour-scheme preference.
 *
 * `experience.theme` held `system | light | dark` — a colour scheme under a theme's name. The registry now has
 * `experience.colorScheme` for that choice and `experience.themeRef` for the theme itself. A person who chose
 * "light" must still have "light" after the upgrade, with its provenance and its Undo intact, and nobody may be
 * given a theme they never chose: the migration writes no `experience.themeRef` row, so the registry default
 * (Clark Default) answers for it.
 */

const VERSION = 35;

type PreferenceRow = {
  principal_id: string;
  key: string;
  value: string;
  scope: string;
  source: string;
  revision: number;
  previous_value: string | null;
  created_at: string;
};

function databaseBeforeSplit(): Database {
  const db = openDatabase({ path: ":memory:" });
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < VERSION),
  );
  return db;
}

function insert(db: Database, row: PreferenceRow): void {
  db.prepare(
    `INSERT INTO preferences (principal_id, key, value, scope, source, revision, previous_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.principal_id,
    row.key,
    row.value,
    row.scope,
    row.source,
    row.revision,
    row.previous_value,
    row.created_at,
  );
}

function rows(db: Database, key: string): PreferenceRow[] {
  return db
    .prepare(
      `SELECT principal_id, key, value, scope, source, revision, previous_value, created_at
         FROM preferences WHERE key = ? ORDER BY principal_id`,
    )
    .all(key) as PreferenceRow[];
}

function legacy(principal: string, value: string, extra: Partial<PreferenceRow> = {}): PreferenceRow {
  return {
    principal_id: principal,
    key: "experience.theme",
    value: JSON.stringify(value),
    scope: "global",
    source: "settings",
    revision: 1,
    previous_value: null,
    created_at: "2026-09-01T08:00:00.000Z",
    ...extra,
  };
}

describe("migration 35: split_theme_preference_into_color_scheme", () => {
  it("carries every stored choice across unchanged, with its provenance and Undo", () => {
    const db = databaseBeforeSplit();
    insert(db, legacy("prin_dark", "dark", { revision: 3, previous_value: JSON.stringify("light"), source: "voice" }));
    insert(db, legacy("prin_light", "light", { created_at: "2026-09-02T09:30:00.000Z" }));
    insert(db, legacy("prin_system", "system", { revision: 2, previous_value: JSON.stringify("dark") }));

    const result = migrate(db, MIGRATIONS);
    expect(result.applied).toContain(VERSION);

    expect(rows(db, "experience.colorScheme")).toEqual([
      {
        ...legacy("prin_dark", "dark", { revision: 3, previous_value: JSON.stringify("light"), source: "voice" }),
        key: "experience.colorScheme",
      },
      { ...legacy("prin_light", "light", { created_at: "2026-09-02T09:30:00.000Z" }), key: "experience.colorScheme" },
      {
        ...legacy("prin_system", "system", { revision: 2, previous_value: JSON.stringify("dark") }),
        key: "experience.colorScheme",
      },
    ]);
  });

  it("gives nobody a theme they did not choose", () => {
    const db = databaseBeforeSplit();
    insert(db, legacy("prin_owner", "dark"));
    migrate(db, MIGRATIONS);
    expect(rows(db, "experience.themeRef")).toEqual([]);
  });

  it("leaves the legacy row in place, so an older node binary reading the same file still finds its choice", () => {
    const db = databaseBeforeSplit();
    insert(db, legacy("prin_owner", "light"));
    migrate(db, MIGRATIONS);
    expect(rows(db, "experience.theme")).toEqual([legacy("prin_owner", "light")]);
  });

  it("keeps a colour-scheme choice that already exists rather than overwriting it", () => {
    const db = databaseBeforeSplit();
    insert(db, legacy("prin_owner", "dark"));
    const newer: PreferenceRow = {
      ...legacy("prin_owner", "light", { revision: 4, created_at: "2026-09-20T10:00:00.000Z" }),
      key: "experience.colorScheme",
    };
    insert(db, newer);

    migrate(db, MIGRATIONS);
    expect(rows(db, "experience.colorScheme")).toEqual([newer]);
  });

  it("writes nothing for a person who never chose, so the default still answers for them", () => {
    const db = databaseBeforeSplit();
    insert(db, { ...legacy("prin_owner", "on"), key: "experience.motion" });
    migrate(db, MIGRATIONS);
    expect(rows(db, "experience.colorScheme")).toEqual([]);
  });

  it("carries no value the old key could not hold, and keeps those legacy rows as they are", () => {
    const db = databaseBeforeSplit();
    const unknown = legacy("prin_blue", "blue");
    const garbage: PreferenceRow[] = [
      { ...legacy("prin_json", "x"), value: "{not json" },
      { ...legacy("prin_number", "x"), value: "3" },
      { ...legacy("prin_object", "x"), value: JSON.stringify({ scheme: "dark" }) },
      { ...legacy("prin_case", "x"), value: JSON.stringify("Dark") },
    ];
    for (const row of [unknown, ...garbage]) insert(db, row);
    insert(db, legacy("prin_valid", "dark"));

    migrate(db, MIGRATIONS);

    expect(rows(db, "experience.colorScheme")).toEqual([{ ...legacy("prin_valid", "dark"), key: "experience.colorScheme" }]);
    expect(rows(db, "experience.theme")).toHaveLength(6);
  });

  it("changes nothing when the migrations run again", () => {
    const db = databaseBeforeSplit();
    insert(db, legacy("prin_owner", "light"));
    migrate(db, MIGRATIONS);
    const once = rows(db, "experience.colorScheme");

    const again = migrate(db, MIGRATIONS);
    expect(again.applied).toEqual([]);
    expect(rows(db, "experience.colorScheme")).toEqual(once);
  });
});
