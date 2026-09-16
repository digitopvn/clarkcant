/**
 * Usage limits and credential freshness.
 *
 * Both exist to make a refusal happen before the work rather than after it. A quota checked after
 * a run has spent its budget has already failed; a credential checked when a call fails leaves the
 * user looking at an authentication error instead of "this connection expired three days ago".
 *
 * The accounting is deliberately per-window rather than cumulative. A cumulative counter can only
 * ever refuse, so a user who hit a limit yesterday would still be blocked today, and the only
 * recovery would be a manual reset.
 */

import { type Instant } from "@clarkcant/contracts";
import { type Database, allRows, oneRow, transaction } from "@clarkcant/storage";

export interface LimitDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
}

/**
 * A window's ceilings.
 *
 * Every field is optional, and an absent field means "no limit" rather than "zero": a node with no
 * configured ceiling must not refuse everything.
 */
export interface UsageLimits {
  runs?: number;
  tokens?: number;
  artifactBytes?: number;
  wallClockMs?: number;
}

export interface UsageTotals {
  runs: number;
  tokens: number;
  artifactBytes: number;
  wallClockMs: number;
}

const ZERO: UsageTotals = { runs: 0, tokens: 0, artifactBytes: 0, wallClockMs: 0 };

/** The start of the window containing a moment, truncated to the hour in UTC. */
export function windowStartFor(at: Instant, windowMs = 3_600_000): Instant {
  const ms = Date.parse(at);
  return new Date(Math.floor(ms / windowMs) * windowMs).toISOString() as Instant;
}

export function readUsage(
  deps: LimitDeps,
  input: { scopeKey: string; windowStart: Instant },
): UsageTotals {
  const row = oneRow<{
    runs: number;
    tokens: number;
    artifact_bytes: number;
    wall_clock_ms: number;
  }>(
    deps.db,
    "SELECT runs, tokens, artifact_bytes, wall_clock_ms FROM usage_counters WHERE node_id = ? AND scope_key = ? AND window_start = ?",
    deps.nodeId,
    input.scopeKey,
    input.windowStart,
  );
  return row === undefined
    ? ZERO
    : {
        runs: row.runs,
        tokens: row.tokens,
        artifactBytes: row.artifact_bytes,
        wallClockMs: row.wall_clock_ms,
      };
}

export type QuotaDecision =
  | { allowed: true; remaining: UsageTotals }
  | {
      allowed: false;
      /** Which ceiling was reached, named so the refusal explains itself. */
      exceeded: keyof UsageLimits;
      limit: number;
      used: number;
      retryAfter: Instant;
    };

/**
 * Decide whether another run may start.
 *
 * Refusing here, before the work, is the point: a run admitted over its ceiling cannot be
 * un-spent, so the only useful place to check is the door.
 */
export function checkQuota(
  deps: LimitDeps,
  input: { scopeKey: string; limits: UsageLimits; estimated?: Partial<UsageTotals> },
): QuotaDecision {
  const windowStart = windowStartFor(deps.now());
  const used = readUsage(deps, { scopeKey: input.scopeKey, windowStart });
  const estimated = input.estimated ?? {};

  const ceilingFor: [keyof UsageLimits, keyof UsageTotals][] = [
    ["runs", "runs"],
    ["tokens", "tokens"],
    ["artifactBytes", "artifactBytes"],
    ["wallClockMs", "wallClockMs"],
  ];

  // The estimate is counted against the ceiling, so a run that would certainly exceed it is
  // refused rather than admitted and then failed half-way.
  for (const [limitKey, totalKey] of ceilingFor) {
    const limit = input.limits[limitKey];
    if (limit === undefined) continue;
    const projected = used[totalKey] + (estimated[totalKey] ?? 0);
    if (projected > limit) {
      return {
        allowed: false,
        exceeded: limitKey,
        limit,
        used: used[totalKey],
        retryAfter: new Date(Date.parse(windowStart) + 3_600_000).toISOString() as Instant,
      };
    }
  }

  const remaining: UsageTotals = {
    runs: input.limits.runs === undefined ? Number.POSITIVE_INFINITY : input.limits.runs - used.runs,
    tokens: input.limits.tokens === undefined ? Number.POSITIVE_INFINITY : input.limits.tokens - used.tokens,
    artifactBytes:
      input.limits.artifactBytes === undefined
        ? Number.POSITIVE_INFINITY
        : input.limits.artifactBytes - used.artifactBytes,
    wallClockMs:
      input.limits.wallClockMs === undefined
        ? Number.POSITIVE_INFINITY
        : input.limits.wallClockMs - used.wallClockMs,
  };
  return { allowed: true, remaining };
}

/** Add to a window's totals. Additive, so two concurrent runs both count. */
export function recordUsage(
  deps: LimitDeps,
  input: { scopeKey: string; windowStart: Instant; delta: Partial<UsageTotals> },
): UsageTotals {
  return transaction(deps.db, () => {
    deps.db
      .prepare(
        `INSERT INTO usage_counters (node_id, scope_key, window_start, runs, tokens, artifact_bytes, wall_clock_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (node_id, scope_key, window_start) DO UPDATE SET
           runs = runs + excluded.runs,
           tokens = tokens + excluded.tokens,
           artifact_bytes = artifact_bytes + excluded.artifact_bytes,
           wall_clock_ms = wall_clock_ms + excluded.wall_clock_ms`,
      )
      .run(
        deps.nodeId,
        input.scopeKey,
        input.windowStart,
        input.delta.runs ?? 0,
        input.delta.tokens ?? 0,
        input.delta.artifactBytes ?? 0,
        input.delta.wallClockMs ?? 0,
      );
    return readUsage(deps, { scopeKey: input.scopeKey, windowStart: input.windowStart });
  });
}

