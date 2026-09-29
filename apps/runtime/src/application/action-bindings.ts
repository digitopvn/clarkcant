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
import { contextRefsProblem } from "./action-context.ts";
import { effectiveLimits } from "./action-limits.ts";
import { isGenerationOf, validateArgs } from "./capability-invoke.ts";
import { stepProblem } from "./workflow-executor.ts";

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
 * What a use of an action sends, for the widgets that send something: a form its values, a list the item picked.
 *
 * `source` is how a field binding names where such a value comes from. `keys` are the names it is sent under — a form's
 * field names; a list's are read from the action itself, because the capability decides which argument takes an item.
 * `schema` turns those keys into the JSON Schema the binding records as the input it accepts, which the node checks
 * every use against before anything runs.
 */
export interface ActionInputSpec {
  source: "user-input" | "selected-row";
  noun: string;
  keys?: readonly string[];
  schema: (keys: readonly string[]) => Record<string, unknown>;
}

/** The key an item's id is sent under when the action is Clark's rather than a capability's. */
export const AGENT_ITEM_KEY = "itemId";

/** A capability's schema with `omit` no longer required: those arguments arrive with each use, not at compile time. */
function withoutRequired(schema: Record<string, unknown> | undefined, omit: readonly string[]): Record<string, unknown> | undefined {
  if (schema === undefined || !Array.isArray(schema.required)) return schema;
  return { ...schema, required: (schema.required as unknown[]).filter((name) => !omit.includes(String(name))) };
}

