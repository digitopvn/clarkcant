import { createHmac, timingSafeEqual } from "node:crypto";

import type { SignalInput } from "@clarkcant/contracts";

import {
  type NormalizeContext,
  type NormalizeResult,
  type PollResult,
  type SignalPoller,
  type SignalSourceAdapter,
  type SourceDelivery,
  type VerifyResult,
  headerValue,
} from "./adapter.ts";

/**
 * GitHub as a signal source.
 *
 * A webhook delivery is verified against the repository's webhook secret — HMAC-SHA256 over the exact bytes sent,
 * compared in constant time — before a single field of it is read. What survives is a small, generic signal: a topic
 * such as `github.issue.labeled`, the issue or pull request it is about, the repository as `subject.refs.repository`,
 * and the few payload fields a person's condition would name. The provider's full payload is never stored: it is large,
 * it is GitHub's shape rather than ours, and a condition that needs more is a field added here, where it is tested.
 *
 * Who caused it travels as `provenance.actor`. When that account is this node's own — the login Clark pushes and
 * comments as — the signal is marked `selfGenerated`, which an automation ignores unless it was set up to react to its
 * own effects. That is what keeps "when an issue is labelled, label it" from feeding itself.
 */

export const GITHUB_PROVIDER = "github";
/** The name the node keeps the webhook secret under, asked for with `request_secret` when an automation first needs it. */
export const GITHUB_WEBHOOK_SECRET_NAME = "github_webhook_secret";
/** Who uses the secret, as the secret's metadata records consumers. */
export const GITHUB_WEBHOOK_CONSUMER = "signals:github";
/** A body is text GitHub wrote; anything that could be a message someone typed is cut to this many characters. */
const TEXT_LIMIT = 2_000;

/** The events this adapter turns into signals, and the topic family each one becomes. */
const TOPIC_FAMILY: Readonly<Record<string, string>> = {
  issues: "issue",
  pull_request: "pull_request",
  issue_comment: "issue_comment",
  pull_request_review_comment: "pull_request_review_comment",
  workflow_run: "workflow_run",
  check_suite: "check_suite",
};

export const GITHUB_EVENTS: readonly string[] = Object.keys(TOPIC_FAMILY);

const ACTION_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/* ------------------------------------------------------------------ *
 * Reading a payload that is not ours
 * ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function text(value: unknown, limit = 500): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function login(value: unknown): string | undefined {
  return text(record(value)?.login, 100);
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const name = text(record(entry)?.name, 100);
    return name === undefined ? [] : [name];
  });
}

function instant(value: unknown, fallback: () => string): string {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return fallback();
}

/** A payload without the keys whose value is absent, so a stored signal carries only what GitHub sent. */
function compact(entries: Json): Json {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

function refs(entries: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) kept[key] = value.slice(0, 500);
  return kept;
}

/* ------------------------------------------------------------------ *
 * Verification
 * ------------------------------------------------------------------ */

/**
 * Whether the body was signed with this secret.
 *
 * The comparison is over the decoded digests, in constant time, after a length check that reveals nothing a caller
 * does not already know (every SHA-256 digest is 32 bytes).
 */
