import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import { openDatabase, type Database } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import {
  deleteSecretMetadata,
  getSecretMetadata,
  listSecretMetadata,
  markSecretUsed,
  nodeStoreSecretBackend,
  putSecretMetadata,
  secretBackendFor,
  summarizeSecret,
} from "../src/secrets.ts";

/**
 * Secrets: metadata about a secret, and a value somewhere else.
 *
 * The property every test here circles is the same one: the metadata is a description, and a description cannot
 * leak what it describes. That is why the summary is built as a projection rather than cast from the row — a
 * column added later stays invisible until somebody decides it should be visible.
 */
const AT = "2026-09-19T10:00:00.000Z" as Instant;
const SECRET_VALUE = "fixture-value-do-not-print-this-anywhere";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-secrets-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function add(name = "github_token", overrides: Partial<Parameters<typeof putSecretMetadata>[1]> = {}): void {
  putSecretMetadata(db, {
    secretId: `secret_${name}`,
    principalId: "owner_1",
    name,
    description: "GitHub PAT dùng cho git push và GitHub API",
    kind: "token",
    backend: "node-store",
    backendRef: name,
    allowedConsumers: ["capability:github", "command:git"],
    injectionPolicy: "tool-only",
    at: AT,
    ...overrides,
  });
}

describe("what the node remembers about a secret", () => {
  it("applies the migration that adds the table", () => {
    // Asserted against the table rather than the schema version, so a later migration does not have to remember to
    // come back and update this line.
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'secrets'").get();
    expect(table).toBeDefined();
  });

  it("keeps the description, the consumers and the policy", () => {
    add();
    const stored = getSecretMetadata(db, "owner_1", "github_token");
    expect(stored).toMatchObject({
      description: "GitHub PAT dùng cho git push và GitHub API",
      kind: "token",
      backend: "node-store",
      injectionPolicy: "tool-only",
      allowedConsumers: ["capability:github", "command:git"],
    });
    expect(listSecretMetadata(db, "owner_1").map((entry) => entry.name)).toEqual(["github_token"]);
  });

  it("updates the description rather than making a second secret of the same name", () => {
    add();
    add("github_token", { description: "Đổi mô tả", injectionPolicy: "process-env" });

    const all = listSecretMetadata(db, "owner_1");
    expect(all).toHaveLength(1);
    expect(all[0]?.description).toBe("Đổi mô tả");
    expect(all[0]?.injectionPolicy).toBe("process-env");
    // The id is the one from the first write: the row was updated, not replaced.
    expect(all[0]?.secretId).toBe("secret_github_token");
  });

  it("keeps secrets per principal", () => {
    add();
    expect(getSecretMetadata(db, "someone_else", "github_token")).toBeUndefined();
    expect(listSecretMetadata(db, "someone_else")).toEqual([]);
  });

  it("forgets one when it is removed", () => {
    add();
    expect(deleteSecretMetadata(db, "owner_1", "github_token")).toBe(true);
    expect(getSecretMetadata(db, "owner_1", "github_token")).toBeUndefined();
    // Removing something that is not there is answered honestly rather than reported as success.
    expect(deleteSecretMetadata(db, "owner_1", "github_token")).toBe(false);
  });

  it("records the last use, which is the question an operator actually asks", () => {
    add();
    expect(getSecretMetadata(db, "owner_1", "github_token")?.lastUsedAt).toBeUndefined();
    markSecretUsed(db, "owner_1", "github_token", "2026-09-19T11:00:00.000Z" as Instant);
    expect(getSecretMetadata(db, "owner_1", "github_token")?.lastUsedAt).toBe("2026-09-19T11:00:00.000Z");
  });

  it("survives a hand-edited consumer list instead of failing the listing", () => {
    add();
    db.prepare("UPDATE secrets SET allowed_consumers = ? WHERE name = ?").run("{not json", "github_token");
    expect(getSecretMetadata(db, "owner_1", "github_token")?.allowedConsumers).toEqual([]);
  });
});

describe("what anything outside the host may see", () => {
  it("is a description, and structurally has no room for a value", () => {
    add();
    const metadata = getSecretMetadata(db, "owner_1", "github_token");
    expect(metadata).toBeDefined();
    const summary = summarizeSecret(metadata!);

    expect(summary).toEqual({
      name: "github_token",
      description: "GitHub PAT dùng cho git push và GitHub API",
      kind: "token",
      present: true,
      allowedConsumers: ["capability:github", "command:git"],
      injectionPolicy: "tool-only",
    });
    expect(Object.keys(summary)).not.toContain("value");
    expect(Object.keys(summary)).not.toContain("backendRef");
  });
});

describe("the backend a value lives in", () => {
  it("writes and reads through the store the node already had", () => {
    const backend = nodeStoreSecretBackend(db, "owner_1");
    expect(backend.has("github_token")).toBe(false);
    backend.write("github_token", SECRET_VALUE, AT);
    expect(backend.has("github_token")).toBe(true);
    expect(backend.read("github_token")).toBe(SECRET_VALUE);

    // Rewriting replaces the value rather than adding a second one.
    backend.write("github_token", "second-value", AT);
    expect(backend.read("github_token")).toBe("second-value");
    const count = db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE name = ?").get("github_token") as { n: number };
    expect(count.n).toBe(1);

    backend.remove("github_token");
    expect(backend.has("github_token")).toBe(false);
  });

  it("answers for a backend this build does not have instead of downgrading to the one it does", () => {
    // A row that says os-keychain and a node that reads SQLite would be a silent downgrade of the promise the row
    // makes, so the honest answer is "no backend" and the caller reports it.
    expect(secretBackendFor(db, "owner_1", "os-keychain")).toBeUndefined();
    expect(secretBackendFor(db, "owner_1", "node-store")?.kind).toBe("node-store");
  });

  it("does not tie a value to the metadata row's lifetime", () => {
    // Removing the metadata is not removing the value: the caller decides, because a half-deleted secret (value
    // gone, row left pointing at it) is worse than either. This test records which half does what.
    const backend = nodeStoreSecretBackend(db, "owner_1");
    backend.write("github_token", SECRET_VALUE, AT);
    add();
    deleteSecretMetadata(db, "owner_1", "github_token");

    expect(getSecretMetadata(db, "owner_1", "github_token")).toBeUndefined();
    expect(backend.has("github_token")).toBe(true);
  });
});
