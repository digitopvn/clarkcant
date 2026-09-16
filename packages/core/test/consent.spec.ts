import { beforeEach, describe, expect, it } from "vitest";

import type { WidgetDefinition } from "@clarkcant/contracts";
import { migrate, openDatabase } from "@clarkcant/storage";
import { createInstance, type WidgetDeps } from "../src/widget-service.ts";
import {
  BOUNDED_INTERVAL_MS,
  bindAgentAction,
  decidePoll,
  putDocument,
  readDocumentState,
  rebindInstance,
  resolveCredentialForNode,
  writeIfCurrent,
} from "../src/consent.ts";

/**
 * What remains permitted (T37, T39, T42, T52, T71).
 *
 * Five staleness checks. Each test asks the same question in a different setting: a decision was
 * correct when it was made, and something has changed since. The refusals are asserted by code
 * rather than by falsiness, because the codes are what tell a caller whether to discover, route,
 * or ask the user.
 */

const AT = "2026-09-16T06:00:00.000Z" as never;
const LATER = "2026-09-16T06:20:00.000Z" as never;
let counter = 0;

const DEF: WidgetDefinition = {
  id: "example.orders.widget",
  version: "1.0.0",
  renderer: "isolated-app",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: { type: "object" },
  stateVersion: 1,
  sizing: { compact: true, expanded: true },
  textFallback: "Orders.",
  effectCategories: ["read"],
  datasetRefs: [],
  semanticDescription: "An orders widget",
  requestedCapabilities: [],
};

function makeDeps() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  db.prepare(
    "INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)",
  ).run("conv_1", "node_a", AT, AT);
  return {
    db,
    nodeId: "node_a",
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  };
}

function makeInstance(deps: WidgetDeps, connectionRefs: string[] = []) {
  return createInstance(deps, {
    definition: DEF,
    packageDigest: "digest_orders",
    ownerPrincipalId: "prin_owner" as never,
    props: { title: "Orders" },
    connectionRefs,
  });
}

/** The inputs a real caller supplies once; each test varies only what it is about. */
function bindingInput(instanceId: string, capabilityRef: string, discovered: string[]) {
  return {
    instanceId,
    label: "Read the order list",
    proposal: { kind: "invoke" as const, capabilityRef, args: {} },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    allowedDataRefs: [],
    fixedConstraints: { nodeId: "node_a" },
    effectCategory: "read" as const,
    requiresApproval: false,
    limits: {},
    discoveredCapabilities: new Set(discovered),
    capabilityRefToDigest: (ref: string) => `digest-of-${ref}`,
  };
}

let deps: ReturnType<typeof makeDeps>;
beforeEach(() => {
  deps = makeDeps();
});

describe("an agent-proposed action binds only a discovered capability (T39)", () => {
  it("binds a capability this node has discovered", () => {
    const instance = makeInstance(deps);
    const outcome = bindAgentAction(
      deps,
      bindingInput(instance.instanceId, "orders.list@1", ["orders.list@1"]),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.binding.effectCategory).toBe("read");
  });

  it("refuses a capability nobody has discovered, with a code that says so", () => {
    const instance = makeInstance(deps);
    const outcome = bindAgentAction(
      deps,
      bindingInput(instance.instanceId, "orders.delete@1", ["orders.list@1"]),
    );

    expect(outcome.ok).toBe(false);
    // The distinct code is the point: this is a prompt to discover, not a failure.
    expect(outcome.ok === false && outcome.code).toBe("CAPABILITY_NOT_DISCOVERED");
    expect(outcome.ok === false && "capabilityRef" in outcome && outcome.capabilityRef).toBe(
      "orders.delete@1",
    );
  });

  it("does not create a binding when it refuses", () => {
    const instance = makeInstance(deps);
    bindAgentAction(deps, bindingInput(instance.instanceId, "orders.delete@1", []));
    const count = deps.db
      .prepare("SELECT COUNT(*) AS n FROM action_bindings WHERE instance_id = ?")
      .get(instance.instanceId) as { n: number };
    expect(Number(count.n)).toBe(0);
  });
});

