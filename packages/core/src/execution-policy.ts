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
 * 2. A node-wide prohibition refuses every effect, before anything else. It is read above the hard
 *    boundaries on purpose: a user who said "never" is not overruled by a consent screen an application
 *    put in front of them.
 * 3. A hard external boundary — an OS permission prompt, an OAuth grant, a browser device permission, a
 *    vendor's own consent screen — is asked for in every mode, including Autonomous. Autonomy is this
 *    application's decision to make; those are not.
 * 4. Otherwise the mode decides, with the effect category, the rules the user wrote, and whether the user
 *    asked for this particular act in this turn.
 *
 * Declared once and in full: `prohibition > hard boundary > rules > mode`. Between a deny rule and the mode sit the two
 * checks about who asked: a peer's handed-over work outside what its owner allowed, and — only when the person opted in
 * with `machineTurns: "ask"` — a risky effect a program on a machine surface asked for. The judgment layer stands beside
 * this decision rather than inside it — `guardrailCovers` answers whether it is consulted for an effect the
 * decision allowed, and it may only narrow what was allowed.
 */

import {
  PREFERENCE_REGISTRY,
  type EffectCategory,
  type ExecutionMode,
  type ExecutionPolicyConfig,
  type Instant,
  type IntentOrigin,
  type RegisteredPreference,
  type TurnOrigin,
  executionModeSchema,
  isMachineSurfaceOrigin,
  executionProhibitionSchema,
  executionRulesPreferenceSchema,
  guardClassFor,
  parseExecutionPolicyConfig,
} from "@clarkcant/contracts";
import { appendEvent, type Database } from "@clarkcant/storage";

import type { BrowserPress } from "./browser-press.ts";
import { EXECUTION_POLICY_PREFERENCE_KEY, migrateExecutionPolicy } from "./execution-policy-migration.ts";
import { readRegisteredPreference } from "./preference-registry.ts";
import { deletePreference, getPreference, type PreferenceDeps } from "./preferences.ts";

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

/**
 * Whose intent an effect carries out, which is the difference Autonomous turns on.
 *
 * - `interactive`: a person asked for this in the conversation.
 * - `delegated`: a paired node handed the work over under a grant. Its owner's intent, but only for the effects both
 *   the grant and this node's owner allowed that peer; anything else waits for this node's owner.
 * - `persistent`: an automation a person set up earlier. It is their intent, but only for the effects they gave
 *   it; anything outside `allowedCategories` is treated as the agent's own initiative.
 * - `system`: the node's own work, which nobody asked for.
 *
 * An interactive intent carries who asked for the turn (`TurnOrigin`), as the node recorded it when it accepted the
 * message. By default it changes nothing: a program on a machine surface is decided exactly like the person. It matters
 * only when the person opted into `machineTurns: "ask"`. Absent is the person.
 */
export type ExecutionIntent =
  | {
      kind: "interactive";
      origin?: TurnOrigin;
      /**
       * For a turn an external channel started (`origin: "channel"`): the risky categories a standing grant on that
       * channel gives the sender. Absent is none, so a risky effect such a turn asks for is asked about.
       */
      channelAllowedCategories?: readonly EffectCategory[];
    }
  | { kind: "delegated"; allowedCategories: readonly EffectCategory[] }
  | { kind: "persistent"; allowedCategories: readonly EffectCategory[] }
  | { kind: "system" };

/** Whether a person's instruction stands behind an effect of this category. */
export function intentCovers(intent: ExecutionIntent, category: EffectCategory): boolean {
  switch (intent.kind) {
    case "interactive":
      return true;
    case "delegated":
    case "persistent":
      return intent.allowedCategories.includes(category);
    case "system":
      return false;
    default:
      // A kind this build does not know is nobody's instruction.
      return false;
  }
}

/**
 * The intent a task carries, read from why it was created.
 *
 * A task stored before origins were recorded was always started by a person in the conversation, so no origin
 * reads as interactive.
 */
export function executionIntentOf(origin: IntentOrigin | undefined): ExecutionIntent {
  if (origin === undefined) return { kind: "interactive" };
  switch (origin.kind) {
    case "interactive":
      return origin.turnOrigin === undefined ? { kind: "interactive" } : { kind: "interactive", origin: origin.turnOrigin };
    case "delegated":
      return { kind: "delegated", allowedCategories: origin.allowedCategories };
    case "persistent":
      return { kind: "persistent", allowedCategories: origin.allowedCategories };
    case "system":
      return { kind: "system" };
    default:
      return { kind: "system" };
  }
}

