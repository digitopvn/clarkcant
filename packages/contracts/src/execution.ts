import { z } from "zod";

import type { EffectCategory } from "./primitives.ts";

/**
 * How much the node asks before it acts.
 *
 * This replaces a boolean `requiresApproval`. The boolean could only say "ask" or "do not ask", which
 * made the approval card the load-bearing control: with it removed there was nothing left between a
 * model's proposal and a shell. The four values separate the two questions that were being answered by
 * one flag — *whether anyone is asked*, and *whether a policy layer may intervene*:
 *
 *   - `auto`    — run it. No policy call either; for an operator who wants the old "let Pi handle it".
 *   - `guarded` — the default. Nobody is asked, and the guardrail may still deny, constrain or ask a
 *                 clarifying question. This is the mode the architecture is built around: autonomy with
 *                 a judgment layer, not autonomy instead of one.
 *   - `confirm` — the previous behaviour, kept whole: a card, a digest, a person's decision.
 *   - `deny`    — this class of effect does not happen on this node at all.
 *
 * Nothing here decides anything by itself. `guarded` is a default because it is the one that keeps a
 * person out of the loop without giving up the loop.
 *
 * **Legacy.** This four-value vocabulary is no longer an authority: `execution.policy` in
 * `preferences.ts` is the one policy this node runs under, and this schema survives because a stored
 * document from an older build has to keep parsing. `executionPolicyOr` and `parseAutonomySettings` are
 * the only readers left, and the only caller that matters is the migration.
 */
export const executionPolicySchema = z.enum(["auto", "guarded", "confirm", "deny"]);
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export const EXECUTION_POLICIES = executionPolicySchema.options;

/** The default an unset or unreadable setting gets: ask nobody, judge everything. */
/**
 * The default the legacy vocabulary falls back to: ask nobody, judge everything.
 *
 * **Legacy.** This is not the product's default execution policy — that is `autonomous`, declared once in
 * `DEFAULT_EXECUTION_POLICY_CONFIG` and documented in DESIGN.md §1.3 and §5.3. It is the fallback of the
 * four-value vocabulary this file still parses for a node that stored it, and nothing else reads it: a
 * node that stored neither legacy family gets the canonical default, never this one.
 */
export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = "guarded";

/**
 * A stored policy, or the default.
 *
 * Deliberately not "throw on a bad value": a settings row written by an older build, or edited by hand,
 * must not be able to turn autonomy into a crash at the moment a command is proposed. A value that is
 * not one of the four resolves to the default, which is the policy that still consults the guardrail.
 */
