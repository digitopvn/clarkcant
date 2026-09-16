import { beforeEach, describe, expect, it } from "vitest";

import type { WidgetDefinition } from "@clarkcant/contracts";
import { migrate, openDatabase, toJson, allRows } from "@clarkcant/storage";
import { createInstance, type WidgetDeps } from "../src/widget-service.ts";
import { disablePackage, initialiseState } from "../src/widget-lifecycle.ts";
import {
  checkQuota,
  connectionsNeedingAttention,
  credentialState,
  EXPIRY_WARNING_DAYS,
  mayUseConnection,
  pruneUsage,
  readUsage,
  recordUsage,
  windowStartFor,
} from "../src/limits.ts";

/**
 * P10 hardening: quota, credential expiry, failure injection and soak.
 *
 * Generation rollback is deliberately absent here; it is already covered by core.spec.ts. These
 * tests cover the four things that were not: a ceiling that has to be enforced before the work
 * rather than after, a credential that has to be judged before a call fails at the provider, a
 * storage failure that has to leave nothing half-written, and repeated use that must not grow
 * storage without bound.
 */

const AT = "2026-09-16T06:00:00.000Z" as never;
const LATER = "2026-09-16T09:30:00.000Z" as never;
let counter = 0;

function makeDeps(now: () => typeof AT = () => AT) {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  db.prepare(
    "INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)",
  ).run("conv_1", "node_a", AT, AT);
  return { db, nodeId: "node_a", now, newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}` };
}

let deps: ReturnType<typeof makeDeps>;
beforeEach(() => {
  deps = makeDeps();
});

describe("a quota is enforced at the door, not after the work", () => {
  it("allows a run that fits", () => {
    const decision = checkQuota(deps, { scopeKey: "node", limits: { runs: 5 } });
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.remaining.runs).toBe(5);
  });

  it("counts an estimate against the ceiling, so an over-budget run is refused up front", () => {
    recordUsage(deps, { scopeKey: "node", windowStart: windowStartFor(AT), delta: { runs: 4 } });
    // Admitting it and failing half-way would already have spent the budget.
    const decision = checkQuota(deps, { scopeKey: "node", limits: { runs: 5 }, estimated: { runs: 2 } });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.exceeded).toBe("runs");
    expect(decision.allowed === false && decision.used).toBe(4);
  });

  it("names which ceiling was reached", () => {
    recordUsage(deps, { scopeKey: "node", windowStart: windowStartFor(AT), delta: { tokens: 1200 } });
    const decision = checkQuota(deps, { scopeKey: "node", limits: { runs: 100, tokens: 1000 } });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.exceeded).toBe("tokens");
    expect(decision.allowed === false && decision.limit).toBe(1000);
  });

  it("allows a run that lands exactly on the ceiling", () => {
    recordUsage(deps, { scopeKey: "node", windowStart: windowStartFor(AT), delta: { runs: 10 } });
    // The ceiling is a limit, not a boundary to stay under: reaching it is allowed and exceeding
    // it is not.
    expect(checkQuota(deps, { scopeKey: "node", limits: { runs: 10 } }).allowed).toBe(true);
  });

  it("treats an absent ceiling as no limit rather than zero", () => {
    recordUsage(deps, { scopeKey: "node", windowStart: windowStartFor(AT), delta: { runs: 999 } });
    // A node with no configured limit must not refuse everything.
    expect(checkQuota(deps, { scopeKey: "node", limits: {} }).allowed).toBe(true);
  });

  it("resets in the next window, so a limit is not permanent", () => {
    // A clock that moves, so the next window is genuinely the same node's next window rather than
    // a second empty database that would pass for the wrong reason.
    const clock = { at: AT };
    const timed = makeDeps(() => clock.at);
    recordUsage(timed, { scopeKey: "node", windowStart: windowStartFor(AT), delta: { runs: 11 } });
    expect(checkQuota(timed, { scopeKey: "node", limits: { runs: 10 } }).allowed).toBe(false);

    clock.at = LATER;
    // A cumulative counter could only ever refuse, and the user's only escape would be a reset.
    expect(checkQuota(timed, { scopeKey: "node", limits: { runs: 10 } }).allowed).toBe(true);
  });

  it("keeps scopes separate, so one busy scope does not spend another's budget", () => {
    recordUsage(deps, { scopeKey: "conversation:one", windowStart: windowStartFor(AT), delta: { runs: 10 } });
    expect(checkQuota(deps, { scopeKey: "conversation:two", limits: { runs: 10 } }).allowed).toBe(true);
  });

  it("accumulates, so two runs both count", () => {
    recordUsage(deps, { scopeKey: "node", windowStart: windowStartFor(AT), delta: { runs: 2, tokens: 100 } });
    const totals = recordUsage(deps, {
      scopeKey: "node",
      windowStart: windowStartFor(AT),
      delta: { runs: 3, tokens: 50 },
    });
    expect(totals).toEqual({ runs: 5, tokens: 150, artifactBytes: 0, wallClockMs: 0 });
  });
});

describe("a credential is judged before the call, not after it fails", () => {
  function addConnection(
    expiresAt: string | undefined,
    status = "connected",
  ): string {
    const connectionId = `conn_${String(++counter).padStart(6, "0")}`;
    deps.db
      .prepare(
        `INSERT INTO connections
           (connection_id, provider, credential_node_id, account_id, status, granted_scopes, missing_scopes, document, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        connectionId,
        "google-calendar",
        "node_a",
        "acct_1",
        status,
        "[]",
        "[]",
        toJson(expiresAt === undefined ? {} : { expiresAt }),
        AT,
        AT,
      );
    return connectionId;
  }

  it("reports a healthy credential with the time it has left", () => {
    const state = credentialState(deps, addConnection("2026-12-16T06:00:00.000Z"));
    expect(state?.status).toBe("valid");
    expect(state?.daysRemaining).toBeGreaterThan(EXPIRY_WARNING_DAYS);
  });

  it("warns while the credential still works, so a reconnect can happen in time", () => {
    const state = credentialState(deps, addConnection("2026-09-19T06:00:00.000Z"));
    expect(state?.status).toBe("expiring");
    expect(state?.message).toContain("expires in");
  });

  it("reports an expired credential as expired rather than as a call failure", () => {
    const state = credentialState(deps, addConnection("2026-09-10T06:00:00.000Z"));
    expect(state?.status).toBe("expired");
    expect(state?.daysRemaining).toBeLessThan(0);
    expect(state?.message).toContain("Reconnect");
  });

  it("does not treat a provider that omits expiry as valid forever", () => {
    const state = credentialState(deps, addConnection(undefined));
    expect(state?.status).toBe("unknown");
    // Not reporting an expiry is not the same as not expiring.
    expect(state?.message).toContain("until it fails");
  });

  it("keeps a revoked connection out of use even if it has not expired yet", () => {
    const state = credentialState(deps, addConnection("2027-01-01T00:00:00.000Z", "revoked"));
    expect(state?.status).toBe("revoked");
  });

  it("refuses to route to an expired credential and says why", () => {
    const connectionId = addConnection("2026-09-01T06:00:00.000Z");
    const decision = mayUseConnection(deps, connectionId);
    expect(decision.route).toBe(false);
    // The user sees the application's own explanation rather than a provider auth error.
    expect(decision.route === false && decision.reason).toContain("expired");
  });

  it("routes to the node that owns the credential", () => {
    const decision = mayUseConnection(deps, addConnection("2026-12-16T06:00:00.000Z"));
    expect(decision.route && decision.credentialNodeId).toBe("node_a");
  });

  it("reports a missing connection instead of assuming it is usable", () => {
    expect(mayUseConnection(deps, "conn_missing").route).toBe(false);
    expect(credentialState(deps, "conn_missing")).toBeUndefined();
  });

  it("lists only the connections that need attention, soonest first", () => {
    addConnection("2027-01-01T00:00:00.000Z");
    const soon = addConnection("2026-09-18T06:00:00.000Z");
    const past = addConnection("2026-09-01T06:00:00.000Z");

    const attention = connectionsNeedingAttention(deps);
    expect(attention.map((state) => state.connectionId)).toEqual([past, soon]);
  });
});

