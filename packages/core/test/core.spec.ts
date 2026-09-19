import { beforeEach, describe, expect, it } from "vitest";

import {
  type CapabilityDescriptor,
  instantSchema,
  nodeIdSchema,
  principalIdSchema,
  type TaskRecord,
} from "@clarkcant/contracts";
import { getTask, migrate, openDatabase } from "@clarkcant/storage";

import {
  acquireLease,
  activateGeneration,
  advanceInstall,
  approveTaskStatesAreConsistent,
  checkSuccessPreconditions,
  claimLiveOwner,
  compileBinding,
  createInstance,
  createTask,
  decideApproval,
  disambiguate,
  emergencyStopActive,
  getPlan,
  invocationPreflight,
  joinOrCreatePlan,
  listCapabilitySummaries,
  markEffectUnknown,
  mayActUnderLease,
  mayDelegateFurther,
  precheckInvocation,
  prepareEffect,
  recordConsent,
  recordEvidence,
  registerCapability,
  requestApproval,
  requestEmergencyStop,
  resolveExecutionNode,
  rollbackGeneration,
  routeTask,
  saveActionBinding,
  updateReadiness,
  applyTaskEvent,
  handleUserMessage,
} from "../src/index.ts";

const AT = instantSchema.parse("2026-09-16T04:00:00.000Z");
const LATER = instantSchema.parse("2026-09-16T05:00:00.000Z");
const NODE_A = nodeIdSchema.parse("node_a");
const NODE_B = nodeIdSchema.parse("node_b");
const OWNER = principalIdSchema.parse("prin_owner");
const USER = { principalId: OWNER, kind: "user" as const, nodeId: NODE_A };
const CONDUCTOR = { principalId: principalIdSchema.parse("prin_conductor"), kind: "conductor" as const, nodeId: NODE_A };

let counter = 0;