export function verifyGithubSignature(rawBody: Uint8Array, signatureHeader: string | undefined, secret: string): VerifyResult {
  if (secret === "") return { ok: false, reason: "no webhook secret is set" };
  if (signatureHeader === undefined || !signatureHeader.startsWith("sha256=")) {
    return { ok: false, reason: "the delivery carries no X-Hub-Signature-256" };
  }
  const presentedHex = signatureHeader.slice("sha256=".length).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(presentedHex)) return { ok: false, reason: "the signature is not a SHA-256 digest" };
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const presented = Buffer.from(presentedHex, "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "the signature does not match" };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

interface EventMeta {
  dedupeKey: string;
  via: string;
  deliveryId?: string;
}

/** The subject and payload for one event, or why there are none. */
function describeEvent(
  event: string,
  body: Json,
  repository: string,
  host: string,
): { ok: true; subject: NonNullable<SignalInput["subject"]>; payload: Json; occurredAt: unknown } | { ok: false; reason: string } {
  const action = text(body.action, 60);
  switch (event) {
    case "issues": {
      const issue = record(body.issue);
      const number = integer(issue?.number);
      if (issue === undefined || number === undefined) return { ok: false, reason: "an issues delivery without its issue" };
      return {
        ok: true,
        subject: { type: "issue", id: String(number), refs: refs({ repository, host, url: text(issue.html_url) }) },
        payload: compact({
          action,
          number,
          title: text(issue.title),
          state: text(issue.state, 40),
          author: login(issue.user),
          labels: labelNames(issue.labels),
          label: text(record(body.label)?.name, 100),
          body: text(issue.body, TEXT_LIMIT),
          url: text(issue.html_url),
        }),
        occurredAt: issue.updated_at,
      };
    }
    case "pull_request": {
      const pull = record(body.pull_request);
      const number = integer(pull?.number) ?? integer(body.number);
      if (pull === undefined || number === undefined) return { ok: false, reason: "a pull_request delivery without its pull request" };
      const head = record(pull.head);
      const base = record(pull.base);
      return {
        ok: true,
        subject: {
          type: "pull_request",
          id: String(number),
          refs: refs({ repository, host, url: text(pull.html_url), headRef: text(head?.ref, 250), baseRef: text(base?.ref, 250) }),
        },
        payload: compact({
          action,
          number,
          title: text(pull.title),
          state: text(pull.state, 40),
          draft: typeof pull.draft === "boolean" ? pull.draft : undefined,
          merged: typeof pull.merged === "boolean" ? pull.merged : undefined,
          author: login(pull.user),
          labels: labelNames(pull.labels),
          label: text(record(body.label)?.name, 100),
          headRef: text(head?.ref, 250),
          headSha: text(head?.sha, 64),
          baseRef: text(base?.ref, 250),
          url: text(pull.html_url),
        }),
        occurredAt: pull.updated_at,
      };
    }
    case "issue_comment": {
      const issue = record(body.issue);
      const comment = record(body.comment);
      const number = integer(issue?.number);
      if (issue === undefined || comment === undefined || number === undefined) {
        return { ok: false, reason: "an issue_comment delivery without its issue or comment" };
      }
      const onPullRequest = record(issue.pull_request) !== undefined;
      return {
        ok: true,
        subject: { type: onPullRequest ? "pull_request" : "issue", id: String(number), refs: refs({ repository, host, url: text(comment.html_url) }) },
        payload: compact({
          action,
          number,
          onPullRequest,
          title: text(issue.title),
          commentId: integer(comment.id),
          author: login(comment.user),
          body: text(comment.body, TEXT_LIMIT),
          labels: labelNames(issue.labels),
          url: text(comment.html_url),
        }),
        occurredAt: comment.updated_at ?? comment.created_at,
      };
    }
    case "pull_request_review_comment": {
      const pull = record(body.pull_request);
      const comment = record(body.comment);
      const number = integer(pull?.number);
      if (pull === undefined || comment === undefined || number === undefined) {
        return { ok: false, reason: "a pull_request_review_comment delivery without its pull request or comment" };
      }
      return {
        ok: true,
        subject: {
          type: "pull_request",
          id: String(number),
          refs: refs({ repository, host, url: text(comment.html_url), headRef: text(record(pull.head)?.ref, 250) }),
        },
        payload: compact({
          action,
          number,
          title: text(pull.title),
          commentId: integer(comment.id),
          author: login(comment.user),
          body: text(comment.body, TEXT_LIMIT),
          path: text(comment.path),
          line: integer(comment.line),
          url: text(comment.html_url),
        }),
        occurredAt: comment.updated_at ?? comment.created_at,
      };
    }
    case "workflow_run": {
      const run = record(body.workflow_run);
      const id = integer(run?.id);
      if (run === undefined || id === undefined) return { ok: false, reason: "a workflow_run delivery without its run" };
      return {
        ok: true,
        subject: { type: "workflow_run", id: String(id), refs: refs({ repository, host, url: text(run.html_url), headRef: text(run.head_branch, 250) }) },
        payload: compact({
          action,
          name: text(run.name, 200),
          status: text(run.status, 40),
          conclusion: text(run.conclusion, 40),
          event: text(run.event, 60),
          headBranch: text(run.head_branch, 250),
          headSha: text(run.head_sha, 64),
          runNumber: integer(run.run_number),
          pullRequests: pullNumbers(run.pull_requests),
          url: text(run.html_url),
        }),
        occurredAt: run.updated_at,
      };
    }
    case "check_suite": {
      const suite = record(body.check_suite);
      const id = integer(suite?.id);
      if (suite === undefined || id === undefined) return { ok: false, reason: "a check_suite delivery without its suite" };
      return {
        ok: true,
        subject: { type: "check_suite", id: String(id), refs: refs({ repository, host, headRef: text(suite.head_branch, 250) }) },
        payload: compact({
          action,
          status: text(suite.status, 40),
          conclusion: text(suite.conclusion, 40),
          headBranch: text(suite.head_branch, 250),
          headSha: text(suite.head_sha, 64),
          app: text(record(suite.app)?.slug, 100),
          pullRequests: pullNumbers(suite.pull_requests),
        }),
        occurredAt: suite.updated_at,
      };
    }
    default:
      return { ok: false, reason: `${event} is not an event this node turns into signals` };
  }
}

function pullNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const number = integer(record(entry)?.number);
    return number === undefined ? [] : [number];
  });
}