/**
 * Who asked, as a task's stored origin says: the turn's origin for a task a turn started, an automation, or a peer. The
 * node's own work, and an interactive task recorded before origins were, name nobody.
 */
export function turnOriginOfIntent(origin: IntentOrigin | undefined): TurnOrigin | undefined {
  switch (origin?.kind) {
    case "interactive":
      return origin.turnOrigin;
    case "persistent":
      return "automation";
    case "delegated":
      return "peer";
    default:
      return undefined;
  }
}

export interface ExecutionQuestion {
  /**
   * The policy in force, passed in rather than read here.
   *
   * This function is one decision and not a reader: the seams that ask it get the policy from
   * `readExecutionPolicy`, which is the only thing in the codebase that opens a policy preference.
   */
  policy: ExecutionPolicyConfig;
  action: ViewAction | EffectAction;
  /**
   * Whose intent this act carries out: a person asking now, an automation they set up, a peer under a grant, or
   * the node itself. This is the difference Autonomous turns on.
   */
  intent: ExecutionIntent;
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
  | { kind: "deny"; reason: string; refusal: PolicyRefusal };

/** Why the policy refused, as data: what the person is told is worded from this in their own language. */
export type PolicyRefusal =
  | { code: "prohibited" }
  | { code: "rule"; category: EffectCategory }
  | { code: "unknown-mode"; mode: string };

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

/** Who asked, in the fixed English an approval's `because` is written in. */
function machineOriginWords(origin: TurnOrigin | undefined): string {
  switch (origin) {
    case "mcp":
      return "an AI client over MCP";
    case "relay":
      return "a program on the WebSocket API";
    default:
      return "a program on the HTTP API";
  }
}

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

  /*
   * Read before everything else, including the hard boundaries.
   *
   * A node-wide refusal is the user's own decision about their machine, and the reason it cannot live in the
   * rule table is in `executionProhibitionSchema`: an enumeration of refused categories is a snapshot of the
   * categories that exist today, and the refusal would fail open on the next one. It is also why it stands
   * above a hard boundary — an OAuth consent screen an application can put in front of the user is not the
   * user taking back a refusal, and the effect must not become reachable by approving something else.
   */
  if (question.policy.prohibition === "all") {
    return {
      kind: "deny",
      reason: "this node refuses every effect, so no category is exempt",
      refusal: { code: "prohibited" },
    };
  }

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

  const rule = question.policy.rules.find((candidate) => candidate.effectCategory === action.category);

  if (rule?.decision === "deny") {
    return {
      kind: "deny",
      reason: `a rule refuses ${action.category} effects on this machine`,
      refusal: { code: "rule", category: action.category },
    };
  }

  /*
   * Work another node handed over is bounded by what this node's owner allowed that peer, in every mode.
   *
   * Nobody here asked for it, so "it stays on this machine" is not enough: the allowance is this owner's decision
   * about that peer, and an effect outside it is theirs to make, even one a general rule would let through.
   */
  if (question.intent.kind === "delegated" && !intentCovers(question.intent, action.category)) {
    return askFor(
      action,
      `another node handed this over and this node's owner did not allow it ${action.category} effects`,
      "work a peer handed over runs only within what this node's owner allowed that peer",
    );
  }

  /*
   * A turn a program asked for on a machine surface, when the person chose to be asked about those.
   *
   * By default (`machineTurns` absent or `as-person`) such a turn is decided exactly as the person's own: this is read
   * only after the person opted in. Like the delegated check, it stands above an "execute" rule and every mode, because
   * the opt-in is the person's decision about who may cause a risky effect without them, not about the category.
   */
  if (
    question.policy.machineTurns === "ask" &&
    question.intent.kind === "interactive" &&
    isMachineSurfaceOrigin(question.intent.origin) &&
    RISKY_CATEGORIES.has(action.category)
  ) {
    return askFor(
      action,
      `${machineOriginWords(question.intent.origin)} asked for a ${action.category} effect`,
      "the person asks to be asked before a program on a machine surface causes a risky effect",
    );
  }

