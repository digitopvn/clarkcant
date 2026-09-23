import {
  type ActionBinding,
  type ActionInvocation,
  type CapabilityRef,
  type CompiledSection,
  type CompositionActionRef,
  type CompositionInitialState,
  type CompositionProvenance,
  type ExecutionPolicyConfig,
  type Instant,
  type PresentationBundle,
  type Principal,
  type SemanticView,
  type StoredPresentationBundle,
  type SurfaceCompositionSpec,
  type WidgetDefinition,
  type WidgetInstance,
  type WidgetSnapshot,
  bindingStillValid,
  checkPresentationBundle,
  checkSurfaceCompositionSpec,
  compileActionBinding,
  nowInstant,
  toCompositionSection,
  widgetInstanceSchema,
  widgetSnapshotSchema,
} from "@clarkcant/contracts";

import {
  type Database,
  asJsonValue,
  insertPresentationBundle,
  insertSurfaceComposition,
  oneRow,
  parseJson,
  payloadDigest,
  toJson,
  transaction,
} from "@clarkcant/storage";

import { decideExecution } from "./execution-policy.ts";

/**
 * Widget and action service.
 *
 * Two invariants are enforced here rather than trusted to the UI:
 *
 * 1. One logical instance per widget. Mounting an instance inline and pinned at
 *    the same time must not produce two live owners, so ownership is recorded on
 *    the instance row and a second "live owner" claim is refused.
 * 2. An action binding is compiled by the host. Widgets and models propose; only
 *    this module can produce a binding, and it refuses anything referencing a
 *    capability the registry does not know about.
 */

export interface WidgetDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
  /**
   * Injected props validator. Optional so this package stays independent of
   * `@clarkcant/widget-host`, but the runtime always supplies one, because storing props
   * that no widget can render is how a timeline becomes unrenderable.
   */
  validateProps?: (
    definition: WidgetDefinition,
    props: Record<string, unknown>,
  ) => { ok: true } | { ok: false; problems: string[] };
}