/** The host a repository lives on, from its web URL: `github.com`, or an Enterprise server's name. */
function repositoryHost(repository: Json): string {
  const url = text(repository.html_url);
  if (url !== undefined) {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      // Not a URL: the default below is what GitHub itself would be.
    }
  }
  return "github.com";
}

/**
 * One GitHub event, already parsed, as a signal.
 *
 * Shared by the webhook and the poller, so the same fact reads the same way however it arrived.
 */
export function normalizeGithubEvent(event: string, body: unknown, context: NormalizeContext, meta: EventMeta): NormalizeResult {
  const payload = record(body);
  if (payload === undefined) return { kind: "invalid", reason: "the body is not a JSON object" };
  if (event === "ping") return { kind: "ping" };
  const family = TOPIC_FAMILY[event];
  if (family === undefined) return { kind: "ignored", reason: `${event} is not an event this node turns into signals` };
  const action = text(payload.action, 60);
  if (action === undefined || !ACTION_PATTERN.test(action)) {
    return { kind: "invalid", reason: `a ${event} delivery without an action` };
  }
  const repository = record(payload.repository);
  const fullName = text(repository?.full_name, 200);
  if (repository === undefined || fullName === undefined || !fullName.includes("/")) {
    return { kind: "invalid", reason: `a ${event} delivery without its repository` };
  }
  const host = repositoryHost(repository);
  const described = describeEvent(event, payload, fullName, host);
  if (!described.ok) return { kind: "invalid", reason: described.reason };

  const actor = login(payload.sender);
  const selfGenerated =
    actor !== undefined && context.selfLogins.some((self) => self.trim().toLowerCase() === actor.toLowerCase());
  return {
    kind: "signal",
    signal: {
      source: { kind: "external", provider: GITHUB_PROVIDER, sourceId: `github:${host}/${fullName}`.slice(0, 200) },
      topic: `github.${family}.${action}`,
      subject: described.subject,
      payload: described.payload,
      occurredAt: instant(described.occurredAt, context.now),
      dedupeKey: meta.dedupeKey.slice(0, 300),
      provenance: {
        via: meta.via,
        selfGenerated,
        ...(actor === undefined ? {} : { actor }),
        ...(meta.deliveryId === undefined ? {} : { deliveryId: meta.deliveryId }),
      },
    },
  };
}

/** Parse the body GitHub sent, in either content type a webhook can be set to. */
function parseBody(delivery: SourceDelivery): { ok: true; value: unknown } | { ok: false; reason: string } {
  const raw = Buffer.from(delivery.rawBody).toString("utf8");
  const contentType = headerValue(delivery.headers, "content-type") ?? "application/json";
  let json = raw;
  if (contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    const payload = new URLSearchParams(raw).get("payload");
    if (payload === null) return { ok: false, reason: "a form-encoded delivery without its payload field" };
    json = payload;
  }
  try {
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch {
    return { ok: false, reason: "the body is not JSON" };
  }
}

/** The GitHub webhook adapter. Stateless: the secret and the node's own logins are handed in per delivery. */
export const githubWebhookAdapter: SignalSourceAdapter = {
  provider: GITHUB_PROVIDER,
  verify(delivery, secret) {
    return verifyGithubSignature(delivery.rawBody, headerValue(delivery.headers, "x-hub-signature-256"), secret);
  },
  normalize(delivery, context) {
    const event = headerValue(delivery.headers, "x-github-event")?.trim();
    if (event === undefined || event === "") return { kind: "invalid", reason: "the delivery carries no X-GitHub-Event" };
    const deliveryId = headerValue(delivery.headers, "x-github-delivery")?.trim();
    if (deliveryId === undefined || deliveryId === "") return { kind: "invalid", reason: "the delivery carries no X-GitHub-Delivery" };
    const body = parseBody(delivery);
    if (!body.ok) return { kind: "invalid", reason: body.reason };
    // The delivery id is GitHub's own: a redelivery carries the same one, so it is recorded once.
    return normalizeGithubEvent(event, body.value, context, { dedupeKey: `delivery:${deliveryId}`, via: "github webhook", deliveryId });
  },
};

/* ------------------------------------------------------------------ *
 * Repository binding
 * ------------------------------------------------------------------ */

/**
 * The repository a git remote URL points at: `https://github.com/acme/widgets.git`, `git@github.com:acme/widgets`,
 * `ssh://git@github.com/acme/widgets.git`. Credentials in the URL are dropped, never returned.
 */
export function githubRepositoryFromRemote(remote: string): { host: string; fullName: string } | undefined {
  const trimmed = remote.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      host = url.hostname.toLowerCase();
      path = url.pathname;
    } catch {
      return undefined;
    }
  } else if (scp !== null && scp[1] !== undefined && scp[2] !== undefined) {
    host = scp[1].toLowerCase();
    path = scp[2];
  } else {
    return undefined;
  }
  const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || parts.some((part) => part === "")) return undefined;
  return { host, fullName: `${parts[0] ?? ""}/${parts[1] ?? ""}` };
}

