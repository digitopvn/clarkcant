import type { Instant } from "@clarkcant/contracts";
import { ingestSignal } from "@clarkcant/core";
import {
  GITHUB_TOKEN_SECRET_NAME,
  GITHUB_WEBHOOK_CONSUMER,
  type PollResult,
  SignalPollError,
  createGithubPoller,
} from "@clarkcant/signal-sources";
import {
  type Database,
  type SignalPollState,
  activeIntentsForTopicFamily,
  getSecretMetadata,
  getSignalPollState,
  lastSignalReceivedAt,
  putSignalPollState,
} from "@clarkcant/storage";

import { tryRecordNodeNotice } from "./notices.ts";
import { githubSelfLogins } from "./routes/github-signals.ts";
import { createSecretBroker } from "./secret-broker.ts";
import type { NodeServices } from "./services.ts";

/**
 * GitHub's events for a node GitHub cannot deliver to.
 *
 * A webhook needs an address GitHub can reach, and a laptop behind a router has none. So the repositories the person's
 * GitHub automations are about are polled instead, into the same signals a delivery would record. Nothing is set up for
 * it: the repositories are read from the active automations' own `subject.refs.repository` conditions, and a node with no
 * GitHub automation makes no request at all.
 *
 * Each repository keeps where it got to in the store — the newest event already recorded and GitHub's tag for that
 * answer — so a restart goes on from there, and an event is recorded once however often it is listed. A repository is
 * asked at most every five minutes, or less often when GitHub says so, and not at all while its webhook works: a verified
 * delivery in the last day means GitHub reaches this node, and polling as well would record each fact twice.
 *
 * A public repository is read without a token. A private one answers 404 to a request without one, so the token is
 * offered when there is one the person allowed for this; when GitHub still refuses, the person is told once, with what
 * to do, and the repository is asked again less and less often until it answers.
 */

export const GITHUB_POLL_INTERVAL_MS = 5 * 60_000;
/** How long a verified webhook delivery counts as proof that GitHub reaches this node. */
export const GITHUB_WEBHOOK_QUIET_MS = 24 * 60 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
/** Failures in a row before a failure that is not a refusal is worth the person's attention. */
const NOTICE_AFTER_FAILURES = 3;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface PolledRepository {
  /** `owner/name`, as the automation wrote it. */
  repository: string;
  /** Where its state is kept: `github.com/owner/name`, lower-case, since GitHub's names are case-insensitive. */
  sourceKey: string;
  /** Where the first automation about it was set up, which is where a problem with it is pointed at. */
  conversationId: string;
}

/**
 * The github.com repositories the active GitHub automations are about, each once.
 *
 * Only what a condition names exactly — `equals owner/name`, or each name of an `in` — since that is all a poll can ask
 * for. An automation bound to another host is left to its webhook: an Enterprise server's API is not asked here.
 */
export function polledGithubRepositories(db: Database): PolledRepository[] {
  const found = new Map<string, PolledRepository>();
  for (const intent of activeIntentsForTopicFamily(db, "github.")) {
    const host = intent.match.find((condition) => condition.path === "subject.refs.host");
    if (host !== undefined && !(host.op === "equals" && typeof host.value === "string" && host.value.toLowerCase() === "github.com")) {
      continue;
    }
    for (const condition of intent.match) {
      if (condition.path !== "subject.refs.repository") continue;
      const values: readonly unknown[] = condition.op === "equals" ? [condition.value] : condition.op === "in" ? condition.value : [];
      for (const value of values) {
        if (typeof value !== "string" || !REPOSITORY_PATTERN.test(value)) continue;
        const sourceKey = `github.com/${value.toLowerCase()}`;
        if (!found.has(sourceKey)) found.set(sourceKey, { repository: value, sourceKey, conversationId: intent.conversationId });
      }
    }
  }
  return [...found.values()];
}

export interface GithubPolling {
  /** Poll each repository that is due. Answers how many new signals were recorded; never rejects. */
  pollDue(): Promise<number>;
}

export interface GithubPollingOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => Instant;
  apiBase?: string;
}

function later(at: Instant, ms: number): Instant {
  return new Date(Date.parse(at) + ms).toISOString() as Instant;
}