  /*
   * A turn a message on an external channel started.
   *
   * Not a refusal of whoever sent it — reads and local work go on under the mode like any turn, and Clark's reply to
   * that message is the binding's to send (`decideChannelReply`). But the provider's account is not the person at this
   * node, so a risky effect it asks for, outside what a standing grant on that channel gives, is the owner's to decide,
   * in every mode, the way a peer's work outside its allowance is.
   */
  if (
    question.intent.kind === "interactive" &&
    question.intent.origin === "channel" &&
    RISKY_CATEGORIES.has(action.category) &&
    !(question.intent.channelAllowedCategories ?? []).includes(action.category)
  ) {
    return askFor(
      action,
      `a message on an external channel asked for a ${action.category} effect no standing grant there covers`,
      "a risky effect a channel message asks for is the owner's to decide unless a grant on that channel covers it",
    );
  }

  switch (question.policy.mode) {
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
      if (RISKY_CATEGORIES.has(action.category) && !intentCovers(question.intent, action.category)) {
        return askFor(
          action,
          question.intent.kind === "persistent"
            ? `${action.category} reaches past this machine and the automation was not given it`
            : `${action.category} reaches past this machine and the user did not ask for it`,
          "autonomous mode does not act outside this machine on the agent's own initiative",
        );
      }
      return {
        kind: "execute",
        reason: !intentCovers(question.intent, action.category)
          ? `${action.category} stays on this machine`
          : question.intent.kind === "persistent"
            ? `an automation the user set up was given ${action.category} effects`
            : `the user asked for this ${action.category} effect`,
        audit: true,
      };

    default:
      // Fail closed. A mode this build does not know cannot be read as permission, and the honest
      // answer to "may I?" is no rather than a guess.
      return {
        kind: "deny",
        reason: `the execution mode "${String(question.policy.mode)}" is not one this build knows`,
        refusal: { code: "unknown-mode", mode: String(question.policy.mode) },
      };
  }
}

/**
 * Whether the judgment layer is consulted for one effect.
 *
 * The second of the two questions the policy answers, kept apart from `mode` on purpose: `mode` says who is
 * asked when an effect is allowed to happen, and this says whether a judgment layer gets to look at it first.
 * It is a predicate rather than part of `decideExecution` because the layer is asynchronous and knows about
 * providers, while the decision must stay a pure function of the policy that both a widget click and a
 * command can call.
 *
 * What the layer may answer is bounded elsewhere and unchanged: it can deny, ask for a clarification, or
 * apply one of the host's own narrowings, and a widening is refused rather than clamped.
 */
export function guardrailCovers(
  policy: ExecutionPolicyConfig,
  input: { surface: "command" | "capability"; effectCategory: EffectCategory },
): boolean {
  if (!policy.guardrails.enabled) return false;
  return policy.guardrails.classes.includes(guardClassFor(input));
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
 * One reader, so the seams cannot disagree about what the user chose, and one preference key, so there is no
 * state to keep in step. It answers with the canonical policy whatever the node has stored:
 *
 *   - a stored canonical row is the answer, parsed field by field;
 *   - nothing stored goes through the migration instead of through a hard-coded default. That is what makes an
 *     upgrade a move rather than a reset: the migration reads both legacy families, joins them pointwise so the
 *     result is never looser than either, and stores it.
 *
 * Field-wise and not all-or-nothing, which is the difference between a policy and a reset: a row whose only
 * defect is one leaf — an `instructions` a newer build rejects, a field that did not exist when it was written —
 * is valid-and-partial, and every other axis in it is what the user chose. Validating the document as one value
 * would fall through to the migration and overwrite `mode` and `prohibition` with the join, which is the one
 * direction this module exists to prevent.
 *
 * A row whose JSON cannot be read at all is treated as absent rather than as a refusal for the whole node: the
 * alternative is a corrupt row that decides a command may run, and a node that stops working is not a safer
 * one. The migration below answers from the legacy families in that case, and stores the repair.
 */
export function readExecutionPolicy(deps: PreferenceDeps, principalId: string): ExecutionPolicyConfig {
  const stored = readStoredPolicyRow(deps, principalId);
  if (stored !== undefined && !stored.isDefault && declaresAnyAxis(stored.value)) {
    return parseExecutionPolicyConfig(stored.value);
  }
  return migrateExecutionPolicy(deps, { principalId }).policy;
}

/**
 * Whether a stored row declares at least one axis this build reads.
 *
 * A row that does is read field by field: the axes it declares are the user's choices, and a leaf this build
 * rejects costs only that leaf. A row that declares none — `{ mode: "sometimes" }`, a document written in a
 * vocabulary nothing here recognizes — carries no choice to preserve, so it is answered the way a node with no row
 * at all is: by the migration, which reads both legacy families and joins them. That is the difference between a
 * partially-valid row (kept, field-wise) and an unreadable one (replaced by the join of what the node stored),
 * and it is what keeps a refusal the user set from being forgotten by a row that never mentioned one.
 *
 * An empty rule list is not an axis: it states no category, which is the absence of a decision rather than one.
 */
function declaresAnyAxis(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    executionModeSchema.safeParse(source.mode).success ||
    executionProhibitionSchema.safeParse(source.prohibition).success ||
    (Array.isArray(source.rules) &&
      source.rules.length > 0 &&
      executionRulesPreferenceSchema.safeParse(source.rules).success) ||
    (typeof source.guardrails === "object" && source.guardrails !== null) ||
    source.machineTurns === "ask"
  );
}

