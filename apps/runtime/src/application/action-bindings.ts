import {
  type ActionBinding,
  type ActionProposal,
  type CapabilityRef,
  type EffectCategory,
  type WidgetInstance,
  actionProposalSchema,
  capabilityRefSchema,
  compileActionBinding,
} from "@clarkcant/contracts";
import { M1_VIEW_OPERATIONS, getCapability, invocationPreflight } from "@clarkcant/core";
import { asJsonValue, type Database, payloadDigest } from "@clarkcant/storage";

import type { ServiceHost } from "../service-host.ts";
import { isGenerationOf, validateArgs } from "./capability-invoke.ts";

/**
 * Action bindings the host makes and reads for a widget: compiling what a model proposed, and saying whether a binding
 * can run right now.
 *
 * Both live here because every surface asks the same two questions. The model's `show_view` compiles; the timeline,
 * the frame route and the voice resolver ask for availability. A second copy of either would be a second opinion about
 * what a button does, and the first place a disabled button and a refused click would disagree.
 */

export interface ActionBindingDeps {
  db: Database;
  nodeId: string;
  /** Absent on a node that runs no package services, where no `invoke` binding can be made or run. */
  serviceHost?: Pick<ServiceHost, "serves"> | undefined;
  now: () => string;
  newId: (prefix: string) => string;
}

/**
 * A compiled action, not yet tied to an instance.
 *
 * Compiled before the instance exists so a proposal the host refuses leaves nothing behind: the model reads the refusal
 * and no button without an action is stored. `bindTo` fixes the instance once it has been made; the digest does not
 * cover the instance id, so the binding it returns is the one that was checked.
 */
export type WidgetActionCompile =
  | { ok: true; bindTo: (instanceId: string) => ActionBinding }
  | { ok: false; message: string };

/** The only view operation a button can perform: the others need input a button does not carry. */
const BUTTON_VIEW_OPERATION = "view.save";

/** Most severe first, so a workflow is described by the worst thing any of its steps may do. */
const SEVERITY: readonly EffectCategory[] = [
  "destructive",
  "financial",
  "external-write",
  "communication",
  "media-capture",
  "local-write",
  "read",
];

function proposalProblem(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length === 0 ? "action" : `action.${issue.path.map(String).join(".")}`}: ${issue.message}`)
    .join("; ");
}

/**
 * Compile the action a model asked a button to perform.
 *
 * Everything that decides what the button does is fixed here and never taken from the model afterwards: an `invoke`
 * records the capability's own effect category from the registry and the package generation serving it now, so a later
 * update makes the binding stale rather than retargeting it. A refusal is a sentence the model reads in the same turn.
 */
export function compileWidgetAction(
  deps: ActionBindingDeps,
  input: { definitionRef: WidgetInstance["definitionRef"]; label: string; action: unknown },
): WidgetActionCompile {
  // `contextRefs` is required by the proposal format; a model that has none to give may leave it out.
  const raw =
    typeof input.action === "object" &&
    input.action !== null &&
    (input.action as { kind?: unknown }).kind === "agent" &&
    (input.action as { contextRefs?: unknown }).contextRefs === undefined
      ? { ...(input.action as Record<string, unknown>), contextRefs: [] }
      : input.action;
  const parsed = actionProposalSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: `the action is not one a button can hold: ${proposalProblem(parsed.error.issues)}` };
  const proposal: ActionProposal = parsed.data;

  const instanceGeneration = input.definitionRef.packageDigest;
  let packageGeneration = instanceGeneration;
  let effectCategory: EffectCategory = "read";
  const knownCapabilities = new Set<string>();

  switch (proposal.kind) {
    case "view": {
      if (proposal.operation !== BUTTON_VIEW_OPERATION) {
        return {
          ok: false,
          message: `a button can only perform the view operation "${BUTTON_VIEW_OPERATION}" (pin this view); "${proposal.operation}" needs input a button does not carry`,
        };
      }
      // Saving pins the view, which is a write to this node's own records.
      effectCategory = "local-write";
      break;
    }
    case "invoke": {
      const ref = capabilityRefSchema.safeParse(proposal.capabilityRef);
      if (!ref.success) return { ok: false, message: `${proposal.capabilityRef} is not a capability reference` };
      const served = deps.serviceHost?.serves(ref.data as CapabilityRef);
      if (served === undefined) {
        return {
          ok: false,
          message: `${proposal.capabilityRef} is not provided by an active package's service on this node; a button can only call one that is`,
        };
      }
      const descriptor = getCapability({ db: deps.db, nodeId: deps.nodeId }, ref.data as CapabilityRef, deps.nodeId);
      if (descriptor === undefined) {
        return { ok: false, message: `${proposal.capabilityRef} is not registered on this node yet` };
      }
      const fromInvocation = (proposal.bindings ?? []).filter((field) => field.source !== "literal");
      if (fromInvocation.length > 0) {
        return {
          ok: false,
          message: `a button carries no input, so ${fromInvocation.map((field) => field.target).join(", ")} must be fixed as a literal or in args`,
        };
      }
      const args: Record<string, unknown> = { ...proposal.args };
      for (const field of proposal.bindings ?? []) args[field.target] = field.value;
      const checked = validateArgs(descriptor.inputSchema, args);
      if (!checked.ok) return { ok: false, message: `${proposal.capabilityRef} does not accept those arguments: ${checked.message}` };
      packageGeneration = served.generationId;
      effectCategory = descriptor.effectCategory;
      knownCapabilities.add(proposal.capabilityRef);
      break;
    }
    case "agent": {
      if (proposal.contextRefs.length > 0) {
        return {
          ok: false,
          message: "context references are not resolved for a button yet; put what the request needs in intent",
        };
      }
      // Starting a turn changes nothing by itself; whatever the turn then does passes the policy on its own.
      break;
    }
    case "workflow": {
      const categories: EffectCategory[] = [];
      for (const step of proposal.steps) {
        if (step.kind !== "invoke" || step.capabilityRef === undefined) continue;
        const descriptor = deps.serviceHost?.serves(step.capabilityRef as CapabilityRef)
          ? getCapability({ db: deps.db, nodeId: deps.nodeId }, step.capabilityRef as CapabilityRef, deps.nodeId)
          : undefined;
        if (descriptor === undefined) continue;
        knownCapabilities.add(step.capabilityRef);
        categories.push(descriptor.effectCategory);
      }
      effectCategory = SEVERITY.find((category) => categories.includes(category)) ?? "read";
      break;
    }
  }

  const compiled = compileActionBinding({
    bindingId: deps.newId("act"),
    instance: { instanceId: "pending", ownerNodeId: deps.nodeId, definitionRef: input.definitionRef, actionBindingRevision: 1 },
    packageGeneration,
    label: input.label,
    proposal,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    allowedDataRefs: [],
    fixedConstraints: {},
    effectCategory,
    // Whether a click needs an approval is the execution policy's decision at the click, not a flag frozen here.
    requiresApproval: false,
    limits: {},
    bindingDigest: `sha256:${payloadDigest(asJsonValue({ proposal, packageGeneration, effectCategory, label: input.label }))}`,
    at: deps.now() as never,
    knownCapabilities,
  });
  if (!compiled.ok) return { ok: false, message: compiled.message };
  const { binding } = compiled;
  return { ok: true, bindTo: (instanceId) => ({ ...binding, instanceId }) };
}

