import {
  type ActionBinding,
  type ActionProposal,
  type WorkflowRunReport,
  type ActionInvocation,
  type CapabilityRef,
  type CompiledSection,
  type CompositionActionRef,
  type CompositionGraph,
  type CompositionInitialState,
  type CompositionProvenance,
  type ExecutionPolicyConfig,
  type Instant,
  type LayoutNode,
  type PresentationBundle,
  type Principal,
  type SemanticView,
  type StoredPresentationBundle,
  type SurfaceCompositionSpec,
  type WidgetDefinition,
  type WidgetInstance,
  type WidgetSnapshot,
  bindingStillValid,
  applyGraphEvent,
  checkPresentationBundle,
  LAYOUT_COMPOSITION_SCHEMA_VERSION,
  SURFACE_COMPOSITION_SCHEMA_VERSION,
  checkSurfaceCompositionSpec,
  compileActionBinding,
  graphValues,
  CALENDAR_ID,
  CALENDAR_STATE_VERSION,
  CALENDAR_VIEW_OPERATION,
  TREE_ID,
  TREE_SELECT_OPERATION,
  TREE_TOGGLE_OPERATION,
  type TreeNode,
  readTree,
  readTreeState,
  treeStateProblems,
  MAX_CHART_POINTS,
  calendarViewProblems,
  isKnownTimeZone,
  readCalendarEvents,
  readCalendarState,
  TIMELINE_ID,
  TIMELINE_SELECT_OPERATION,
  readTimeline,
  readTimelineSelection,
  timelineSelectionProblems,
  XY_CHART_KIND,
  nowInstant,
  readXyChart,
  readXyChartView,
  stateAsCurrentVersion,
  toCompositionSection,
  widgetInstanceSchema,
  widgetSnapshotSchema,
  xyChartViewProblems,
  BOARD_ID,
  BOARD_MOVE_OPERATION,
  BOARD_APPROVAL_OPERATION,
  BOARD_RESOLVE_OPERATION,
  BOARD_ACKNOWLEDGE_OPERATION,
  MEDIA_STATE_VERSION,
  MEDIA_VIEW_OPERATION,
  MAP_ID,
  MAP_SELECT_OPERATION,
  MAP_VIEW_OPERATION,
  readMap,
  mapSelectProblems,
  mapViewProblems,
  type BoardState,
  readBoard,
  readBoardState,
  boardMoveProblems,
  moveBoardCard,
  boardApprovalState,
  settleBoardMove,
} from "@clarkcant/contracts";

import {
  type Database,
  asJsonValue,
  insertPresentationBundle,
  findCompositionByInstance,
  getDatasetForPrincipal,
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

/**
 * Keep what a message showed.
 *
 * The snapshot is checked against the schema it is read back with before it is stored. A row the reader refuses (a
 * text alternative over its limit, say) would make every later read of the conversation throw, so it is refused here,
 * where the caller can still turn it into a reason, rather than written and discovered when the conversation will not
 * open.
 */
export function captureSnapshot(
  deps: WidgetDeps,
  input: { messageId: string; instance: WidgetInstance; textAlternative: string; presentationRef: string },
): WidgetSnapshot {
  const checked = widgetSnapshotSchema.safeParse({
    snapshotId: deps.newId("wsnap"),
    instanceId: input.instance.instanceId,
    messageId: input.messageId,
    capturedRevision: input.instance.revision,
    capturedAt: deps.now(),
    textAlternative: input.textAlternative,
    presentationRef: input.presentationRef,
    stale: false,
  });
  if (!checked.success) {
    const problems = checked.error.issues.map((issue) => `${issue.path.map(String).join(".") || "snapshot"}: ${issue.message}`);
    throw new Error(`${input.presentationRef} cannot be kept in the conversation: ${problems.join("; ")}`);
  }
  const snapshot: WidgetSnapshot = checked.data;

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

/**
 * Place one widget in a message: the instance, the binding its action runs through if it has one, and the snapshot the
 * message keeps.
 *
 * In one transaction. A snapshot the conversation could not read back is refused by `captureSnapshot`, and without the
 * transaction that refusal would leave an instance and a live action binding that no message shows and nothing
 * removes.
 */
export function placeInstance(
  deps: WidgetDeps,
  input: Parameters<typeof createInstance>[1] & {
    messageId: string;
    textAlternative: string;
    presentationRef: string;
    /** The bindings for the new instance, made once its id exists and saved atomically with it. */
    bind?: (instanceId: string) => ActionBinding | readonly ActionBinding[];
  },
): { instance: WidgetInstance; snapshot: WidgetSnapshot } {
  const { messageId, textAlternative, presentationRef, bind, ...creating } = input;
  return transaction(deps.db, () => {
    const instance = createInstance(deps, creating);
    if (bind !== undefined) {
      const bindings = bind(instance.instanceId);
      for (const binding of Array.isArray(bindings) ? bindings : [bindings]) saveActionBindingWithinTransaction(deps, binding);
    }
    const snapshot = captureSnapshot(deps, { messageId, instance, textAlternative, presentationRef });
    return { instance, snapshot };
  });
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
  /** How the sections are arranged, when a tree rather than a template's slots does it. Makes the spec version 2. */
  layout?: LayoutNode;
  /** The state the surface holds and how its leaves write and read it. Only beside a layout. */
  graph?: CompositionGraph;
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
    ...(binding.proposal.kind === "view" ? { operation: binding.proposal.operation } : {}),
  }));

  const composition: SurfaceCompositionSpec = {
    schemaVersion: input.layout === undefined ? SURFACE_COMPOSITION_SCHEMA_VERSION : LAYOUT_COMPOSITION_SCHEMA_VERSION,
    compositionId,
    instanceId,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    catalogDigest: input.catalogDigest,
    sections: input.sections.map(toCompositionSection),
    initialState: input.initialState,
    actions,
    provenance: input.provenance,
    ...(input.layout === undefined ? {} : { layout: input.layout }),
    ...(input.graph === undefined ? {} : { graph: input.graph }),
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
  transaction(deps.db, () => saveActionBindingWithinTransaction(deps, binding));
}