/** Arguments a capability's schema says it does not take, of the ones a use would send. */
function notTaken(schema: Record<string, unknown> | undefined, keys: readonly string[]): string[] {
  if (schema?.additionalProperties !== false) return [];
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  return keys.filter((key) => !Object.hasOwn(properties, key));
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
  input: {
    definitionRef: WidgetInstance["definitionRef"];
    label: string;
    action: unknown;
    carries?: ActionInputSpec;
    /** Who is placing the button: a context reference to another widget must name one this person owns. */
    ownerPrincipalId?: string;
  },
): WidgetActionCompile {
  const carries = input.carries;
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
  let proposal: ActionProposal = parsed.data;
  let inputKeys: readonly string[] = [];

  const instanceGeneration = input.definitionRef.packageDigest;
  let packageGeneration = instanceGeneration;
  let effectCategory: EffectCategory = "read";
  const knownCapabilities = new Set<string>();

  switch (proposal.kind) {
    case "view": {
      if (carries !== undefined) {
        return {
          ok: false,
          message: `what a ${carries.noun} sends cannot go to a view operation; bind it to a package service ("invoke") or to Clark ("agent")`,
        };
      }
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
      if (carries === undefined && fromInvocation.length > 0) {
        return {
          ok: false,
          message: `a button carries no input, so ${fromInvocation.map((field) => field.target).join(", ")} must be fixed as a literal or in args`,
        };
      }
      if (carries !== undefined) {
        const wrong = fromInvocation.filter((field) => field.source !== carries.source);
        if (wrong.length > 0) {
          return {
            ok: false,
            message: `a ${carries.noun} sends ${carries.source} values, so ${wrong.map((field) => field.target).join(", ")} cannot come from ${wrong[0]?.source ?? ""}`,
          };
        }
        if (carries.keys === undefined) {
          // A list: the action names the one argument an item's id goes to.
          if (fromInvocation.length !== 1) {
            return {
              ok: false,
              message: `name the one argument that takes the item's id: "bindings":[{"target":"<argument>","source":"${carries.source}"}]`,
            };
          }
          inputKeys = fromInvocation.map((field) => field.target);
        } else {
          // A form: each field goes to the argument of the same name, bound here when the model did not say so.
          const stray = fromInvocation.filter((field) => !carries.keys?.includes(field.target));
          if (stray.length > 0) {
            return { ok: false, message: `${stray.map((field) => field.target).join(", ")} is not a field of this ${carries.noun}` };
          }
          inputKeys = carries.keys;
          const bound = new Set(fromInvocation.map((field) => field.target));
          const added = inputKeys.filter((key) => !bound.has(key)).map((target) => ({ target, source: carries.source }));
          proposal = { ...proposal, bindings: [...(proposal.bindings ?? []), ...added] };
        }
        const refused = notTaken(descriptor.inputSchema, inputKeys);
        if (refused.length > 0) {
          return { ok: false, message: `${proposal.capabilityRef} does not take ${refused.join(", ")}` };
        }
      }
      const args: Record<string, unknown> = { ...proposal.args };
      for (const field of proposal.bindings ?? []) if (field.source === "literal") args[field.target] = field.value;
      const checked = validateArgs(withoutRequired(descriptor.inputSchema, inputKeys), args);
      if (!checked.ok) return { ok: false, message: `${proposal.capabilityRef} does not accept those arguments: ${checked.message}` };
      packageGeneration = served.generationId;
      effectCategory = descriptor.effectCategory;
      knownCapabilities.add(proposal.capabilityRef);
      break;
    }
    case "agent": {
      // Each reference is checked against the grammar now, and one naming another widget against who owns it, so a
      // button is never made with a reference nothing on this node can read (`action-context.ts`).
      const problem = contextRefsProblem(deps, proposal.contextRefs, input.ownerPrincipalId);
      if (problem !== undefined) return { ok: false, message: `a context reference was refused: ${problem}` };
      if (carries !== undefined) inputKeys = carries.keys ?? [AGENT_ITEM_KEY];
      // Starting a turn changes nothing by itself; whatever the turn then does passes the policy on its own.
      break;
    }
    case "workflow": {
      if (carries !== undefined) inputKeys = carries.keys ?? [AGENT_ITEM_KEY];
      const categories: EffectCategory[] = [];
      const providers = new Set<string>();
      for (const step of proposal.steps) {
        const problem = stepProblem(step, inputKeys);
        if (problem !== undefined) return { ok: false, message: problem };
        if (step.kind !== "invoke" || step.capabilityRef === undefined) continue;
        const served = deps.serviceHost?.serves(step.capabilityRef as CapabilityRef);
        if (served === undefined) {
          return {
            ok: false,
            message: `step ${step.stepId}: ${step.capabilityRef} is not provided by an active package's service on this node; a workflow can only call one that is`,
          };
        }
        const descriptor = getCapability({ db: deps.db, nodeId: deps.nodeId }, step.capabilityRef as CapabilityRef, deps.nodeId);
        if (descriptor === undefined) continue;
        knownCapabilities.add(step.capabilityRef);
        categories.push(descriptor.effectCategory);
        providers.add(served.generationId);
      }
      // One package behind every step pins its generation, as an `invoke` does, so an update makes the button stale
      // rather than retargeting it. Steps from several packages are each checked against the registry when they run.
      const [only] = providers;
      if (providers.size === 1 && only !== undefined) packageGeneration = only;
      effectCategory = SEVERITY.find((category) => categories.includes(category)) ?? "read";
      break;
    }
  }

  const inputSchema =
    carries === undefined ? { type: "object", properties: {}, additionalProperties: false } : carries.schema(inputKeys);
  const limits = effectiveLimits(proposal.kind, proposal.kind === "view" ? undefined : proposal.limits);
  const compiled = compileActionBinding({
    bindingId: deps.newId("act"),
    instance: { instanceId: "pending", ownerNodeId: deps.nodeId, definitionRef: input.definitionRef, actionBindingRevision: 1 },
    packageGeneration,
    label: input.label,
    proposal,
    inputSchema,
    allowedDataRefs: [],
    fixedConstraints: {},
    effectCategory,
    // Whether a click needs an approval is the execution policy's decision at the click, not a flag frozen here.
    requiresApproval: false,
    limits,
    bindingDigest: `sha256:${payloadDigest(asJsonValue({ proposal, packageGeneration, effectCategory, label: input.label, inputSchema, limits }))}`,
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
    case "workflow": {
      // Runnable only when every step that calls a service could be called now: a workflow that would stop at its
      // third step for a reason the node already knows is a disabled button with that step named, not a live one.
      for (const step of proposal.steps) {
        if (step.kind !== "invoke" || step.capabilityRef === undefined) continue;
        const answer = capabilityAvailability(deps, binding, step.capabilityRef);
        if (!answer.available) return { ...answer, reason: `step "${step.stepId}": ${answer.reason}` };
      }
      return { available: true };
    }
    case "invoke":
      return capabilityAvailability(deps, binding, proposal.capabilityRef);
  }
}

/** Whether one capability a binding calls could be called now: the checks the invoke path makes before it runs. */
function capabilityAvailability(
  deps: Pick<ActionBindingDeps, "db" | "nodeId" | "serviceHost">,
  binding: ActionBinding,
  ref: string,
): BindingAvailability {
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
