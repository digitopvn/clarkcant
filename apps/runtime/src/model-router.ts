import type { ModelPool, ModelRole, UserModelProfile } from "@clarkcant/contracts";

/**
 * Which model a background worker runs.
 *
 * Foreground is not routed: the person chose a model and the node honours it. Background is different — nobody is
 * watching, the work was not asked for in so many words, and the best model for it depends on facts the person
 * cannot be expected to weigh per job.
 *
 * The shape here is the same one the rest of the decision layer uses: **deterministic filters first, a model second,
 * and a fallback that always exists.** Every filter below is a fact the node can check, so the policy layer is only
 * ever asked to choose among models that can actually run — and when it cannot be reached, a worker still starts.
 * Routing that could fail a task is worse than routing that is occasionally unambitious.
 */

export interface ModelCandidate {
  alias: string;
  provider: string;
  modelId: string;
  priority: number;
}

export interface CandidateFilterInput {
  pool: ModelPool;
  /** The role the work needs. Defaults to `background`, which is the only role this router is for. */
  role?: ModelRole;
  /** Whether this node holds a credential for the provider. */
  hasCredential: (provider: string) => boolean;
  /** Whether the provider answered the last time the node asked. */
  isHealthy: (provider: string) => boolean;
  /** The context window the catalogue reports, when it reports one. */
  contextWindowFor: (provider: string, modelId: string) => number | undefined;
  /**
   * Whether a model can call tools: `true`, `false`, or `undefined` for "this build does not know".
   *
   * Unknown is not treated as "no". A model whose tool support the node cannot confirm is allowed through and the
   * worker finds out, which is the same thing that would happen without a router — whereas filtering it out would
   * silently remove every model on any installation whose catalogue is thin.
   */
  supportsTools: (provider: string, modelId: string) => boolean | undefined;
  needsTools: boolean;
  /** How much context the work needs, when it is known. */
  neededContextWindow?: number;
  /** How many tokens the work may spend, checked against the profile's own ceiling. */
  neededTokens?: number;
}

export interface FilterOutcome {
  eligible: ModelCandidate[];
  /** Every profile that was left out, with the reason — so a panel can say why the pool is not being used. */
  rejected: { alias: string; reason: string }[];
}

function candidateFor(profile: UserModelProfile): ModelCandidate {
  return { alias: profile.alias, provider: profile.provider, modelId: profile.modelId, priority: profile.priority };
}

/**
 * The profiles that could run this work.
 *
 * Ordered by the pool's own priority, so the fallback below is deterministic rather than whatever the store
 * happened to return.
 *
 * The role is decided in two passes, and that is deliberate. A profile that declares the role is the right answer when
 * there is one, so the strict pass runs first. When nothing declares it, the alternative is not "this node cannot run
 * background work" — it is "this node never said which profile is for that", which is the state of every node whose
 * owner has one profile and gave no thought to roles. Refusing then would withdraw a core feature for a reason nobody
 * can see, and the capability checks below are what actually keep a choice safe. So when the strict pass finds nothing,
 * capability alone decides; the strict pass's rejections are kept only when it found something, because a stated reason
 * is worth more than a longer list.
 */
export function filterBackgroundCandidates(input: CandidateFilterInput): FilterOutcome {
  const role = input.role ?? "background";
  const strict = filterByCapability(input, role, true);
  if (strict.eligible.length > 0) return strict;
  const relaxed = filterByCapability(input, role, false);
  return relaxed.eligible.length > 0 ? relaxed : strict;
}

/** One pass of the filter above, with the role either required or advisory. */
function filterByCapability(
  input: CandidateFilterInput,
  role: NonNullable<CandidateFilterInput["role"]>,
  requireRole: boolean,
): FilterOutcome {
  const eligible: ModelCandidate[] = [];
  const rejected: { alias: string; reason: string }[] = [];

  for (const profile of input.pool.profiles) {
    if (!profile.enabled) {
      rejected.push({ alias: profile.alias, reason: "đang tắt" });
      continue;
    }
    if (requireRole && !profile.roles.includes(role)) {
      rejected.push({ alias: profile.alias, reason: `không nhận vai trò ${role}` });
      continue;
    }
    if (!input.hasCredential(profile.provider)) {
      rejected.push({ alias: profile.alias, reason: `node chưa có credential cho ${profile.provider}` });
      continue;
    }
    if (!input.isHealthy(profile.provider)) {
      rejected.push({ alias: profile.alias, reason: `provider ${profile.provider} không khoẻ` });
      continue;
    }
    if (input.needsTools) {
      const tools = input.supportsTools(profile.provider, profile.modelId);
      if (tools === false) {
        rejected.push({ alias: profile.alias, reason: "model không gọi được tool" });
        continue;
      }
    }
    if (input.neededContextWindow !== undefined) {
      const window = input.contextWindowFor(profile.provider, profile.modelId);
      if (window !== undefined && window < input.neededContextWindow) {
        rejected.push({ alias: profile.alias, reason: `context ${window} nhỏ hơn ${input.neededContextWindow}` });
        continue;
      }
    }
    if (input.neededTokens !== undefined && profile.maxTokens !== undefined && profile.maxTokens < input.neededTokens) {
      rejected.push({ alias: profile.alias, reason: `trần ${profile.maxTokens} token nhỏ hơn ${input.neededTokens}` });
      continue;
    }
    eligible.push(candidateFor(profile));
  }

  eligible.sort((left, right) => left.priority - right.priority || left.alias.localeCompare(right.alias));
  return { eligible, rejected };
}