function makeDeps(nodeId = NODE_A) {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  db.prepare(
    "INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)",
  ).run("conv_1", nodeId, AT, AT);
  return {
    db,
    nodeId,
    now: () => AT,
    newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}`,
  };
}

let deps: ReturnType<typeof makeDeps>;
beforeEach(() => {
  deps = makeDeps();
});

describe("task lifecycle persistence (T17)", () => {
  it("creates a task and records an event for it", () => {
    const task = createTask(deps, {
      conversationId: "conv_1" as never,
      goal: "read the fixture file and summarise it",
      principal: USER,
    });
    expect(task.state).toBe("queued");
    const events = deps.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(task.taskId) as {
      n: number;
    };
    expect(Number(events.n)).toBe(1);
  });

  it("refuses an illegal transition instead of ignoring it", () => {
    const task = createTask(deps, {
      conversationId: "conv_1" as never,
      goal: "goal",
      principal: USER,
    });
    const outcome = applyTaskEvent(deps, task.taskId, "verify.passed");
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.code).toBe("ILLEGAL_TRANSITION");
  });

  it("increments the revision and logs each state change", () => {
    const task = createTask(deps, { conversationId: "conv_1" as never, goal: "goal", principal: USER });
    const first = applyTaskEvent(deps, task.taskId, "resolve.start");
    expect(first.ok).toBe(true);
    expect(first.ok && first.task.revision).toBe(1);
    expect(first.ok && first.task.state).toBe("resolving");
  });

  it("keeps the disposition column consistent with the contract reducer", () => {
    // The storage layer mirrors the disposition mapping to avoid importing the
    // reducer into a query path; this asserts the two have not drifted.
    expect(approveTaskStatesAreConsistent()).toBe(true);
  });
});

describe("success gating (T18)", () => {
  function runningTask(): TaskRecord {
    const task = createTask(deps, { conversationId: "conv_1" as never, goal: "do the thing", principal: USER });
    applyTaskEvent(deps, task.taskId, "resolve.start");
    applyTaskEvent(deps, task.taskId, "resolve.ready", { executionNodeId: NODE_A });
    applyTaskEvent(deps, task.taskId, "dispatch.acknowledged");
    // Read through the repository rather than casting a raw row: the row uses
    // snake_case columns and a cast would silently produce undefined fields.
    const stored = getTask(deps.db, task.taskId);
    if (!stored) throw new Error("task disappeared");
    return stored;
  }

  it("refuses success with no evidence at all", () => {
    const task = runningTask();
    const check = checkSuccessPreconditions(deps, task.taskId, []);
    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.code).toBe("NO_EVIDENCE");
  });

  it("refuses success when evidence exists but nothing was verified", () => {
    const task = runningTask();
    const result = recordEvidence(deps, {
      taskId: task.taskId,
      evidence: { kind: "test-output", summary: "the command exited 0", verdict: "not-verified" },
    });
    const check = checkSuccessPreconditions(deps, task.taskId, [result.evidence]);
    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.code).toBe("NO_EVIDENCE");
  });

  it("refuses success while an effect outcome is still unknown", () => {
    const task = runningTask();
    const result = recordEvidence(deps, {
      taskId: task.taskId,
      evidence: { kind: "exit-status", summary: "worker exited 0", verdict: "verified" },
    });
    const effect = prepareEffect(deps, {
      taskId: task.taskId,
      executorNodeId: NODE_A,
      category: "external-write",
      capabilityRef: "calendar.events.create@1" as never,
      intent: "create the event",
      operationDigest: "sha256:aa",
      externalSupportsDedup: false,
    });
    // Simulate a submit whose acknowledgement never arrived.
    deps.db.prepare("UPDATE effects SET state = 'submitted', submit_attempts = 1 WHERE effect_id = ?").run(effect.effectId);

    const check = checkSuccessPreconditions(deps, task.taskId, [result.evidence]);
    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.code).toBe("EFFECT_UNSETTLED");
  });

  it("allows success only with verified evidence and no unsettled effect", () => {
    const task = runningTask();
    const result = recordEvidence(deps, {
      taskId: task.taskId,
      evidence: { kind: "file-diff", summary: "the fixture file changed as expected", verdict: "verified" },
    });
    const check = checkSuccessPreconditions(deps, task.taskId, [result.evidence]);
    expect(check.allowed).toBe(true);
  });

  it("refuses success when evidence contradicts the expected outcome", () => {
    const task = runningTask();
    const result = recordEvidence(deps, {
      taskId: task.taskId,
      evidence: { kind: "test-output", summary: "2 of 5 tests failed", verdict: "contradicted" },
    });
    const check = checkSuccessPreconditions(deps, task.taskId, [result.evidence]);
    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.code).toBe("EVIDENCE_CONTRADICTED");
  });

  it("moves the task to uncertain when an effect outcome is unknown (T05)", () => {
    const task = runningTask();
    const effect = prepareEffect(deps, {
      taskId: task.taskId,
      executorNodeId: NODE_A,
      category: "external-write",
      capabilityRef: "calendar.events.create@1" as never,
      intent: "create the event",
      operationDigest: "sha256:bb",
      externalSupportsDedup: false,
    });
    const outcome = markEffectUnknown(deps, effect.effectId, "the request timed out after it was submitted");
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.task.state).toBe("uncertain");
    const row = deps.db.prepare("SELECT state FROM effects WHERE effect_id = ?").get(effect.effectId) as {
      state: string;
    };
    expect(row.state).toBe("unknown");
  });
});

describe("leases and fencing (T14, T59)", () => {
  it("allocates a monotonically increasing epoch per resource", () => {
    const first = acquireLease(deps, {
      resourceNodeId: NODE_A,
      resourceId: "ws_main",
      resourceKind: "workspace",
      ttlMs: 60_000,
    });
    expect(first.ok).toBe(true);
    expect(first.ok && first.lease.epoch).toBe(1);

    // A second holder is refused while the first lease is live.
    const second = acquireLease(deps, {
      resourceNodeId: NODE_A,
      resourceId: "ws_main",
      resourceKind: "workspace",
      ttlMs: 60_000,
    });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.code).toBe("LEASE_HELD");
  });

  it("fences out a holder whose epoch is behind the resource", () => {
    acquireLease(deps, { resourceNodeId: NODE_A, resourceId: "ws_main", resourceKind: "workspace", ttlMs: 1 });
    // The first lease has already expired at AT + 1 ms, so a new holder takes over
    // with a higher epoch.
    deps.db.prepare("UPDATE leases SET expires_at = ? WHERE released_at IS NULL").run(
      instantSchema.parse("2026-09-16T03:00:00.000Z"),
    );
    const takeover = acquireLease(deps, {
      resourceNodeId: NODE_A,
      resourceId: "ws_main",
      resourceKind: "workspace",
      ttlMs: 60_000,
    });
    expect(takeover.ok).toBe(true);
    expect(takeover.ok && takeover.lease.epoch).toBe(2);

    const stale = mayActUnderLease(deps, { resourceNodeId: NODE_A, resourceId: "ws_main", heldEpoch: 1 });
    expect(stale.allowed).toBe(false);
    expect(stale.allowed === false && stale.code).toBe("STALE_LEASE_EPOCH");

    const current = mayActUnderLease(deps, { resourceNodeId: NODE_A, resourceId: "ws_main", heldEpoch: 2 });
    expect(current.allowed).toBe(true);
  });

  it("records a local emergency stop that does not depend on the network", () => {
    expect(emergencyStopActive(deps).active).toBe(false);
    requestEmergencyStop(deps, { scope: "automation", reason: "user pressed stop" });
    const stop = emergencyStopActive(deps);
    expect(stop.active).toBe(true);
    expect(stop.active && stop.scope).toBe("automation");
  });
});

describe("approvals", () => {
  it("refuses to let a non-user principal approve an operation", () => {
    const approval = requestApproval(deps, {
      operationDigest: "sha256:op",
      operationDescription: "send the email",
      effectCategory: "communication",
      ttlMs: 60_000,
    });
    const decision = decideApproval(deps, {
      approvalId: approval.approvalId,
      decision: "granted",
      decidingPrincipal: CONDUCTOR,
      seenOperationDigest: "sha256:op",
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe("APPROVAL_FORGED");
  });

  it("refuses an approval whose displayed digest does not match the stored operation", () => {
    const approval = requestApproval(deps, {
      operationDigest: "sha256:op",
      operationDescription: "send the email",
      effectCategory: "communication",
      ttlMs: 60_000,
    });
    const decision = decideApproval(deps, {
      approvalId: approval.approvalId,
      decision: "granted",
      decidingPrincipal: USER,
      seenOperationDigest: "sha256:different",
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe("APPROVAL_FORGED");
  });

  it("allows a user to approve exactly the operation that was shown", () => {
    const approval = requestApproval(deps, {
      operationDigest: "sha256:op",
      operationDescription: "send the email",
      effectCategory: "communication",
      ttlMs: 60_000,
    });
    const decision = decideApproval(deps, {
      approvalId: approval.approvalId,
      decision: "granted",
      decidingPrincipal: USER,
      seenOperationDigest: "sha256:op",
    });
    expect(decision.ok).toBe(true);
  });

  it("refuses an expired approval", () => {
    const approval = requestApproval(deps, {
      operationDigest: "sha256:op",
      operationDescription: "send the email",
      effectCategory: "communication",
      ttlMs: 1,
    });
    const expiredDeps = { ...deps, now: () => LATER };
    const decision = decideApproval(
      { db: expiredDeps.db, nodeId: expiredDeps.nodeId, now: () => LATER, newId: expiredDeps.newId },
      {
        approvalId: approval.approvalId,
        decision: "granted",
        decidingPrincipal: USER,
        seenOperationDigest: "sha256:op",
      },
    );
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe("APPROVAL_EXPIRED");
  });

  it("refuses to decide an approval twice", () => {
    const approval = requestApproval(deps, {
      operationDigest: "sha256:op",
      operationDescription: "send the email",
      effectCategory: "communication",
      ttlMs: 60_000,
    });
    decideApproval(deps, {
      approvalId: approval.approvalId,
      decision: "granted",
      decidingPrincipal: USER,
      seenOperationDigest: "sha256:op",
    });
    const again = decideApproval(deps, {
      approvalId: approval.approvalId,
      decision: "denied",
      decidingPrincipal: USER,
      seenOperationDigest: "sha256:op",
    });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.code).toBe("APPROVAL_ALREADY_DECIDED");
  });
});

describe("capability registry (T29)", () => {
  function descriptor(overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
    return {
      ref: "project.file.read@1" as CapabilityDescriptor["ref"],
      executionNodeId: NODE_A,
      summary: "read a file",
      resourceKinds: ["file"],
      effectCategory: "read",
      supportsCancellation: true,
      requiresConnection: false,
      readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      uiAffordances: [],
      ...overrides,
    };
  }

  it("reports a missing capability as installable rather than ready", () => {
    const check = invocationPreflight(deps, "project.file.read@1" as never);
    expect(check.ready).toBe(false);
    expect(check.ready === false && check.code).toBe("CAPABILITY_MISSING");
  });

  it("distinguishes 'needs a connection' from 'not installed'", () => {
    registerCapability(deps, descriptor({ readiness: { installed: true, loaded: true, authenticated: false, authorized: true, healthy: true } }));
    const check = invocationPreflight(deps, "project.file.read@1" as never);
    expect(check.ready === false && check.code).toBe("CAPABILITY_NOT_AUTHENTICATED");
  });

  it("stops reporting a capability as usable once a probe fails", () => {
    registerCapability(deps, descriptor());
    expect(invocationPreflight(deps, "project.file.read@1" as never).ready).toBe(true);
    updateReadiness(deps, {
      ref: "project.file.read@1" as never,
      executionNodeId: NODE_A,
      change: { healthy: false },
      at: LATER,
    });
    const after = invocationPreflight(deps, "project.file.read@1" as never);
    expect(after.ready).toBe(false);
    expect(listCapabilitySummaries(deps, { usableOnly: true })).toHaveLength(0);
  });

  it("prefers a node that can actually run the capability", () => {
    registerCapability(deps, descriptor());
    registerCapability(deps, descriptor({ executionNodeId: NODE_B, readiness: { installed: true, loaded: false, authenticated: false, authorized: false, healthy: false, blockedReason: "facet failed to load" } }));
    const resolved = resolveExecutionNode(deps, { ref: "project.file.read@1" as never });
    expect(resolved.nodeId).toBe(NODE_A);
  });

  it("says why no node can run a capability rather than picking one anyway", () => {
    registerCapability(deps, descriptor({ readiness: { installed: true, loaded: false, authenticated: false, authorized: false, healthy: false, blockedReason: "facet failed to load" } }));
    const resolved = resolveExecutionNode(deps, { ref: "project.file.read@1" as never });
    expect(resolved.nodeId).toBeUndefined();
    expect(resolved.nodeId === undefined && resolved.reason).toContain("facet failed to load");
  });
});

describe("install lifecycle (T20, T21, T26)", () => {
  const plan = {
    planId: "plan_1",
    ownerPrincipalId: OWNER,
    requirementKey: "cap:google.calendar.events.list",
    requestedCapabilityRefs: ["google.calendar.events.list@1"],
    candidate: {
      id: "example.calendar-pack",
      version: "0.2.0",
      artifactUrl: "https://registry.example.invalid/calendar.tgz",
      digest: "sha256:aa",
      rationale: "first-party recipe",
      sourceTier: "first-party-recipe" as const,
    },
    resolvedDependencies: [],
    targetNodeId: NODE_A,
    grantedCapabilities: ["google.calendar.events.list@1"],
    effectCategories: ["read" as const],
    dataRecipients: [],
    planDigest: "sha256:plan-v1",
    isolationPlan: [{ facetKind: "tools" as const, isolation: "service" as const }],
    createdAt: AT,
    expiresAt: LATER,
  };

  it("lets two tasks needing the same pack join one plan (T20)", () => {
    const first = joinOrCreatePlan(deps, plan as never);
    expect(first.status).toBe("created");
    const second = joinOrCreatePlan(deps, { ...plan, planId: "plan_2" } as never);
    expect(second.status).toBe("joined-existing");
    expect(second.planId).toBe("plan_1");
    const rows = deps.db.prepare("SELECT COUNT(*) AS n FROM install_plans").get() as { n: number };
    expect(Number(rows.n)).toBe(1);
  });

  it("invalidates consent when the artifact digest moved (T21)", () => {
    joinOrCreatePlan(deps, plan as never);
    const result = recordConsent(deps, {
      planId: "plan_1",
      currentPlan: { ...plan, candidate: { ...plan.candidate, digest: "sha256:zz" } } as never,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("CONSENT_STALE");
    expect(getPlan(deps, "plan_1")?.state).toBe("proposed");
  });

  it("records consent and refuses to activate without it", () => {
    joinOrCreatePlan(deps, plan as never);
    const activation = activateGeneration(deps, {
      planId: "plan_1",
      currentPlan: plan as never,
      codeGeneration: "gen-1",
      uiOnlyFacets: [],
      nativeExtensionChanged: false,
      skillOrPromptChanged: false,
    });
    expect(activation.ok).toBe(false);
    expect(activation.ok === false && activation.code).toBe("CONSENT_MISSING");
  });

  it("activates a consented plan and reports the refresh scope it needs", () => {
    joinOrCreatePlan(deps, plan as never);
    recordConsent(deps, { planId: "plan_1", currentPlan: plan as never });
    advanceInstall(deps, "plan_1", "staging");
    advanceInstall(deps, "plan_1", "validating");
    advanceInstall(deps, "plan_1", "ready_to_activate");

    const activation = activateGeneration(deps, {
      planId: "plan_1",
      currentPlan: plan as never,
      codeGeneration: "gen-1",
      uiOnlyFacets: [],
      nativeExtensionChanged: false,
      skillOrPromptChanged: false,
    });
    expect(activation.ok).toBe(true);
    // A connector change restarts the tool service, not the worker (T24).
    expect(activation.ok && activation.refreshScope).toBe("tool-service");
  });

  it("keeps the previous generation usable after a failed activation (T26)", () => {
    joinOrCreatePlan(deps, plan as never);
    recordConsent(deps, { planId: "plan_1", currentPlan: plan as never });
    advanceInstall(deps, "plan_1", "staging");
    advanceInstall(deps, "plan_1", "validating");
    advanceInstall(deps, "plan_1", "ready_to_activate");
    activateGeneration(deps, {
      planId: "plan_1",
      currentPlan: plan as never,
      codeGeneration: "gen-1",
      uiOnlyFacets: [],
      nativeExtensionChanged: false,
      skillOrPromptChanged: false,
    });
    // A second generation supersedes the first.
    const next = { ...plan, planId: "plan_2", requirementKey: "cap:google.calendar.events.list.v2", planDigest: "sha256:plan-v2" };
    joinOrCreatePlan(deps, next as never);
    recordConsent(deps, { planId: "plan_2", currentPlan: next as never });
    advanceInstall(deps, "plan_2", "staging");
    advanceInstall(deps, "plan_2", "validating");
    advanceInstall(deps, "plan_2", "ready_to_activate");
    activateGeneration(deps, {
      planId: "plan_2",
      currentPlan: next as never,
      codeGeneration: "gen-2",
      uiOnlyFacets: [],
      nativeExtensionChanged: false,
      skillOrPromptChanged: false,
    });

    const rolledBack = rollbackGeneration(deps, {
      packageId: "example.calendar-pack",
      nodeId: NODE_A,
      failedAt: "healthchecking",
    });
    expect(rolledBack.ok).toBe(true);
    expect(rolledBack.ok && rolledBack.generation.codeGeneration).toBe("gen-1");
  });

  it("refuses an automatic rollback once the failed step may already have replaced the generation", () => {
    const result = rollbackGeneration(deps, {
      packageId: "example.calendar-pack",
      nodeId: NODE_A,
      failedAt: "active",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("operator review");
  });
});

describe("widget ownership and bindings (T41, T43, T47)", () => {
  const definition = {
    id: "example.notes.editor",
    version: "1.0.0",
    renderer: "isolated-app" as const,
    propsSchema: { type: "object", additionalProperties: false, properties: { title: { type: "string" } }, required: ["title"] },
    eventSchemas: {},
    semanticDescription: "a personal note",
    requestedCapabilities: [],
    sizing: { compact: true, expanded: true },
    textFallback: "Personal note",
    effectCategories: ["read" as const],
    datasetRefs: [],
  };

  function instance() {
    return createInstance(deps, {
      definition,
      packageDigest: "sha256:pkg",
      ownerPrincipalId: OWNER,
      props: { title: "Draft" },
    });
  }

  it("refuses a second live owner for the same instance (T47)", () => {
    const widget = instance();
    const inline = claimLiveOwner(deps, { instanceId: widget.instanceId, surface: "inline", ownerToken: "token-inline" });
    expect(inline.ok).toBe(true);

    const pinned = claimLiveOwner(deps, { instanceId: widget.instanceId, surface: "pin", ownerToken: "token-pin" });
    expect(pinned.ok).toBe(false);
    if (!pinned.ok) expect(pinned.heldBy.surface).toBe("inline");

    // The same owner re-claiming is a no-op, which is what a remount needs.
    expect(
      claimLiveOwner(deps, { instanceId: widget.instanceId, surface: "pin", ownerToken: "token-inline" }).ok,
    ).toBe(true);
  });

  it("refuses to bind an action to a capability the registry does not know (T40)", () => {
    const widget = instance();
    const result = compileBinding(deps, {
      instanceId: widget.instanceId,
      label: "Do something imaginary",
      proposal: { kind: "invoke", capabilityRef: "imaginary.tool@1" as never, args: {} },
      inputSchema: {},
      allowedDataRefs: [],
      fixedConstraints: {},
      effectCategory: "read",
      requiresApproval: false,
      limits: {},
      knownCapabilities: new Set<string>(),
      capabilityRefToDigest: () => "sha256:cap",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an invocation whose revision has moved (T43)", () => {
    const widget = instance();
    saveActionBinding(deps, {
      actionBindingId: "act_1",
      instanceId: widget.instanceId,
      definitionId: definition.id,
      packageGeneration: "sha256:pkg",
      proposal: { kind: "view", operation: "noop", args: {} },
      label: "Noop",
      inputSchema: {},
      allowedDataRefs: [],
      fixedConstraints: {},
      effectCategory: "read",
      requiresApproval: false,
      limits: {},
      bindingDigest: "sha256:binding",
      createdAt: AT,
    });

    const check = precheckInvocation(deps, {
      instanceId: widget.instanceId,
      actionBindingId: "act_1",
      expectedRevision: 99,
      expectedBindingDigest: "sha256:binding",
      input: {},
      invocationId: "inv_1",
    });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.code).toBe("REVISION_MISMATCH");

    const correct = precheckInvocation(deps, {
      instanceId: widget.instanceId,
      actionBindingId: "act_1",
      expectedRevision: widget.revision,
      expectedBindingDigest: "sha256:binding",
      input: {},
      invocationId: "inv_2",
    });
    expect(correct.ok).toBe(true);
  });
});

describe("delegation depth (T07)", () => {
  it("stops a task from being forwarded beyond its grant", () => {
    const grant = { maxDelegationDepth: 2 } as never;
    expect(mayDelegateFurther(grant, 0)).toBe(true);
    expect(mayDelegateFurther(grant, 1)).toBe(true);
    expect(mayDelegateFurther(grant, 2)).toBe(false);
  });
});

describe("routing (T06, T09, T19)", () => {
  const base = {
    nodeId: NODE_A,
    usableCapabilityRefs: ["project.code.change@1"],
    connectionBoundCapabilityRefs: [],
    operatingSystem: "linux" as const,
    localResourceKinds: ["workspace"],
    online: true,
    leasedResourceIds: [],
    activeRunCount: 0,
    maxConcurrentRuns: 2,
  };

  it("refuses to place a task on a node with no usable capability", () => {
    const decision = routeTask(
      { requiredCapabilityRefs: ["project.code.change@1"], requiredResources: [], connectionBoundCapabilityRefs: [] },
      [{ ...base, usableCapabilityRefs: [] }],
    );
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe("NO_ELIGIBLE_NODE");
  });

  it("refuses an offline node", () => {
    const decision = routeTask(
      { requiredCapabilityRefs: [], requiredResources: [], connectionBoundCapabilityRefs: [] },
      [{ ...base, online: false }],
    );
    expect(decision.ok).toBe(false);
  });

  it("treats resource locality as a hard constraint (T09)", () => {
    const decision = routeTask(
      {
        requiredCapabilityRefs: [],
        requiredResources: [{ nodeId: NODE_B, resourceId: "ws_remote", kind: "workspace" }],
        connectionBoundCapabilityRefs: [],
      },
      [base],
    );
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.code).toBe("RESOURCE_LOCALITY_CONFLICT");
  });

  it("refuses to split a task across two nodes' resources", () => {
    const decision = routeTask(
      {
        requiredCapabilityRefs: [],
        requiredResources: [
          { nodeId: NODE_A, resourceId: "ws_a", kind: "workspace" },
          { nodeId: NODE_B, resourceId: "ws_b", kind: "workspace" },
        ],
        connectionBoundCapabilityRefs: [],
      },
      [base],
    );
    expect(decision.ok).toBe(false);
  });

  it("refuses to move a credential-bound capability to another node", () => {
    const decision = routeTask(
      {
        requiredCapabilityRefs: ["google.calendar.events.list@1"],
        requiredResources: [],
        connectionBoundCapabilityRefs: ["google.calendar.events.list@1"],
      },
      [{ ...base, usableCapabilityRefs: ["google.calendar.events.list@1"], connectionBoundCapabilityRefs: [] }],
    );
    expect(decision.ok).toBe(false);
  });

  it("asks one clarifying question when a project is ambiguous (T19)", () => {
    const ambiguous = disambiguate([
      { id: "p1", label: "customer website" },
      { id: "p2", label: "internal dashboard" },
    ]);
    expect(ambiguous.resolved).toBe(false);
    expect(ambiguous.resolved === false && ambiguous.options).toHaveLength(2);
  });

  it("resolves without asking when only one project matches", () => {
    expect(disambiguate([{ id: "p1", label: "only project" }])).toEqual({ resolved: true, id: "p1" });
  });
});

describe("choosing between usable capabilities (Phase 9)", () => {
  function descriptorOn(nodeId: typeof NODE_A): CapabilityDescriptor {
    return {
      ref: "project.file.read@1" as CapabilityDescriptor["ref"],
      executionNodeId: nodeId,
      summary: "read a file",
      resourceKinds: ["file"],
      effectCategory: "read",
      supportsCancellation: true,
      requiresConnection: false,
      readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
      uiAffordances: [],
    };
  }

  const ask = async (
    deps: ReturnType<typeof makeDeps> & {
      sampleRecipes: never[];
      chooseExecutionNode?: (input: {
        intent: string;
        candidates: readonly { capabilityRef: string; executionNodeId: string; effectCategory: string }[];
      }) => Promise<{ capabilityRef: string; executionNodeId: string } | undefined>;
    },
    text = "đọc file này",
  ) =>
    handleUserMessage(deps, {
      conversationId: "conv_1" as never,
      principal: USER,
      text,
      at: AT,
    });

  it("does not ask when only one capability is usable", async () => {
    const base = makeDeps();
    registerCapability(base, descriptorOn(NODE_A));
    let calls = 0;
    const deps = {
      ...base,
      sampleRecipes: [],
      chooseExecutionNode: async (): Promise<{ capabilityRef: string; executionNodeId: string }> => {
        calls += 1;
        return { capabilityRef: "project.file.read@1", executionNodeId: NODE_B };
      },
    };

    const outcome = await ask(deps);
    expect(outcome.resolution).toBe("task-dispatched");
    expect(calls).toBe(0);
    expect(JSON.stringify(outcome.messages)).toContain(NODE_A);
  });

  it("asks when there is a real choice, and uses the answer", async () => {
    const base = makeDeps();
    registerCapability(base, descriptorOn(NODE_A));
    registerCapability(base, descriptorOn(NODE_B));
    const seen: string[] = [];
    const deps = {
      ...base,
      sampleRecipes: [],
      chooseExecutionNode: async (input: {
        intent: string;
        candidates: readonly { capabilityRef: string; executionNodeId: string; effectCategory: string }[];
      }): Promise<{ capabilityRef: string; executionNodeId: string }> => {
        seen.push(...input.candidates.map((candidate) => `${candidate.capabilityRef}@${candidate.executionNodeId}`));
        return { capabilityRef: "project.file.read@1", executionNodeId: NODE_B };
      },
    };

    const outcome = await ask(deps);
    expect(outcome.resolution).toBe("task-dispatched");
    expect(seen.sort()).toEqual(["project.file.read@1@node_a", "project.file.read@1@node_b"]);
    // The dispatch follows the decision, and the lease/grant path is untouched.
    expect(JSON.stringify(outcome.messages)).toContain(NODE_B);
  });

  it("ignores a decider that names something it was not offered", async () => {
    const base = makeDeps();
    registerCapability(base, descriptorOn(NODE_A));
    registerCapability(base, descriptorOn(NODE_B));
    const deps = {
      ...base,
      sampleRecipes: [],
      chooseExecutionNode: async (): Promise<{ capabilityRef: string; executionNodeId: string }> => ({
        capabilityRef: "project.file.write@1",
        executionNodeId: NODE_B,
      }),
    };

    const outcome = await ask(deps);
    expect(outcome.resolution).toBe("task-dispatched");
    // The deterministic order wins, because a decider may only choose from what it was offered.
    expect(JSON.stringify(outcome.messages)).toContain(NODE_A);
  });

  it("keeps the deterministic order when no decider is configured", async () => {
    const base = makeDeps();
    registerCapability(base, descriptorOn(NODE_A));
    registerCapability(base, descriptorOn(NODE_B));
    const outcome = await ask({ ...base, sampleRecipes: [] });
    expect(outcome.resolution).toBe("task-dispatched");
    expect(JSON.stringify(outcome.messages)).toContain(NODE_A);
  });
});

/**
 * Guidance attached to one turn.
 *
 * It exists because a turn that will be read aloud has to be shorter than one that will be read, and only the
 * caller knows which it is. The note travels with the message rather than replacing it.
 */
describe("what a turn asks the model for", () => {
  it("carries the caller's note to the model, with the message unchanged", async () => {
    const seen: Array<{ text: string; note: string | undefined }> = [];
    const outcome = await handleUserMessage(
      {
        ...deps,
        sampleRecipes: [],
        respondWithModel: async (input: { text: string; note?: string }) => {
          seen.push({ text: input.text, note: input.note });
          return {
            text: "ok",
            segments: [{ kind: "text", text: "ok" }],
            provider: "test",
            model: "test",
            elapsedMs: 1,
          };
        },
      } as never,
      {
        conversationId: "conv_1" as never,
        principal: USER,
        text: "clone giúp tôi",
        at: AT,
        note: "trả lời ngắn",
      },
    );

    // The note is guidance, not a different question: the words the person said arrive exactly as said.
    expect(seen).toEqual([{ text: "clone giúp tôi", note: "trả lời ngắn" }]);
    expect(outcome.resolution).toBe("model");
  });
});
