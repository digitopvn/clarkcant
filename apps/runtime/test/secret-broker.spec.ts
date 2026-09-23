import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";
import {
  type Database,
  type InjectionPolicy,
  getSecretMetadata,
  migrate,
  nodeStoreSecretBackend,
  openDatabase,
  putSecretMetadata,
} from "@clarkcant/storage";

import { agentContextSecret, createSecretBroker } from "../src/secret-broker.ts";

/**
 * Injection, just in time.
 *
 * Every test here is about what does *not* come back. A broker that returns a value is a broker whose value ends up
 * in a log line, a tool result or a model's context eventually, so the assertions are mostly negative: the value is
 * inside the callback's stack and nowhere in the value this module hands back.
 */
const AT = "2026-09-19T10:00:00.000Z" as Instant;
const SECRET_VALUE = "fixture-value-that-must-not-escape";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-broker-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(options: {
  policy?: InjectionPolicy;
  consumers?: string[];
  backend?: "node-store" | "os-keychain";
  withValue?: boolean;
} = {}): void {
  putSecretMetadata(db, {
    secretId: "secret_github_token",
    principalId: "owner_1",
    name: "github_token",
    description: "GitHub PAT",
    kind: "token",
    backend: options.backend ?? "node-store",
    backendRef: "github_token",
    allowedConsumers: options.consumers ?? ["command:git"],
    injectionPolicy: options.policy ?? "tool-only",
    at: AT,
  });
  if (options.withValue !== false) {
    nodeStoreSecretBackend(db, "owner_1").write("github_token", SECRET_VALUE, AT);
  }
}

function broker(): ReturnType<typeof createSecretBroker> {
  return createSecretBroker({ db, principalId: "owner_1", now: () => AT });
}

describe("the value inside one call", () => {
  it("is given to the callback and is nowhere in what comes back", () => {
    seed();
    let seen = "";
    const outcome = broker().withSecret({ name: "github_token", consumer: "command:git" }, (value) => {
      seen = value;
      return value.length;
    });

    expect(outcome).toEqual({ ok: true, result: SECRET_VALUE.length });
    expect(seen).toBe(SECRET_VALUE);
    // The negative assertion: whatever a caller does with the result, the result cannot leak the value.
    expect(JSON.stringify(outcome)).not.toContain(SECRET_VALUE);
  });

  it("defaults to tool-only, so a caller that asks for nothing gets the narrowest thing", () => {
    seed();
    const outcome = broker().withSecret({ name: "github_token", consumer: "command:git" }, () => "done");
    expect(outcome.ok).toBe(true);
  });

  it("never runs the callback when the consumer is not allowed", () => {
    seed({ consumers: ["command:git"] });
    let ran = false;
    const outcome = broker().withSecret({ name: "github_token", consumer: "capability:elsewhere" }, () => {
      ran = true;
      return "x";
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("CONSUMER_NOT_ALLOWED");
    // The value was never read, which is stronger than not returning it.
    expect(ran).toBe(false);
  });

  it("treats a secret with no recorded consumer as unrestricted, rather than as unusable", () => {
    // Every secret stored by an older build looks like this; a rule that disabled them would be discovered as an
    // outage rather than as a policy.
    seed({ consumers: [] });
    expect(broker().withSecret({ name: "github_token", consumer: "capability:anything" }, () => "ok").ok).toBe(true);
  });

  it("records that it was used, which is the question an operator asks later", () => {
    seed();
    broker().withSecret({ name: "github_token", consumer: "command:git" }, () => "ok");
    expect(getSecretMetadata(db, "owner_1", "github_token")?.lastUsedAt).toBe(AT);
  });

  it("answers for a secret that does not exist, and for one whose value went missing", () => {
    expect(broker().withSecret({ name: "nope", consumer: "command:git" }, () => "x")).toMatchObject({
      ok: false,
      code: "SECRET_NOT_FOUND",
    });

    seed({ withValue: false });
    expect(broker().withSecret({ name: "github_token", consumer: "command:git" }, () => "x")).toMatchObject({
      ok: false,
      code: "SECRET_NOT_FOUND",
    });
  });
});

describe("the envelope each exposure builds", () => {
  it("builds a child process's environment, when the policy allows it", () => {
    seed({ policy: "process-env" });
    const outcome = broker().environmentFor({ name: "github_token", consumer: "command:git" }, "GITHUB_TOKEN");
    expect(outcome).toEqual({ ok: true, env: { GITHUB_TOKEN: SECRET_VALUE } });
  });

  it("builds request headers, when the policy allows it", () => {
    seed({ policy: "http-header" });
    const outcome = broker().headersFor({ name: "github_token", consumer: "command:git" }, "Authorization");
    expect(outcome).toEqual({ ok: true, headers: { Authorization: SECRET_VALUE } });
  });

  it("refuses an exposure the policy does not name", () => {
    // A policy of process-env does not authorise http-header: they are different places for a value to exist, and an
    // operator who chose one did not choose the other.
    seed({ policy: "process-env" });
    expect(broker().headersFor({ name: "github_token", consumer: "command:git" }, "Authorization")).toMatchObject({
      ok: false,
      code: "EXPOSURE_NOT_ALLOWED",
    });
  });

  it("refuses the widest exposure unless the metadata asked for it", () => {
    seed({ policy: "tool-only" });
    expect(agentContextSecret({ db, principalId: "owner_1", now: () => AT }, { name: "github_token", consumer: "command:git" })).toMatchObject(
      { ok: false, code: "EXPOSURE_NOT_ALLOWED" },
    );

    // And permits it when the operator did, because that is the only consent that counts here.
    nodeStoreSecretBackend(db, "owner_1").remove("github_token");
    db.prepare("UPDATE secrets SET injection_policy = ? WHERE name = ?").run("agent-context", "github_token");
    nodeStoreSecretBackend(db, "owner_1").write("github_token", SECRET_VALUE, AT);
    const allowed = agentContextSecret({ db, principalId: "owner_1", now: () => AT }, { name: "github_token", consumer: "command:git" });
    expect(allowed).toEqual({ ok: true, value: SECRET_VALUE });
  });

  it("does not downgrade to the store when the metadata names a backend this build lacks", () => {
    seed({ backend: "os-keychain" });
    expect(broker().withSecret({ name: "github_token", consumer: "command:git" }, () => "x")).toMatchObject({
      ok: false,
      code: "BACKEND_UNAVAILABLE",
    });
  });
});
