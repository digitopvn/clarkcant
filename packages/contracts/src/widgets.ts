import { z } from "zod";

import { effectCategorySchema, instantSchema, type Instant } from "./primitives.ts";
import { capabilityRefSchema } from "./grants.ts";

/**
 * Widgets, instances, pins, and agent-defined actions.
 *
 * Two ideas carry most of the weight here:
 *
 * 1. A definition is registered by a package and discovered like a capability.
 *    A model never fetches JavaScript from a URL it invented; unknown component
 *    or version falls back to text.
 * 2. An action binding is server-owned. The agent proposes what a button should
 *    do; the host compiles that into a binding with a fixed target, account,
 *    resource and generation, and re-authorizes every invocation.
 */

export const widgetRendererSchema = z.enum(["catalog", "isolated-app", "mcp-app"]);
export type WidgetRenderer = z.infer<typeof widgetRendererSchema>;

/**
 * A dataset a fixture draws from.
 *
 * Inline rather than a reference, because a preview surface has no host to resolve an opaque
 * reference: a fixture that named a reference the library cannot resolve would render the
 * "unavailable" state and quietly make a conformance claim that is not true.
 */
export const fixtureDatasetSchema = z.strictObject({
  datasetId: z.string().min(1).max(128),
  source: z.enum(["sample", "cached"]),
  columns: z.array(z.string().min(1).max(64)).min(1),
  rows: z.array(z.record(z.string(), z.unknown())),
});
export type FixtureDataset = z.infer<typeof fixtureDatasetSchema>;

/**
 * One deterministic way to show a widget.
 *
 * Fixtures are data, never code, and they carry no effect binding that could reach the outside
 * world: a catalog preview must not be able to trigger a real action by being displayed.
 */
export const widgetFixtureSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  props: z.record(z.string(), z.unknown()),
  state: z.record(z.string(), z.unknown()).optional(),
  dataset: fixtureDatasetSchema.optional(),
  mode: z.enum(["interactive", "read-only"]).optional(),
});
export type WidgetFixture = z.infer<typeof widgetFixtureSchema>;

const stateKeySchema = z.string().min(1).max(120);

/**
 * One operation of a declarative state migration.
 *
 * A closed set on purpose. The host runs a migration inside the transaction that holds the user's data, so what a
 * step may do is fixed here rather than supplied as code: a widget that could ship a migration function would be a
 * widget running its own code against state nobody has validated yet.
 */
export const stateMigrationOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("rename"), from: stateKeySchema, to: stateKeySchema }),
  /** Sets `key` only when it is absent, so a step never overwrites a value the user already has. */
  z.strictObject({ op: z.literal("default"), key: stateKeySchema, value: z.unknown() }),
  z.strictObject({ op: z.literal("remove"), key: stateKeySchema }),
  /** Replaces a string value by the entry named for it; a value with no entry is left as it is. */
  z.strictObject({
    op: z.literal("map"),
    key: stateKeySchema,
    values: z.record(z.string().max(200), z.unknown()),
  }),
]);
export type StateMigrationOp = z.infer<typeof stateMigrationOpSchema>;

export const stateMigrationStepSchema = z
  .strictObject({
    from: z.int().nonnegative(),
    to: z.int().positive(),
    ops: z.array(stateMigrationOpSchema).min(1).max(32),
  })
  .refine((step) => step.to === step.from + 1, { message: "a migration step moves exactly one stateVersion" });
export type StateMigrationStep = z.infer<typeof stateMigrationStepSchema>;