export type BindingAvailability =
  | { available: true }
  | { available: false; code: string; reason: string; capabilityRef?: string };

/**
 * Whether a binding can run right now, and if not, the reason a click would be refused with.
 *
 * Read at the same moment the surface is drawn, so a button shows the node's real answer: a service that crashed or a
 * package that was updated is a disabled button with that reason, not a live one that fails when pressed. The click is
 * still checked again when it arrives, because this answer can be out of date by then.
 */
export function bindingAvailability(
  deps: Pick<ActionBindingDeps, "db" | "nodeId" | "serviceHost">,
  binding: ActionBinding,
): BindingAvailability {
  const { proposal } = binding;
  switch (proposal.kind) {
    case "view":
      return (M1_VIEW_OPERATIONS as readonly string[]).includes(proposal.operation)
        ? { available: true }
        : { available: false, code: "UNSUPPORTED_ACTION", reason: `"${proposal.operation}" is not a view operation this node performs` };
    case "agent":
      return { available: true };
    case "workflow":
      return { available: false, code: "WORKFLOW_UNSUPPORTED", reason: "this node cannot run a workflow action yet" };
    case "invoke": {
      const ref = proposal.capabilityRef;
      // The same first question the invoke path asks: a row the registry holds is not a service this node runs.
      const served = deps.serviceHost?.serves(ref as CapabilityRef);
      if (served === undefined) {
        return {
          available: false,
          code: "NOT_A_SERVICE_CAPABILITY",
          reason: `${ref} is not provided by an active package's service on this node`,
          capabilityRef: ref,
        };
      }
      if (binding.packageGeneration !== served.generationId && isGenerationOf(deps.db, served.packageId, binding.packageGeneration)) {
        return {
          available: false,
          code: "BINDING_STALE",
          reason: "the package behind this action changed since the action was made; ask for the widget again",
          capabilityRef: ref,
        };
      }
      const parsed = capabilityRefSchema.safeParse(ref);
      if (!parsed.success) return { available: false, code: "CAPABILITY_MISSING", reason: `${ref} is not a capability reference`, capabilityRef: ref };
      const preflight = invocationPreflight({ db: deps.db, nodeId: deps.nodeId }, parsed.data);
      return preflight.ready
        ? { available: true }
        : { available: false, code: preflight.code, reason: preflight.message, capabilityRef: ref };
    }
  }
}