/** `saveActionBinding` for a caller that already holds the transaction the binding belongs to. */
export function saveActionBindingWithinTransaction(deps: WidgetDeps, binding: ActionBinding): void {
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
export const M1_VIEW_OPERATIONS = [
  "period.change",
  "date.select",
  "view.save",
  "state.event",
  "chart.view",
  "calendar.view",
  "timeline.select",
  BOARD_MOVE_OPERATION,
  BOARD_APPROVAL_OPERATION,
  BOARD_RESOLVE_OPERATION,
  BOARD_ACKNOWLEDGE_OPERATION,
  TREE_SELECT_OPERATION,
  TREE_TOGGLE_OPERATION,
  MEDIA_VIEW_OPERATION,
  MAP_SELECT_OPERATION,
  MAP_VIEW_OPERATION,
] as const;

/** Bumped when a filter changes the range, because the underlying rows are re-read. */
const OPERATION_BUMP: Record<string, "presentation" | "data"> = {
  "period.change": "data",
  "date.select": "presentation",
  "view.save": "presentation",
  // A leaf wired into the surface's graph changes what the surface shows, not the rows it reads.
  "state.event": "presentation",
  // Hiding a series or selecting a point changes what the chart shows, not the rows it reads.
  "chart.view": "presentation",
  // Switching view or selecting a day or an event changes what the calendar shows, not the events it reads.
  "calendar.view": "presentation",
  // Selecting an entry changes what the timeline shows, not the entries it holds.
  "timeline.select": "presentation",
  [TREE_SELECT_OPERATION]: "presentation",
  [TREE_TOGGLE_OPERATION]: "presentation",
  [MEDIA_VIEW_OPERATION]: "presentation",
  // Selecting a place or moving the map changes what the map shows, not the features it holds.
  [MAP_SELECT_OPERATION]: "presentation",
  [MAP_VIEW_OPERATION]: "presentation",
  [BOARD_MOVE_OPERATION]: "presentation",
  [BOARD_APPROVAL_OPERATION]: "presentation",
  [BOARD_RESOLVE_OPERATION]: "presentation",
  [BOARD_ACKNOWLEDGE_OPERATION]: "presentation",
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
            intent: { kind: "interactive" },
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

  const validation =
    operation === BOARD_MOVE_OPERATION || operation === BOARD_APPROVAL_OPERATION || operation === BOARD_RESOLVE_OPERATION || operation === BOARD_ACKNOWLEDGE_OPERATION
      ? { ok: true as const, patch: {} }
      :
    operation === "chart.view"
      ? chartViewPatch(deps, instance, request.input)
      : operation === CALENDAR_VIEW_OPERATION
        ? calendarViewPatch(deps, instance, request.input)
        : operation === TIMELINE_SELECT_OPERATION
          ? timelineSelectPatch(instance, request.input)
          : operation === TREE_SELECT_OPERATION
            ? treeSelectPatch(instance, request.input)
            : operation === TREE_TOGGLE_OPERATION
              ? treeToggleInputPatch(instance, request.input)
              : operation === MEDIA_VIEW_OPERATION
                ? mediaViewPatch(instance, request.input)
                : operation === MAP_SELECT_OPERATION
                  ? mapSelectPatch(instance, request.input)
                  : operation === MAP_VIEW_OPERATION
                    ? mapViewPatch(instance, request.input)
                    : validateViewInput(operation, request.input);
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

  return transaction(deps.db, (): MiniAppActionOutcome => {
    const at = deps.now();
    const current = readWidgetStateRow(deps.db, instance.instanceId);
    let patch = validation.patch;
    if (operation === TREE_TOGGLE_OPERATION) {
      const tree = readTree(instance.props);
      const nodeId = request.input.nodeId;
      const expanded = request.input.expanded;
      if (tree === undefined || typeof nodeId !== "string" || typeof expanded !== "boolean") {
        return { ok: false, code: "INVALID_INPUT", message: "the tree no longer holds the node to expand or collapse" };
      }
      const state = readTreeState(current?.body, tree);
      const expandedIds = expanded
        ? [...new Set([...state.expandedIds, nodeId])]
        : state.expandedIds.filter((id) => id !== nodeId);
      patch = { expandedIds, ...(state.selectedId === undefined ? {} : { selectedId: state.selectedId }) };
    }
    if (operation === BOARD_MOVE_OPERATION || operation === BOARD_APPROVAL_OPERATION || operation === BOARD_RESOLVE_OPERATION || operation === BOARD_ACKNOWLEDGE_OPERATION) {
      const board = instance.definitionRef.id === BOARD_ID ? readBoard(instance.props) : undefined;
      if (board === undefined) return { ok: false, code: "INVALID_INPUT", message: "this action is not on a readable board" };
      const state = readBoardState(current?.body, board);
      let next: BoardState;
      if (operation === BOARD_MOVE_OPERATION) {
        const externalBound = instance.actionBindingIds.some((id) => getActionBinding(deps, id)?.proposal.kind === "invoke");
        const problems = boardMoveProblems(board, state, { ...request.input, external: externalBound });
        if (problems.length > 0 || typeof request.input.cardId !== "string" || typeof request.input.fromColumnId !== "string" || typeof request.input.toColumnId !== "string" || typeof request.input.position !== "number") {
          return { ok: false, code: "INVALID_INPUT", message: problems[0] ?? "a board move is incomplete" };
        }
        next = moveBoardCard(board, state, { cardId: request.input.cardId, fromColumnId: request.input.fromColumnId, toColumnId: request.input.toColumnId, position: request.input.position, external: externalBound });
      } else if (operation === BOARD_APPROVAL_OPERATION) {
        if (typeof request.input.approvalId !== "string" || request.input.approvalId.length < 1 || request.input.approvalId.length > 128 || state.pendingMove === undefined) {
          return { ok: false, code: "INVALID_INPUT", message: "an approval id and pending board move are required" };
        }
        next = boardApprovalState(state, request.input.approvalId);
      } else if (operation === BOARD_RESOLVE_OPERATION) {
        const outcome = request.input.outcome;
        if (outcome !== "done" && outcome !== "refused" && outcome !== "uncertain") return { ok: false, code: "INVALID_INPUT", message: "a board outcome must be done, refused or uncertain" };
        if (state.pendingMove === undefined || (request.input.approvalId !== undefined && request.input.approvalId !== state.pendingMove.approvalId)) return { ok: false, code: "INVALID_INPUT", message: "the board move no longer matches this result" };
        next = settleBoardMove(state, outcome);
      } else {
        if (state.pendingMove?.outcome !== "uncertain") return { ok: false, code: "INVALID_INPUT", message: "only an uncertain board move can be acknowledged" };
        const { pendingMove: _pending, ...acknowledged } = state;
        next = acknowledged;
      }
      patch = next as unknown as Record<string, unknown>;
    }
    if (operation === "state.event") {
      // Applied here, to the values the node holds, by the same rules the page ran: what is stored is what the graph
      // says the event does, never a value the page computed and sent.
      const applied = applyStateEvent(deps, {
        instanceId: instance.instanceId,
        principalId: request.principalId,
        actionBindingId: request.actionBindingId,
        stored: current?.body.graph,
        input: request.input,
      });
      if (!applied.ok) return { ok: false, code: "INVALID_INPUT", message: applied.problem };
      patch = { graph: applied.values };
    }
    // Chart, calendar, timeline and board operations each produce the widget's whole bounded view state, so each
    // replaces what was stored. This also removes a selection or pending board move that was cleared.
    const replaces = operation === "chart.view" || operation === CALENDAR_VIEW_OPERATION || operation === TIMELINE_SELECT_OPERATION || operation === MEDIA_VIEW_OPERATION ||
      operation === BOARD_MOVE_OPERATION || operation === BOARD_APPROVAL_OPERATION || operation === BOARD_RESOLVE_OPERATION || operation === BOARD_ACKNOWLEDGE_OPERATION;
    const body: Record<string, unknown> = replaces ? patch : { ...(current?.body ?? {}), ...patch };
    if ((operation === TREE_SELECT_OPERATION || operation === MAP_SELECT_OPERATION) && request.input.selectedId === "") delete body.selectedId;
    const stateRevision = (current?.revision ?? 0) + 1;
    // A calendar view is written in the calendar's current state shape, so the row says so; a row written in an older
    // shape is replaced whole, which is its migration. Every other operation keeps the version the row already has.
    const stateVersion = operation === CALENDAR_VIEW_OPERATION ? CALENDAR_STATE_VERSION : operation === MEDIA_VIEW_OPERATION ? MEDIA_STATE_VERSION : undefined;

    if (current === undefined) {
      deps.db
        .prepare(
          `INSERT INTO widget_state
             (instance_id, state_version, state_revision, document, draft, draft_revision, draft_saved_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        )
        .run(instance.instanceId, stateVersion ?? 1, stateRevision, toJson(body), at);
    } else if (stateVersion !== undefined) {
      deps.db
        .prepare("UPDATE widget_state SET state_version = ?, state_revision = ?, document = ?, updated_at = ? WHERE instance_id = ?")
        .run(stateVersion, stateRevision, toJson(body), at, instance.instanceId);
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

type InvokeProposal = Extract<ActionProposal, { kind: "invoke" }>;

/**
 * The arguments an `invoke` binding calls its capability with.
 *
 * The binding is the host's compiled record of what the action does, so what it fixed stays fixed: `args` and every
 * `literal` field come from the binding, a `widget-state` field from the instance's own stored state, and only the
 * fields the binding names as coming from the person or their selection are taken from the invocation. An invocation
 * that sends any other field is refused rather than quietly dropped, because a frame that sends a field it was never
 * given is either broken or probing, and neither should look like success.
 */
export function composeInvokeArgs(
  proposal: InvokeProposal,
  input: Record<string, unknown>,
  state: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  const args: Record<string, unknown> = { ...proposal.args };
  const fromInvocation = new Set<string>();
  for (const binding of proposal.bindings ?? []) {
    if (binding.source === "literal") {
      args[binding.target] = binding.value;
    } else if (binding.source === "widget-state") {
      if (Object.hasOwn(state, binding.target)) args[binding.target] = state[binding.target];
    } else {
      fromInvocation.add(binding.target);
      if (Object.hasOwn(input, binding.target)) args[binding.target] = input[binding.target];
    }
  }
  const extra = Object.keys(input).filter((key) => !fromInvocation.has(key));
  if (extra.length > 0) {
    return { ok: false, message: `this action does not take ${extra.slice(0, 5).join(", ")}` };
  }
  return { ok: true, args };
}

interface InvokeRecord {
  digest: string;
  result:
    | { kind: "done"; output: string }
    | { kind: "approval-required"; approvalId: string }
    /** A long-running capability the node accepted as a durable job; its state is read through the job, not here. */
    | { kind: "job"; jobId: string }
    /**
     * Sent, and its answer never came back: the deadline passed or a person stopped it. Recorded so the same
     * invocation id is told that again rather than sent a second time, which is how an effect would happen twice.
     */
    | { kind: "uncertain"; code: string; message: string; taskId?: string }
    /** Handed to the node's background lane; its result arrives in the conversation, not in this answer. */
    | { kind: "background"; workId: string; state: "running" | "queued" }
    /** A workflow's run, complete or stopped at a step, with what each step came to. */
    | { kind: "workflow"; report: WorkflowRunReport }
    /**
     * Written before anything is sent, and replaced by the outcome once there is one. Found again after a restart, it
     * means the node stopped while the action ran: its effect is unknown, and it is not run a second time.
     */
    | { kind: "started"; at: string };
}

/** What an action run outside this package came to, recorded so the same invocation id gets it back. */
export type BoundActionResult = InvokeRecord["result"];

/**
 * Whether a widget instance is part of a conversation: pinned there, captured in one of its messages, or named by a
 * block of one — the same blocks the conversation's timeline draws its widgets from.
 */
export function instanceInConversation(deps: Pick<WidgetDeps, "db">, instanceId: string, conversationId: string): boolean {
  const pinned = oneRow(deps.db, "SELECT 1 AS found FROM pins WHERE conversation_id = ? AND instance_id = ? LIMIT 1", conversationId, instanceId);
  if (pinned !== undefined) return true;
  const captured = oneRow(
    deps.db,
    `SELECT 1 AS found FROM widget_snapshots s JOIN messages m ON m.message_id = s.message_id
     WHERE s.instance_id = ? AND m.conversation_id = ? LIMIT 1`,
    instanceId,
    conversationId,
  );
  if (captured !== undefined) return true;
  // A widget-ref block, or a surface block whose snapshot names the instance, as the message document stores it.
  const named = oneRow(
    deps.db,
    "SELECT 1 AS found FROM messages WHERE conversation_id = ? AND instr(document, ?) > 0 LIMIT 1",
    conversationId,
    JSON.stringify({ instanceId }).slice(1, -1),
  );
  return named !== undefined;
}

export type BoundActionCheck =
  | { ok: false; code: MiniAppActionCode; message: string; currentRevision?: number }
  | {
      ok: true;
      /** The same invocation arriving again: its first outcome, returned rather than repeated. */
      duplicate: BoundActionResult | undefined;
      instance: WidgetInstance;
      binding: ActionBinding;
      digest: string;
    };

/**
 * The gate every action that runs outside this package passes before it runs: an `invoke` calling a capability, an
 * `agent` starting a turn.
 *
 * The same checks a view action passes — the instance's owner rather than the request's, the binding on this instance,
 * one outcome per invocation id, and the revision and binding digest the person was shown — in the same order and for
 * the same reasons (see `invokeMiniAppAction`). `kind` is checked before the invocation record, so an id reused across
 * kinds is refused as the wrong kind rather than answered with another action's outcome. Nothing is called here, and
 * `recordBoundAction` writes the outcome once there is one.
 */
export function checkBoundAction(
  deps: WidgetDeps,
  request: MiniAppActionRequest,
  kind: ActionProposal["kind"],
): BoundActionCheck {
  const instance = getInstance(deps, request.instanceId);
  if (instance === undefined) {
    return { ok: false, code: "INSTANCE_UNKNOWN", message: `widget instance ${request.instanceId} does not exist` };
  }
  if (instance.ownerPrincipalId !== request.principalId) {
    return { ok: false, code: "NOT_AUTHORIZED", message: "this instance belongs to another principal" };
  }
  // Stop, the approval card, a background run and the ledger's task are all kept under the conversation the request
  // names, so a press is only taken in a conversation the widget is actually in.
  if (!instanceInConversation(deps, instance.instanceId, request.conversationId)) {
    return {
      ok: false,
      code: "INSTANCE_UNKNOWN",
      message: `widget instance ${request.instanceId} is not in this conversation`,
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
  if (binding.proposal.kind !== kind) {
    return { ok: false, code: "UNSUPPORTED_ACTION", message: `a ${binding.proposal.kind} action is not an ${kind} action` };
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
  const row = oneRow<{ outcome: string }>(
    deps.db,
    "SELECT outcome FROM action_invocations WHERE invocation_id = ?",
    request.invocationId,
  );
  if (row !== undefined) {
    let prior: InvokeRecord | undefined;
    try {
      prior = JSON.parse(row.outcome) as InvokeRecord;
    } catch {
      prior = undefined;
    }
    if (prior?.digest !== digest || prior.result === undefined) {
      return {
        ok: false,
        code: "INVOCATION_KEY_REUSED",
        message: "the same invocation id was reused with different input; use a new id for a new operation",
      };
    }
    return { ok: true, duplicate: prior.result, instance, binding, digest };
  }

  const precheck = precheckInvocation(deps, request);
  if (!precheck.ok) {
    return {
      ok: false,
      code: precheck.code === "REVISION_MISMATCH" ? "REVISION_MISMATCH" : "BINDING_STALE",
      message: precheck.message,
      currentRevision: instance.revision,
    };
  }
  return { ok: true, duplicate: undefined, instance, binding, digest };
}

export type InvokeActionCheck =
  | { ok: false; code: MiniAppActionCode; message: string; currentRevision?: number }
  | {
      ok: true;
      /** The same invocation arriving again: its first outcome, returned rather than repeated. */
      duplicate: InvokeRecord["result"] | undefined;
      instance: WidgetInstance;
      binding: ActionBinding;
      proposal: InvokeProposal;
      args: Record<string, unknown>;
      digest: string;
    };

/**
 * Check a widget's `invoke` action before its capability is called: the shared gate, then the arguments the binding
 * fixes composed with the ones the person supplied. The capability itself runs in the runtime, behind the registry and
 * the policy.
 */
export function checkInvokeAction(deps: WidgetDeps, request: MiniAppActionRequest): InvokeActionCheck {
  const checked = checkBoundAction(deps, request, "invoke");
  if (!checked.ok) return checked;
  const { instance, binding, digest } = checked;
  const proposal = binding.proposal as InvokeProposal;
  if (checked.duplicate !== undefined) {
    return { ok: true, duplicate: checked.duplicate, instance, binding, proposal, args: {}, digest };
  }

  const composed = composeInvokeArgs(proposal, request.input, readWidgetStateRow(deps.db, instance.instanceId)?.body ?? {});
  if (!composed.ok) return { ok: false, code: "INVALID_INPUT", message: composed.message };
  return { ok: true, duplicate: undefined, instance, binding, proposal, args: composed.args, digest };
}

/** Record what an `invoke` or `agent` action came to, so the same invocation id arriving again gets this answer back. */
export function recordInvokeAction(
  deps: WidgetDeps,
  input: {
    invocationId: string;
    actionBindingId: string;
    instanceId: string;
    digest: string;
    result: InvokeRecord["result"];
  },
): void {
  deps.db
    .prepare(
      `INSERT INTO action_invocations (invocation_id, action_binding_id, instance_id, outcome, recorded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(invocation_id) DO NOTHING`,
    )
    .run(
      input.invocationId,
      input.actionBindingId,
      input.instanceId,
      toJson({ digest: input.digest, result: input.result }),
      deps.now(),
    );
}

/**
 * Replace a `started` record with what the action came to.
 *
 * Only a `started` record is replaced: an outcome already written is the answer the same id keeps getting.
 */
export function settleInvokeAction(
  deps: WidgetDeps,
  input: { invocationId: string; digest: string; result: InvokeRecord["result"] },
): void {
  deps.db
    .prepare(
      `UPDATE action_invocations SET outcome = ?, recorded_at = ?
       WHERE invocation_id = ? AND json_extract(outcome, '$.result.kind') = 'started'`,
    )
    .run(toJson({ digest: input.digest, result: input.result }), deps.now(), input.invocationId);
}

/**
 * Remove a `started` record for an action that was refused before anything was sent, so the same id can be pressed
 * again once whatever refused it has changed.
 */
export function forgetStartedInvokeAction(deps: WidgetDeps, invocationId: string): void {
  deps.db
    .prepare(
      `DELETE FROM action_invocations WHERE invocation_id = ? AND json_extract(outcome, '$.result.kind') = 'started'`,
    )
    .run(invocationId);
}

/**
 * Replace an invocation's `approval-required` outcome with the job its approval started, so the same invocation id
 * arriving again is answered with that JobRef rather than a second job. Only the invocation the approved payload named,
 * on the instance and binding it named and waiting on that approval, is changed.
 */
export function settleApprovedInvokeJob(
  deps: WidgetDeps,
  input: { invocationId: string; instanceId: string; actionBindingId: string; approvalId: string; jobId: string },
): boolean {
  const changed = deps.db.prepare(`UPDATE action_invocations
    SET outcome = json_set(outcome, '$.result', json(?)), recorded_at = ?
    WHERE invocation_id = ? AND instance_id = ? AND action_binding_id = ?
      AND json_extract(outcome, '$.result.kind') = 'approval-required'
      AND json_extract(outcome, '$.result.approvalId') = ?`)
    .run(toJson({ kind: "job", jobId: input.jobId }), deps.now(), input.invocationId,
      input.instanceId, input.actionBindingId, input.approvalId);
  return Number(changed.changes) > 0;
}

function readDisplayMode(input: Record<string, unknown>): "compact" | "expanded" {
  return input.displayMode === "expanded" ? "expanded" : "compact";
}

/** Read the state row as a plain object, so a caller inside a transaction can merge into it. */
export function readWidgetStateRow(
  db: Database,
  instanceId: string,
): { revision: number; stateVersion: number; body: Record<string, unknown>; updatedAt: string } | undefined {
  const row = oneRow<{ state_revision: number; state_version: number; document: string; updated_at: string }>(
    db,
    "SELECT state_revision, state_version, document, updated_at FROM widget_state WHERE instance_id = ?",
    instanceId,
  );
  if (row === undefined) return undefined;
  const body = parseJson<unknown>(row.document, "widget_state.document");
  return {
    revision: Number(row.state_revision),
    stateVersion: Number(row.state_version),
    body: typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {},
    updatedAt: String(row.updated_at),
  };
}

/**
 * Public read of live state, for the state route.
 *
 * Given the instance's definition, a state stored by an older version of it is read in the current shape, migrated in
 * memory by the definition's declared steps; the row itself is left as it is until something writes the state.
 */
export function liveStateOf(
  deps: WidgetDeps,
  instanceId: string,
  definition?: Pick<WidgetDefinition, "stateVersion" | "stateMigrations">,
): { revision: number; stateVersion: number; body: Record<string, unknown>; updatedAt: string } | undefined {
  const row = readWidgetStateRow(deps.db, instanceId);
  if (row === undefined || definition === undefined) return row;
  return { revision: row.revision, updatedAt: row.updatedAt, ...stateAsCurrentVersion(definition, row) };
}

type InputValidation = { ok: true; patch: Record<string, unknown> } | { ok: false; message: string };

/**
 * Apply one wired event to the graph values an instance holds.
 *
 * The section comes from the binding the person pressed through, not from the request, so an event cannot be
 * attributed to a leaf that does not emit it.
 */
function applyStateEvent(
  deps: WidgetDeps,
  input: { instanceId: string; principalId: string; actionBindingId: string; stored: unknown; input: Record<string, unknown> },
): { ok: true; values: Record<string, unknown> } | { ok: false; problem: string } {
  const composition = findCompositionByInstance(deps.db, input.instanceId, input.principalId);
  const graph: CompositionGraph | undefined = composition?.graph;
  if (composition === undefined || graph === undefined) return { ok: false, problem: "this surface has no graph to apply the event to" };
  const sectionId = composition.actions.find((action) => action.actionBindingId === input.actionBindingId)?.sectionId;
  const section = composition.sections.find((candidate) => candidate.sectionId === sectionId);
  if (section === undefined) return { ok: false, problem: "the binding is not attached to a section of this surface" };
  const applied = applyGraphEvent(graph, graphValues(graph, input.stored), {
    sectionId: section.sectionId,
    definitionId: section.definitionRef.id,
    event: String(input.input.event),
    payload: input.input.payload,
  });
  return applied.ok ? { ok: true, values: applied.values } : { ok: false, problem: applied.problem };
}

/**
 * The state a chart view sets, checked against the chart it is set on.
 *
 * Read from the instance, not the request: the series are the ones the chart was placed with, and a point is one the
 * chart draws from the rows this node holds now. What is stored is the view read back from what passed, so the state
 * row never holds a key the chart's state schema does not.
 */
function chartViewPatch(deps: WidgetDeps, instance: WidgetInstance, input: Record<string, unknown>): InputValidation {
  const kind = XY_CHART_KIND[instance.definitionRef.id];
  const chart = kind === undefined ? undefined : readXyChart(kind, instance.props);
  if (chart === undefined) return { ok: false, message: "only an area or a scatter chart holds a chart view" };
  const document = getDatasetForPrincipal(deps.db, chart.datasetRef, instance.ownerPrincipalId)?.document;
  const rows = typeof document === "object" && document !== null && Array.isArray((document as { rows?: unknown }).rows)
    ? ((document as { rows: unknown[] }).rows)
    : [];
  const shown = Math.min(rows.length, MAX_CHART_POINTS);
  const problems = xyChartViewProblems(chart, input, shown);
  if (problems.length > 0) return { ok: false, message: `the chart view was refused: ${problems.join("; ")}` };
  const view = readXyChartView(chart, input, shown);
  return { ok: true, patch: { hiddenSeries: view.hiddenSeries, ...(view.selected === undefined ? {} : { selected: view.selected }) } };
}

function mediaViewPatch(instance: WidgetInstance, input: Record<string, unknown>): InputValidation {
  const definitionId = instance.definitionRef.id;
  if (definitionId === "canvas.carousel@1" || definitionId === "canvas.gallery@1") {
    const refs = instance.props.imageRefs;
    const count = Array.isArray(refs) ? refs.length : 0;
    const index = input.selectedIndex;
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(index) || typeof index !== "number" || index < 0 || index >= count) {
      return { ok: false, message: "the selected media index is outside this gallery" };
    }
    return { ok: true, patch: { selectedIndex: index } };
  }
  if (definitionId === "canvas.video@1") {
    const { status, position, duration } = input;
    if ((status !== "playing" && status !== "paused" && status !== "ended") ||
      typeof position !== "number" || !Number.isFinite(position) || position < 0 ||
      typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 ||
      (duration > 0 && position > duration)) {
      return { ok: false, message: "the video playback state is incomplete or outside the media duration" };
    }
    return { ok: true, patch: { status, position, duration } };
  }
  return { ok: false, message: "only a gallery, carousel or local video holds media view state" };
}

/**
 * The state a calendar view sets, checked against the calendar it is set on.
 *
 * The month and timezone are the ones the calendar was placed with, and a selected event is one the node reads from the
 * rows it holds now, placed on its days in that timezone. What is stored is the view read back from what passed, so the
 * state row never holds a key the calendar's state schema does not.
 */
function calendarViewPatch(deps: WidgetDeps, instance: WidgetInstance, input: Record<string, unknown>): InputValidation {
  if (instance.definitionRef.id !== CALENDAR_ID) return { ok: false, message: "only a calendar holds a calendar view" };
  const month = typeof instance.props.month === "string" ? instance.props.month : "";
  const timeZone = instance.props.timezone ?? "UTC";
  const datasetRef = instance.props.datasetRef;
  if (!isKnownTimeZone(timeZone) || typeof datasetRef !== "string") {
    return { ok: false, message: "the calendar view was refused: the calendar does not name a dataset and a timezone this node reads" };
  }
  const document = getDatasetForPrincipal(deps.db, datasetRef, instance.ownerPrincipalId)?.document;
  const rows = typeof document === "object" && document !== null && Array.isArray((document as { rows?: unknown }).rows)
    ? ((document as { rows: unknown[] }).rows)
    : [];
  const { events } = readCalendarEvents(rows, timeZone);
  const problems = calendarViewProblems(month, input, events);
  if (problems.length > 0) return { ok: false, message: `the calendar view was refused: ${problems.join("; ")}` };
  const view = readCalendarState(input, month, undefined, events);
  return {
    ok: true,
    patch: {
      view: view.view,
      ...(view.selectedDate === undefined ? {} : { selectedDate: view.selectedDate }),
      ...(view.selectedEventId === undefined ? {} : { selectedEventId: view.selectedEventId }),
    },
  };
}

/**
 * The selection a timeline holds, checked against the entries it was placed with.
 *
 * Read from the instance, not the request: the entry must be one of the timeline's own entries now. An empty id clears
 * the selection, which is stored as no key at all, so the state row never holds a key the timeline's state schema does
 * not.
 */
function timelineSelectPatch(instance: WidgetInstance, input: Record<string, unknown>): InputValidation {
  if (instance.definitionRef.id !== TIMELINE_ID) return { ok: false, message: "only a timeline holds a timeline selection" };
  const timeline = readTimeline(instance.props);
  if (timeline === undefined) return { ok: false, message: "the timeline selection was refused: the timeline's props do not describe a timeline" };
  const problems = timelineSelectionProblems(timeline, input);
  if (problems.length > 0) return { ok: false, message: `the timeline selection was refused: ${problems.join("; ")}` };
  const selection = readTimelineSelection(input, timeline);
  return { ok: true, patch: selection.selectedId === undefined ? {} : { selectedId: selection.selectedId } };
}

function treeSelectPatch(instance: WidgetInstance, input: Record<string, unknown>): InputValidation {
  if (instance.definitionRef.id !== TREE_ID) return { ok: false, message: "only a tree holds a tree selection" };
  const tree = readTree(instance.props);
  if (tree === undefined) return { ok: false, message: "the tree selection was refused: the tree's props do not describe a hierarchy" };
  const problems = treeStateProblems(tree, input);
  if (problems.length > 0) return { ok: false, message: `the tree selection was refused: ${problems.join("; ")}` };
  const selectedId = input.selectedId;
  if (typeof selectedId !== "string") return { ok: false, message: "selectedId names a tree node or is empty to clear the selection" };
  return { ok: true, patch: selectedId === "" ? {} : { selectedId } };
}

/**
 * The selection a map holds, checked against the features it was placed with. An empty id clears it; the view the map
 * shows is kept, because a selection merges into what was stored.
 */
function mapSelectPatch(instance: WidgetInstance, input: Record<string, unknown>): InputValidation {
  if (instance.definitionRef.id !== MAP_ID) return { ok: false, message: "only a map holds a map selection" };
  const map = readMap(instance.props);
  if (map === undefined) return { ok: false, message: "the map selection was refused: the map's props do not describe a map" };
  const problems = mapSelectProblems(map, input);
  if (problems.length > 0) return { ok: false, message: `the map selection was refused: ${problems.join("; ")}` };
  const selectedId = input.selectedId as string;
  return { ok: true, patch: selectedId === "" ? {} : { selectedId } };
}

/** Where the person moved a map: a center and a whole zoom inside the projection's bounds. The selection is kept. */
function mapViewPatch(instance: WidgetInstance, input: Record<string, unknown>): InputValidation {
  if (instance.definitionRef.id !== MAP_ID) return { ok: false, message: "only a map can be panned or zoomed" };
  if (readMap(instance.props) === undefined) return { ok: false, message: "the map view was refused: the map's props do not describe a map" };
  const problems = mapViewProblems(input);
  if (problems.length > 0) return { ok: false, message: `the map view was refused: ${problems.join("; ")}` };
  const center = input.center as readonly number[];
  return { ok: true, patch: { center: [center[0], center[1]], zoom: input.zoom } };
}

function treeToggleInputPatch(instance: WidgetInstance, input: Record<string, unknown>): InputValidation {
  if (instance.definitionRef.id !== TREE_ID) return { ok: false, message: "only a tree can expand or collapse a node" };
  const tree = readTree(instance.props);
  if (tree === undefined) return { ok: false, message: "the tree toggle was refused: the tree's props do not describe a hierarchy" };
  const extra = Object.keys(input).filter((key) => key !== "nodeId" && key !== "expanded");
  if (extra.length > 0 || typeof input.nodeId !== "string" || typeof input.expanded !== "boolean") {
    return { ok: false, message: "a tree toggle carries nodeId and expanded" };
  }
  const findNode = (nodes: readonly TreeNode[]): TreeNode | undefined => {
    for (const candidate of nodes) {
      if (candidate.id === input.nodeId) return candidate;
      const child = findNode(candidate.children ?? []);
      if (child !== undefined) return child;
    }
    return undefined;
  };
  const node = findNode(tree.nodes);
  if (node === undefined || (node.children?.length ?? 0) === 0) {
    return { ok: false, message: "the node to expand or collapse is not a branch on this tree" };
  }
  return { ok: true, patch: { treeToggle: { nodeId: input.nodeId, expanded: input.expanded } } };
}

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
    case "state.event": {
      // Only the envelope here; what the event may carry depends on the graph, which is read with the state it changes.
      const extra = Object.keys(input).filter((key) => key !== "event" && key !== "payload");
      if (extra.length > 0) return { ok: false, message: `a state event carries event and payload, not ${extra.join(", ")}` };
      if (typeof input.event !== "string" || input.event === "" || input.event.length > 80) {
        return { ok: false, message: "a state event must name the event the widget reported" };
      }
      if (typeof input.payload !== "object" || input.payload === null || Array.isArray(input.payload)) {
        return { ok: false, message: "a state event must carry the fields the widget reported as an object" };
      }
      return { ok: true, patch: {} };
    }
    case BOARD_MOVE_OPERATION: {
      if (Object.keys(input).some((key) => !["cardId", "fromColumnId", "toColumnId", "position", "external"].includes(key)) ||
          typeof input.cardId !== "string" || typeof input.fromColumnId !== "string" || typeof input.toColumnId !== "string" ||
          !Number.isInteger(input.position) || typeof input.external !== "boolean") return { ok: false, message: "a board move must name its card, columns, position and external binding state" };
      return { ok: true, patch: {} };
    }
    case BOARD_APPROVAL_OPERATION:
      return typeof input.approvalId === "string" && Object.keys(input).length === 1 ? { ok: true, patch: {} } : { ok: false, message: "a board approval carries one approval id" };
    case BOARD_RESOLVE_OPERATION:
      return Object.keys(input).every((key) => ["outcome", "approvalId"].includes(key)) ? { ok: true, patch: {} } : { ok: false, message: "a board resolution carries an outcome and optional approval id" };
    case BOARD_ACKNOWLEDGE_OPERATION:
      return Object.keys(input).length === 0 ? { ok: true, patch: {} } : { ok: false, message: "acknowledging a board move carries no input" };
    default:
      return { ok: false, message: `"${operation}" has no input contract` };
  }
}