describe("a storage failure mid-operation leaves nothing half-written", () => {
  const DEF: WidgetDefinition = {
    id: "example.notes.editor",
    version: "1.0.0",
    renderer: "isolated-app",
    propsSchema: { type: "object", additionalProperties: true },
    eventSchemas: {},
    stateSchema: { type: "object" },
    stateVersion: 1,
    sizing: { compact: true, expanded: true },
    textFallback: "A note.",
    effectCategories: ["read"],
    datasetRefs: [],
    semanticDescription: "A note",
    requestedCapabilities: [],
  };

  function makeInstance(deps: WidgetDeps, digest: string) {
    const instance = createInstance(deps, {
      definition: DEF,
      packageDigest: digest,
      ownerPrincipalId: "prin_owner" as never,
      props: { title: "Note" },
    });
    initialiseState(deps, { instanceId: instance.instanceId, body: { body: "x" } });
    return instance;
  }

  it("rolls the whole operation back when the store fails part-way through", () => {
    const first = makeInstance(deps, "digest_pack");
    const second = makeInstance(deps, "digest_pack");

    // Failure injected at the storage layer rather than by a mock, so the rollback under test is
    // the real one: the trigger aborts the transaction after its first write.
    //
    // The instance to fail on is inserted as a bound parameter into a marker table, because a
    // CREATE TRIGGER body cannot take bound parameters. Interpolating the id into the SQL text
    // would work here and would be the wrong habit to keep in a test that is about correctness.
    deps.db.exec(`
      CREATE TABLE inject_fail_at (instance_id TEXT NOT NULL);
      CREATE TRIGGER inject_storage_failure BEFORE UPDATE ON widget_instances
      WHEN OLD.instance_id = (SELECT instance_id FROM inject_fail_at LIMIT 1)
      BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;
    `);
    deps.db.prepare("INSERT INTO inject_fail_at (instance_id) VALUES (?)").run(second.instanceId);

    expect(() =>
      disablePackage(deps, { packageDigest: "digest_pack", reason: "uninstalling" }),
    ).toThrow(/injected storage failure/);

    // The first instance was updated before the failure. It must not still be offline: a partial
    // disable is worse than a failed one, because the user sees a package that is half gone.
    const rows = allRows<{ instance_id: string; lifecycle: string }>(
      deps.db,
      "SELECT instance_id, lifecycle FROM widget_instances ORDER BY instance_id",
    );
    expect(rows.map((row) => row.lifecycle)).toEqual(["ready", "ready"]);
    expect(rows.map((row) => row.instance_id)).toEqual([first.instanceId, second.instanceId].sort());
  });

  it("still performs the operation once the injected failure is removed", () => {
    makeInstance(deps, "digest_pack");
    makeInstance(deps, "digest_pack");
    deps.db.exec("DROP TRIGGER IF EXISTS inject_storage_failure");

    // The differential: without this, the previous test would also pass if disabling simply
    // never worked.
    const outcome = disablePackage(deps, { packageDigest: "digest_pack", reason: "uninstalling" });
    expect(outcome.instancesOffline).toBe(2);
  });
});

