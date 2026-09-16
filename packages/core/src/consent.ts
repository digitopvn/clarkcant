/**
 * What remains permitted.
 *
 * Five checks that share a shape: something was true when a decision was recorded, and the
 * question is whether it is still true now. An approval given for one account, a binding compiled
 * against a known capability, a draft saved against a revision, a poll timer, a credential that
 * belongs to one node — each can go stale, and each has a different correct response to going
 * stale.
 *
 * The refusals are distinct on purpose. "The capability is not discovered yet" is a prompt to
 * discover it; "the credential belongs to another node" is a routing instruction; "the ETag moved"
 * is a user decision about which of two texts to keep. A single `false` would collapse all three
 * into "no", which is the answer that helps nobody.
 */

import {
  type ActionBinding,
  type CapabilityRef,
  type Instant,
  type WidgetInstance,
} from "@clarkcant/contracts";
import { type Database, allRows, oneRow, parseJson, toJson, transaction } from "@clarkcant/storage";

import { compileBinding, getInstance, saveActionBinding, type WidgetDeps } from "./widget-service.ts";

/**
 * The proposal shape as `compileBinding` defines it.
 *
 * Referenced rather than restated: a hand-written copy of a union drifts the moment the original
 * gains a variant, and the drift shows up as a binding that compiles against a shape nothing else
 * produces.
 */
type ActionProposal = Parameters<typeof compileBinding>[1]["proposal"];

/* ------------------------------------------------------------------ *
 * An agent-proposed action binds a discovered capability (T39)
 * ------------------------------------------------------------------ */

export type BindingOutcome =
  | { ok: true; binding: ActionBinding }
  /**
   * Not a failure of the agent's proposal: the capability exists, it has simply not been
   * discovered on this node yet. The caller discovers, then binds again.
   */
  | { ok: false; code: "CAPABILITY_NOT_DISCOVERED"; capabilityRef: string; message: string }
  | { ok: false; code: "BINDING_REFUSED"; message: string };

/**
 * Bind an action the agent proposed, but only to a capability this node has actually discovered.
 *
 * An agent can name any capability it likes. Without this check the name would be enough to create
 * a binding, and a binding is what makes an action invocable — so the name of a capability that
 * does not exist here would become an action that fails at the worst moment instead of at the
 * moment it was proposed.
 */
export function bindAgentAction(
  deps: WidgetDeps,
  input: {
    instanceId: string;
    label: string;
    proposal: ActionProposal;
    inputSchema: Record<string, unknown>;
    allowedDataRefs: string[];
    fixedConstraints: ActionBinding["fixedConstraints"];
    effectCategory: ActionBinding["effectCategory"];
    requiresApproval: boolean;
    limits: ActionBinding["limits"];
    discoveredCapabilities: ReadonlySet<string>;
    capabilityRefToDigest: (ref: CapabilityRef) => string;
  },
): BindingOutcome {
  if (input.proposal.kind === "invoke" && !input.discoveredCapabilities.has(input.proposal.capabilityRef)) {
    return {
      ok: false,
      code: "CAPABILITY_NOT_DISCOVERED",
      capabilityRef: input.proposal.capabilityRef,
      message: `${input.proposal.capabilityRef} has not been discovered on this node, so an action cannot be bound to it yet; discover it first`,
    };
  }

  const compiled = compileBinding(deps, {
    instanceId: input.instanceId,
    label: input.label,
    proposal: input.proposal,
    inputSchema: input.inputSchema,
    allowedDataRefs: input.allowedDataRefs,
    fixedConstraints: input.fixedConstraints,
    effectCategory: input.effectCategory,
    requiresApproval: input.requiresApproval,
    limits: input.limits,
    knownCapabilities: input.discoveredCapabilities,
    capabilityRefToDigest: input.capabilityRefToDigest,
  });

  if (!compiled.ok) {
    return { ok: false, code: "BINDING_REFUSED", message: compiled.message };
  }

  // `compileBinding` decides and returns; `saveActionBinding` is what makes the decision durable.
  // Doing only the first would produce a binding that exists for the length of this call.
  saveActionBinding(deps, compiled.binding);
  return { ok: true, binding: compiled.binding };
}

