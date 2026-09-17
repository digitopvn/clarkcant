import { beforeEach, describe, expect, it } from "vitest";

import {
  type CompiledSection,
  type Instant,
  type WidgetDefinition,
  compileActionBinding,
} from "@clarkcant/contracts";
import { migrate, openDatabase, type Database } from "@clarkcant/storage";

import {
  type WidgetDeps,
  captureCompositeSurface,
  claimLiveOwner,
  invokeMiniAppAction,
  liveOwnerOf,
  liveStateOf,
  releaseLiveOwner,
  sweepExpiredLiveOwners,
  unpinInstance,
} from "../src/index.ts";

/**
 * Live ownership and view actions (Phase 4).
 *
 * The two properties under test are the ones a UI cannot be trusted to hold: that there is exactly
 * one live owner of an instance, and that an action pressed twice produces one effect. Both are
 * enforced here in SQLite rather than in the browser, because a browser can be reloaded, duplicated
 * or killed at any moment.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;
const TZ = "Asia/Saigon";

const OVERVIEW: WidgetDefinition = {
  id: "canvas.overview@1",
  version: "1.0.0",
  renderer: "catalog",
  propsSchema: { type: "object", additionalProperties: true },
  eventSchemas: {},
  stateSchema: { type: "object" },
  stateVersion: 1,
  semanticDescription: "A composed overview",
  requestedCapabilities: [],
  sizing: { compact: true, expanded: true },
  textFallback: "An overview described in text.",
  effectCategories: ["read"],
  datasetRefs: [],
};

let counter = 0;
/** Mutable clock, so a lease can be watched expiring rather than waited out. */
let clock = AT;

function makeDeps(db: Database): WidgetDeps {
  return {
    db,
    nodeId: "node_local",
    now: () => clock,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
  };
}

function sections(): CompiledSection[] {
  return [
    {
      sectionId: "metrics",
      slot: "metrics",
      definitionRef: { id: "canvas.metrics@1", version: "1.0.0", digest: "sha256:metrics" },
      props: { datasetRef: "ds_tasks" },
      dataRefs: ["ds_tasks"],
      rows: [{ label: "x", value: 1 }],
      textAlternative: "One task.",
    },
    {
      sectionId: "filter",
      slot: "filter",
      definitionRef: { id: "canvas.filter@1", version: "1.0.0", digest: "sha256:filter" },
      props: { period: "week", timezone: TZ },
      dataRefs: [],
      textAlternative: "Period selector at week.",
    },
  ];
}

function binding(deps: WidgetDeps, instanceId: string, operation: string, kind: "view" | "agent" = "view", id?: string) {
  const compiled = compileActionBinding({
    bindingId: id ?? deps.newId("act"),
    instance: {
      instanceId,
      ownerNodeId: deps.nodeId,
      definitionRef: { id: OVERVIEW.id, version: OVERVIEW.version, packageDigest: "sha256:overview" },
      actionBindingRevision: 1,
    },
    packageGeneration: "sha256:overview",
    label: operation,
    proposal:
      kind === "agent"
        ? { kind: "agent", intent: "do something", contextRefs: [] }
        : { kind: "view", operation, args: {} },
    inputSchema: { type: "object" },
    allowedDataRefs: ["ds_tasks"],
    fixedConstraints: {},
    effectCategory: kind === "agent" ? "local-write" : "read",
    requiresApproval: kind === "agent",
    limits: {},
    bindingDigest: `sha256:${operation}`,
    at: AT,
    knownCapabilities: new Set<string>(),
  });
  if (!compiled.ok) throw new Error(`fixture binding ${operation} did not compile: ${compiled.message}`);
  return compiled.binding;
}

