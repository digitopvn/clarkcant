import { z } from "zod";

/**
 * The models a person keeps, and the alias they switch between.
 *
 * The node used to store one model — `key: "model"`, scope `node` — which answered "which model" and nothing else.
 * A pool answers the questions that follow: which one for background work, which one is fast, which one can hold a
 * long context, and which of them may be picked without looking. The aliases are the person's own; the identifiers
 * are the provider's.
 *
 * Nothing here copies the catalogue of available models. A profile names a provider and a model id, and
 * `validateProfileAgainstCatalogue` is what says whether this installation can actually run it — a stored list that
 * looked like a catalogue would be a list that silently went stale the moment a provider was added or removed.
 */
export const modelRoleSchema = z.enum(["foreground", "background", "coding", "research", "fast", "long-context"]);
export type ModelRole = z.infer<typeof modelRoleSchema>;

export const MODEL_ROLES = modelRoleSchema.options;

export const userModelProfileSchema = z.object({
  modelProfileId: z.string().min(1).max(128),
  /** What the person calls it. Shown in the composer and on the hotkey, so it stays short. */
  alias: z.string().min(1).max(60),
  provider: z.string().min(1).max(120),
  modelId: z.string().min(1).max(200),
  /**
   * Whether it takes part in a switch.
   *
   * A profile that is off keeps its settings: disabling is how a person says "not this week", not "forget this".
   */
  enabled: z.boolean(),
  roles: z.array(modelRoleSchema).max(8),
  /**
   * The order a hotkey walks in, lowest first.
   *
   * A number rather than an array position, because the panel edits it as a field and a person who reorders two
   * rows expects the rest to keep their places.
   */
  priority: z.number().int().min(0).max(1_000),
  maxTokens: z.number().int().positive().max(10_000_000).optional(),
  maxWallClockMs: z.number().int().positive().max(86_400_000).optional(),
  notes: z.string().max(500).optional(),
});
export type UserModelProfile = z.infer<typeof userModelProfileSchema>;

export const modelPoolSchema = z.object({
  profiles: z.array(userModelProfileSchema).max(32),
});
export type ModelPool = z.infer<typeof modelPoolSchema>;

export const EMPTY_MODEL_POOL: ModelPool = { profiles: [] };

/** Which profiles a hotkey may walk, in the order it walks them. */
export function enabledProfilesByPriority(pool: ModelPool): UserModelProfile[] {
  return pool.profiles
    .filter((profile) => profile.enabled)
    .slice()
    .sort((left, right) => left.priority - right.priority || left.alias.localeCompare(right.alias));
}

/**
 * The next alias after this one.
 *
 * Wraps, because a cycle that stops at the end is a cycle that stops working at the moment somebody presses it
 * twice. An alias that is not in the list — a profile deleted since, or a model chosen from the catalogue — starts
 * the walk from the beginning rather than refusing: the hotkey's job is to change the model, and there is always a
 * first one to change to.
 */
export function nextModelProfile(pool: ModelPool, currentAlias: string | undefined): UserModelProfile | undefined {
  const ordered = enabledProfilesByPriority(pool);
  if (ordered.length === 0) return undefined;
  const at = currentAlias === undefined ? -1 : ordered.findIndex((profile) => profile.alias === currentAlias);
  return ordered[(at + 1) % ordered.length];
}

/** A provider's models, as this installation offers them. Structurally the adapter's catalogue, without importing it. */
export interface CatalogueProvider {
  id: string;
  models: readonly { id: string }[];
}

/**
 * Whether this node can run a profile at all.
 *
 * Two refusals with different fixes, which is why they are not one message: an unknown provider means the
 * installation has no such provider (upgrade pi, or fix the spelling), while an unknown model means the provider is
 * there and does not offer that model.
 */
export function validateProfileAgainstCatalogue(
  profile: Pick<UserModelProfile, "alias" | "provider" | "modelId">,
  catalogue: readonly CatalogueProvider[],
): { ok: true } | { ok: false; message: string } {
  const offered = catalogue.find((entry) => entry.id === profile.provider);
  if (offered === undefined) {
    return { ok: false, message: `Node này không có provider “${profile.provider}” (${profile.alias}).` };
  }
  if (!offered.models.some((model) => model.id === profile.modelId)) {
    return {
      ok: false,
      message: `Provider “${profile.provider}” không có model “${profile.modelId}” (${profile.alias}).`,
    };
  }
  return { ok: true };
}

/** Read a stored pool, field-wise, so one malformed profile does not cost the others. */
export function parseModelPool(value: unknown): ModelPool {
  const source = typeof value === "object" && value !== null ? (value as { profiles?: unknown }) : {};
  if (!Array.isArray(source.profiles)) return EMPTY_MODEL_POOL;
  const profiles: UserModelProfile[] = [];
  for (const entry of source.profiles.slice(0, 32)) {
    const parsed = userModelProfileSchema.safeParse(entry);
    if (parsed.success) profiles.push(parsed.data);
  }
  return { profiles };
}

/** The profile an alias names, whether or not it is enabled: a panel shows disabled rows too. */
export function profileByAlias(pool: ModelPool, alias: string): UserModelProfile | undefined {
  return pool.profiles.find((profile) => profile.alias === alias);
}

/**
 * Whether a model change needs a new generation.
 *
 * Pi resolves the model when a session is created, so changing it cannot be done to the session underneath a
 * running turn. The answer here is the honest one — `handoff` means "this change takes effect as a new generation",
 * and the caller decides when: immediately if nothing is running, at the end of the turn if something is.
 */
export function modelChangeNeedsGeneration(input: {
  currentModel: string | undefined;
  preferredModel: string | undefined;
}): "none" | "handoff" {
  if (input.preferredModel === undefined) return "none";
  if (input.currentModel === undefined) return "handoff";
  return input.currentModel === input.preferredModel ? "none" : "handoff";
}