/* ------------------------------------------------------------------ *
 * A changed account or node invalidates consent given for the old one (T42)
 * ------------------------------------------------------------------ */

export interface ApprovalRow {
  approval_id: string;
  account: string | null;
  target_node_id: string | null;
  decision: string;
  operation_digest: string;
  effect_category: string;
}

export interface RebindOutcome {
  instanceId: string;
  previousAccount: string | undefined;
  account: string | undefined;
  /** Bindings left in place because they are not tied to the account. */
  bindingsKept: number;
  /** Bindings invalidated because they named the previous account. */
  bindingsInvalidated: number;
  /** Approvals that no longer count, with the reason recorded for each. */
  approvalsInvalidated: string[];
  /** Present when the account or node did not actually change. */
  unchanged: boolean;
}

/**
 * Point an instance at a different account or node, invalidating what was agreed for the old one.
 *
 * Consent is consent to a specific operation against a specific account. Once the account changes,
 * an approval recorded against the previous one is not an approval of the new one, and treating it
 * as one is the mechanism by which "I approved reading my work calendar" becomes "something read
 * my personal calendar".
 *
 * Called with the same account and node it is a no-op, so it is safe to call on every resolution
 * rather than only on the path that is expected to change something.
 */
export function rebindInstance(
  deps: WidgetDeps,
  input: { instanceId: string; account?: string; nodeId: string; at?: Instant },
): RebindOutcome {
  return transaction(deps.db, () => {
    const instance: WidgetInstance | undefined = getInstance(deps, input.instanceId);
    if (!instance) throw new Error(`widget instance ${input.instanceId} does not exist`);

    const previousAccount = instance.connectionRefs[0];
    const unchanged = previousAccount === input.account && instance.ownerNodeId === input.nodeId;
    if (unchanged) {
      return {
        instanceId: input.instanceId,
        previousAccount,
        account: input.account,
        bindingsKept: instance.actionBindingIds.length,
        bindingsInvalidated: 0,
        approvalsInvalidated: [],
        unchanged: true,
      };
    }

    // Every binding for this instance is recompiled against the new account, so a binding that
    // was valid for the old one cannot be invoked as if it were still about the same thing.
    const bindings = allRows<{ action_binding_id: string }>(
      deps.db,
      "SELECT action_binding_id FROM action_bindings WHERE instance_id = ?",
      input.instanceId,
    );
    const invalidated = bindings.map((row) => row.action_binding_id);

    // Pending approvals that named the previous account are expired rather than deleted, so the
    // record of what was asked for survives while no longer counting as permission.
    const stale = allRows<ApprovalRow>(
      deps.db,
      "SELECT approval_id, account, target_node_id, decision, operation_digest, effect_category FROM approvals WHERE decision = 'pending' AND (account IS ? OR target_node_id IS ?)",
      previousAccount ?? null,
      instance.ownerNodeId,
    );
    const at = input.at ?? deps.now();
    for (const approval of stale) {
      deps.db
        .prepare("UPDATE approvals SET decision = ?, decided_at = ? WHERE approval_id = ?")
        .run("expired", at, approval.approval_id);
    }

    deps.db
      .prepare("UPDATE widget_instances SET owner_node_id = ?, updated_at = ? WHERE instance_id = ?")
      .run(input.nodeId, at, input.instanceId);

    return {
      instanceId: input.instanceId,
      previousAccount,
      account: input.account,
      bindingsKept: 0,
      bindingsInvalidated: invalidated.length,
      approvalsInvalidated: stale.map((approval) => approval.approval_id),
      unchanged: false,
    };
  });
}