describe("a changed account or node invalidates consent for the old one (T42)", () => {
  function addApproval(account: string, nodeId: string, decision = "pending"): string {
    const approvalId = `appr_${String(++counter).padStart(6, "0")}`;
    deps.db
      .prepare(
        `INSERT INTO approvals
           (approval_id, operation_digest, operation_description, effect_category, target_node_id, account, decider, decision, requested_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        approvalId,
        "digest_1",
        "read the calendar",
        "read",
        nodeId,
        account,
        "prin_owner",
        decision,
        AT,
        LATER,
      );
    return approvalId;
  }

  function decisionOf(approvalId: string): string {
    const row = deps.db
      .prepare("SELECT decision FROM approvals WHERE approval_id = ?")
      .get(approvalId) as { decision: string };
    return row.decision;
  }

  it("expires the approval that named the previous account", () => {
    const instance = makeInstance(deps, ["acct_work"]);
    const workApproval = addApproval("acct_work", "node_a");

    const outcome = rebindInstance(deps, {
      instanceId: instance.instanceId,
      account: "acct_personal",
      nodeId: "node_a",
    });

    expect(outcome.unchanged).toBe(false);
    expect(outcome.approvalsInvalidated).toEqual([workApproval]);
    // Expired rather than deleted: the record of what was asked for survives while no longer
    // counting as permission.
    expect(decisionOf(workApproval)).toBe("expired");
  });

  it("expires the approval that named the previous node", () => {
    const instance = makeInstance(deps, ["acct_work"]);
    const nodeApproval = addApproval("acct_other", "node_a");

    rebindInstance(deps, { instanceId: instance.instanceId, account: "acct_other", nodeId: "node_b" });

    expect(decisionOf(nodeApproval)).toBe("expired");
  });

  it("does not touch an approval that was already decided", () => {
    const instance = makeInstance(deps, ["acct_work"]);
    const granted = addApproval("acct_work", "node_a", "granted");

    rebindInstance(deps, { instanceId: instance.instanceId, account: "acct_personal", nodeId: "node_a" });

    // A decided approval is a record of what happened, not a standing permission to revoke.
    expect(decisionOf(granted)).toBe("granted");
  });

  it("is a no-op when the account and node did not change", () => {
    const instance = makeInstance(deps, ["acct_work"]);
    const approval = addApproval("acct_work", "node_a");

    const outcome = rebindInstance(deps, {
      instanceId: instance.instanceId,
      account: "acct_work",
      nodeId: "node_a",
    });

    // Safe to call on every resolution, which is what makes it get called at all.
    expect(outcome.unchanged).toBe(true);
    expect(decisionOf(approval)).toBe("pending");
  });

  it("invalidate bindings compiled for the old account", () => {
    const instance = makeInstance(deps, ["acct_work"]);
    const bound = bindAgentAction(
      deps,
      bindingInput(instance.instanceId, "orders.list@1", ["orders.list@1"]),
    );
    // Asserted first, so a failure here is reported as a binding failure rather than as a
    // confusing count of zero below.
    expect(bound.ok).toBe(true);

    const outcome = rebindInstance(deps, {
      instanceId: instance.instanceId,
      account: "acct_personal",
      nodeId: "node_a",
    });
    expect(outcome.bindingsInvalidated).toBe(1);
    expect(outcome.bindingsKept).toBe(0);
  });
});

describe("a credential is used where it lives, never copied (T71)", () => {
  function addConnection(status = "connected"): string {
    const connectionId = `conn_${String(++counter).padStart(6, "0")}`;
    deps.db
      .prepare(
        `INSERT INTO connections
           (connection_id, provider, credential_node_id, account_id, status, granted_scopes, missing_scopes, document, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(connectionId, "google-calendar", "node_a", "acct_1", status, "[]", "[]", "{}", AT, AT);
    return connectionId;
  }

  it("returns a handle to the owning node, not a value", () => {
    const connectionId = addConnection();
    const reference = resolveCredentialForNode(deps, { connectionId, requestingNodeId: "node_a" });

    expect(reference.usable).toBe(true);
    // A handle the owner resolves locally. Nothing returned here is usable as a secret anywhere
    // else, which is what makes routing possible without copying.
    expect(reference.usable && reference.handle).toBe(`credential:${connectionId}`);
  });

  it("refuses a node that is not the owner, and says where to route instead", () => {
    const reference = resolveCredentialForNode(deps, {
      connectionId: addConnection(),
      requestingNodeId: "node_b",
    });

    expect(reference.usable).toBe(false);
    expect(reference.usable === false && reference.code).toBe("OWNED_ELSEWHERE");
    expect(reference.usable === false && reference.credentialNodeId).toBe("node_a");
    // Copying the secret would make every node a place it has to be revoked from.
    expect(reference.usable === false && reference.message).toContain("run the work there");
  });

  it("refuses a revoked connection even on its own node", () => {
    const reference = resolveCredentialForNode(deps, {
      connectionId: addConnection("revoked"),
      requestingNodeId: "node_a",
    });
    expect(reference.usable).toBe(false);
  });

  it("refuses a connection that does not exist rather than assuming it does", () => {
    expect(
      resolveCredentialForNode(deps, { connectionId: "conn_missing", requestingNodeId: "node_a" }).usable,
    ).toBe(false);
  });
});

describe("a conditional write does not lose the draft (T37)", () => {
  const ETAG_1 = '"v1"';

  it("writes when the caller holds the current version", () => {
    putDocument(deps, { documentId: "doc_1", body: { title: "original" }, etag: ETAG_1 });
    const outcome = writeIfCurrent(deps, {
      documentId: "doc_1",
      expectedEtag: ETAG_1,
      body: { title: "edited" },
      etag: '"v2"',
    });

    expect(outcome).toEqual({ ok: true, etag: '"v2"', revision: 2 });
    expect(readDocumentState(deps, "doc_1")?.document.body).toEqual({ title: "edited" });
  });

  it("refuses a stale write and keeps the caller's text", () => {
    putDocument(deps, { documentId: "doc_1", body: { title: "original" }, etag: ETAG_1 });
    // Someone else's write lands first.
    writeIfCurrent(deps, {
      documentId: "doc_1",
      expectedEtag: ETAG_1,
      body: { title: "someone else's version" },
      etag: '"v2"',
    });

    const stale = writeIfCurrent(deps, {
      documentId: "doc_1",
      expectedEtag: ETAG_1,
      body: { title: "what the user typed" },
      etag: '"v3"',
    });

    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.code).toBe("STALE_ETAG");
    // The newer content is untouched, which is the point of refusing.
    expect(stale.ok === false && stale.current).toEqual({ title: "someone else's version" });

    const state = readDocumentState(deps, "doc_1");
    // And the user's text survives, so the refusal is recoverable rather than destructive.
    expect(state?.draft).toEqual({ title: "what the user typed" });
    expect(state?.document.body).toEqual({ title: "someone else's version" });
  });

  it("says explicitly that the draft was preserved", () => {
    putDocument(deps, { documentId: "doc_1", body: { title: "a" }, etag: ETAG_1 });
    writeIfCurrent(deps, { documentId: "doc_1", expectedEtag: ETAG_1, body: { title: "b" }, etag: '"v2"' });
    const stale = writeIfCurrent(deps, {
      documentId: "doc_1",
      expectedEtag: ETAG_1,
      body: { title: "c" },
      etag: '"v3"',
    });
    expect(stale.ok === false && stale.draftPreserved).toBe(true);
  });
});

describe("background polling is rate-limited by policy (T52)", () => {
  // A fresh clock per test: a shared one let an earlier test's time travel reach a later one, and
  // the interval check passed for the wrong reason.
  let clock = { at: AT };
  const timed = { now: () => clock.at };
  beforeEach(() => {
    clock = { at: AT };
  });

  it("never polls a manual subscription, on screen or off", () => {
    expect(decidePoll(timed, { policy: "manual", offscreen: false }).allowed).toBe(false);
    expect(decidePoll(timed, { policy: "manual", offscreen: true }).allowed).toBe(false);
  });

  it("refreshes an on-open subscription only while it is on screen", () => {
    expect(decidePoll(timed, { policy: "on-open", offscreen: true }).allowed).toBe(false);
    expect(decidePoll(timed, { policy: "on-open", offscreen: false }).allowed).toBe(true);
  });

  it("rate-limits a bounded interval", () => {
    const decision = decidePoll(timed, {
      policy: "bounded-interval",
      offscreen: false,
      lastPolledAt: AT,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("refreshes at most every");
  });

  it("allows the next poll once the interval has passed", () => {
    clock.at = LATER;
    // Twenty minutes have passed and the floor is fifteen.
    expect(
      decidePoll(timed, { policy: "bounded-interval", offscreen: false, lastPolledAt: AT }).allowed,
    ).toBe(true);
  });

  it("does not let being offscreen shorten the interval", () => {
    const offscreen = decidePoll(timed, {
      policy: "bounded-interval",
      offscreen: true,
      lastPolledAt: AT,
      // A caller asking for a tighter schedule does not get one: the floor holds regardless.
      intervalMs: 1000,
    });
    expect(offscreen.allowed).toBe(false);
    expect(offscreen.allowed === false && retryDelayMs(offscreen)).toBe(BOUNDED_INTERVAL_MS);
  });

  it("polls immediately the first time, since there is nothing to throttle yet", () => {
    expect(decidePoll(timed, { policy: "bounded-interval", offscreen: true }).allowed).toBe(true);
  });
});

/** Whole milliseconds the decision asked the caller to wait. */
function retryDelayMs(decision: { retryAfter: string }): number {
  return Date.parse(decision.retryAfter) - Date.parse(AT);
}