/** An instance with a period, a date and a save action already bound to it. */
function seed(db: Database) {
  const deps = makeDeps(db);
  const instanceId = "winst_seeded";
  const periodBinding = binding(deps, instanceId, "period.change");
  const dateBinding = binding(deps, instanceId, "date.select");
  const saveBinding = binding(deps, instanceId, "view.save");
  const agentBinding = binding(deps, instanceId, "escalate", "agent");

  const captured = captureCompositeSurface(
    { ...deps, newId: (prefix) => (prefix === "winst" ? instanceId : `${prefix}_${(counter += 1)}`) },
    {
      conversationId: "conv_1",
      messageId: "msg_1",
      principalId: "prin_owner" as never,
      definition: OVERVIEW,
      packageDigest: "sha256:overview",
      catalogDigest: "sha256:catalog",
      templateId: "overview",
      templateVersion: "1",
      sections: sections(),
      props: { compositionId: "comp_1" },
      initialState: { period: "week", timezone: TZ },
      provenance: {
        createdAt: AT,
        templateId: "overview",
        templateVersion: "1",
        selector: { mode: "explicit", policyVersion: "1" },
        sourceRevisions: [],
      },
      textAlternative: "An overview for this week.",
      bindings: [
        { binding: periodBinding, sectionId: "filter" },
        { binding: dateBinding, sectionId: "filter" },
        { binding: saveBinding, sectionId: "metrics" },
        { binding: agentBinding, sectionId: "metrics" },
      ],
      at: AT,
    },
  );
  if (!captured.ok) throw new Error(`fixture capture failed: ${captured.message}`);
  return { deps, captured, periodBinding, dateBinding, saveBinding, agentBinding };
}

let db: Database;

beforeEach(() => {
  counter = 0;
  clock = AT;
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  db.prepare(
    "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES ('conv_1', NULL, 'node_local', ?, ?)",
  ).run(AT, AT);
});

describe("live ownership", () => {
  it("refuses a second surface while the first holds the claim, and names the holder", () => {
    const { deps, captured } = seed(db);
    const instanceId = captured.instance.instanceId;

    const first = claimLiveOwner(deps, { instanceId, surface: "inline", ownerToken: "tok_a" });
    expect(first.ok).toBe(true);

    const second = claimLiveOwner(deps, { instanceId, surface: "pin", ownerToken: "tok_b" });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("ALREADY_OWNED");
      expect(second.heldBy.surface).toBe("inline");
      // The token is returned to the server-side caller so it can be compared, and the gateway is
      // what decides not to put it on the wire.
      expect(second.heldBy.ownerToken).toBe("tok_a");
    }

    // The same client re-claiming refreshes rather than conflicts.
    expect(claimLiveOwner(deps, { instanceId, surface: "pin", ownerToken: "tok_a" }).ok).toBe(true);
    expect(liveOwnerOf(deps, instanceId)?.surface).toBe("pin");
  });

  it("recovers a claim whose lease ran out instead of leaving the instance locked", () => {
    const { deps, captured } = seed(db);
    const instanceId = captured.instance.instanceId;

    claimLiveOwner(deps, { instanceId, surface: "inline", ownerToken: "tok_a", leaseMs: 1000 });
    expect(claimLiveOwner(deps, { instanceId, surface: "pin", ownerToken: "tok_b" }).ok).toBe(false);

    // A tab that was killed never sends its release. The lease is what makes that recoverable.
    clock = new Date(new Date(AT).getTime() + 1500).toISOString() as Instant;
    expect(liveOwnerOf(deps, instanceId)).toBeUndefined();
    const recovered = claimLiveOwner(deps, { instanceId, surface: "pin", ownerToken: "tok_b" });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.recoveredFrom).toBe("tok_a");
    expect(sweepExpiredLiveOwners(deps)).toBe(0);
  });

  it("treats a claim written before the lease column existed as recoverable once it is old", () => {
    const { deps, captured } = seed(db);
    const instanceId = captured.instance.instanceId;
    // No expiry recorded, claimed an hour ago: the only honest reading is that the process that
    // wrote it is gone.
    db.prepare(
      "INSERT INTO widget_live_owners (instance_id, owner_token, owner_surface, claimed_at, lease_expires_at) VALUES (?, 'tok_old', 'inline', ?, NULL)",
    ).run(instanceId, new Date(new Date(AT).getTime() - 3_600_000).toISOString());

    expect(liveOwnerOf(deps, instanceId)).toBeDefined();
    const claim = claimLiveOwner(deps, { instanceId, surface: "inline", ownerToken: "tok_new" });
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(claim.recoveredFrom).toBe("tok_old");
  });

  it("refuses a release from a client that does not hold the claim", () => {
    const { deps, captured } = seed(db);
    const instanceId = captured.instance.instanceId;
    claimLiveOwner(deps, { instanceId, surface: "inline", ownerToken: "tok_a" });

    expect(releaseLiveOwner(deps, instanceId, "tok_b")).toBe(false);
    expect(liveOwnerOf(deps, instanceId)?.ownerToken).toBe("tok_a");
    expect(releaseLiveOwner(deps, instanceId, "tok_a")).toBe(true);
    expect(liveOwnerOf(deps, instanceId)).toBeUndefined();
    // A claim can be taken again once it is released, with no recovery notice.
    const claim = claimLiveOwner(deps, { instanceId, surface: "pin", ownerToken: "tok_c" });
    expect(claim.ok).toBe(true);
    if (claim.ok) expect(claim.recoveredFrom).toBeUndefined();
  });

  it("sweeps claims whose lease has expired", () => {
    const { deps, captured } = seed(db);
    const instanceId = captured.instance.instanceId;
    claimLiveOwner(deps, { instanceId, surface: "inline", ownerToken: "tok_a", leaseMs: 500 });
    clock = new Date(new Date(AT).getTime() + 1000).toISOString() as Instant;
    expect(sweepExpiredLiveOwners(deps)).toBe(1);
    expect(liveOwnerOf(deps, instanceId)).toBeUndefined();
  });
});

