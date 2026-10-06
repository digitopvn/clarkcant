import { z } from "zod";

import { acquisitionSourceSchema } from "./capability-discovery.ts";
import { dataClassSchema } from "./data-class.ts";
import { riskLaneSchema } from "./directory.ts";
import { capabilityRefSchema } from "./grants.ts";
import { networkOriginSchema } from "./network-origin.ts";
import {
  capabilityCandidateIdSchema,
  instantSchema,
  nodeIdSchema,
  reachExpansionPlanIdSchema,
  runtimeIdSchema,
  taskIdSchema,
} from "./primitives.ts";

/**
 * Asking once before Clark reaches further.
 *
 * Inside what is already granted, Clark acts without asking. When closing a gap would widen what it reaches — read a
 * new folder, install or enable code, connect a server or an account, send data to someone new, let another runtime or
 * node do more — every one of those steps is gathered into one plan and asked about once, in one place: what Clark is
 * trying to do, the option it recommends and the real alternatives, and for each exactly what it would reach.
 *
 * Consent binds to that reach, item by item. A later request that reaches further than what was consented to is a new
 * question; one that reaches less is covered. The purpose sentences are said to the person but are not part of the
 * binding: rewording a purpose changes what is said, not what is reached.
 *
 * The plan decides nothing and grants nothing. Whether a question is needed at all is the execution policy's call, and
 * acquiring, enabling and connecting go through the host's existing install, connection and policy paths.
 */

/** The version of the reach-expansion plan. */
export const REACH_EXPANSION_VERSION = 1;

const purposeSchema = z.string().min(1).max(300);

/** Who may be given new access: an agent runtime, or a paired node. */
export const accessHolderSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("runtime"), runtimeId: runtimeIdSchema }),
  z.strictObject({ kind: z.literal("node"), nodeId: nodeIdSchema }),
]);
export type AccessHolder = z.infer<typeof accessHolderSchema>;

/** The most items one list in a plan carries. A plan that needs more is not one a person can read and decide. */
export const REACH_EXPANSION_LIST_MAX = 16;

/** Everything one option would reach that is not reached today. Each list is compared item by item. */
export const acquisitionReachSchema = z.strictObject({
  /** Folders on this machine, as the person would recognise them, and whether they would be read or written. */
  filesystem: z
    .array(z.strictObject({ path: z.string().min(1).max(1000), access: z.enum(["read", "write"]), purpose: purposeSchema }))
    .max(REACH_EXPANSION_LIST_MAX),
  networkOrigins: z.array(z.strictObject({ origin: networkOriginSchema, purpose: purposeSchema })).max(REACH_EXPANSION_LIST_MAX),
  /** Who would receive data, and of which classes: a service, a channel, a person. */
  dataRecipients: z
    .array(
      z.strictObject({
        recipient: z.string().min(1).max(200),
        dataClasses: z.array(dataClassSchema).min(1).max(4),
        purpose: purposeSchema,
      }),
    )
    .max(REACH_EXPANSION_LIST_MAX),
  /** Credentials by name and account, never by value. */
  credentials: z
    .array(z.strictObject({ name: z.string().min(1).max(120), account: z.string().min(1).max(200).optional(), purpose: purposeSchema }))
    .max(REACH_EXPANSION_LIST_MAX),
  /** Capabilities a runtime or a paired node would be allowed to use. */
  grants: z
    .array(
      z.strictObject({
        to: accessHolderSchema,
        capabilityRefs: z.array(capabilityRefSchema).min(1).max(REACH_EXPANSION_LIST_MAX),
        purpose: purposeSchema,
      }),
    )
    .max(REACH_EXPANSION_LIST_MAX),
});
export type AcquisitionReach = z.infer<typeof acquisitionReachSchema>;

/** One step the option takes, in a sentence a person reads. */
export const acquisitionActionSchema = z.strictObject({
  kind: z.enum(["install", "enable", "connect", "grant"]),
  summary: z.string().min(1).max(300),
});
export type AcquisitionAction = z.infer<typeof acquisitionActionSchema>;

