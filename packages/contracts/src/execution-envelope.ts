import { z } from "zod";

import { DEFAULT_ALLOWED_DATA_CLASSES, dataClassSchema } from "./data-class.ts";
import { capabilityRefSchema } from "./grants.ts";
import { hostPathWithin } from "./host-path.ts";
import { connectionIdSchema, effectCategorySchema, nodeIdSchema } from "./primitives.ts";
import { runtimeFeatureNameSchema } from "./runtime-fabric.ts";
import { taskResourceSchema, type TaskResource } from "./tasks.ts";

/**
 * Everything one piece of standing work may touch, in one bounded record.
 *
 * Today a standing automation's task names folders and effect categories, which fits work on a repository and nothing
 * else: "summarise important email every morning" has no folder, and inventing one to satisfy the shape would be a fake
 * resource. The envelope names what the work actually uses — folders where there are folders, capabilities, account
 * connections — together with the effects it may have, the data classes it may carry, where it may run, what it may
 * spend and where its results may be delivered.
 *
 * The envelope is the authority boundary of the work, not a request: anything the work does outside it is refused or
 * asked about, and a run, a delegation or a retry started from it may narrow it but never widen it. It runs through the
 * existing signal, intent and task path; it is not a second scheduler.
 *
 * This is a sketch of the shape standing intents will carry. Nothing reads it yet.
 */

/** The version of the execution envelope. */
export const EXECUTION_ENVELOPE_VERSION = 1;

/** The outcomes a delivery target may be told about. `report` is a scheduled report's regular result. */
export const deliveryOutcomeSchema = z.enum(["succeeded", "failed", "needs-input", "report"]);
export type DeliveryOutcome = z.infer<typeof deliveryOutcomeSchema>;

/**
 * Where a result goes. The conversation the work was set up in, the inbox, this device's notifications, web push, or
 * an external channel through an account connection. A channel is named by connection and a target within it; being
 * connected is not enough, the envelope has to name it.
 */
export const deliveryTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("conversation"), on: z.array(deliveryOutcomeSchema).min(1).max(4) }),
  z.strictObject({ kind: z.literal("inbox"), on: z.array(deliveryOutcomeSchema).min(1).max(4) }),
  z.strictObject({ kind: z.literal("os-notification"), on: z.array(deliveryOutcomeSchema).min(1).max(4) }),
  z.strictObject({ kind: z.literal("web-push"), on: z.array(deliveryOutcomeSchema).min(1).max(4) }),
  z.strictObject({
    kind: z.literal("channel"),
    connectionId: connectionIdSchema,
    /** The chat, channel or thread inside that connection, as the person named it. */
    target: z.string().min(1).max(200),
    on: z.array(deliveryOutcomeSchema).min(1).max(4),
  }),
]);
export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;

/** The most items one list in an envelope carries. */
export const EXECUTION_ENVELOPE_LIST_MAX = 16;

/**
 * An absent list means none: no folders, no capabilities, no connections, no delivery. The exception is `dataClasses`,
 * where absent means the classes a profile that names none may carry (`DEFAULT_ALLOWED_DATA_CLASSES`).
 */
export const executionEnvelopeSchema = z
  .strictObject({
    version: z.literal(EXECUTION_ENVELOPE_VERSION),
    resources: z.array(taskResourceSchema).max(8).optional(),
    capabilities: z.array(capabilityRefSchema).max(EXECUTION_ENVELOPE_LIST_MAX).optional(),
    connections: z.array(connectionIdSchema).max(EXECUTION_ENVELOPE_LIST_MAX).optional(),
    allowedEffects: z.array(effectCategorySchema).max(8),
    dataClasses: z.array(dataClassSchema).min(1).max(4).optional(),
    /**
     * Where the work may run: on one of these nodes, and through a runtime that supports these traits. Constraints,
     * never a runtime name — which runtime runs it is the host's choice inside them.
     */
    executor: z
      .strictObject({
        nodeIds: z.array(nodeIdSchema).min(1).max(8).optional(),
        requiredFeatures: z.array(runtimeFeatureNameSchema).max(EXECUTION_ENVELOPE_LIST_MAX).optional(),
      })
      .optional(),
    budget: z
      .strictObject({
        maxWallClockMs: z.int().positive().optional(),
        maxTokens: z.int().positive().optional(),
        maxCostUsd: z.number().positive().optional(),
      })
      .optional(),
    deliveryTargets: z.array(deliveryTargetSchema).max(8).optional(),
  })
  .superRefine((envelope, ctx) => {
    for (const [index, target] of (envelope.deliveryTargets ?? []).entries()) {
      if (target.kind !== "channel") continue;
      if (!envelope.allowedEffects.includes("communication")) {
        ctx.addIssue({
          code: "custom",
          path: ["deliveryTargets", index],
          message: "sending to a channel is a communication effect, which this envelope does not allow",
        });
      }
      if (!(envelope.connections ?? []).includes(target.connectionId)) {
        ctx.addIssue({
          code: "custom",
          path: ["deliveryTargets", index, "connectionId"],
          message: `${target.connectionId} is not one of this envelope's connections`,
        });
      }
    }
  });