export function createInstance(
  deps: WidgetDeps,
  input: {
    definition: WidgetDefinition;
    packageDigest: string;
    ownerPrincipalId: Principal["principalId"];
    props: Record<string, unknown>;
    dataRefs?: string[];
    connectionRefs?: string[];
    at?: Instant;
  },
): WidgetInstance {
  const at = input.at ?? deps.now();

  if (deps.validateProps) {
    const validation = deps.validateProps(input.definition, input.props);
    if (!validation.ok) {
      throw new Error(
        `props for ${input.definition.id} do not match its schema: ${validation.problems.join(", ")}`,
      );
    }
  }

  const instance = widgetInstanceSchema.parse({
    instanceId: deps.newId("winst"),
    definitionRef: {
      id: input.definition.id,
      version: input.definition.version,
      packageDigest: input.packageDigest,
    },
    ownerNodeId: deps.nodeId,
    ownerPrincipalId: input.ownerPrincipalId,
    revision: 1,
    presentationRevision: 1,
    dataRevision: 1,
    actionBindingRevision: 1,
    props: input.props,
    dataRefs: input.dataRefs ?? [],
    connectionRefs: input.connectionRefs ?? [],
    actionBindingIds: [],
    lifecycle: "ready",
  });

  deps.db
    .prepare(
      `INSERT INTO widget_instances
         (instance_id, definition_id, definition_version, package_digest, owner_node_id, owner_principal_id,
          revision, presentation_revision, data_revision, action_binding_revision, lifecycle, document, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      instance.instanceId,
      instance.definitionRef.id,
      instance.definitionRef.version,
      instance.definitionRef.packageDigest,
      instance.ownerNodeId,
      instance.ownerPrincipalId,
      instance.revision,
      instance.presentationRevision,
      instance.dataRevision,
      instance.actionBindingRevision,
      instance.lifecycle,
      toJson(instance),
      at,
    );

  return instance;
}

export function getInstance(deps: WidgetDeps, instanceId: string): WidgetInstance | undefined {
  const row = oneRow<{ document: string }>(
    deps.db,
    "SELECT document FROM widget_instances WHERE instance_id = ?",
    instanceId,
  );
  return row === undefined ? undefined : parseJson<WidgetInstance>(row.document, "widget_instances.document");
}

/**
 * Bump only the revision that actually changed.
 *
 * Presentation changes must not invalidate an action binding, while a data change
 * should not force the user to re-approve an unchanged operation. Tracking three
 * revisions separately is what expresses that distinction.
 */
export function bumpRevision(
  deps: WidgetDeps,
  instanceId: string,
  which: "presentation" | "data" | "binding",
  patch: Partial<Pick<WidgetInstance, "props" | "lifecycle" | "needsConnectionRef" | "dataRefs">> = {},
): WidgetInstance {
  return transaction(deps.db, () => {
    const instance = getInstance(deps, instanceId);
    if (!instance) throw new Error(`widget instance ${instanceId} does not exist`);

    const at = deps.now();
    const next: WidgetInstance = {
      ...instance,
      ...patch,
      revision: instance.revision + 1,
      presentationRevision: which === "presentation" ? instance.presentationRevision + 1 : instance.presentationRevision,
      dataRevision: which === "data" ? instance.dataRevision + 1 : instance.dataRevision,
      actionBindingRevision: which === "binding" ? instance.actionBindingRevision + 1 : instance.actionBindingRevision,
    };

    deps.db
      .prepare(
        `UPDATE widget_instances SET
           revision = ?, presentation_revision = ?, data_revision = ?, action_binding_revision = ?,
           lifecycle = ?, document = ?, updated_at = ?
         WHERE instance_id = ?`,
      )
      .run(
        next.revision,
        next.presentationRevision,
        next.dataRevision,
        next.actionBindingRevision,
        next.lifecycle,
        toJson(next),
        at,
        instanceId,
      );

    return next;
  });
}

/* ------------------------------------------------------------------ *
 * Live ownership
 * ------------------------------------------------------------------ */

export interface LiveOwnerClaim {
  instanceId: string;
  /**
   * Where this instance is being presented.
   *
   * `detached` is a third presentation of the *same* instance, not a new one: a widget moved into its own
   * window keeps its state, its subscriptions and its single owner, and the point of listing it here is that
   * the one-owner rule has to hold across surfaces. Without it, detaching would be the way to end up with two
   * live copies of one widget — the failure the lease exists to prevent.
   */
  surface: "inline" | "pin" | "detached";
  ownerToken: string;
  /** How long the claim stays valid without being refreshed. */
  leaseMs?: number;
}

/**
 * Default lease for a live claim.
 *
 * A claim with no expiry is an orphan waiting to happen: a tab that is killed never sends its
 * release, and the instance would then be locked forever. Sixty seconds is long enough that a
 * healthy client refreshes it many times over and short enough that a crashed one is recoverable
 * while the user is still looking at the screen.
 */
export const LIVE_OWNER_LEASE_MS = 60_000;

export type LiveOwnerClaimResult =
  | { ok: true; expiresAt: Instant; recoveredFrom?: string }
  | { ok: false; code: "ALREADY_OWNED"; heldBy: LiveOwnerClaim; expiresAt: Instant | undefined };

/**
 * Claim the single live owner of an instance.
 *
 * Recording this on one row is what makes "pin a widget that is already inline" safe: the second
 * claim is refused with the current owner so the UI can move the surface instead of mounting a
 * duplicate (acceptance test T47), and a claim whose lease has run out is recoverable rather than
 * permanent.
 */
export function claimLiveOwner(deps: WidgetDeps, claim: LiveOwnerClaim): LiveOwnerClaimResult {
  return transaction(deps.db, () => {
    const at = deps.now();
    const expiresAt = new Date(new Date(at).getTime() + (claim.leaseMs ?? LIVE_OWNER_LEASE_MS)).toISOString() as Instant;
    const row = oneRow<{
      owner_token: string | null;
      owner_surface: string | null;
      claimed_at: string | null;
      lease_expires_at: string | null;
    }>(
      deps.db,
      "SELECT owner_token, owner_surface, claimed_at, lease_expires_at FROM widget_live_owners WHERE instance_id = ?",
      claim.instanceId,
    );

    if (row !== undefined && row.owner_token !== null && row.owner_token !== claim.ownerToken) {
      // A row written before the lease column existed has no expiry, so its age is what decides:
      // reading it as "never expires" would leave the instance locked by a process that is gone.
      const window = claim.leaseMs ?? LIVE_OWNER_LEASE_MS;
      const deadline =
        row.lease_expires_at === null
          ? row.claimed_at === null
            ? 0
            : new Date(row.claimed_at).getTime() + window
          : new Date(row.lease_expires_at).getTime();
      if (deadline > new Date(at).getTime()) {
        return {
          ok: false as const,
          code: "ALREADY_OWNED" as const,
          heldBy: {
            instanceId: claim.instanceId,
            surface: (row.owner_surface ?? "inline") as LiveOwnerClaim["surface"],
            ownerToken: row.owner_token,
          },
          expiresAt: row.lease_expires_at === null ? undefined : (row.lease_expires_at as Instant),
        };
      }
      const recovered = row.owner_token;
      deps.db
        .prepare(
          `INSERT INTO widget_live_owners (instance_id, owner_token, owner_surface, claimed_at, lease_expires_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(instance_id) DO UPDATE SET owner_token = excluded.owner_token,
             owner_surface = excluded.owner_surface, claimed_at = excluded.claimed_at,
             lease_expires_at = excluded.lease_expires_at`,
        )
        .run(claim.instanceId, claim.ownerToken, claim.surface, at, expiresAt);
      return { ok: true as const, expiresAt, recoveredFrom: recovered };
    }

    deps.db
      .prepare(
        `INSERT INTO widget_live_owners (instance_id, owner_token, owner_surface, claimed_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET owner_token = excluded.owner_token,
           owner_surface = excluded.owner_surface, claimed_at = excluded.claimed_at,
           lease_expires_at = excluded.lease_expires_at`,
      )
      .run(claim.instanceId, claim.ownerToken, claim.surface, at, expiresAt);

    return { ok: true as const, expiresAt };
  });
}

/**
 * Release a live claim.
 *
 * The token has to match. Without that check any client could release any other client's claim,
 * which turns "one owner" into "whoever asks last".
 */
export function releaseLiveOwner(deps: WidgetDeps, instanceId: string, ownerToken: string): boolean {
  const result = deps.db
    .prepare("DELETE FROM widget_live_owners WHERE instance_id = ? AND owner_token = ?")
    .run(instanceId, ownerToken);
  return Number(result.changes) > 0;
}

/** Read the current claim, treating an expired lease as no claim. */
export function liveOwnerOf(
  deps: WidgetDeps,
  instanceId: string,
): { ownerToken: string; surface: "inline" | "pin" | "detached"; expiresAt?: string } | undefined {
  const row = oneRow<{
    owner_token: string;
    owner_surface: string;
    claimed_at: string;
    lease_expires_at: string | null;
  }>(
    deps.db,
    "SELECT owner_token, owner_surface, claimed_at, lease_expires_at FROM widget_live_owners WHERE instance_id = ?",
    instanceId,
  );
  if (row === undefined) return undefined;
  if (row.lease_expires_at !== null && new Date(row.lease_expires_at).getTime() <= new Date(deps.now()).getTime()) {
    return undefined;
  }
  return {
    ownerToken: row.owner_token,
    surface: row.owner_surface as "inline" | "pin" | "detached",
    ...(row.lease_expires_at === null ? {} : { expiresAt: row.lease_expires_at }),
  };
}

/**
 * Remove claims whose lease has run out.
 *
 * A recovery path rather than a policy: `claimLiveOwner` already treats an expired lease as free,
 * and this makes that visible in the table instead of leaving rows that describe a process which
 * no longer exists.
 */
export function sweepExpiredLiveOwners(deps: WidgetDeps): number {
  const at = deps.now();
  const stale = deps.db
    .prepare(
      `SELECT COUNT(*) AS n FROM widget_live_owners
        WHERE (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           OR (lease_expires_at IS NULL AND claimed_at <= ?)`,
    )
    .get(at, new Date(new Date(at).getTime() - LIVE_OWNER_LEASE_MS).toISOString()) as { n: number };
  const result = deps.db
    .prepare(
      `DELETE FROM widget_live_owners
        WHERE (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           OR (lease_expires_at IS NULL AND claimed_at <= ?)`,
    )
    .run(at, new Date(new Date(at).getTime() - LIVE_OWNER_LEASE_MS).toISOString());
  void stale;
  return Number(result.changes);
}

/* ------------------------------------------------------------------ *
 * Snapshots
 * ------------------------------------------------------------------ */

export function captureSnapshot(
  deps: WidgetDeps,
  input: { messageId: string; instance: WidgetInstance; textAlternative: string; presentationRef: string },
): WidgetSnapshot {
  const snapshot: WidgetSnapshot = {
    snapshotId: deps.newId("wsnap") as WidgetSnapshot["snapshotId"],
    instanceId: input.instance.instanceId,
    messageId: input.messageId as WidgetSnapshot["messageId"],
    capturedRevision: input.instance.revision,
    capturedAt: deps.now(),
    textAlternative: input.textAlternative,
    presentationRef: input.presentationRef,
    stale: false,
  };

  deps.db
    .prepare(
      `INSERT INTO widget_snapshots
         (snapshot_id, instance_id, message_id, captured_revision, captured_at, stale, document)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      snapshot.snapshotId,
      snapshot.instanceId ?? null,
      snapshot.messageId,
      snapshot.capturedRevision,
      snapshot.capturedAt,
      0,
      toJson(snapshot),
    );

  return snapshot;
}

/* ------------------------------------------------------------------ *
 * Composed surfaces
 * ------------------------------------------------------------------ */

/**
 * A binding with the section it belongs to.
 *
 * The pairing is supplied by the compiler rather than inferred from the binding, because a
 * binding's proposal legitimately does not say which part of the layout drew the button.
 */
export interface SectionBinding {
  binding: ActionBinding;
  sectionId: string;
}

export interface CompositeCaptureInput {
  conversationId: string;
  messageId: string;
  principalId: Principal["principalId"];
  /**
   * The instance id, when the caller already knows it.
   *
   * A compiler that compiles action bindings before it persists the instance has to name the
   * instance those bindings belong to, and a binding whose `instanceId` does not match the instance
   * it is stored against is refused at invocation time. Allocating it here instead would leave the
   * caller unable to produce a consistent pair.
   */
  instanceId?: string;
  /**
   * The composition id, when the caller already knows it.
   *
   * Same reason as `instanceId`: the container's props name the composition, so a spec whose props
   * say one id while the row holds another is a surface that cannot find its own layout.
   */
  compositionId?: string;
  /** The container definition (`canvas.overview@1`), not a leaf. */
  definition: WidgetDefinition;
  packageDigest: string;
  catalogDigest: string;
  templateId: string;
  templateVersion: string;
  sections: readonly CompiledSection[];
  /** Container props. The leaf regions live in the spec, not here. */
  props: Record<string, unknown>;
  initialState: CompositionInitialState;
  provenance: CompositionProvenance;
  textAlternative: string;
  dataRefs?: string[];
  bindings?: readonly SectionBinding[];
  /** Definitions the host catalog holds, keyed `id@version`. Used to check pinned digests. */
  knownDefinitions?: ReadonlyMap<string, string>;
  allowedDataRefs?: ReadonlySet<string>;
  maxSpecBytes?: number;
  maxBundleBytes?: number;
  at?: Instant;
}

export type CompositeCaptureResult =
  | {
      ok: true;
      instance: WidgetInstance;
      snapshot: WidgetSnapshot;
      composition: SurfaceCompositionSpec;
      bundle: StoredPresentationBundle;
    }
  | {
      ok: false;
      code: "SPEC_INVALID" | "BUNDLE_TOO_LARGE" | "PROPS_INVALID" | "OWNERSHIP_MISMATCH";
      message: string;
      problems?: string[];
    };

/**
 * Write a composed surface: instance, spec, bindings, snapshot and bundle, in one transaction.
 *
 * This is the only place a `canvas.overview@1` instance is created, and the ordering is the
 * point. A half-written composition is worse than a refused one: an instance with no spec
 * renders as an empty card, a snapshot with no bundle looks like a snapshot but silently shows
 * current data, and a message referencing either cannot be repaired by a retry because the
 * message has already been appended. So every row goes in together, or none of them do.
 *
 * Validation happens *before* the transaction opens. A refusal has to be cheap, and a
 * transaction that exists only to be rolled back still takes the write lock.
 */
export function captureCompositeSurface(
  deps: WidgetDeps,
  input: CompositeCaptureInput,
): CompositeCaptureResult {
  if (deps.validateProps) {
    const validation = deps.validateProps(input.definition, input.props);
    if (!validation.ok) {
      return {
        ok: false,
        code: "PROPS_INVALID",
        message: `props for ${input.definition.id} do not match its schema`,
        problems: validation.problems,
      };
    }
  }

  const bindings = input.bindings ?? [];
  for (const { binding, sectionId } of bindings) {
    if (input.instanceId !== undefined && binding.instanceId !== input.instanceId) {
      return {
        ok: false,
        code: "OWNERSHIP_MISMATCH",
        message: `action binding ${binding.actionBindingId} belongs to instance ${binding.instanceId}, not ${input.instanceId}`,
      };
    }
    if (binding.definitionId !== input.definition.id) {
      return {
        ok: false,
        code: "OWNERSHIP_MISMATCH",
        message: `action binding ${binding.actionBindingId} belongs to ${binding.definitionId}, not ${input.definition.id}`,
      };
    }
    if (!input.sections.some((section) => section.sectionId === sectionId)) {
      return {
        ok: false,
        code: "SPEC_INVALID",
        message: `action binding ${binding.actionBindingId} is attached to unknown section ${sectionId}`,
      };
    }
  }

  const at = input.at ?? deps.now();
  const instanceId = input.instanceId ?? deps.newId("winst");
  const compositionId = input.compositionId ?? deps.newId("comp");
  const snapshotId = deps.newId("wsnap");
  const bundleId = deps.newId("bundle");

  const actions: CompositionActionRef[] = bindings.map(({ binding, sectionId }) => ({
    actionBindingId: binding.actionBindingId,
    sectionId,
    label: binding.label,
    kind: binding.proposal.kind,
    effectCategory: binding.effectCategory,
  }));

  const composition: SurfaceCompositionSpec = {
    schemaVersion: 1,
    compositionId,
    instanceId,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    catalogDigest: input.catalogDigest,
    sections: input.sections.map(toCompositionSection),
    initialState: input.initialState,
    actions,
    provenance: input.provenance,
  };

  const specCheck = checkSurfaceCompositionSpec(composition, {
    ...(input.knownDefinitions === undefined ? {} : { knownDefinitions: input.knownDefinitions }),
    ...(input.allowedDataRefs === undefined ? {} : { allowedDataRefs: input.allowedDataRefs }),
    knownActionBindingIds: new Set(bindings.map(({ binding }) => binding.actionBindingId)),
    ...(input.maxSpecBytes === undefined ? {} : { maxBytes: input.maxSpecBytes }),
  });
  if (!specCheck.ok) {
    return {
      ok: false,
      code: "SPEC_INVALID",
      message: "the composition spec failed validation",
      problems: specCheck.problems,
    };
  }

  const bundle: PresentationBundle = {
    schemaVersion: 1,
    bundleId,
    snapshotId,
    messageId: input.messageId,
    instanceId,
    ownerPrincipalId: input.principalId,
    catalogDigest: input.catalogDigest,
    capturedAt: at,
    composition,
    sections: [...input.sections],
    sourceRevisions: input.provenance.sourceRevisions,
  };

  const bundleCheck = checkPresentationBundle(bundle, {
    ...(input.knownDefinitions === undefined ? {} : { knownDefinitions: input.knownDefinitions }),
    ...(input.maxBundleBytes === undefined ? {} : { maxBytes: input.maxBundleBytes }),
  });
  if (!bundleCheck.ok) {
    // Too large is a refusal, not a trim. A silently truncated bundle would look complete and
    // show something the user never saw.
    return {
      ok: false,
      code: "BUNDLE_TOO_LARGE",
      message: "the presentation bundle exceeded its ceiling",
      problems: bundleCheck.problems,
    };
  }

  const instance: WidgetInstance = widgetInstanceSchema.parse({
    instanceId,
    definitionRef: {
      id: input.definition.id,
      version: input.definition.version,
      packageDigest: input.packageDigest,
    },
    ownerNodeId: deps.nodeId,
    ownerPrincipalId: input.principalId,
    revision: 1,
    presentationRevision: 1,
    dataRevision: 1,
    actionBindingRevision: 1,
    props: input.props,
    dataRefs: input.dataRefs ?? [],
    connectionRefs: [],
    actionBindingIds: bindings.map(({ binding }) => binding.actionBindingId),
    lifecycle: "ready",
  });

  const snapshot: WidgetSnapshot = widgetSnapshotSchema.parse({
    snapshotId,
    instanceId,
    messageId: input.messageId,
    capturedRevision: instance.revision,
    capturedAt: at,
    textAlternative:
      input.textAlternative.trim() === "" ? input.definition.textFallback : input.textAlternative,
    presentationRef: `catalog:${input.definition.id}`,
    bundleRef: bundleId,
    bundleSchemaVersion: 1,
    catalogDigest: input.catalogDigest,
    stale: false,
  });

  const storedBundle: StoredPresentationBundle = { ...bundle, byteSize: bundleCheck.byteSize };

  transaction(deps.db, () => {
    deps.db
      .prepare(
        `INSERT INTO widget_instances
           (instance_id, definition_id, definition_version, package_digest, owner_node_id, owner_principal_id,
            revision, presentation_revision, data_revision, action_binding_revision, lifecycle, document, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        instance.instanceId,
        instance.definitionRef.id,
        instance.definitionRef.version,
        instance.definitionRef.packageDigest,
        instance.ownerNodeId,
        instance.ownerPrincipalId,
        instance.revision,
        instance.presentationRevision,
        instance.dataRevision,
        instance.actionBindingRevision,
        instance.lifecycle,
        toJson(instance),
        at,
      );

    for (const { binding } of bindings) {
      deps.db
        .prepare(
          `INSERT INTO action_bindings
             (action_binding_id, instance_id, definition_id, package_generation, binding_digest,
              effect_category, requires_approval, document, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          binding.actionBindingId,
          instanceId,
          binding.definitionId,
          binding.packageGeneration,
          binding.bindingDigest,
          binding.effectCategory,
          binding.requiresApproval ? 1 : 0,
          toJson(binding),
          binding.createdAt,
        );
    }

    deps.db
      .prepare(
        `INSERT INTO widget_snapshots
           (snapshot_id, instance_id, message_id, captured_revision, captured_at, stale, document)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.snapshotId,
        instanceId,
        snapshot.messageId,
        snapshot.capturedRevision,
        snapshot.capturedAt,
        0,
        toJson(snapshot),
      );

    insertSurfaceComposition(deps.db, {
      composition,
      ownerPrincipalId: input.principalId,
      messageId: input.messageId,
      conversationId: input.conversationId,
      at,
    });

    insertPresentationBundle(deps.db, storedBundle);
  });

  return { ok: true, instance, snapshot, composition, bundle: storedBundle };
}

/**
 * Mark snapshots behind the instance's current revision as stale.
 *
 * History must keep showing what the user actually saw, labelled as superseded,
 * rather than being rewritten to look like current data.
 */
export function markSnapshotsStale(deps: WidgetDeps, instanceId: string): number {
  const instance = getInstance(deps, instanceId);
  if (!instance) return 0;
  const result = deps.db
    .prepare("UPDATE widget_snapshots SET stale = 1 WHERE instance_id = ? AND captured_revision < ?")
    .run(instanceId, instance.revision);
  return Number(result.changes);
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export function saveActionBinding(deps: WidgetDeps, binding: ActionBinding): void {
  transaction(deps.db, () => {
    deps.db
      .prepare(
        `INSERT INTO action_bindings
           (action_binding_id, instance_id, definition_id, package_generation, binding_digest, effect_category, requires_approval, document, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(action_binding_id) DO UPDATE SET
           package_generation = excluded.package_generation,
           binding_digest = excluded.binding_digest,
           document = excluded.document`,
      )
      .run(
        binding.actionBindingId,
        binding.instanceId,
        binding.definitionId,
        binding.packageGeneration,
        binding.bindingDigest,
        binding.effectCategory,
        binding.requiresApproval ? 1 : 0,
        toJson(binding),
        binding.createdAt,
      );

    const instance = getInstance(deps, binding.instanceId);
    if (instance && !instance.actionBindingIds.includes(binding.actionBindingId)) {
      const next: WidgetInstance = {
        ...instance,
        actionBindingIds: [...instance.actionBindingIds, binding.actionBindingId],
      };
      deps.db
        .prepare("UPDATE widget_instances SET document = ? WHERE instance_id = ?")
        .run(toJson(next), binding.instanceId);
    }
  });
}

export function getActionBinding(deps: WidgetDeps, bindingId: string): ActionBinding | undefined {
  const row = oneRow<{ document: string }>(
    deps.db,
    "SELECT document FROM action_bindings WHERE action_binding_id = ?",
    bindingId,
  );
  return row === undefined ? undefined : parseJson<ActionBinding>(row.document, "action_bindings.document");
}

export type InvocationPrecheck =
  | { ok: true; binding: ActionBinding }
  | {
      ok: false;
      code:
        | "WIDGET_ACTION_UNKNOWN"
        | "WIDGET_INSTANCE_UNKNOWN"
        | "REVISION_MISMATCH"
        | "BINDING_STALE";
      message: string;
    };

/**
 * Validate an invocation before anything executes.
 *
 * The client sends the revision and binding digest it displayed. Comparing both
 * means a click on a stale view cannot be applied to a target the user never saw,
 * and an account or generation change invalidates the binding rather than
 * silently retargeting the action.
 */
export function precheckInvocation(deps: WidgetDeps, invocation: ActionInvocation): InvocationPrecheck {
  const instance = getInstance(deps, invocation.instanceId);
  if (!instance) {
    return {
      ok: false,
      code: "WIDGET_INSTANCE_UNKNOWN",
      message: `widget instance ${invocation.instanceId} does not exist`,
    };
  }

  const binding = getActionBinding(deps, invocation.actionBindingId);
  if (!binding) {
    return {
      ok: false,
      code: "WIDGET_ACTION_UNKNOWN",
      message: `action binding ${invocation.actionBindingId} does not exist`,
    };
  }

  if (binding.instanceId !== instance.instanceId) {
    return {
      ok: false,
      code: "WIDGET_ACTION_UNKNOWN",
      message: "the action binding belongs to a different instance",
    };
  }

  if (invocation.expectedRevision !== instance.revision) {
    return {
      ok: false,
      code: "REVISION_MISMATCH",
      message: `invocation expected revision ${invocation.expectedRevision} but the instance is at ${instance.revision}; re-read before acting`,
    };
  }

  const validity = bindingStillValid(binding, {
    packageGeneration: binding.packageGeneration,
    bindingDigest: invocation.expectedBindingDigest,
  });
  if (!validity.valid) {
    return {
      ok: false,
      code: "BINDING_STALE",
      message: `the action binding changed (${validity.changed.join(", ")}); it must be recompiled before use`,
    };
  }

  return { ok: true, binding };
}

/** Compile an action proposal, refusing to bind capability names that do not exist. */
export function compileBinding(
  deps: WidgetDeps,
  input: {
    instanceId: string;
    label: string;
    proposal: Parameters<typeof compileActionBinding>[0]["proposal"];
    inputSchema: Record<string, unknown>;
    allowedDataRefs: string[];
    fixedConstraints: ActionBinding["fixedConstraints"];
    effectCategory: ActionBinding["effectCategory"];
    requiresApproval: boolean;
    limits: ActionBinding["limits"];
    knownCapabilities: ReadonlySet<string>;
    capabilityRefToDigest: (ref: CapabilityRef) => string;
  },
): { ok: true; binding: ActionBinding } | { ok: false; code: string; message: string } {
  const instance = getInstance(deps, input.instanceId);
  if (!instance) {
    return { ok: false, code: "WIDGET_INSTANCE_UNKNOWN", message: `widget instance ${input.instanceId} does not exist` };
  }

  // The digest covers the proposal plus the fixed constraints, so a change to
  // either invalidates a prior approval.
  const digestSource =
    input.proposal.kind === "invoke"
      ? input.capabilityRefToDigest(input.proposal.capabilityRef)
      : JSON.stringify(input.proposal);
  const bindingDigest = `${digestSource}:${JSON.stringify(input.fixedConstraints)}`;

  return compileActionBinding({
    bindingId: deps.newId("act"),
    instance,
    packageGeneration: instance.definitionRef.packageDigest,
    label: input.label,
    proposal: input.proposal,
    inputSchema: input.inputSchema,
    allowedDataRefs: input.allowedDataRefs,
    fixedConstraints: input.fixedConstraints,
    effectCategory: input.effectCategory,
    requiresApproval: input.requiresApproval,
    limits: input.limits,
    bindingDigest,
    at: deps.now(),
    knownCapabilities: input.knownCapabilities,
  }) as { ok: true; binding: ActionBinding } | { ok: false; code: string; message: string };
}

/**
 * Build the semantic view of an instance.
 *
 * Voice and the accessibility tree consume the same object, which is how a
 * spoken instruction and a click end up at the same action state rather than
 * diverging (acceptance test T66).
 */
export function semanticViewOf(deps: WidgetDeps, instanceId: string, freshness: SemanticView["dataFreshness"]): SemanticView | undefined {
  const instance = getInstance(deps, instanceId);
  if (!instance) return undefined;

  const bindings = instance.actionBindingIds
    .map((id) => getActionBinding(deps, id))
    .filter((binding): binding is ActionBinding => binding !== undefined);

  return {
    instanceId: instance.instanceId,
    summary: `widget ${instance.definitionRef.id} v${instance.definitionRef.version} (${instance.lifecycle})`,
    selectedIds: [],
    availableActions: bindings.map((binding) => ({
      actionBindingId: binding.actionBindingId,
      label: binding.label,
      requiresApproval: binding.requiresApproval,
    })),
    textRepresentation: `${instance.definitionRef.id} with ${bindings.length} available action(s)`,
    dataFreshness: freshness,
  };
}

export { nowInstant };

/* ------------------------------------------------------------------ *
 * Pins
 * ------------------------------------------------------------------ */

export type PinResult =
  | { ok: true; pinId: string }
  | { ok: false; code: "WIDGET_INSTANCE_UNKNOWN" | "PIN_LIMIT_REACHED" | "ALREADY_PINNED"; message: string };

/**
 * Pin an instance into the conversation.
 *
 * Pinning is a presentation preference and nothing more. It creates no task, no
 * subscription and no grant — the blueprint is explicit that a pin must not start work or
 * turn on a device, and the only thing this writes is a reference plus a display mode.
 *
 * The pin limit exists so a conversation cannot accumulate unbounded live surfaces, which
 * is what a widget with a background subscription would otherwise cost.
 */
export function pinInstance(
  deps: WidgetDeps,
  input: {
    conversationId: string;
    instanceId: string;
    displayMode: "compact" | "expanded";
    refreshPolicy?: "on-open" | "bounded-interval" | "manual";
    maxPins?: number;
  },
): PinResult {
  const instance = getInstance(deps, input.instanceId);
  if (!instance) {
    return {
      ok: false,
      code: "WIDGET_INSTANCE_UNKNOWN",
      message: `widget instance ${input.instanceId} does not exist`,
    };
  }

  return transaction(deps.db, () => {
    const existing = deps.db
      .prepare("SELECT pin_id FROM pins WHERE conversation_id = ? AND instance_id = ?")
      .get(input.conversationId, input.instanceId) as { pin_id: string } | undefined;
    if (existing) {
      return {
        ok: false as const,
        code: "ALREADY_PINNED" as const,
        message: `instance ${input.instanceId} is already pinned as ${existing.pin_id}`,
      };
    }

    const count = deps.db
      .prepare("SELECT COUNT(*) AS n FROM pins WHERE conversation_id = ?")
      .get(input.conversationId) as { n: number };
    const max = input.maxPins ?? 8;
    if (Number(count.n) >= max) {
      return {
        ok: false as const,
        code: "PIN_LIMIT_REACHED" as const,
        message: `this conversation already holds ${max} pins; unpin one before adding another`,
      };
    }

    const position = Number(count.n);
    const pinId = deps.newId("pin");
    deps.db
      .prepare(
        `INSERT INTO pins (pin_id, conversation_id, instance_id, display_mode, position, refresh_policy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pinId,
        input.conversationId,
        input.instanceId,
        input.displayMode,
        position,
        // Default is on-open. A background refresh needs a standing grant, and inventing
        // one here would give a pin privileges the user never approved.
        input.refreshPolicy ?? "on-open",
        deps.now(),
      );

    return { ok: true as const, pinId };
  });
}

/**
 * Remove a pin.
 *
 * Data survives. Unpinning a note must not delete the note, and unpinning a player must
 * not cancel a remote job — those are separate operations with separate confirmations.
 */
export function unpinInstance(deps: WidgetDeps, input: { conversationId: string; pinId: string }): boolean {
  const result = deps.db
    .prepare("DELETE FROM pins WHERE pin_id = ? AND conversation_id = ?")
    .run(input.pinId, input.conversationId);
  return Number(result.changes) > 0;
}

export interface PinSummary {
  pinId: string;
  instanceId: string;
  displayMode: "compact" | "expanded";
  position: number;
  refreshPolicy: "on-open" | "bounded-interval" | "manual";
}

export function listPinsForConversation(deps: WidgetDeps, conversationId: string): PinSummary[] {
  // Mapped explicitly rather than cast: the columns are snake_case, so a cast would
  // silently hand back undefined for every camelCase field.
  const rows = deps.db
    .prepare(
      "SELECT pin_id, instance_id, display_mode, position, refresh_policy FROM pins WHERE conversation_id = ? ORDER BY position",
    )
    .all(conversationId) as {
    pin_id: string;
    instance_id: string;
    display_mode: string;
    position: number;
    refresh_policy: string;
  }[];

  return rows.map((row) => ({
    pinId: row.pin_id,
    instanceId: row.instance_id,
    displayMode: row.display_mode as PinSummary["displayMode"],
    position: Number(row.position),
    refreshPolicy: row.refresh_policy as PinSummary["refreshPolicy"],
  }));
}

/* ------------------------------------------------------------------ *
 * Mini-app view actions
 * ------------------------------------------------------------------ */

/**
 * The operations an M1 composed surface may perform.
 *
 * Closed on purpose. Filtering a view, selecting a day and saving the result are view operations:
 * they change what is displayed and nothing else. Anything that would cause an effect — an
 * `invoke`, an `agent` intent, a workflow — goes through the approval path instead, and a binding
 * that proposes one is refused here rather than quietly executed.
 */
export const M1_VIEW_OPERATIONS = ["period.change", "date.select", "view.save"] as const;

/** Bumped when a filter changes the range, because the underlying rows are re-read. */
const OPERATION_BUMP: Record<string, "presentation" | "data"> = {
  "period.change": "data",
  "date.select": "presentation",
  "view.save": "presentation",
};

export interface MiniAppActionRequest extends ActionInvocation {
  conversationId: string;
  principalId: Principal["principalId"];
  /**
   * The execution policy in force, when the caller can read it.
   *
   * Supplied by the transport rather than read here, because this package takes no dependency on the
   * preference store. Absent keeps the behaviour that existed before the modes did: an effect action is
   * refused as needing the approval path.
   */
  policy?: ExecutionPolicyConfig;
}

export type MiniAppActionCode =
  | "INSTANCE_UNKNOWN"
  | "NOT_AUTHORIZED"
  | "ACTION_UNKNOWN"
  | "UNSUPPORTED_ACTION"
  | "INVALID_INPUT"
  | "REVISION_MISMATCH"
  | "BINDING_STALE"
  | "INVOCATION_KEY_REUSED"
  | "STATE_CONFLICT"
  /** Refused by the user's own execution policy, which no mode and no rule may override. */
  | "POLICY_REFUSED";

export type MiniAppActionOutcome =
  | {
      ok: true;
      /** True when this was the same invocation arriving twice rather than a second effect. */
      duplicate: boolean;
      instanceId: string;
      revision: number;
      stateRevision: number;
      state: Record<string, unknown>;
      pinId?: string;
    }
  | { ok: false; code: MiniAppActionCode; message: string; currentRevision?: number };

interface ActionRecord {
  digest: string;
  result: { pinId?: string; revision: number; stateRevision: number; state: Record<string, unknown> };
}

function readActionRecord(db: Database, invocationId: string): ActionRecord | undefined {
  const row = oneRow<{ outcome: string }>(
    db,
    "SELECT outcome FROM action_invocations WHERE invocation_id = ?",
    invocationId,
  );
  if (row === undefined) return undefined;
  try {
    const parsed = JSON.parse(row.outcome) as ActionRecord;
    return typeof parsed?.digest === "string" ? parsed : undefined;
  } catch {
    // A row written by an older path holds a plain string. It is treated as an unknown record
    // rather than as a match, so a reused key still cannot silently satisfy a new request.
    return undefined;
  }
}

/**
 * Invoke a bound view action.
 *
 * The order of the checks is the whole design:
 *
 * 1. **Idempotency first.** A duplicate arrives *after* the first call bumped the revision, so a
 *    revision check placed before this would refuse the retry as stale instead of returning the
 *    outcome it already produced (T43).
 * 2. **Authorization.** The principal on the instance, not the one in the request body.
 * 3. **Binding shape.** Only view operations reach the write path.
 * 4. **Revision and digest.** A click on a view the user never saw is refused rather than applied
 *    to a target they did not look at.
 *
 * Everything that changes state then happens in one transaction: the state row, the instance
 * revision, the staleness of older snapshots, and — for a save — the pin. A crash between those
 * writes would leave a surface whose revision says one thing and whose state says another.
 */
export function invokeMiniAppAction(deps: WidgetDeps, request: MiniAppActionRequest): MiniAppActionOutcome {
  const instance = getInstance(deps, request.instanceId);
  if (instance === undefined) {
    return { ok: false, code: "INSTANCE_UNKNOWN", message: `widget instance ${request.instanceId} does not exist` };
  }
  if (instance.ownerPrincipalId !== request.principalId) {
    return {
      ok: false,
      code: "NOT_AUTHORIZED",
      message: "this instance belongs to another principal",
    };
  }

  const binding = getActionBinding(deps, request.actionBindingId);
  if (binding === undefined || binding.instanceId !== instance.instanceId) {
    return {
      ok: false,
      code: "ACTION_UNKNOWN",
      message: `action binding ${request.actionBindingId} is not on this instance`,
    };
  }
  if (binding.proposal.kind !== "view") {
    /*
     * Whether this needs an approval is the policy's decision, not a flag frozen when the binding was
     * registered. An action invoked from a surface is the user acting — the click or the spoken request is
     * the instruction — which is what the risk gate reads.
     */
    const decision =
      request.policy === undefined
        ? undefined
        : decideExecution({
            policy: request.policy,
            explicitUserIntent: true,
            action: {
              kind: "effect",
              category: binding.effectCategory,
              // Bound to the binding digest the caller was shown, so a card could not cover a different one.
              operationDigest: request.expectedBindingDigest,
            },
          });

    if (decision?.kind === "deny") {
      return { ok: false, code: "POLICY_REFUSED", message: decision.reason };
    }

    return {
      ok: false,
      code: "UNSUPPORTED_ACTION",
      // Which of the two refusals this is, said plainly: a policy that allows an action this node cannot
      // perform yet is a missing executor, not a permission problem, and the two need different fixes.
      message:
        decision?.kind === "execute"
          ? `the execution policy allows this ${binding.proposal.kind} action, but this node has no executor for it yet`
          : `a ${binding.proposal.kind} action needs the approval path; the M1 surface only performs view operations`,
    };
  }
  const operation = binding.proposal.operation;
  if (!(M1_VIEW_OPERATIONS as readonly string[]).includes(operation)) {
    return {
      ok: false,
      code: "UNSUPPORTED_ACTION",
      message: `"${operation}" is not one of the view operations a surface may perform`,
    };
  }

  const digest = payloadDigest(
    asJsonValue({
      instanceId: request.instanceId,
      actionBindingId: request.actionBindingId,
      expectedRevision: request.expectedRevision,
      expectedBindingDigest: request.expectedBindingDigest,
      input: request.input,
    }),
  );

  const prior = readActionRecord(deps.db, request.invocationId);
  if (prior !== undefined) {
    if (prior.digest !== digest) {
      return {
        ok: false,
        code: "INVOCATION_KEY_REUSED",
        message:
          "the same invocation id was reused with different input; use a new id for a new operation",
      };
    }
    return {
      ok: true,
      duplicate: true,
      instanceId: instance.instanceId,
      revision: prior.result.revision,
      stateRevision: prior.result.stateRevision,
      state: prior.result.state,
      ...(prior.result.pinId === undefined ? {} : { pinId: prior.result.pinId }),
    };
  }

  const validation = validateViewInput(operation, request.input);
  if (!validation.ok) return { ok: false, code: "INVALID_INPUT", message: validation.message };

  const precheck = precheckInvocation(deps, request);
  if (!precheck.ok) {
    const code: MiniAppActionCode = precheck.code === "REVISION_MISMATCH" ? "REVISION_MISMATCH" : "BINDING_STALE";
    return {
      ok: false,
      code,
      message: precheck.message,
      currentRevision: instance.revision,
    };
  }

  const bump = OPERATION_BUMP[operation] ?? "presentation";
  const saveRequested = operation === "view.save";

  return transaction(deps.db, () => {
    const at = deps.now();
    const current = readWidgetStateRow(deps.db, instance.instanceId);
    const body: Record<string, unknown> = { ...(current?.body ?? {}), ...validation.patch };
    const stateRevision = (current?.revision ?? 0) + 1;

    if (current === undefined) {
      deps.db
        .prepare(
          `INSERT INTO widget_state
             (instance_id, state_version, state_revision, document, draft, draft_revision, draft_saved_at, updated_at)
           VALUES (?, 1, ?, ?, NULL, NULL, NULL, ?)`,
        )
        .run(instance.instanceId, stateRevision, toJson(body), at);
    } else {
      deps.db
        .prepare("UPDATE widget_state SET state_revision = ?, document = ?, updated_at = ? WHERE instance_id = ?")
        .run(stateRevision, toJson(body), at, instance.instanceId);
    }

    const next: WidgetInstance = {
      ...instance,
      revision: instance.revision + 1,
      presentationRevision: bump === "presentation" ? instance.presentationRevision + 1 : instance.presentationRevision,
      dataRevision: bump === "data" ? instance.dataRevision + 1 : instance.dataRevision,
      ...(saveRequested ? { stateRef: `widget_state:${instance.instanceId}` } : {}),
    };
    deps.db
      .prepare(
        `UPDATE widget_instances SET revision = ?, presentation_revision = ?, data_revision = ?,
           lifecycle = ?, document = ?, updated_at = ?
         WHERE instance_id = ?`,
      )
      .run(
        next.revision,
        next.presentationRevision,
        next.dataRevision,
        next.lifecycle,
        toJson(next),
        at,
        instance.instanceId,
      );

    // History keeps its own captured values; what changes is that they are now labelled as
    // superseded rather than silently presented as current.
    deps.db
      .prepare("UPDATE widget_snapshots SET stale = 1 WHERE instance_id = ? AND captured_revision < ?")
      .run(instance.instanceId, next.revision);

    let pinId: string | undefined;
    if (saveRequested) {
      const existing = deps.db
        .prepare("SELECT pin_id FROM pins WHERE conversation_id = ? AND instance_id = ?")
        .get(request.conversationId, instance.instanceId) as { pin_id: string } | undefined;
      if (existing !== undefined) {
        // Saving a view that is already pinned is a success, not a conflict: the user asked for
        // the view to be saved and pinned, and it is.
        pinId = existing.pin_id;
      } else {
        const position = Number(
          (
            deps.db
              .prepare("SELECT COUNT(*) AS n FROM pins WHERE conversation_id = ?")
              .get(request.conversationId) as { n: number }
          ).n,
        );
        pinId = deps.newId("pin");
        deps.db
          .prepare(
            `INSERT INTO pins (pin_id, conversation_id, instance_id, display_mode, position, refresh_policy, created_at)
             VALUES (?, ?, ?, ?, ?, 'on-open', ?)`,
          )
          .run(
            pinId,
            request.conversationId,
            instance.instanceId,
            readDisplayMode(request.input),
            position,
            at,
          );
      }
    }

    const result: ActionRecord["result"] = {
      revision: next.revision,
      stateRevision,
      state: body,
      ...(pinId === undefined ? {} : { pinId }),
    };
    deps.db
      .prepare(
        `INSERT INTO action_invocations (invocation_id, action_binding_id, instance_id, outcome, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        request.invocationId,
        request.actionBindingId,
        instance.instanceId,
        toJson({ digest, result }),
        at,
      );

    return {
      ok: true as const,
      duplicate: false,
      instanceId: instance.instanceId,
      revision: next.revision,
      stateRevision,
      state: body,
      ...(pinId === undefined ? {} : { pinId }),
    };
  });
}

function readDisplayMode(input: Record<string, unknown>): "compact" | "expanded" {
  return input.displayMode === "expanded" ? "expanded" : "compact";
}

/** Read the state row as a plain object, so a caller inside a transaction can merge into it. */
export function readWidgetStateRow(
  db: Database,
  instanceId: string,
): { revision: number; stateVersion: number; body: Record<string, unknown> } | undefined {
  const row = oneRow<{ state_revision: number; state_version: number; document: string }>(
    db,
    "SELECT state_revision, state_version, document FROM widget_state WHERE instance_id = ?",
    instanceId,
  );
  if (row === undefined) return undefined;
  const body = parseJson<unknown>(row.document, "widget_state.document");
  return {
    revision: Number(row.state_revision),
    stateVersion: Number(row.state_version),
    body: typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {},
  };
}

/** Public read of live state, for the state route. */
export function liveStateOf(
  deps: WidgetDeps,
  instanceId: string,
): { revision: number; stateVersion: number; body: Record<string, unknown> } | undefined {
  return readWidgetStateRow(deps.db, instanceId);
}

type InputValidation = { ok: true; patch: Record<string, unknown> } | { ok: false; message: string };

/**
 * Validate the input a view operation carries.
 *
 * The values are checked here rather than trusted from the binding, because the binding says what
 * the action is, not what this particular click contained.
 */
function validateViewInput(operation: string, input: Record<string, unknown>): InputValidation {
  switch (operation) {
    case "period.change": {
      const period = input.period;
      if (period !== "week" && period !== "month") {
        return { ok: false, message: 'a period change must carry period: "week" or "month"' };
      }
      if (typeof input.timezone === "string" && input.timezone.length > 60) {
        return { ok: false, message: "the timezone is longer than any real timezone name" };
      }
      return {
        ok: true,
        patch: {
          period,
          ...(typeof input.timezone === "string" ? { timezone: input.timezone } : {}),
        },
      };
    }
    case "date.select": {
      const date = input.date;
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { ok: false, message: "a date selection must carry an ISO calendar date" };
      }
      return { ok: true, patch: { selectedDate: date } };
    }
    case "view.save":
      return { ok: true, patch: {} };
    default:
      return { ok: false, message: `"${operation}" has no input contract` };
  }
}