/** A short description per candidate, which is all the policy layer is shown. */
export function describeCandidate(candidate: ModelCandidate): string {
  return `${candidate.alias} (${candidate.provider}/${candidate.modelId})`;
}

export interface BackgroundRouting {
  /** Where the choice came from, so the reason can be reported rather than implied. */
  via: "jev" | "background-default" | "foreground" | "first-eligible";
  alias: string;
  provider: string;
  modelId: string;
  reason?: string;
}

export interface BackgroundRouteInput {
  eligible: readonly ModelCandidate[];
  /**
   * The policy layer, when one is configured.
   *
   * It is handed the eligible aliases and nothing else: a choice outside that list is refused rather than
   * accepted, which is what keeps the filters above authoritative.
   */
  decide?: (
    candidates: readonly { alias: string; description: string }[],
  ) => Promise<{ status: "chosen"; alias: string } | { status: "unavailable"; reason: string }>;
  /** The profile this node prefers for background work, if it has one. */
  backgroundDefaultAlias?: string;
  /** What foreground work is running on. Used as a fallback, never as a preference. */
  foregroundAlias?: string;
  /** Whether an alias is still a real, enabled profile. Checked after the decision, because a pool can change. */
  verify: (alias: string) => boolean;
}

function findCandidate(eligible: readonly ModelCandidate[], alias: string | undefined): ModelCandidate | undefined {
  if (alias === undefined) return undefined;
  return eligible.find((candidate) => candidate.alias === alias);
}

/**
 * Choose one, and never fail the job.
 *
 * The order is the design: the policy layer if it can be reached, then the node's background default, then whatever
 * foreground is using, then the first eligible profile. Every step is one somebody can predict, and the last step
 * means there is always an answer when at least one profile is eligible.
 */
export async function routeBackgroundModel(input: BackgroundRouteInput): Promise<BackgroundRouting | undefined> {
  const fromDecision = async (): Promise<{ candidate?: ModelCandidate; reason?: string }> => {
    if (input.decide === undefined || input.eligible.length < 2) return {};
    const offered = input.eligible.map((candidate) => ({ alias: candidate.alias, description: describeCandidate(candidate) }));
    const answer = await input.decide(offered);
    if (answer.status !== "chosen") return { reason: answer.reason };
    const chosen = findCandidate(input.eligible, answer.alias);
    if (chosen === undefined) return { reason: `bộ chọn trả về ${answer.alias}, không nằm trong danh sách đủ điều kiện` };
    if (!input.verify(chosen.alias)) return { reason: `${chosen.alias} không còn hợp lệ sau khi được chọn` };
    return { candidate: chosen };
  };

  const decided = await fromDecision();
  if (decided.candidate !== undefined) {
    return {
      via: "jev",
      alias: decided.candidate.alias,
      provider: decided.candidate.provider,
      modelId: decided.candidate.modelId,
    };
  }

  // The fallbacks, each one checked against `verify`: a preference that names a profile somebody has since disabled
  // is not a preference any more.
  const fallbacks: { via: BackgroundRouting["via"]; alias: string | undefined }[] = [
    { via: "background-default", alias: input.backgroundDefaultAlias },
    { via: "foreground", alias: input.foregroundAlias },
  ];
  for (const fallback of fallbacks) {
    if (fallback.alias === undefined || !input.verify(fallback.alias)) continue;
    const candidate = findCandidate(input.eligible, fallback.alias);
    if (candidate === undefined) continue;
    return {
      via: fallback.via,
      alias: candidate.alias,
      provider: candidate.provider,
      modelId: candidate.modelId,
      ...(decided.reason === undefined ? {} : { reason: decided.reason }),
    };
  }

  const first = input.eligible[0];
  if (first === undefined) return undefined;
  return {
    via: "first-eligible",
    alias: first.alias,
    provider: first.provider,
    modelId: first.modelId,
    ...(decided.reason === undefined ? {} : { reason: decided.reason }),
  };
}
