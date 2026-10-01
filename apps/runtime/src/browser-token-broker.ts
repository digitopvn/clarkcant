import {
  type BrowserTokenDeclaration,
  type BrowserTokenGrant,
  type BrowserTokenRefusal,
  type BrowserTokenRequest,
} from "@clarkcant/contracts";
import { type BrowserTokenAdapter, checkBrowserTokenRequest } from "@clarkcant/integration-sdk";

/**
 * The node's browser-token broker: the one place a provider token meant for a widget frame is minted and withdrawn.
 *
 * What it holds, and what it never holds:
 *
 * - **A token is bound to one instance and one frame session.** The session id is chosen by the host chrome that
 *   mounted the frame, and when that frame goes away its tokens are revoked. A token asked for under a session that
 *   already ended is revoked as soon as it arrives and never handed out.
 * - **Its lifetime is enforced here**, not only stated: a token is forgotten at its expiry, and a provider that gave a
 *   longer lifetime than was asked is revoked at the lifetime asked — or, when it cannot be revoked, refused.
 * - **The value is passed through, never kept.** The broker keeps the provider's id for the token, so it can revoke
 *   it, and the provider and instance it was for, so the audit can say who held what. No log, audit line or error it
 *   writes contains the value.
 */

export interface BrowserTokenAuditEvent {
  provider: string;
  packageId: string;
  instanceId: string;
  outcome: "issued" | "refused" | "revoked" | "expired";
  /** For a refusal, why. */
  code?: BrowserTokenRefusal;
  /** For an issued token, when it stops working. */
  expiresAt?: string;
}

export type BrowserTokenIssueOutcome =
  | { ok: true; grant: BrowserTokenGrant }
  | { ok: false; code: BrowserTokenRefusal; message: string };

/** One live token, as the broker remembers it: everything but the value. */
export interface HeldBrowserToken {
  provider: string;
  packageId: string;
  instanceId: string;
  session: string;
  tokenId: string;
  expiresAt: string;
}

export interface BrowserTokenBroker {
  /** Make a provider's adapter available. A later adapter for the same provider replaces the earlier one. */
  register(adapter: BrowserTokenAdapter): void;
  issue(input: {
    packageId: string;
    instanceId: string;
    session: string;
    declared: readonly BrowserTokenDeclaration[];
    request: BrowserTokenRequest;
  }): Promise<BrowserTokenIssueOutcome>;
  /** The frame went away: revoke its tokens and refuse any later request under that session. */
  endSession(instanceId: string, session: string): Promise<number>;
  /** The package was uninstalled: revoke every token any of its instances holds. */
  endPackage(packageId: string): Promise<number>;
  /** What is live, without values. */
  held(): readonly HeldBrowserToken[];
  /** Revoke everything, as the node stops. */
  close(): Promise<void>;
}

interface Held extends HeldBrowserToken {
  adapter: BrowserTokenAdapter;
  timer: ReturnType<typeof setTimeout>;
}

/** Live tokens one frame session may hold at once; a new one beyond this withdraws the oldest. */
const MAX_TOKENS_PER_SESSION = 8;
/** Ended sessions remembered, so a request that raced the frame's disposal is still refused. */
const MAX_ENDED_SESSIONS = 1_024;