/** Whether a remote points at the repository a signal is about. GitHub names are case-insensitive. */
export function remoteMatchesRepository(remote: string, repository: string, host?: string): boolean {
  const parsed = githubRepositoryFromRemote(remote);
  if (parsed === undefined) return false;
  if (host !== undefined && parsed.host !== host.toLowerCase()) return false;
  return parsed.fullName.toLowerCase() === repository.toLowerCase();
}

/* ------------------------------------------------------------------ *
 * Polling
 * ------------------------------------------------------------------ */

/** The Events API names for the events above. Only the ones the Events API carries: CI runs arrive by webhook. */
const EVENT_FROM_TYPE: Readonly<Record<string, string>> = {
  IssuesEvent: "issues",
  PullRequestEvent: "pull_request",
  IssueCommentEvent: "issue_comment",
  PullRequestReviewCommentEvent: "pull_request_review_comment",
};

export interface GithubPollerOptions {
  /** `owner/name`. */
  repository: string;
  fetch: typeof globalThis.fetch;
  /** Sent as a bearer token when given. A public repository can be polled without one, within GitHub's rate limit. */
  token?: string;
  apiBase?: string;
  selfLogins: readonly string[];
  now: () => string;
}

function laterId(left: string | undefined, right: string): string {
  if (left === undefined) return right;
  try {
    return BigInt(right) > BigInt(left) ? right : left;
  } catch {
    return left;
  }
}

/**
 * Polling a repository's events, for a node GitHub cannot reach.
 *
 * The first poll only finds where "now" is: events from before a person set anything up are history, not signals. After
 * that, each poll returns the events newer than the cursor, oldest first.
 */
export function createGithubPoller(options: GithubPollerOptions): SignalPoller {
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  // Where the repositories live, for their web URL: github.com behind the public API, the server itself for Enterprise.
  const apiHost = new URL(apiBase).host.toLowerCase();
  const webHost = apiHost === "api.github.com" ? "github.com" : apiHost;
  return {
    provider: GITHUB_PROVIDER,
    async poll(cursor): Promise<PollResult> {
      const [owner, name] = options.repository.split("/");
      if (owner === undefined || name === undefined || owner === "" || name === "") {
        throw new Error(`${options.repository} is not owner/name`);
      }
      const response = await options.fetch(`${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/events?per_page=100`, {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        },
      });
      if (!response.ok) throw new Error(`GitHub answered ${String(response.status)} for the events of ${options.repository}`);
      const listed: unknown = await response.json();
      if (!Array.isArray(listed)) throw new Error(`GitHub's events for ${options.repository} were not a list`);

      let next = cursor;
      const fresh: { id: string; event: Json }[] = [];
      for (const entry of listed) {
        const event = record(entry);
        const id = text(event?.id, 40);
        if (event === undefined || id === undefined || !/^\d+$/.test(id)) continue;
        next = laterId(next, id);
        if (cursor !== undefined && BigInt(id) > BigInt(cursor)) fresh.push({ id, event });
      }
      if (cursor === undefined) return { signals: [], cursor: next };

      fresh.sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
      const signals: SignalInput[] = [];
      for (const { id, event } of fresh) {
        const name = EVENT_FROM_TYPE[text(event.type, 80) ?? ""];
        if (name === undefined) continue;
        const repo = record(event.repo);
        const fullName = text(repo?.name, 200) ?? options.repository;
        const body = {
          ...record(event.payload),
          repository: { full_name: fullName, html_url: `https://${webHost}/${fullName}` },
          sender: record(event.actor) ?? {},
        };
        const normalized = normalizeGithubEvent(name, body, { selfLogins: options.selfLogins, now: () => instant(event.created_at, options.now) }, {
          dedupeKey: `event:${id}`,
          via: "github poll",
        });
        if (normalized.kind === "signal") signals.push(normalized.signal);
      }
      return { signals, cursor: next };
    },
  };
}