/** What taking one candidate would take: its steps, what it would reach and the lane its code would run in. */
export const acquisitionPlanSchema = z.strictObject({
  candidateId: capabilityCandidateIdSchema,
  /** What this option does for the goal, in a sentence. */
  summary: z.string().min(1).max(300),
  /** What is installed or connected, in a form the host verifies before using it. */
  acquisition: acquisitionSourceSchema.optional(),
  actions: z.array(acquisitionActionSchema).min(1).max(REACH_EXPANSION_LIST_MAX),
  reach: acquisitionReachSchema,
  trustLane: riskLaneSchema,
});
export type AcquisitionPlan = z.infer<typeof acquisitionPlanSchema>;

/**
 * How long a yes lasts. `once`: this plan only. `task`: anything the same task asks within the same reach. `standing`:
 * a preference the person keeps for this candidate within the same reach, until they take it back.
 */
export const consentScopeSchema = z.enum(["once", "task", "standing"]);
export type ConsentScope = z.infer<typeof consentScopeSchema>;

/** The most alternatives a plan offers beside its recommendation. More is a list to read, not a choice to make. */
export const REACH_EXPANSION_ALTERNATIVES_MAX = 3;

export const reachExpansionPlanSchema = z
  .strictObject({
    version: z.literal(REACH_EXPANSION_VERSION),
    planId: reachExpansionPlanIdSchema,
    /** What Clark is trying to accomplish, in the person's terms. */
    goal: z.string().min(1).max(500),
    /** The task this plan unblocks. It resumes once the chosen option is acquired and verified. */
    taskId: taskIdSchema.optional(),
    recommended: acquisitionPlanSchema,
    alternatives: z.array(acquisitionPlanSchema).max(REACH_EXPANSION_ALTERNATIVES_MAX),
    /** The scopes the person may choose from. */
    consentOptions: z.array(consentScopeSchema).min(1).max(3),
    createdAt: instantSchema,
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    for (const [index, option] of [plan.recommended, ...plan.alternatives].entries()) {
      if (seen.has(option.candidateId)) {
        ctx.addIssue({
          code: "custom",
          path: index === 0 ? ["recommended"] : ["alternatives", index - 1],
          message: `${option.candidateId} is offered twice; each option is a different candidate`,
        });
      }
      seen.add(option.candidateId);
    }
    if (new Set(plan.consentOptions).size !== plan.consentOptions.length) {
      ctx.addIssue({ code: "custom", path: ["consentOptions"], message: "each consent scope is offered once" });
    }
    if (plan.consentOptions.includes("task") && plan.taskId === undefined) {
      ctx.addIssue({ code: "custom", path: ["consentOptions"], message: "consent for the task needs the task the plan is for" });
    }
  });
export type ReachExpansionPlan = z.infer<typeof reachExpansionPlanSchema>;

/** A person's yes to one option of one plan, with the reach it was given for. */
export const reachConsentSchema = z.strictObject({
  version: z.literal(REACH_EXPANSION_VERSION),
  planId: reachExpansionPlanIdSchema,
  candidateId: capabilityCandidateIdSchema,
  scope: consentScopeSchema,
  /** Present when the scope is `task`. */
  taskId: taskIdSchema.optional(),
  acquisition: acquisitionSourceSchema.optional(),
  reach: acquisitionReachSchema,
  trustLane: riskLaneSchema,
  decidedAt: instantSchema,
});
export type ReachConsent = z.infer<typeof reachConsentSchema>;

/** The consent a person gives by choosing an option and a scope the plan offered, or why that choice is not one. */
export function reachConsentFor(
  plan: ReachExpansionPlan,
  choice: { candidateId: string; scope: ConsentScope; decidedAt: ReachConsent["decidedAt"] },
): ReachConsent | string {
  const option = [plan.recommended, ...plan.alternatives].find((item) => item.candidateId === choice.candidateId);
  if (option === undefined) return `${choice.candidateId} is not an option this plan offers`;
  if (!plan.consentOptions.includes(choice.scope)) return `this plan does not offer consent for ${choice.scope}`;
  return {
    version: REACH_EXPANSION_VERSION,
    planId: plan.planId,
    candidateId: option.candidateId,
    scope: choice.scope,
    ...(choice.scope === "task" && plan.taskId !== undefined ? { taskId: plan.taskId } : {}),
    ...(option.acquisition === undefined ? {} : { acquisition: option.acquisition }),
    reach: option.reach,
    trustLane: option.trustLane,
    decidedAt: choice.decidedAt,
  };
}