/** Drop windows that have already ended, so the table does not grow without bound. */
export function pruneUsage(deps: LimitDeps, keepWindows = 24): number {
  const cutoff = new Date(Date.parse(windowStartFor(deps.now())) - keepWindows * 3_600_000).toISOString();
  const result = deps.db
    .prepare("DELETE FROM usage_counters WHERE node_id = ? AND window_start < ?")
    .run(deps.nodeId, cutoff);
  return Number(result.changes);
}

/* ------------------------------------------------------------------ *
 * Credential freshness
 * ------------------------------------------------------------------ */

export interface CredentialState {
  connectionId: string;
  provider: string;
  /** Where the credential lives. A remote task is routed to that node rather than the token. */
  credentialNodeId: string;
  status: "valid" | "expiring" | "expired" | "revoked" | "unknown";
  expiresAt: Instant | undefined;
  /** Whole days until expiry; negative once past. */
  daysRemaining: number | undefined;
  /** What the user should be told, in one sentence. */
  message: string;
}

/** How soon before expiry the user is warned, so a refresh can happen while it still works. */
export const EXPIRY_WARNING_DAYS = 7;

/**
 * Read a connection's credential state.
 *
 * `expiresAt` is optional and its absence is reported as `unknown` rather than treated as valid
 * forever: a connection whose provider does not tell us when it expires is not the same as one we
 * know is good.
 */
export function credentialState(
  deps: LimitDeps,
  connectionId: string,
): CredentialState | undefined {
  const row = oneRow<{
    connection_id: string;
    provider: string;
    credential_node_id: string;
    status: string;
    document: string;
  }>(
    deps.db,
    "SELECT connection_id, provider, credential_node_id, status, document FROM connections WHERE connection_id = ?",
    connectionId,
  );
  if (!row) return undefined;

  let expiresAt: string | undefined;
  try {
    const document = JSON.parse(row.document) as { expiresAt?: unknown };
    if (typeof document.expiresAt === "string") expiresAt = document.expiresAt;
  } catch {
    // A malformed document is not a reason to claim the credential is fine.
    expiresAt = undefined;
  }

  const base = {
    connectionId: row.connection_id,
    provider: row.provider,
    credentialNodeId: row.credential_node_id,
    expiresAt: expiresAt as Instant | undefined,
  };

  if (row.status === "revoked") {
    return {
      ...base,
      status: "revoked",
      daysRemaining: undefined,
      message: `The ${row.provider} connection was revoked. It has to be reconnected before it can be used.`,
    };
  }

  if (expiresAt === undefined) {
    return {
      ...base,
      status: "unknown",
      daysRemaining: undefined,
      message: `The ${row.provider} connection does not report an expiry, so it is used until it fails.`,
    };
  }

  const msRemaining = Date.parse(expiresAt) - Date.parse(deps.now());
  const daysRemaining = Math.floor(msRemaining / 86_400_000);

  if (msRemaining <= 0) {
    return {
      ...base,
      status: "expired",
      daysRemaining,
      message: `The ${row.provider} connection expired ${Math.abs(daysRemaining)} day(s) ago. Reconnect it before using it.`,
    };
  }

  if (daysRemaining <= EXPIRY_WARNING_DAYS) {
    return {
      ...base,
      status: "expiring",
      daysRemaining,
      message: `The ${row.provider} connection expires in ${daysRemaining} day(s). Reconnect it while it still works.`,
    };
  }

  return {
    ...base,
    status: "valid",
    daysRemaining,
    message: `The ${row.provider} connection is valid for ${daysRemaining} more day(s).`,
  };
}

export type ConnectionRoutingDecision =
  | { route: true; credentialNodeId: string }
  | { route: false; reason: string; credential: CredentialState };

/**
 * Decide whether a connection may be used for a new call.
 *
 * An expired credential is refused here rather than at the provider, so the user is told what is
 * wrong in the application's own words instead of being shown an authentication error from
 * somewhere else.
 */
export function mayUseConnection(deps: LimitDeps, connectionId: string): ConnectionRoutingDecision {
  const credential = credentialState(deps, connectionId);
  if (!credential) {
    return {
      route: false,
      reason: `connection ${connectionId} does not exist`,
      credential: {
        connectionId,
        provider: "unknown",
        credentialNodeId: "unknown",
        status: "unknown",
        expiresAt: undefined,
        daysRemaining: undefined,
        message: `connection ${connectionId} does not exist`,
      },
    };
  }
  if (credential.status === "expired" || credential.status === "revoked") {
    return { route: false, reason: credential.message, credential };
  }
  return { route: true, credentialNodeId: credential.credentialNodeId };
}

/** Every connection whose credential needs attention, newest expiry first. */
export function connectionsNeedingAttention(deps: LimitDeps): CredentialState[] {
  const rows = allRows<{ connection_id: string }>(deps.db, "SELECT connection_id FROM connections");
  const states: CredentialState[] = [];
  for (const row of rows) {
    const state = credentialState(deps, row.connection_id);
    if (state && (state.status === "expired" || state.status === "expiring" || state.status === "revoked")) {
      states.push(state);
    }
  }
  return states.sort((a, b) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0));
}
