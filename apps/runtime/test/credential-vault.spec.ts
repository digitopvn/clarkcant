import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";
import { type Database, getSecretMetadata, migrate, openDatabase } from "@clarkcant/storage";

import { consumersOf, injectionPolicyFor, storeCredentialFields } from "../src/application/credential-vault.ts";
import { createSecretBroker } from "../src/secret-broker.ts";

/**
 * How far a typed secret may travel, decided by what it was asked for.
 *
 * The card names who will use the value; the stored policy follows from that and from nothing else, so a token a
 * person gave to `git` can reach git's environment and a key given to a tool stays inside that tool's call.
 */

const AT = "2026-09-29T09:00:00.000Z" as Instant;
const VALUE = "fixture-value-typed-into-the-card";

let dir: string;
let db: Database;
let ids = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-vault-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function store(consumer: string): void {
  const outcome = storeCredentialFields(
    { db, ownerPrincipalId: "owner_1", nodeId: "node_1", newId: (prefix) => `${prefix}_${String(++ids)}` },
    [{ name: "github_token", value: VALUE, kind: "token", consumer }],
  );
  expect(outcome).toEqual({ ok: true, names: ["github_token"] });
}

describe("the consumers a card named", () => {
  it("reads one or several, trimmed and without repeats", () => {
    expect(consumersOf("command:git")).toEqual(["command:git"]);
    expect(consumersOf(" command:gh , command:git,command:gh,, ")).toEqual(["command:gh", "command:git"]);
    expect(consumersOf(undefined)).toEqual([]);
    expect(consumersOf(42)).toEqual([]);
  });

  it("keeps a bounded list, whatever a request carries", () => {
    const many = Array.from({ length: 50 }, (_, index) => `capability:c${String(index)}`).join(",");
    expect(consumersOf(many)).toHaveLength(10);
  });
});

describe("the policy a stored secret gets", () => {
  it("lets a command receive it in its environment, because that is the only way a command can", () => {
    expect(injectionPolicyFor(["command:gh", "command:git"])).toBe("process-env");
    store("command:gh,command:git");
    expect(getSecretMetadata(db, "owner_1", "github_token")).toMatchObject({
      allowedConsumers: ["command:gh", "command:git"],
      injectionPolicy: "process-env",
    });
    const broker = createSecretBroker({ db, principalId: "owner_1", now: () => AT });
    expect(broker.environmentFor({ name: "github_token", consumer: "command:gh" }, "GH_TOKEN")).toEqual({
      ok: true,
      env: { GH_TOKEN: VALUE },
    });
    // Still only for what the card named.
    expect(broker.environmentFor({ name: "github_token", consumer: "command:curl" }, "GH_TOKEN")).toMatchObject({
      ok: false,
      code: "CONSUMER_NOT_ALLOWED",
    });
  });

  it("lets a package's service have it only as a request header the host adds, never in its environment", () => {
    expect(injectionPolicyFor(["package:com.example.search"])).toBe("http-header");
    store("package:com.example.search");
    expect(getSecretMetadata(db, "owner_1", "github_token")).toMatchObject({
      allowedConsumers: ["package:com.example.search"],
      injectionPolicy: "http-header",
    });
    const broker = createSecretBroker({ db, principalId: "owner_1", now: () => AT });
    expect(broker.headersFor({ name: "github_token", consumer: "package:com.example.search" }, "authorization")).toEqual({
      ok: true,
      headers: { authorization: VALUE },
    });
    expect(broker.environmentFor({ name: "github_token", consumer: "package:com.example.search" }, "TOKEN")).toMatchObject({
      ok: false,
      code: "EXPOSURE_NOT_ALLOWED",
    });
    expect(broker.headersFor({ name: "github_token", consumer: "package:com.example.other" }, "authorization")).toMatchObject({
      ok: false,
      code: "CONSUMER_NOT_ALLOWED",
    });
  });

  it("keeps a command's environment policy when a secret is asked for a command and a package together", () => {
    expect(injectionPolicyFor(["command:gh", "package:com.example.search"])).toBe("process-env");
  });

  it("keeps anything else inside one tool call", () => {
    expect(injectionPolicyFor(["signals:github"])).toBe("tool-only");
    expect(injectionPolicyFor([])).toBe("tool-only");
    store("signals:github");
    expect(getSecretMetadata(db, "owner_1", "github_token")?.injectionPolicy).toBe("tool-only");
    expect(
      createSecretBroker({ db, principalId: "owner_1", now: () => AT }).environmentFor({ name: "github_token", consumer: "signals:github" }, "TOKEN"),
    ).toMatchObject({ ok: false, code: "EXPOSURE_NOT_ALLOWED" });
  });
});