describe("repeated use does not grow storage without bound", () => {
  it("keeps one preference row however many times it is written", () => {
    for (let index = 0; index < 500; index += 1) {
      deps.db
        .prepare(
          `INSERT INTO preferences (principal_id, key, value, scope, source, revision, previous_value, created_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT (principal_id, key, scope) DO UPDATE SET value = excluded.value, revision = excluded.revision`,
        )
        .run("prin_owner", "theme", `"v${index}"`, "global", "user", index, null, AT);
    }
    const count = deps.db
      .prepare("SELECT COUNT(*) AS n FROM preferences WHERE principal_id = ?")
      .get("prin_owner") as { n: number };
    // A version per write would be the natural mistake, and it grows without limit.
    expect(Number(count.n)).toBe(1);
  });

  it("accumulates usage within a window rather than adding a row per run", () => {
    const windowStart = windowStartFor(AT);
    for (let index = 0; index < 500; index += 1) {
      recordUsage(deps, { scopeKey: "node", windowStart, delta: { runs: 1, tokens: 10 } });
    }
    const count = deps.db
      .prepare("SELECT COUNT(*) AS n FROM usage_counters")
      .get() as { n: number };
    expect(Number(count.n)).toBe(1);
    expect(readUsage(deps, { scopeKey: "node", windowStart })).toEqual({
      runs: 500,
      tokens: 5000,
      artifactBytes: 0,
      wallClockMs: 0,
    });
  });

  it("drops windows that have already ended", () => {
    // Twenty-six windows ending at the current one, so exactly one falls outside the retained
    // span of twenty-four hours before it.
    const nowMs = Date.parse(AT);
    for (let hoursAgo = 25; hoursAgo >= 0; hoursAgo -= 1) {
      const at = new Date(nowMs - hoursAgo * 3_600_000).toISOString() as typeof AT;
      recordUsage(deps, { scopeKey: "node", windowStart: windowStartFor(at), delta: { runs: 1 } });
    }
    const before = deps.db.prepare("SELECT COUNT(*) AS n FROM usage_counters").get() as { n: number };
    expect(Number(before.n)).toBe(26);

    const removed = pruneUsage(deps, 24);
    expect(removed).toBe(1);
    const after = deps.db.prepare("SELECT COUNT(*) AS n FROM usage_counters").get() as { n: number };
    expect(Number(after.n)).toBe(25);
  });
});
