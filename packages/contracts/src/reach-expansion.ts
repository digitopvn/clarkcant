import { z } from "zod";

import { acquisitionSourceSchema } from "./capability-discovery.ts";
import { dataClassSchema } from "./data-class.ts";
import { riskLaneSchema } from "./directory.ts";
import { capabilityRefSchema } from "./grants.ts";
import { absoluteHostPathSchema, hostPathWithin } from "./host-path.ts";
import { networkOriginSchema } from "./network-origin.ts";
import {
  capabilityCandidateIdSchema,
  connectionIdSchema,
  instantSchema,
  nodeIdSchema,
  principalIdSchema,
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
 * Consent binds to what was shown: the thing acquired (its verifiable source and where it runs), the capabilities it
 * provides, the kinds of step taken, the lane its code runs in, and the reach, item by item. A later request that goes
 * beyond any of these is a new question; one that stays inside is covered. The purpose sentences are said to the
 * person but are not part of the binding: rewording a purpose changes what is said, not what is reached.
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

/**
 * Who would receive data: a service at a network origin, a target inside an account connection (a chat, a channel, a
 * mailbox), or a principal Clark knows. Never free text, so consent names a recipient that can be compared.
 */
export const dataRecipientSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("origin"), origin: networkOriginSchema }),
  z.strictObject({ kind: z.literal("connection"), connectionId: connectionIdSchema, target: z.string().min(1).max(200) }),
  z.strictObject({ kind: z.literal("principal"), principalId: principalIdSchema }),
]);
export type DataRecipient = z.infer<typeof dataRecipientSchema>;

/** The most items one list in a plan carries. A plan that needs more is not one a person can read and decide. */
export const REACH_EXPANSION_LIST_MAX = 16;