export function createBrowserTokenBroker(options: {
  adapters?: readonly BrowserTokenAdapter[];
  audit?: (event: BrowserTokenAuditEvent) => void;
  log?: (line: string) => void;
  now?: () => number;
  /** How long a provider has to mint or revoke a token. */
  timeoutMs?: number;
}): BrowserTokenBroker {
  const adapters = new Map<string, BrowserTokenAdapter>();
  for (const adapter of options.adapters ?? []) adapters.set(adapter.support.provider, adapter);
  const now = options.now ?? ((): number => Date.now());
  const timeoutMs = options.timeoutMs ?? 15_000;
  const held = new Map<string, Held>();
  const ended = new Set<string>();
  const sessionKey = (instanceId: string, session: string): string => `${instanceId}\u0000${session}`;

  const audit = (event: BrowserTokenAuditEvent): void => {
    try {
      options.audit?.(event);
    } catch {
      // The audit is a record of what happened, not a gate on it; a failed write must not keep a token alive.
    }
  };

  /** Revoke at the provider where it can be, and forget the token either way. */
  const withdraw = async (entry: Held, outcome: "revoked" | "expired"): Promise<void> => {
    if (held.get(entry.tokenId) !== entry) return;
    held.delete(entry.tokenId);
    clearTimeout(entry.timer);
    if (outcome === "revoked" && entry.adapter.support.revocation === "revocable" && entry.adapter.revoke !== undefined) {
      try {
        await entry.adapter.revoke(entry.tokenId, AbortSignal.timeout(timeoutMs));
      } catch (cause) {
        // Named by provider and instance only. The token still lapses at its expiry, which is never more than an hour.
        options.log?.(
          `browser tokens: ${entry.provider} did not confirm revoking a token for ${entry.instanceId} (${cause instanceof Error ? cause.name : "error"}); it lapses at ${entry.expiresAt}`,
        );
      }
    }
    audit({ provider: entry.provider, packageId: entry.packageId, instanceId: entry.instanceId, outcome });
  };

  const withdrawWhere = async (match: (entry: Held) => boolean): Promise<number> => {
    const matched = [...held.values()].filter(match);
    await Promise.all(matched.map((entry) => withdraw(entry, "revoked")));
    return matched.length;
  };

  const refuse = (
    input: { provider: string; packageId: string; instanceId: string },
    code: BrowserTokenRefusal,
    message: string,
  ): BrowserTokenIssueOutcome => {
    audit({ provider: input.provider, packageId: input.packageId, instanceId: input.instanceId, outcome: "refused", code });
    return { ok: false, code, message };
  };

  return {
    register(adapter) {
      adapters.set(adapter.support.provider, adapter);
    },

    async issue(input) {
      const who = { provider: input.request.provider, packageId: input.packageId, instanceId: input.instanceId };
      const key = sessionKey(input.instanceId, input.session);
      if (ended.has(key)) return refuse(who, "TOKEN_SESSION_ENDED", "the frame this token was asked for has closed");
      const adapter = adapters.get(input.request.provider);
      const checked = checkBrowserTokenRequest({ support: adapter?.support, declared: input.declared, request: input.request });
      if (!checked.ok) return refuse(who, checked.code, checked.message);
      if (adapter === undefined) return refuse(who, "TOKEN_PROVIDER_UNAVAILABLE", `this node has no browser-token adapter for ${who.provider}`);

      let issued;
      try {
        issued = await adapter.issue({
          scopes: checked.scopes,
          ttlSeconds: checked.ttlSeconds,
          bindTo: { packageId: input.packageId, instanceId: input.instanceId },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // A fixed sentence: what an adapter threw may carry the provider's own response, and that is not the widget's.
        return refuse(who, "TOKEN_ISSUE_FAILED", `${who.provider} did not issue a token; try again later`);
      }
      if (
        typeof issued.token !== "string" ||
        issued.token === "" ||
        typeof issued.tokenId !== "string" ||
        issued.tokenId === "" ||
        !Number.isFinite(issued.expiresInSeconds) ||
        issued.expiresInSeconds <= 0
      ) {
        return refuse(who, "TOKEN_ISSUE_FAILED", `${who.provider} answered without a usable token`);
      }

      const lifetimeSeconds = Math.min(issued.expiresInSeconds, checked.ttlSeconds);
      const expiresAtMs = now() + lifetimeSeconds * 1000;
      const entry: Held = {
        provider: who.provider,
        packageId: input.packageId,
        instanceId: input.instanceId,
        session: input.session,
        tokenId: issued.tokenId,
        expiresAt: new Date(expiresAtMs).toISOString(),
        adapter,
        // Revoked rather than merely forgotten when the provider gave longer than asked: the lifetime asked is the one
        // the person's frame is held to.
        timer: setTimeout(
          () => void withdraw(entry, issued.expiresInSeconds > checked.ttlSeconds ? "revoked" : "expired"),
          lifetimeSeconds * 1000,
        ),
      };
      entry.timer.unref?.();
      held.set(entry.tokenId, entry);

      if (issued.expiresInSeconds > checked.ttlSeconds && adapter.support.revocation !== "revocable") {
        // A token that outlives what was asked and cannot be withdrawn is one this node cannot hold to its lifetime.
        held.delete(entry.tokenId);
        clearTimeout(entry.timer);
        return refuse(who, "TOKEN_ISSUE_FAILED", `${who.provider} issued a token longer-lived than asked, and it cannot be revoked`);
      }
      if (ended.has(key)) {
        // The frame closed while the provider was minting: the token is withdrawn, never handed to anyone.
        await withdraw(entry, "revoked");
        return { ok: false, code: "TOKEN_SESSION_ENDED", message: "the frame this token was asked for has closed" };
      }
      const live = [...held.values()].filter((other) => other.instanceId === input.instanceId && other.session === input.session);
      for (const oldest of live.slice(0, Math.max(0, live.length - MAX_TOKENS_PER_SESSION))) await withdraw(oldest, "revoked");

      audit({ ...who, outcome: "issued", expiresAt: entry.expiresAt });
      return { ok: true, grant: { provider: who.provider, token: issued.token, scopes: checked.scopes, expiresAt: entry.expiresAt } };
    },

    async endSession(instanceId, session) {
      const key = sessionKey(instanceId, session);
      ended.add(key);
      if (ended.size > MAX_ENDED_SESSIONS) ended.delete(ended.values().next().value ?? key);
      return await withdrawWhere((entry) => entry.instanceId === instanceId && entry.session === session);
    },

    async endPackage(packageId) {
      return await withdrawWhere((entry) => entry.packageId === packageId);
    },

    held: () =>
      [...held.values()].map(({ provider, packageId, instanceId, session, tokenId, expiresAt }) => ({
        provider,
        packageId,
        instanceId,
        session,
        tokenId,
        expiresAt,
      })),

    async close() {
      await withdrawWhere(() => true);
    },
  };
}