export const widgetDefinitionSchema = z.strictObject({
  id: z.string().min(1).max(160),
  version: z.string().min(1).max(80),
  renderer: widgetRendererSchema,
  /** Runtime JSON Schema. Validated on every render, never passed through to DOM. */
  propsSchema: z.record(z.string(), z.unknown()),
  eventSchemas: z.record(z.string(), z.record(z.string(), z.unknown())),
  stateSchema: z.record(z.string(), z.unknown()).optional(),
  stateVersion: z.int().nonnegative().optional(),
  /**
   * Keys that are view state — a filter, a zoom level, a selection — rather than the user's data.
   *
   * The host never persists them: a write carrying one is applied in the frame and dropped before it reaches the
   * node. Every key not listed here is durable, which is the safe default — a widget that forgot to declare a key
   * loses nothing, where the opposite default would lose data for the same mistake.
   */
  ephemeralStateKeys: z.array(stateKeySchema).max(64).optional(),
  /** Declarative, host-run steps from each older `stateVersion` to the next. */
  stateMigrations: z.array(stateMigrationStepSchema).max(64).optional(),
  /** One sentence the conductor and voice layer use to choose this widget. */
  semanticDescription: z.string().min(1).max(400),
  requestedCapabilities: z.array(capabilityRefSchema).max(64),
  sizing: z.strictObject({
    compact: z.boolean(),
    expanded: z.boolean(),
    minHeight: z.int().nonnegative().optional(),
  }),
  /**
   * Rendered when the definition is unavailable, the props are invalid, or the
   * widget fails. Chat must stay usable, so a fallback is mandatory.
   */
  textFallback: z.string().min(1).max(2000),
  /** Integrity-checked bundle installed with the package. Never an arbitrary URL. */
  entryArtifact: z.string().min(1).max(300).optional(),
  /** Effects this widget's own actions can cause, shown on the frame chrome. */
  effectCategories: z.array(effectCategorySchema).max(16),
  /** Data refs the definition needs at render time, resolved by the host. */
  datasetRefs: z.array(z.string().min(1).max(200)).max(64),
});
export type WidgetDefinition = z.infer<typeof widgetDefinitionSchema>;

export const widgetLifecycleSchema = z.enum([
  "ready",
  "active",
  "suspended",
  "needs_auth",
  "offline",
  "error",
]);
export type WidgetLifecycle = z.infer<typeof widgetLifecycleSchema>;

/**
 * A live widget.
 *
 * `ownerNodeId` is the single instance owner. Media and network grants attach to
 * the instance, not to whichever surface happens to be rendering it, which is
 * what makes "one player, two views" possible without two players.
 */
export const widgetInstanceSchema = z.strictObject({
  instanceId: z.string().min(1).max(128),
  definitionRef: z.strictObject({
    id: z.string().min(1).max(160),
    version: z.string().min(1).max(80),
    packageDigest: z.string().min(1).max(120),
  }),
  ownerNodeId: z.string().min(1).max(128),
  ownerPrincipalId: z.string().min(1).max(128),
  /**
   * Bumped on any state change. Three revisions are tracked separately because
   * a tooltip change must not invalidate an approval, while a target or account
   * change must.
   */
  revision: z.int().nonnegative(),
  presentationRevision: z.int().nonnegative(),
  dataRevision: z.int().nonnegative(),
  actionBindingRevision: z.int().nonnegative(),
  props: z.record(z.string(), z.unknown()),
  stateRef: z.string().min(1).max(200).optional(),
  dataRefs: z.array(z.string().min(1).max(200)).max(64),
  connectionRefs: z.array(z.string().min(1).max(160)).max(32),
  actionBindingIds: z.array(z.string().min(1).max(128)).max(64),
  lifecycle: widgetLifecycleSchema,
  /** Set when lifecycle is `needs_auth`, naming the connection to fix. */
  needsConnectionRef: z.string().min(1).max(160).optional(),
});
export type WidgetInstance = z.infer<typeof widgetInstanceSchema>;

export const widgetSnapshotSchema = z.strictObject({
  snapshotId: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128).optional(),
  messageId: z.string().min(1).max(128),
  capturedRevision: z.int().nonnegative(),
  capturedAt: instantSchema,
  /** Mandatory: history must be readable when the renderer is gone. */
  textAlternative: z.string().min(1).max(4000),
  presentationRef: z.string().min(1).max(300),
  /**
   * Opaque reference to the immutable presentation bundle, when one was captured.
   *
   * Additive on purpose. `presentationRef` only ever said which renderer drew the block; it
   * never carried the values the user saw, so a history entry could only be re-rendered by
   * asking the live source what it currently holds. A snapshot written before this field
   * existed still parses, and the absence of a bundle is itself the signal to fall back to the
   * text alternative instead of substituting current props.
   */
  bundleRef: z.string().min(1).max(200).optional(),
  bundleSchemaVersion: z.int().nonnegative().optional(),
  /** Digest of the catalog the snapshot was captured against, so drift is detectable. */
  catalogDigest: z.string().min(1).max(120).optional(),
  /** True when the snapshot predates the instance's current revision. */
  stale: z.boolean(),
});
export type WidgetSnapshot = z.infer<typeof widgetSnapshotSchema>;