export function executionPolicyOr(value: unknown, fallback: ExecutionPolicy = DEFAULT_EXECUTION_POLICY): ExecutionPolicy {
  const parsed = executionPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/**
 * The categories a person recognises in settings.
 *
 * These are not the effect categories. `effectCategorySchema` describes what an effect *is* so the
 * ledger and the outbox can reason about it; these six describe what a person wants to switch off, and
 * people think in surfaces ("commands") as much as in reach ("external writes"). Keeping one list for
 * both would mean either seven settings rows nobody understands or an effect category called "commands".
 */
export const guardClassSchema = z.enum([
  "commands",
  "local-writes",
  "external-writes",
  "communication",
  "financial",
  "reads",
]);
export type GuardClass = z.infer<typeof guardClassSchema>;

export const GUARD_CLASSES = guardClassSchema.options;

/**
 * Which switch governs one effect.
 *
 * A command is governed by `commands` whatever it turns out to do, because that is the row a person
 * would look for after an agent ran something surprising. Everything else — a bound widget action, a
 * capability invocation — is governed by how far its effect reaches.
 */
export function guardClassFor(input: { surface: "command" | "capability"; effectCategory: EffectCategory }): GuardClass {
  if (input.surface === "command") {
    /*
     * A read is not guarded, whatever surface it arrived on.
     *
     * The default switches already say this — "Reads are not guarded: a guardrail call on every read spends a provider
     * call to decide nothing" — but every command was governed by the `commands` row whatever it turned out to do, so a
     * read-only command was judged anyway and an ordinary fetch was refused. What the command *does* decides here. The
     * `commands` row still governs everything that can change something, which is the row a person looks for after an
     * agent ran something surprising.
     */
    return input.effectCategory === "read" ? "reads" : "commands";
  }
  switch (input.effectCategory) {
    case "read":
      return "reads";
    case "external-write":
      return "external-writes";
    case "communication":
      return "communication";
    case "financial":
      return "financial";
    // `destructive` and `media-capture` are local effects: they change or record something on this
    // machine, which is the row a person switches off when they want the node to stop touching disk.
    default:
      return "local-writes";
  }
}

/** What the node does when the guardrail cannot be reached at all. */
export const jevUnavailablePolicySchema = z.enum(["allow", "deny"]);
export type JevUnavailablePolicy = z.infer<typeof jevUnavailablePolicySchema>;

/**
 * The autonomy settings as an older build stored them.
 *
 * **Legacy storage shape.** It is read exactly once — by the migration that turns it into the canonical
 * policy — and written by nothing. The settings panel reaches it through a compatibility projection in
 * `apps/runtime/src/autonomy-settings.ts`, which is the only thing that still turns a canonical policy
 * into these five fields and back.
 *
 * `instructions` is free text handed to the guardrail as policy, which is the reason it is bounded and
 * the reason it is never treated as authority: a stored instruction can only ask the guardrail to
 * narrow what the host already allowed. The host's preflight does not read this field.
 */
export const autonomySettingsSchema = z.object({
  executionPolicy: executionPolicySchema,
  /** Off means `guarded` behaves as `auto`: the policy layer is skipped, the preflight is not. */
  jevGuardrails: z.boolean(),
  /** The user's own rules, in their own words, e.g. "never delete git repositories". */
  instructions: z.string().max(4_000),
  guardedClasses: z.array(guardClassSchema).max(16),
  whenJevUnavailable: jevUnavailablePolicySchema,
});
export type AutonomySettings = z.infer<typeof autonomySettingsSchema>;

/**
 * The defaults a fresh node starts with, in the legacy vocabulary.
 *
 * Reads are not guarded: a guardrail call on every read spends a provider call to decide nothing, and
 * the search path already taught this codebase that lesson. Everything that can change something is.
 *
 * **Legacy**, like the shape around it: this is what `parseAutonomySettings` fills a gap from, so a stored
 * document from an older build keeps parsing. The policy a node runs under comes from
 * `DEFAULT_EXECUTION_POLICY_CONFIG`, and `autonomous` is the default there — see the constant above.
 */
export const DEFAULT_AUTONOMY_SETTINGS: AutonomySettings = {
  executionPolicy: DEFAULT_EXECUTION_POLICY,
  jevGuardrails: true,
  instructions: "",
  guardedClasses: GUARD_CLASSES.filter((guardClass) => guardClass !== "reads"),
  whenJevUnavailable: "allow",
};

/**
 * Read stored settings, field by field.
 *
 * Field-wise rather than all-or-nothing, because a settings object written before a field existed is
 * the normal case after an upgrade, and refusing the whole object would silently reset a policy the
 * person chose. An unknown value for one field costs that field only.
 */
export function parseAutonomySettings(value: unknown): AutonomySettings {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const defaults = DEFAULT_AUTONOMY_SETTINGS;

  // Each field is parsed on its own rather than as part of one object. Validating the assembled object
  // would make one bad field poison the rest, which is exactly the case this function exists for: a
  // stored `executionPolicy` a newer build does not recognise must not also discard the instructions a
  // person wrote and the switches they turned off.
  const policy = executionPolicySchema.safeParse(source.executionPolicy);
  const unavailable = jevUnavailablePolicySchema.safeParse(source.whenJevUnavailable);
  const guardedClasses = Array.isArray(source.guardedClasses)
    ? source.guardedClasses.filter((entry) => guardClassSchema.safeParse(entry).success)
    : [...defaults.guardedClasses];

  return {
    executionPolicy: policy.success ? policy.data : defaults.executionPolicy,
    jevGuardrails: typeof source.jevGuardrails === "boolean" ? source.jevGuardrails : defaults.jevGuardrails,
    instructions: typeof source.instructions === "string" ? source.instructions.slice(0, 4_000) : defaults.instructions,
    guardedClasses: guardedClasses as GuardClass[],
    whenJevUnavailable: unavailable.success ? unavailable.data : defaults.whenJevUnavailable,
  };
}

/**
 * What a policy layer is allowed to say.
 *
 * Four answers, and the shape is the whole point: `constrain` carries constraints, `clarify` carries a
 * question, and neither of them is an approval. A guardrail cannot say "yes, and also here is a wider
 * directory" — there is no field for it, and `applyGuardrailConstraints` refuses an attempt to widen.
 */
export const guardrailConstraintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("timeout-ms"), value: z.number().int().positive().max(600_000) }),
  z.object({ kind: z.literal("max-output-bytes"), value: z.number().int().positive().max(1_000_000) }),
  z.object({ kind: z.literal("cwd"), value: z.string().min(1).max(1_024) }),
]);
export type GuardrailConstraint = z.infer<typeof guardrailConstraintSchema>;

export type GuardrailDecision =
  | { decision: "allow"; reason?: string }
  | { decision: "deny"; reason: string }
  /** The operation may happen, but only inside a smaller envelope than the host already allowed. */
  | { decision: "constrain"; constraints: GuardrailConstraint[]; reason: string }
  /** Not permission: the operation is under-specified and several of its targets are equally valid. */
  | { decision: "clarify"; question: string };

/** Parse one constraint, or nothing. Used where a constraint arrives as untrusted model output. */
export function parseGuardrailConstraint(value: unknown): GuardrailConstraint | undefined {
  const parsed = guardrailConstraintSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