/** Everything one option would reach that is not reached today. Each list is compared item by item. */
export const acquisitionReachSchema = z.strictObject({
  /** Folders, each on one node, by absolute normalized path, and whether they would be read or written. */
  filesystem: z
    .array(
      z.strictObject({
        nodeId: nodeIdSchema,
        path: absoluteHostPathSchema,
        access: z.enum(["read", "write"]),
        purpose: purposeSchema,
      }),
    )
    .max(REACH_EXPANSION_LIST_MAX),
  networkOrigins: z.array(z.strictObject({ origin: networkOriginSchema, purpose: purposeSchema })).max(REACH_EXPANSION_LIST_MAX),
  /** Who would receive data, and of which classes. */
  dataRecipients: z
    .array(
      z.strictObject({
        recipient: dataRecipientSchema,
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

export const acquisitionStepKindSchema = z.enum(["install", "enable", "connect", "grant"]);
export type AcquisitionStepKind = z.infer<typeof acquisitionStepKindSchema>;

/** One step the option takes, in a sentence a person reads. */
export const acquisitionActionSchema = z.strictObject({
  kind: acquisitionStepKindSchema,
  summary: z.string().min(1).max(300),
});
export type AcquisitionAction = z.infer<typeof acquisitionActionSchema>;

/** Where the acquired thing runs: a node, or an agent runtime on a node. */
export const acquisitionLocationSchema = z.strictObject({ nodeId: nodeIdSchema, runtimeId: runtimeIdSchema.optional() });
export type AcquisitionLocation = z.infer<typeof acquisitionLocationSchema>;

/** What taking one candidate would take: its steps, what it would reach and the lane its code would run in. */
export const acquisitionPlanSchema = z
  .strictObject({
    candidateId: capabilityCandidateIdSchema,
    /** What this option does for the goal, in a sentence. */
    summary: z.string().min(1).max(300),
    /** What is installed or connected, in a form the host verifies before using it. Required when a step installs. */
    acquisition: acquisitionSourceSchema.optional(),
    location: acquisitionLocationSchema.optional(),
    /** The capabilities the option would make usable. */
    provides: z.array(capabilityRefSchema).min(1).max(REACH_EXPANSION_LIST_MAX),
    actions: z.array(acquisitionActionSchema).min(1).max(REACH_EXPANSION_LIST_MAX),
    reach: acquisitionReachSchema,
    trustLane: riskLaneSchema,
  })
  .superRefine((plan, ctx) => {
    if (plan.acquisition === undefined && plan.actions.some((action) => action.kind === "install")) {
      ctx.addIssue({
        code: "custom",
        path: ["acquisition"],
        message: "an option that installs something names the verifiable source it installs from",
      });
    }
  });
export type AcquisitionPlan = z.infer<typeof acquisitionPlanSchema>;

/**
 * How long a yes lasts. `once`: this plan only — that it is used a single time is the consent store's to enforce, by
 * spending it. `task`: anything the same task asks within the same bounds. `standing`: a preference the person keeps
 * for the same thing within the same bounds, until they take it back.
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

/** A person's yes to one option of one plan, with everything it was given for. */
export const reachConsentSchema = z
  .strictObject({
    version: z.literal(REACH_EXPANSION_VERSION),
    planId: reachExpansionPlanIdSchema,
    candidateId: capabilityCandidateIdSchema,
    scope: consentScopeSchema,
    /** Required when the scope is `task`. */
    taskId: taskIdSchema.optional(),
    acquisition: acquisitionSourceSchema.optional(),
    location: acquisitionLocationSchema.optional(),
    provides: z.array(capabilityRefSchema).min(1).max(REACH_EXPANSION_LIST_MAX),
    /** The kinds of step the person saw. A later step of another kind is a new question. */
    steps: z.array(acquisitionStepKindSchema).min(1).max(4),
    reach: acquisitionReachSchema,
    trustLane: riskLaneSchema,
    decidedAt: instantSchema,
  })
  .superRefine((consent, ctx) => {
    if (consent.scope === "task" && consent.taskId === undefined) {
      ctx.addIssue({ code: "custom", path: ["taskId"], message: "consent for a task names the task" });
    }
  });
export type ReachConsent = z.infer<typeof reachConsentSchema>;

function stepKinds(option: AcquisitionPlan): AcquisitionStepKind[] {
  return acquisitionStepKindSchema.options.filter((kind) => option.actions.some((action) => action.kind === kind));
}

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
    ...(option.location === undefined ? {} : { location: option.location }),
    provides: option.provides,
    steps: stepKinds(option),
    reach: option.reach,
    trustLane: option.trustLane,
    decidedAt: choice.decidedAt,
  };
}

interface ReachItem {
  sentence: string;
}

type FilesystemReach = AcquisitionReach["filesystem"][number];

/** A folder covers itself and every folder inside it on the same node; writing covers reading. */
function folderCovers(given: FilesystemReach, wanted: FilesystemReach): boolean {
  return (
    given.nodeId === wanted.nodeId &&
    (given.access === "write" || wanted.access === "read") &&
    hostPathWithin(wanted.path, given.path)
  );
}

function recipientLabel(recipient: DataRecipient): string {
  if (recipient.kind === "origin") return recipient.origin;
  if (recipient.kind === "connection") return `${recipient.target} on ${recipient.connectionId}`;
  return recipient.principalId;
}

/**
 * The canonical items of a reach other than folders, one key per thing reached, with a sentence for each. Purposes are
 * left out. Folders are compared by containment instead, in `reachWidening`.
 */
function reachItems(reach: AcquisitionReach): Map<string, ReachItem> {
  const items = new Map<string, ReachItem>();
  for (const entry of reach.networkOrigins) items.set(JSON.stringify(["origin", entry.origin]), { sentence: `reach ${entry.origin}` });
  for (const entry of reach.dataRecipients) {
    for (const dataClass of entry.dataClasses) {
      items.set(JSON.stringify(["recipient", entry.recipient, dataClass]), {
        sentence: `send ${dataClass} data to ${recipientLabel(entry.recipient)}`,
      });
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
  const wider: [string, string][] = [...reachItems(requested).entries()]
    .filter(([key]) => !given.has(key))
    .map(([key, item]) => [key, item.sentence]);
  for (const wanted of requested.filesystem) {
    if (consented.filesystem.some((entry) => folderCovers(entry, wanted))) continue;
    wider.push([JSON.stringify(["fs", wanted.nodeId, wanted.path, wanted.access]), `${wanted.access} ${wanted.path} on ${wanted.nodeId}`]);
  }
  return wider.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, sentence]) => sentence);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Why an earlier consent does not cover what an option now asks, or `undefined` when it does.
 *
 * It covers the same thing — acquired from the same verifiable source and running in the same place — providing no
 * capability beyond those consented to, taking no kind of step beyond those shown, in the same lane, reaching no
 * further. `once` covers only the plan it was given for and the same candidate; `task` only the same task and candidate;
 * `standing` any later plan for the same thing, whatever id discovery gave it then. A standing consent for something
 * with neither a source nor a location has no stable identity, so it stays bound to the candidate id.
 */
export function consentDoesNotCover(
  consent: ReachConsent,
  request: { planId: ReachExpansionPlan["planId"]; taskId?: ReachExpansionPlan["taskId"]; option: AcquisitionPlan },
): string | undefined {
  const { option } = request;
  const anchored = consent.acquisition !== undefined || consent.location !== undefined;
  if ((consent.scope !== "standing" || !anchored) && consent.candidateId !== option.candidateId) {
    return "the consent was given for another option";
  }
  if (!same(consent.acquisition, option.acquisition)) return "what would be acquired is not what was consented to";
  if (!same(consent.location, option.location)) return "it would run somewhere other than where it was consented to";
  if (consent.trustLane !== option.trustLane) return `the option now runs as ${option.trustLane}, not ${consent.trustLane}`;
  if (consent.scope === "once" && consent.planId !== request.planId) return "the consent was for one question only";
  if (consent.scope === "task" && consent.taskId !== request.taskId) return "the consent was for another task";
  const newSteps = stepKinds(option).filter((kind) => !consent.steps.includes(kind));
  if (newSteps.length > 0) return `it now also needs to ${newSteps.join(" and ")}`;
  const newCapabilities = option.provides.filter((ref) => !consent.provides.includes(ref));
  if (newCapabilities.length > 0) return `it now also provides ${newCapabilities.join(", ")}`;
  const wider = reachWidening(consent.reach, option.reach);
  if (wider.length > 0) return `it now also asks to ${wider.join("; ")}`;
  return undefined;
}
