/**
 * Whether an effect may run.
 *
 * One decision, in one place, for every seam that can cause an effect: a command the agent wants to
 * run, a widget action that is not a view operation, and an install. Before this, each seam decided
 * for itself — `run_command` always produced an approval card, a widget binding carried a
 * `requires_approval` flag frozen when it was registered — which is why the product's three execution
 * modes could not be more than a setting: there was nothing for them to change.
 *
 * What this module does *not* decide, deliberately, because it must hold in every mode and is
 * enforced where the act happens rather than here: the operation digest an approval is bound to, the
 * binding digest, stale revisions, grants, credential locality, deadlines and invocation de-duplication.
 * Autonomy changes who is asked, never what is checked.
 *
 * Four things it does decide, in this order:
 *
 * 1. A local view action changes only what is displayed, so it is not an effect and never asks.
 * 2. A hard external boundary — an OS permission prompt, an OAuth grant, a browser device
 *    permission, a vendor's own consent screen — is asked for in every mode, including Autonomous.
 *    Autonomy is this application's decision to make; those are not.
 * 3. A user rule that refuses an effect category holds in every mode. A rule is the user's own
 *    decision about their machine, and a mode cannot overrule it.
 * 4. Otherwise the mode decides, with the effect category and whether the user asked for this
 *    particular act in this turn.
 */

import {
  PREFERENCE_REGISTRY,
  executionModeSchema,
  executionRulesPreferenceSchema,
  type EffectCategory,
  type ExecutionMode,
  type ExecutionRule,
  type Instant,
} from "@clarkcant/contracts";
import { appendEvent, type Database } from "@clarkcant/storage";

import { readRegisteredPreference } from "./preference-registry.ts";
import type { PreferenceDeps } from "./preferences.ts";

/** A consent boundary this application does not own and therefore cannot lift. */
export type HardBoundaryKind = "os-permission" | "oauth" | "browser-permission" | "vendor-consent";

export interface HardBoundary {
  kind: HardBoundaryKind;
  /** Written for whoever will be asked: which boundary, and whose permission is needed. */
  because: string;
}

/** A change to what is displayed, and to nothing else. */
export interface ViewAction {
  kind: "view";
}

export interface EffectAction {
  kind: "effect";
  category: EffectCategory;
  /** What an approval would be bound to. Carried through so the approval cannot cover other bytes. */
  operationDigest: string;
}

export interface ExecutionQuestion {
  mode: ExecutionMode;
  rules: readonly ExecutionRule[];
  action: ViewAction | EffectAction;
  /**
   * True when the user asked for this act in this turn, rather than the agent deciding to do it while
   * working on something else. This is the difference Autonomous turns on.
   */
  explicitUserIntent: boolean;
  hardBoundary?: HardBoundary;
}

export interface ApprovalSpec {
  effectCategory: EffectCategory;
  operationDigest: string;
  /** Why the approval exists, for the card. */
  because: string;
  /** Present when the approval exists for an external boundary rather than for this application's policy. */
  hardBoundary?: HardBoundaryKind;
}

export type PolicyDecision =
  | {
      kind: "execute";
      reason: string;
      /**
       * Whether this execution is an effect that has to leave evidence. False for a view action,
       * which is not an effect and would otherwise fill the log with filter changes.
       */
      audit: boolean;
    }
  | { kind: "ask"; reason: string; approvalSpec: ApprovalSpec }
  | { kind: "deny"; reason: string };

/**
 * Categories whose effect reaches past this machine or cannot be undone by running something else.
 *
 * The distinction is not severity — changing a file is sometimes worse than sending a message. It is
 * whether the act is the kind a person would want to have asked for, which is what the risk gate
 * uses when the agent decided to do it on its own.
 */
const RISKY_CATEGORIES: ReadonlySet<EffectCategory> = new Set<EffectCategory>([
  "external-write",
  "destructive",
  "financial",
  "communication",
  "media-capture",
]);

function askFor(
  action: EffectAction,
  because: string,
  reason: string,
  hardBoundary?: HardBoundaryKind,
): PolicyDecision {
  return {
    kind: "ask",
    reason,
    approvalSpec: {
      effectCategory: action.category,
      operationDigest: action.operationDigest,
      because,
      ...(hardBoundary === undefined ? {} : { hardBoundary }),
    },
  };
}