interface ReachItem {
  sentence: string;
  /** Another item that covers this one: write access to a folder covers reading it. */
  coveredBy?: string;
}

/** The canonical items of a reach, one key per thing reached, with a sentence for each. Purposes are left out. */
function reachItems(reach: AcquisitionReach): Map<string, ReachItem> {
  const items = new Map<string, ReachItem>();
  for (const entry of reach.filesystem) {
    items.set(JSON.stringify(["fs", entry.path, entry.access]), {
      sentence: `${entry.access} ${entry.path}`,
      ...(entry.access === "read" ? { coveredBy: JSON.stringify(["fs", entry.path, "write"]) } : {}),
    });
  }
  for (const entry of reach.networkOrigins) items.set(JSON.stringify(["origin", entry.origin]), { sentence: `reach ${entry.origin}` });
  for (const entry of reach.dataRecipients) {
    for (const dataClass of entry.dataClasses) {
      items.set(JSON.stringify(["recipient", entry.recipient, dataClass]), { sentence: `send ${dataClass} data to ${entry.recipient}` });
    }
  }
  for (const entry of reach.credentials) {
    items.set(JSON.stringify(["credential", entry.name, entry.account ?? null]), {
      sentence: `use the credential ${entry.name}${entry.account === undefined ? "" : ` for ${entry.account}`}`,
    });
  }
  for (const entry of reach.grants) {
    const holder = entry.to.kind === "runtime" ? entry.to.runtimeId : entry.to.nodeId;
    for (const ref of entry.capabilityRefs) items.set(JSON.stringify(["grant", holder, ref]), { sentence: `let ${holder} use ${ref}` });
  }
  return items;
}

/**
 * What `requested` reaches that `consented` does not, one sentence per item, in a stable order. Empty when the request
 * stays inside the consent.
 */
export function reachWidening(consented: AcquisitionReach, requested: AcquisitionReach): string[] {
  const given = reachItems(consented);
  return [...reachItems(requested).entries()]
    .filter(([key, item]) => !given.has(key) && (item.coveredBy === undefined || !given.has(item.coveredBy)))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item.sentence);
}

function sameAcquisition(a: ReachConsent["acquisition"], b: AcquisitionPlan["acquisition"]): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Why an earlier consent does not cover what an option now asks, or `undefined` when it does.
 *
 * It covers only the same candidate, acquired in the same form, running in the same lane, reaching no further than
 * what was consented to. `once` covers only the plan it was given for; `task` only the same task; `standing` any later
 * plan within those bounds.
 */
export function consentDoesNotCover(
  consent: ReachConsent,
  request: { planId: ReachExpansionPlan["planId"]; taskId?: ReachExpansionPlan["taskId"]; option: AcquisitionPlan },
): string | undefined {
  const { option } = request;
  if (consent.candidateId !== option.candidateId) return "the consent was given for another option";
  if (!sameAcquisition(consent.acquisition, option.acquisition)) return "what would be acquired is not what was consented to";
  if (consent.trustLane !== option.trustLane) return `the option now runs as ${option.trustLane}, not ${consent.trustLane}`;
  if (consent.scope === "once" && consent.planId !== request.planId) return "the consent was for one question only";
  if (consent.scope === "task" && (consent.taskId === undefined || consent.taskId !== request.taskId)) {
    return "the consent was for another task";
  }
  const wider = reachWidening(consent.reach, option.reach);
  if (wider.length > 0) return `it now also asks to ${wider.join("; ")}`;
  return undefined;
}