export const pinSchema = z.strictObject({
  pinId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(128),
  /**
   * Points at the logical instance. Two surfaces may reference one pin, but a
   * pin never creates a second live owner.
   */
  instanceId: z.string().min(1).max(128),
  displayMode: z.enum(["compact", "expanded"]),
  position: z.int().nonnegative(),
  createdAt: instantSchema,
  /**
   * Whether the user granted a bounded background read subscription. Pins never
   * create a periodic LLM task; this only allows deterministic adapter refresh.
   */
  refreshPolicy: z.enum(["on-open", "bounded-interval", "manual"]),
  backgroundGrantId: z.string().min(1).max(128).optional(),
});
export type Pin = z.infer<typeof pinSchema>;

/* ------------------------------------------------------------------ *
 * Agent-defined actions
 * ------------------------------------------------------------------ */

export const fieldBindingSchema = z.strictObject({
  /** Field on the capability input schema this binding fills. */
  target: z.string().min(1).max(160),
  /** Where the value comes from. */
  source: z.enum(["user-input", "selected-row", "selected-event", "widget-state", "literal"]),
  /** Present only for `literal`. */
  value: z.unknown().optional(),
});
export type FieldBinding = z.infer<typeof fieldBindingSchema>;

/** Bounded workflow step. No arbitrary code, no shell interpolation. */
export const workflowStepSchema = z.strictObject({
  stepId: z.string().min(1).max(80),
  kind: z.enum(["invoke", "transform", "condition"]),
  capabilityRef: capabilityRefSchema.optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  /** Closed transform vocabulary; anything richer needs a real capability. */
  transform: z.enum(["select-field", "filter-equals", "map-field", "take", "count"]).optional(),
  condition: z
    .strictObject({
      field: z.string().min(1).max(160),
      operator: z.enum(["equals", "not-equals", "exists", "greater-than", "less-than"]),
      value: z.unknown().optional(),
    })
    .optional(),
  dependsOn: z.array(z.string().min(1).max(80)).max(16),
});
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const actionProposalSchema = z.discriminatedUnion("kind", [
  /** Client-local gesture or canonical view state. Does not call the model. */
  z.strictObject({
    kind: z.literal("view"),
    operation: z.string().min(1).max(120),
    args: z.record(z.string(), z.unknown()),
  }),
  /** Call a capability the registry actually knows about. */
  z.strictObject({
    kind: z.literal("invoke"),
    capabilityRef: capabilityRefSchema,
    args: z.record(z.string(), z.unknown()),
    bindings: z.array(fieldBindingSchema).max(32).optional(),
  }),
  /** Turn a click into a fresh intent with bounded context. */
  z.strictObject({
    kind: z.literal("agent"),
    intent: z.string().min(1).max(2000),
    contextRefs: z.array(z.string().min(1).max(200)).max(32),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
  }),
  /** A bounded multi-step sequence over capabilities already known to work. */
  z.strictObject({
    kind: z.literal("workflow"),
    steps: z.array(workflowStepSchema).min(1).max(16),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type ActionProposal = z.infer<typeof actionProposalSchema>;

/**
 * A compiled, server-owned action binding.
 *
 * The agent proposes; the host compiles. Everything that determines what will
 * actually happen is fixed here — node, account, resource versions, data
 * classes — so a later invocation cannot drift onto a different target. The
 * `bindingDigest` covers exactly that fixed set.
 */
export const actionBindingSchema = z.strictObject({
  actionBindingId: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128),
  definitionId: z.string().min(1).max(160),
  /** Generation of the providing package. A new generation needs a new binding. */
  packageGeneration: z.string().min(1).max(200),
  proposal: actionProposalSchema,
  /** User-visible label. Never treated as a permission. */
  label: z.string().min(1).max(200),
  inputSchema: z.record(z.string(), z.unknown()),
  allowedDataRefs: z.array(z.string().min(1).max(200)).max(64),
  /** Fixed target constraints, if any. Recorded so reauthorization can compare. */
  fixedConstraints: z.strictObject({
    nodeId: z.string().min(1).max(128).optional(),
    connectionRef: z.string().min(1).max(160).optional(),
    resourceId: z.string().min(1).max(200).optional(),
    resourceVersion: z.string().min(1).max(120).optional(),
    accountId: z.string().min(1).max(200).optional(),
  }),
  effectCategory: effectCategorySchema,
  /** Whether the host must obtain fresh approval before each invocation. */
  requiresApproval: z.boolean(),
  /** Token/rate/deadline limits applied before any model call is started. */
  limits: z.strictObject({
    maxTokens: z.int().nonnegative().optional(),
    maxCallsPerMinute: z.int().nonnegative().optional(),
    deadlineMs: z.int().nonnegative().optional(),
  }),
  bindingDigest: z.string().min(1).max(120),
  createdAt: instantSchema,
});
export type ActionBinding = z.infer<typeof actionBindingSchema>;

/**
 * Request body for invoking a bound action.
 *
 * The client sends the revision it saw. A mismatch means the binding or the
 * instance moved underneath it, and the invocation is refused rather than
 * applied to a target the user never saw.
 */
export const actionInvocationSchema = z.strictObject({
  instanceId: z.string().min(1).max(128),
  actionBindingId: z.string().min(1).max(128),
  expectedRevision: z.int().nonnegative(),
  expectedBindingDigest: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()),
  /** Client-generated so a double click produces one accepted effect. */
  invocationId: z.string().min(1).max(128),
});
export type ActionInvocation = z.infer<typeof actionInvocationSchema>;

export type ActionCompileResult =
  | { ok: true; binding: ActionBinding }
  | { ok: false; code: "ACTION_REFERENCE_UNKNOWN" | "ACTION_NOT_PERMITTED" | "ACTION_MALFORMED"; message: string };

/**
 * Compile an action proposal into a binding.
 *
 * The important refusal is `invoke` against a capability the registry does not
 * know: a model naming a tool it imagined must produce a proposal to install
 * something, not an executable binding (acceptance test T40).
 */
export function compileActionBinding(input: {
  bindingId: string;
  instance: Pick<
    WidgetInstance,
    "instanceId" | "ownerNodeId" | "definitionRef" | "actionBindingRevision"
  >;
  packageGeneration: string;
  label: string;
  proposal: ActionProposal;
  inputSchema: Record<string, unknown>;
  allowedDataRefs: string[];
  fixedConstraints: ActionBinding["fixedConstraints"];
  effectCategory: z.infer<typeof effectCategorySchema>;
  requiresApproval: boolean;
  limits: ActionBinding["limits"];
  bindingDigest: string;
  at: Instant;
  knownCapabilities: ReadonlySet<string>;
}): ActionCompileResult {
  const { proposal } = input;

  if (proposal.kind === "invoke" && !input.knownCapabilities.has(proposal.capabilityRef)) {
    return {
      ok: false,
      code: "ACTION_REFERENCE_UNKNOWN",
      message: `capability ${proposal.capabilityRef} is not in the registry; propose an install instead of binding it`,
    };
  }

  if (proposal.kind === "workflow") {
    for (const step of proposal.steps) {
      if (step.kind === "invoke") {
        if (!step.capabilityRef || !input.knownCapabilities.has(step.capabilityRef)) {
          return {
            ok: false,
            code: "ACTION_REFERENCE_UNKNOWN",
            message: `workflow step ${step.stepId} references unknown capability ${String(step.capabilityRef)}`,
          };
        }
      }
      if (step.kind === "transform" && !step.transform) {
        return {
          ok: false,
          code: "ACTION_MALFORMED",
          message: `workflow step ${step.stepId} declares transform kind without a transform`,
        };
      }
    }
    const ids = new Set(proposal.steps.map((step) => step.stepId));
    if (ids.size !== proposal.steps.length) {
      return { ok: false, code: "ACTION_MALFORMED", message: "workflow step ids must be unique" };
    }
    for (const step of proposal.steps) {
      for (const dependency of step.dependsOn) {
        if (!ids.has(dependency)) {
          return {
            ok: false,
            code: "ACTION_MALFORMED",
            message: `workflow step ${step.stepId} depends on unknown step ${dependency}`,
          };
        }
      }
    }
    if (hasDependencyCycle(proposal.steps)) {
      return { ok: false, code: "ACTION_MALFORMED", message: "workflow steps contain a dependency cycle" };
    }
  }

  return {
    ok: true,
    binding: {
      actionBindingId: input.bindingId,
      instanceId: input.instance.instanceId,
      definitionId: input.instance.definitionRef.id,
      packageGeneration: input.packageGeneration,
      proposal,
      label: input.label,
      inputSchema: input.inputSchema,
      allowedDataRefs: input.allowedDataRefs,
      fixedConstraints: input.fixedConstraints,
      effectCategory: input.effectCategory,
      requiresApproval: input.requiresApproval,
      limits: input.limits,
      bindingDigest: input.bindingDigest,
      createdAt: input.at,
    },
  };
}

function hasDependencyCycle(steps: readonly WorkflowStep[]): boolean {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const visiting = new Set<string>();
  const settled = new Set<string>();

  const visit = (id: string): boolean => {
    if (settled.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    settled.add(id);
    return false;
  };

  return steps.some((step) => visit(step.stepId));
}

/**
 * Version comparison for invocations.
 *
 * Presentation-only changes must not invalidate a binding, while a changed tool
 * generation, account, resource version, or digest must. Comparing the digest
 * plus the fixed constraints expresses exactly that.
 */
export function bindingStillValid(
  binding: ActionBinding,
  current: {
    packageGeneration: string;
    bindingDigest: string;
    connectionRef?: string;
    accountId?: string;
    resourceVersion?: string;
  },
): { valid: true } | { valid: false; changed: string[] } {
  const changed: string[] = [];
  if (binding.packageGeneration !== current.packageGeneration) changed.push("packageGeneration");
  if (binding.bindingDigest !== current.bindingDigest) changed.push("bindingDigest");
  if (
    binding.fixedConstraints.connectionRef !== undefined &&
    binding.fixedConstraints.connectionRef !== current.connectionRef
  ) {
    changed.push("connectionRef");
  }
  if (
    binding.fixedConstraints.accountId !== undefined &&
    binding.fixedConstraints.accountId !== current.accountId
  ) {
    changed.push("accountId");
  }
  if (
    binding.fixedConstraints.resourceVersion !== undefined &&
    binding.fixedConstraints.resourceVersion !== current.resourceVersion
  ) {
    changed.push("resourceVersion");
  }
  return changed.length === 0 ? { valid: true } : { valid: false, changed };
}

/* ------------------------------------------------------------------ *
 * Semantic view for voice and accessibility
 * ------------------------------------------------------------------ */

/**
 * A compact description of a widget that voice can act on.
 *
 * Voice and clicking must reach the same action state (acceptance test T66), so
 * both consume this shape rather than each maintaining their own view of what is
 * actionable.
 */
export const semanticViewSchema = z.strictObject({
  instanceId: z.string().min(1).max(128),
  summary: z.string().min(1).max(600),
  selectedIds: z.array(z.string().min(1).max(200)).max(64),
  availableActions: z
    .array(
      z.strictObject({
        actionBindingId: z.string().min(1).max(128),
        label: z.string().min(1).max(200),
        requiresApproval: z.boolean(),
      }),
    )
    .max(64),
  /** Human-readable state, used for text alternatives and screen readers. */
  textRepresentation: z.string().min(1).max(4000),
  dataFreshness: z.strictObject({
    /** When the underlying data was last refreshed. Drives "cached" disclosure. */
    updatedAt: instantSchema.optional(),
    source: z.enum(["live", "cached", "sample", "unknown"]),
  }),
});
export type SemanticView = z.infer<typeof semanticViewSchema>;