describe("view actions", () => {
  it("changes the period, bumps the data revision and leaves the previous snapshot readable", () => {
    const { deps, captured, periodBinding } = seed(db);
    const instanceId = captured.instance.instanceId;

    const outcome = invokeMiniAppAction(deps, {
      conversationId: "conv_1",
      principalId: "prin_owner" as never,
      instanceId,
      actionBindingId: periodBinding.actionBindingId,
      expectedRevision: 1,
      expectedBindingDigest: periodBinding.bindingDigest,
      input: { period: "month", timezone: TZ },
      invocationId: "inv_period",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.revision).toBe(2);
    expect(outcome.stateRevision).toBe(1);
    expect(outcome.state.period).toBe("month");

    const instance = db.prepare("SELECT revision, data_revision, presentation_revision FROM widget_instances WHERE instance_id = ?").get(instanceId) as {
      revision: number;
      data_revision: number;
      presentation_revision: number;
    };
    expect(instance.data_revision).toBe(2);
    // A data change is not a presentation change: an unchanged action binding stays valid.
    expect(instance.presentation_revision).toBe(1);

    // The captured bundle is untouched; only its staleness flag moves.
    const bundle = db.prepare("SELECT document FROM presentation_bundles WHERE instance_id = ?").get(instanceId) as { document: string };
    expect(JSON.parse(bundle.document).composition.initialState.period).toBe("week");
    const stale = db.prepare("SELECT stale FROM widget_snapshots WHERE instance_id = ?").get(instanceId) as { stale: number };
    expect(stale.stale).toBe(1);
  });

  it("selects a day as a presentation change", () => {
    const { deps, captured, dateBinding } = seed(db);
    const outcome = invokeMiniAppAction(deps, {
      conversationId: "conv_1",
      principalId: "prin_owner" as never,
      instanceId: captured.instance.instanceId,
      actionBindingId: dateBinding.actionBindingId,
      expectedRevision: 1,
      expectedBindingDigest: dateBinding.bindingDigest,
      input: { date: "2026-09-17" },
      invocationId: "inv_date",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.selectedDate).toBe("2026-09-17");
    const instance = db.prepare("SELECT presentation_revision, data_revision FROM widget_instances WHERE instance_id = ?").get(
      captured.instance.instanceId,
    ) as { presentation_revision: number; data_revision: number };
    expect(instance.presentation_revision).toBe(2);
    expect(instance.data_revision).toBe(1);
  });

  it("saves the view and pins the same instance in one step", () => {
    const { deps, captured, saveBinding, periodBinding } = seed(db);
    const instanceId = captured.instance.instanceId;

    // A state a previous action left behind is part of what gets saved, which is why the save
    // reads the current document instead of writing a fresh one.
    const changed = invokeMiniAppAction(deps, {
      conversationId: "conv_1",
      principalId: "prin_owner" as never,
      instanceId,
      actionBindingId: periodBinding.actionBindingId,
      expectedRevision: 1,
      expectedBindingDigest: periodBinding.bindingDigest,
      input: { period: "month" },
      invocationId: "inv_period_before_save",
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    const saved = invokeMiniAppAction(deps, {
      conversationId: "conv_1",
      principalId: "prin_owner" as never,
      instanceId,
      actionBindingId: saveBinding.actionBindingId,
      expectedRevision: changed.revision,
      expectedBindingDigest: saveBinding.bindingDigest,
      input: { displayMode: "expanded" },
      invocationId: "inv_save",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.pinId).toBeDefined();
    // The saved view is the state that was on screen, not the template's default.
    expect(saved.state.period).toBe("month");

    const pin = db.prepare("SELECT instance_id, display_mode FROM pins WHERE conversation_id = 'conv_1'").get() as {
      instance_id: string;
      display_mode: string;
    };
    // A pin points at the logical instance: saving a view does not create a second one.
    expect(pin.instance_id).toBe(instanceId);
    expect(pin.display_mode).toBe("expanded");

    // Unpinning is a presentation change; the instance, its state and its snapshot survive.
    expect(unpinInstance(deps, { conversationId: "conv_1", pinId: saved.pinId as string })).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM widget_instances WHERE instance_id = ?").get(instanceId)).toEqual({ n: 1 });
    expect(liveStateOf(deps, instanceId)).toBeDefined();
  });

  it("produces one effect for a double click, and refuses the same key with different input", () => {
    const { deps, captured, periodBinding } = seed(db);
    const instanceId = captured.instance.instanceId;
    const request = {
      conversationId: "conv_1",
      principalId: "prin_owner" as never,
      instanceId,
      actionBindingId: periodBinding.actionBindingId,
      expectedRevision: 1,
      expectedBindingDigest: periodBinding.bindingDigest,
      input: { period: "month" as const },
      invocationId: "inv_double",
    };

    const first = invokeMiniAppAction(deps, request);
    expect(first.ok).toBe(true);
    // The second click arrives after the first bumped the revision. Idempotency is checked before
    // the revision, so it returns the first outcome instead of a stale-revision refusal.
    const second = invokeMiniAppAction(deps, request);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(second.revision).toBe(1 + 1);

    const revision = db.prepare("SELECT revision FROM widget_instances WHERE instance_id = ?").get(instanceId) as { revision: number };
    expect(revision.revision).toBe(2);

    const reused = invokeMiniAppAction(deps, { ...request, input: { period: "week" } });
    expect(reused.ok).toBe(false);
    if (reused.ok) return;
    expect(reused.code).toBe("INVOCATION_KEY_REUSED");
  });

  it("refuses a stale revision and a digest that does not match the binding", () => {
    const { deps, captured, periodBinding } = seed(db);
    const stale = invokeMiniAppAction(deps, {
      conversationId: "conv_1",
      principalId: "prin_owner" as never,
      instanceId: captured.instance.instanceId,
      actionBindingId: periodBinding.actionBindingId,
      expectedRevision: 7,
      expectedBindingDigest: periodBinding.bindingDigest,
      input: { period: "month" },
      invocationId: "inv_stale",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("REVISION_MISMATCH");
      expect(stale.currentRevision).toBe(1);
    }

    const wrongDigest = invokeMiniAppAction(deps, {
      conversationId: "conv_1",
      principalId: "prin_owner" as never,
      instanceId: captured.instance.instanceId,
      actionBindingId: periodBinding.actionBindingId,
      expectedRevision: 1,
      expectedBindingDigest: "sha256:not-the-binding",
      input: { period: "month" },
      invocationId: "inv_digest",
    });
    expect(wrongDigest.ok).toBe(false);
    if (!wrongDigest.ok) expect(wrongDigest.code).toBe("BINDING_STALE");
  });

  it("refuses another principal, an unknown binding, and an action that is not a view operation", () => {
    const { deps, captured, periodBinding, agentBinding } = seed(db);
    const instanceId = captured.instance.instanceId;
    const base = {
      conversationId: "conv_1",
      instanceId,
      actionBindingId: periodBinding.actionBindingId,
      expectedRevision: 1,
      expectedBindingDigest: periodBinding.bindingDigest,
      input: { period: "month" as const },
      invocationId: "inv_x",
    };

    const otherPrincipal = invokeMiniAppAction(deps, { ...base, principalId: "prin_other" as never });
    expect(otherPrincipal.ok).toBe(false);
    if (!otherPrincipal.ok) expect(otherPrincipal.code).toBe("NOT_AUTHORIZED");

    const unknown = invokeMiniAppAction(deps, {
      ...base,
      principalId: "prin_owner" as never,
      actionBindingId: "act_missing",
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("ACTION_UNKNOWN");

    const unknownInstance = invokeMiniAppAction(deps, { ...base, principalId: "prin_owner" as never, instanceId: "winst_missing" });
    expect(unknownInstance.ok).toBe(false);
    if (!unknownInstance.ok) expect(unknownInstance.code).toBe("INSTANCE_UNKNOWN");

    // An agent action must go through the approval path, and this is the boundary that says so.
    const agent = invokeMiniAppAction(deps, {
      ...base,
      principalId: "prin_owner" as never,
      actionBindingId: agentBinding.actionBindingId,
      expectedBindingDigest: agentBinding.bindingDigest,
    });
    expect(agent.ok).toBe(false);
    if (!agent.ok) expect(agent.code).toBe("UNSUPPORTED_ACTION");

    // Nothing was written by any of the refusals.
    const revision = db.prepare("SELECT revision FROM widget_instances WHERE instance_id = ?").get(instanceId) as { revision: number };
    expect(revision.revision).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM action_invocations").get()).toEqual({ n: 0 });
  });

  it("refuses input that does not fit the operation", () => {
    const { deps, captured, periodBinding, dateBinding } = seed(db);
    const wrongPeriod = invokeMiniAppAction(deps, {
      conversationId: "conv_1",
      principalId: "prin_owner" as never,
      instanceId: captured.instance.instanceId,
      actionBindingId: periodBinding.actionBindingId,
      expectedRevision: 1,
      expectedBindingDigest: periodBinding.bindingDigest,
      input: { period: "quarter" },
      invocationId: "inv_bad_period",
    });
    expect(wrongPeriod.ok).toBe(false);
    if (!wrongPeriod.ok) expect(wrongPeriod.code).toBe("INVALID_INPUT");

    const wrongDate = invokeMiniAppAction(deps, {
      conversationId: "conv_1",
      principalId: "prin_owner" as never,
      instanceId: captured.instance.instanceId,
      actionBindingId: dateBinding.actionBindingId,
      expectedRevision: 1,
      expectedBindingDigest: dateBinding.bindingDigest,
      input: { date: "17/09/2026" },
      invocationId: "inv_bad_date",
    });
    expect(wrongDate.ok).toBe(false);
    if (!wrongDate.ok) expect(wrongDate.code).toBe("INVALID_INPUT");
  });
});