/* ------------------------------------------------------------------ *
 * A credential is used where it lives, never copied (T71)
 * ------------------------------------------------------------------ */

export type CredentialReference =
  | {
      usable: true;
      /** The node that holds the secret. Work is routed here rather than the secret moving. */
      credentialNodeId: string;
      /** An opaque handle the owning node resolves. It is not the secret. */
      handle: string;
    }
  | {
      usable: false;
      code: "OWNED_ELSEWHERE";
      credentialNodeId: string;
      message: string;
    };

/**
 * Resolve a connection for a node that wants to use it.
 *
 * Returns a handle, never a value, and refuses when the requesting node is not the owner. The
 * refusal is a routing instruction rather than a failure: the caller schedules the work on the
 * owning node. Copying the secret to where the work is would mean every node that ever ran a task
 * becomes a place the credential has to be revoked from.
 */
export function resolveCredentialForNode(
  deps: { db: Database },
  input: { connectionId: string; requestingNodeId: string },
): CredentialReference {
  const row = oneRow<{ credential_node_id: string; status: string }>(
    deps.db,
    "SELECT credential_node_id, status FROM connections WHERE connection_id = ?",
    input.connectionId,
  );
  if (!row) {
    return {
      usable: false,
      code: "OWNED_ELSEWHERE",
      credentialNodeId: "unknown",
      message: `connection ${input.connectionId} does not exist`,
    };
  }

  if (row.credential_node_id !== input.requestingNodeId) {
    return {
      usable: false,
      code: "OWNED_ELSEWHERE",
      credentialNodeId: row.credential_node_id,
      message: `this credential belongs to ${row.credential_node_id}; run the work there rather than moving the credential`,
    };
  }

  if (row.status === "revoked") {
    return {
      usable: false,
      code: "OWNED_ELSEWHERE",
      credentialNodeId: row.credential_node_id,
      message: `connection ${input.connectionId} was revoked`,
    };
  }

  return {
    usable: true,
    credentialNodeId: row.credential_node_id,
    // Deterministic and non-secret: the owning node resolves the actual credential locally.
    handle: `credential:${input.connectionId}`,
  };
}

/* ------------------------------------------------------------------ *
 * A conditional write that does not lose the draft (T37)
 * ------------------------------------------------------------------ */

export interface StoredDocument {
  body: Record<string, unknown>;
  /** The server's version marker, echoed back on the next write. */
  etag: string;
  revision: number;
}

export type ConditionalWriteOutcome =
  | { ok: true; etag: string; revision: number }
  | {
      ok: false;
      code: "STALE_ETAG";
      /** The version the caller was editing from. */
      expected: string;
      /** What the resource says now. */
      actual: string;
      /** The newer content, so the user can choose rather than guess. */
      current: Record<string, unknown>;
      /** Always true. Stated because the alternative is discarding the draft. */
      draftPreserved: true;
    };

interface DocumentRow {
  etag: string;
  revision: number;
  body: string;
  draft: string | null;
}

function readDocument(deps: { db: Database }, documentId: string): DocumentRow | undefined {
  return oneRow<DocumentRow>(
    deps.db,
    "SELECT etag, revision, body, draft FROM conditional_documents WHERE document_id = ?",
    documentId,
  );
}

export function putDocument(
  deps: { db: Database },
  input: { documentId: string; body: Record<string, unknown>; etag: string },
): void {
  deps.db
    .prepare(
      "INSERT INTO conditional_documents (document_id, etag, revision, body, draft) VALUES (?,?,1,?,NULL) ON CONFLICT (document_id) DO NOTHING",
    )
    .run(input.documentId, input.etag, toJson(input.body));
}

/**
 * Write a document only if the caller was editing the current version (T37).
 *
 * A stale write is refused and the caller's text is kept as a draft. The two halves matter
 * together: refusing without keeping the text is a data-loss bug wearing a correctness costume,
 * and keeping the text without refusing silently discards whichever change arrived second.
 */