/**
 * The canonical row, or nothing.
 *
 * The store reports a row whose JSON is unreadable instead of treating it as absent, which is right for a store.
 * This reader runs per command, per widget action and per install, and is not the place to fail: a corrupt row is
 * answered as no row at all, and removed, so the migration below can store the policy the node actually has. It has
 * to be removed rather than overwritten in place — the store reads what it replaces, so that an undo can restore it,
 * and that read is the same failure again.
 */
function readStoredPolicyRow(
  deps: PreferenceDeps,
  principalId: string,
): RegisteredPreference | undefined {
  try {
    return readRegisteredPreference(deps, { principalId, key: EXECUTION_POLICY_PREFERENCE_KEY });
  } catch {
    deletePreference(deps, { principalId, key: EXECUTION_POLICY_PREFERENCE_KEY, scope: "global" });
    return undefined;
  }
}

/**
 * The policy in force, as the registry reports a preference.
 *
 * The value is the effective policy and the revision, `isDefault` and timestamp are the canonical row's own, so a
 * surface that projects a legacy key (`execution.mode`, `execution.rules`) from this cannot report a mode the node
 * does not obey. It exists because the projection needs the row's markers, and reading that row anywhere but in
 * this module is exactly what the one-reader rule forbids.
 */
export function readExecutionPolicyPreference(
  deps: PreferenceDeps,
  principalId: string,
): RegisteredPreference {
  const policy = readExecutionPolicy(deps, principalId);
  const stored = readStoredPolicyRow(deps, principalId);
  if (stored === undefined) {
    // Unreachable — the key is registered, so a read answers for it whether or not a row exists — and answered
    // rather than thrown so a routing mistake cannot take a whole response down.
    const definition = PREFERENCE_REGISTRY[EXECUTION_POLICY_PREFERENCE_KEY];
    return {
      key: definition.key,
      scope: definition.scope,
      applies: definition.applies,
      value: policy,
      isDefault: true,
      revision: 0,
      updatedAt: null,
    };
  }
  return { ...stored, value: policy };
}

/**
 * The person's choice about machine-surface turns now, and before the last write to the policy.
 *
 * The choice is one axis of the policy row, and undoing the row would undo every axis its last write changed; a caller
 * that undoes only this choice needs to know what it was before that write, and whether that write changed it at all.
 * Absent when no policy was ever written. A value the schema does not read counts as the default.
 */
export function readMachineTurnsLastChange(
  deps: PreferenceDeps,
  principalId: string,
): { current: "as-person" | "ask"; previous: "as-person" | "ask" } | undefined {
  const row = getPreference(deps, { principalId, key: EXECUTION_POLICY_PREFERENCE_KEY, scope: "global" });
  if (row === undefined) return undefined;
  const turnsOf = (value: unknown): "as-person" | "ask" => (parseExecutionPolicyConfig(value).machineTurns === "ask" ? "ask" : "as-person");
  return { current: turnsOf(row.value), previous: turnsOf(row.previousValue) };
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
    /** What ran, in fixed words any surface can show when it cannot word it itself. Never a credential. */
    description: string;
    /** A press on a page, as data, so each surface can say it in the person's language. */
    action?: BrowserPress;
    /** Who asked for the turn that caused it, when a turn did. */
    origin?: TurnOrigin;
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
      ...(input.action === undefined ? {} : { action: input.action }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      because: input.decision.reason,
      approvedBy: "policy",
    },
    occurredAt: deps.now(),
  });
}