export type ExecutionEnvelope = z.infer<typeof executionEnvelopeSchema>;

function missing<T>(inner: readonly T[] | undefined, outer: readonly T[] | undefined, key: (item: T) => string): T[] {
  const allowed = new Set((outer ?? []).map(key));
  return (inner ?? []).filter((item) => !allowed.has(key(item)));
}

/**
 * Whether `outer` grants `inner`. A repository is granted only by the same repository. A folder is granted by the same
 * folder or one that contains it, with the same access or write (which covers reading). Containment is compared segment
 * by segment and only between absolute normalized paths; any other path must match exactly, because a relative or
 * unnormalized path cannot be placed inside another without the machine that resolves it.
 *
 * A task resource names a path without a node, so two machines' folders at the same path compare as the same folder.
 * Binding resources to a node is #209's; until then an envelope that needs to tell nodes apart restricts
 * `executor.nodeIds`.
 */
function resourceCovers(outer: TaskResource, inner: TaskResource): boolean {
  if (outer.kind === "repository" || inner.kind === "repository") {
    return outer.kind === inner.kind && outer.path === inner.path;
  }
  if (outer.access === "read" && inner.access === "write") return false;
  return outer.path === inner.path || hostPathWithin(inner.path, outer.path);
}

function targetKey(target: DeliveryTarget): string {
  return JSON.stringify(target.kind === "channel" ? [target.kind, target.connectionId, target.target] : [target.kind]);
}

/**
 * How `inner` reaches beyond `outer`, one sentence per difference. Empty when `inner` stays inside: a run, retry or
 * delegation started from an envelope must, because authority narrows as work is handed on and never widens.
 *
 * A budget or an executor constraint that `outer` sets and `inner` drops or loosens is a widening; one `outer` leaves
 * open may be anything in `inner`.
 */
export function envelopeWidening(inner: ExecutionEnvelope, outer: ExecutionEnvelope): string[] {
  const out: string[] = [];
  for (const resource of inner.resources ?? []) {
    if (!(outer.resources ?? []).some((granted) => resourceCovers(granted, resource))) {
      out.push(`the ${resource.kind} ${resource.path}${resource.kind === "folder" ? ` (${resource.access})` : ""}`);
    }
  }
  for (const ref of missing(inner.capabilities, outer.capabilities, String)) out.push(`the capability ${ref}`);
  for (const id of missing(inner.connections, outer.connections, String)) out.push(`the connection ${id}`);
  for (const effect of missing(inner.allowedEffects, outer.allowedEffects, String)) out.push(`the ${effect} effect`);
  const innerClasses = inner.dataClasses ?? DEFAULT_ALLOWED_DATA_CLASSES;
  for (const dataClass of missing(innerClasses, outer.dataClasses ?? DEFAULT_ALLOWED_DATA_CLASSES, String)) {
    out.push(`${dataClass} data`);
  }

  const outerNodes = outer.executor?.nodeIds;
  if (outerNodes !== undefined) {
    const innerNodes = inner.executor?.nodeIds;
    if (innerNodes === undefined) out.push("any node");
    else for (const node of missing(innerNodes, outerNodes, String)) out.push(`the node ${node}`);
  }
  for (const feature of missing(outer.executor?.requiredFeatures, inner.executor?.requiredFeatures, String)) {
    out.push(`a runtime without ${feature}`);
  }

  for (const limit of ["maxWallClockMs", "maxTokens", "maxCostUsd"] as const) {
    const bound = outer.budget?.[limit];
    if (bound === undefined) continue;
    const own = inner.budget?.[limit];
    if (own === undefined || own > bound) out.push(`${limit} above ${String(bound)}`);
  }

  // The same target may be listed more than once; what it may be told is everything those entries allow together.
  const outerTargets = new Map<string, Set<DeliveryOutcome>>();
  for (const target of outer.deliveryTargets ?? []) {
    const key = targetKey(target);
    const allowed = outerTargets.get(key) ?? new Set<DeliveryOutcome>();
    for (const outcome of target.on) allowed.add(outcome);
    outerTargets.set(key, allowed);
  }
  for (const target of inner.deliveryTargets ?? []) {
    const allowed = outerTargets.get(targetKey(target));
    const label = target.kind === "channel" ? `${target.target} on ${target.connectionId}` : target.kind;
    if (allowed === undefined) out.push(`delivery to ${label}`);
    else for (const outcome of target.on.filter((item) => !allowed.has(item))) out.push(`delivery of ${outcome} to ${label}`);
  }
  return out;
}