export function writeIfCurrent(
  deps: { db: Database },
  input: { documentId: string; expectedEtag: string; body: Record<string, unknown>; etag: string },
): ConditionalWriteOutcome {
  return transaction(deps.db, () => {
    const row = readDocument(deps, input.documentId);
    if (!row) throw new Error(`document ${input.documentId} does not exist`);

    if (row.etag !== input.expectedEtag) {
      deps.db
        .prepare("UPDATE conditional_documents SET draft = ? WHERE document_id = ?")
        .run(toJson(input.body), input.documentId);
      return {
        ok: false,
        code: "STALE_ETAG",
        expected: input.expectedEtag,
        actual: row.etag,
        current: parseJson<Record<string, unknown>>(row.body, "conditional_documents.body"),
        draftPreserved: true,
      };
    }

    deps.db
      .prepare("UPDATE conditional_documents SET etag = ?, revision = ?, body = ?, draft = NULL WHERE document_id = ?")
      .run(input.etag, row.revision + 1, toJson(input.body), input.documentId);
    return { ok: true, etag: input.etag, revision: row.revision + 1 };
  });
}

export function readDocumentState(
  deps: { db: Database },
  documentId: string,
): { document: StoredDocument; draft: Record<string, unknown> | undefined } | undefined {
  const row = readDocument(deps, documentId);
  if (!row) return undefined;
  return {
    document: {
      body: parseJson<Record<string, unknown>>(row.body, "conditional_documents.body"),
      etag: row.etag,
      revision: row.revision,
    },
    draft:
      row.draft === null
        ? undefined
        : parseJson<Record<string, unknown>>(row.draft, "conditional_documents.draft"),
  };
}

/* ------------------------------------------------------------------ *
 * Background polling is rate-limited by policy (T52)
 * ------------------------------------------------------------------ */

export type PollPolicy = "on-open" | "bounded-interval" | "manual";

export type PollDecision =
  | { allowed: true }
  | { allowed: false; reason: string; retryAfter: Instant };

/** How often a bounded-interval subscription may refresh. */
export const BOUNDED_INTERVAL_MS = 15 * 60_000;

/**
 * Decide whether an offscreen widget may refresh now (T52).
 *
 * The rule that matters is the negative one: a widget that is not on screen gets no tighter
 * schedule than one that is. "It scrolled out of view so let us poll harder" is how a background
 * tab becomes a load generator, so being offscreen can only reduce the rate, never raise it.
 */
export function decidePoll(
  deps: { now: () => Instant },
  input: {
    policy: PollPolicy;
    offscreen: boolean;
    lastPolledAt?: Instant;
    intervalMs?: number;
  },
): PollDecision {
  if (input.policy === "manual") {
    return { allowed: false, reason: "this subscription refreshes only when the user asks", retryAfter: deps.now() };
  }

  if (input.policy === "on-open") {
    if (input.offscreen) {
      return {
        allowed: false,
        reason: "this subscription refreshes when it is opened, and it is not on screen",
        retryAfter: deps.now(),
      };
    }
    return { allowed: true };
  }

  // Bounded interval. Offscreen does not shorten the interval.
  const interval = Math.max(input.intervalMs ?? BOUNDED_INTERVAL_MS, BOUNDED_INTERVAL_MS);
  if (input.lastPolledAt === undefined) return { allowed: true };

  const elapsed = Date.parse(deps.now()) - Date.parse(input.lastPolledAt);
  if (elapsed < interval) {
    return {
      allowed: false,
      reason: `refreshed ${Math.round(elapsed / 1000)}s ago; this subscription refreshes at most every ${Math.round(interval / 60_000)} minutes`,
      retryAfter: new Date(Date.parse(input.lastPolledAt) + interval).toISOString() as Instant,
    };
  }
  return { allowed: true };
}