export function createGithubPolling(
  services: Pick<NodeServices, "runtime" | "conductor">,
  options: GithubPollingOptions = {},
): GithubPolling {
  const now = options.now ?? ((): Instant => new Date().toISOString() as Instant);
  const fetch = options.fetch ?? globalThis.fetch;
  const db = services.runtime.db;
  const principalId = services.runtime.identity.ownerPrincipalId;

  /** Whether the token was stored after the last attempt: a refusal is worth asking about again as soon as it is. */
  const tokenChangedSince = (at: Instant): boolean => {
    const metadata = getSecretMetadata(db, principalId, GITHUB_TOKEN_SECRET_NAME);
    return metadata !== undefined && metadata.updatedAt > at;
  };

  const due = (target: PolledRepository, state: SignalPollState | undefined, at: Instant): boolean => {
    if (state !== undefined && state.nextPollAt > at && !(state.failures > 0 && tokenChangedSince(state.updatedAt))) return false;
    const delivered = lastSignalReceivedAt(db, `github:${target.sourceKey}`, "delivery:");
    return delivered === undefined || Date.parse(at) - Date.parse(delivered) >= GITHUB_WEBHOOK_QUIET_MS;
  };

  const failed = (target: PolledRepository, state: SignalPollState | undefined, cause: unknown, withToken: boolean): void => {
    const at = now();
    const error = cause instanceof SignalPollError ? cause : undefined;
    // Written from the status and the repository only: nothing a request carried is in it.
    const reason = cause instanceof Error ? cause.message : String(cause);
    const kept = {
      sourceKey: target.sourceKey,
      ...(state?.cursor === undefined ? {} : { cursor: state.cursor }),
      ...(state?.etag === undefined ? {} : { etag: state.etag }),
    };
    if (error?.rateLimited === true) {
      // Waiting is what GitHub asked for; it is not a failure of this repository.
      const retryAt = error.retryAt === undefined ? undefined : (error.retryAt as Instant);
      const soonest = later(at, GITHUB_POLL_INTERVAL_MS);
      putSignalPollState(db, {
        ...kept,
        nextPollAt: retryAt !== undefined && retryAt > soonest ? retryAt : soonest,
        failures: state?.failures ?? 0,
        ...(state?.failingSince === undefined ? {} : { failingSince: state.failingSince }),
        lastError: reason,
        updatedAt: at,
      });
      return;
    }
    const failures = (state?.failures ?? 0) + 1;
    const failingSince = state?.failingSince ?? at;
    const wait = Math.min(GITHUB_POLL_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
    putSignalPollState(db, { ...kept, nextPollAt: later(at, wait), failures, failingSince, lastError: reason, updatedAt: at });

    // A refusal is worth saying at once; anything else only once it keeps happening. Keyed on the run of failures, so
    // the person hears once per run whichever comes first, and again only after the repository has answered.
    const refused = error !== undefined && [401, 403, 404].includes(error.status);
    if (!refused && failures < NOTICE_AFTER_FAILURES) return;
    const body = !refused
      ? `Chưa đọc được sự kiện GitHub của ${target.repository} sau ${String(failures)} lần thử (${reason}). Node vẫn thử lại, thưa dần, và các việc tự động về repository này chờ đến khi đọc được.`
      : withToken
        ? `GitHub từ chối token “${GITHUB_TOKEN_SECRET_NAME}” khi node đọc sự kiện của ${target.repository} (${String(error.status)}): token có thể đã hết hạn hoặc không có quyền đọc repository này. Hãy nói với Clark để lưu lại token; node thử lại ngay khi có token mới.`
        : `GitHub không cho node này đọc sự kiện của ${target.repository} (${String(error.status)}). Nếu đây là repository riêng tư, hãy nói với Clark để lưu token GitHub cho việc theo dõi repository này; node thử lại ngay khi có token.`;
    tryRecordNodeNotice(services, {
      sourceKind: "automation",
      category: "alert",
      severity: "warning",
      title: `Chưa theo dõi được ${target.repository}`,
      body,
      conversationId: target.conversationId,
      // Names the repository, so "stop telling me about this" quiets this repository's polling and no other's.
      subject: { kind: "signal-source", sourceKey: target.sourceKey, label: target.repository, conversationId: target.conversationId },
      dedupKey: `github-poll:${target.sourceKey}:${failingSince}`,
      at,
    });
  };

  const pollOne = async (target: PolledRepository, state: SignalPollState | undefined): Promise<number> => {
    const selfLogins = githubSelfLogins(db, principalId, now);
    const poll = (token?: string): Promise<PollResult> =>
      createGithubPoller({
        repository: target.repository,
        fetch,
        ...(token === undefined ? {} : { token }),
        ...(options.apiBase === undefined ? {} : { apiBase: options.apiBase }),
        selfLogins,
        now,
      }).poll(state?.cursor, state?.etag === undefined ? {} : { etag: state.etag });

    // The token goes from the store into this one request's header and nowhere else. Without one the person allowed for
    // this, the request goes without, which is all a public repository needs.
    const withToken = createSecretBroker({ db, principalId, now }).withSecret(
      { name: GITHUB_TOKEN_SECRET_NAME, consumer: GITHUB_WEBHOOK_CONSUMER },
      (token) => poll(token),
    );
    let result: PollResult;
    try {
      result = await (withToken.ok ? withToken.result : poll());
    } catch (cause) {
      failed(target, state, cause, withToken.ok);
      return 0;
    }

    let recorded = 0;
    const deps = { db, nodeId: services.runtime.identity.nodeId, now, newId: services.conductor.newId };
    for (const signal of result.signals) {
      const ingested = ingestSignal(deps, signal);
      if (ingested.ok && ingested.created) recorded += 1;
    }
    // After the signals: a node that stops in between lists the same events again, and each is already recorded.
    const at = now();
    putSignalPollState(db, {
      sourceKey: target.sourceKey,
      ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
      ...(result.etag === undefined ? {} : { etag: result.etag }),
      nextPollAt: later(at, Math.max(GITHUB_POLL_INTERVAL_MS, (result.pollIntervalSeconds ?? 0) * 1000)),
      failures: 0,
      updatedAt: at,
    });
    return recorded;
  };

  return {
    async pollDue() {
      let recorded = 0;
      for (const target of polledGithubRepositories(db)) {
        try {
          const state = getSignalPollState(db, target.sourceKey);
          if (!due(target, state, now())) continue;
          recorded += await pollOne(target, state);
        } catch (cause) {
          process.stderr.write(
            `github polling: ${target.repository} could not be polled (${cause instanceof Error ? cause.message : String(cause)})\n`,
          );
        }
      }
      return recorded;
    },
  };
}