export function decideExecution(question: ExecutionQuestion): PolicyDecision {
  if (question.action.kind === "view") {
    return {
      kind: "execute",
      reason: "a view action changes what is displayed and nothing else",
      audit: false,
    };
  }

  const action = question.action;

  // Checked before the rules and before the mode: a rule saying "execute everything" is still not a
  // permission from the operating system, an account holder, or a browser.
  if (question.hardBoundary !== undefined) {
    return askFor(
      action,
      question.hardBoundary.because,
      `${question.hardBoundary.kind} is not this application's decision to make, so it is asked for in every mode`,
      question.hardBoundary.kind,
    );
  }

  const rule = question.rules.find((candidate) => candidate.effectCategory === action.category);

  if (rule?.decision === "deny") {
    return {
      kind: "deny",
      reason: `a rule refuses ${action.category} effects on this machine`,
    };
  }

  switch (question.mode) {
    case "ask":
      // The strictest mode, and the one the other two are measured against: a rule may tighten this
      // to a refusal, and nothing may loosen it.
      return askFor(action, `the execution mode is "ask every time"`, "this node asks before every effect");

    case "guarded":
      if (rule?.decision === "execute") {
        return {
          kind: "execute",
          reason: `a rule allows ${action.category} effects without asking`,
          audit: true,
        };
      }
      if (rule?.decision === "ask" || RISKY_CATEGORIES.has(action.category)) {
        return askFor(
          action,
          rule?.decision === "ask"
            ? `a rule asks before ${action.category} effects`
            : `${action.category} reaches past this machine`,
          `guarded mode asks where the effect category or a rule requires it`,
        );
      }
      return {
        kind: "execute",
        reason: `${action.category} stays on this machine and no rule asks about it`,
        audit: true,
      };

    case "autonomous":
      if (rule?.decision === "ask") {
        return askFor(
          action,
          `a rule asks before ${action.category} effects`,
          `a rule asks even though the mode is autonomous`,
        );
      }
      /*
       * The risk gate.
       *
       * Autonomous means the user's own instruction is enough: it is not a promise to perform effects
       * the user never asked for. So a risky category the agent chose on its own is still asked about —
       * which is the difference between an assistant that carries out what it was told and one that
       * sends mail nobody asked it to send.
       */
      if (RISKY_CATEGORIES.has(action.category) && !question.explicitUserIntent) {
        return askFor(
          action,
          `${action.category} reaches past this machine and the user did not ask for it`,
          "autonomous mode does not act outside this machine on the agent's own initiative",
        );
      }
      return {
        kind: "execute",
        reason: question.explicitUserIntent
          ? `the user asked for this ${action.category} effect`
          : `${action.category} stays on this machine`,
        audit: true,
      };

    default:
      // Fail closed. A mode this build does not know cannot be read as permission, and the honest
      // answer to "may I?" is no rather than a guess.
      return {
        kind: "deny",
        reason: `the execution mode "${String(question.mode)}" is not one this build knows`,
      };
  }
}

export interface ExecutionAuditDeps {
  db: Database;
  nodeId: string;
  newId: (prefix: string) => string;
  now: () => Instant;
}

/**
 * The policy in force, read from the preference store.
 *
 * One reader, so the seams cannot disagree about what the user chose. A stored value that no longer
 * parses falls back to the registry's own default rather than throwing: a corrupted preference must not
 * decide that a command runs, and it must not be the reason the node stops working either. The fallback
 * is read from the registry, so there is exactly one declaration of what the default is.
 */
export function readExecutionPolicy(
  deps: PreferenceDeps,
  principalId: string,
): { mode: ExecutionMode; rules: readonly ExecutionRule[] } {
  const storedMode = readRegisteredPreference(deps, { principalId, key: "execution.mode" });
  const storedRules = readRegisteredPreference(deps, { principalId, key: "execution.rules" });
  const mode = executionModeSchema.safeParse(storedMode?.value);
  const rules = executionRulesPreferenceSchema.safeParse(storedRules?.value);
  return {
    mode: mode.success ? mode.data : executionModeSchema.parse(PREFERENCE_REGISTRY["execution.mode"].default),
    rules: rules.success ? rules.data : [],
  };
}

/**
 * Leave evidence that an effect ran without an approval card.
 *
 * The audit is the thing that makes autonomy checkable rather than merely trusted: an approval card is
 * its own record, and an effect that skipped the card would otherwise leave nothing at all. Written
 * after the decision and before the act, so a command that hangs or a process that dies still shows
 * that something was started.
 */
export function recordEffectExecution(
  deps: ExecutionAuditDeps,
  input: {
    principalId: string;
    mode: ExecutionMode;
    decision: Extract<PolicyDecision, { kind: "execute" }>;
    category: EffectCategory;
    operationDigest: string;
    conversationId?: string;
    /** What ran, in the words the interface shows. Never a credential. */
    description: string;
  },
): number {
  return appendEvent(deps.db, {
    eventId: deps.newId("evt"),
    kind: "effect.executed",
    stream: "activity",
    nodeId: deps.nodeId,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    document: {
      principalId: input.principalId,
      mode: input.mode,
      category: input.category,
      operationDigest: input.operationDigest,
      description: input.description,
      because: input.decision.reason,
      approvedBy: "policy",
    },
    occurredAt: deps.now(),
  });
}
