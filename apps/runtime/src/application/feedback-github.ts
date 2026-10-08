import { FEEDBACK_REPOSITORY, type Instant, type IssueMention } from "@clarkcant/contracts";
import { GITHUB_TOKEN_SECRET_NAME } from "@clarkcant/signal-sources";

import { createSecretBroker } from "../secret-broker.ts";
import type { NodeServices } from "../services.ts";

/**
 * GitHub, as product reports reach it (#510): the few REST calls a report needs, and nothing else.
 *
 * The token is the person's own `github_token` (#197), handed by the secret broker into one request's header and gone:
 * this module never holds it. Reading needs no token for a public repository, so searching for duplicates works on a
 * node that has none; writing needs one, and without it the report says so instead of being sent.
 *
 * Every failure is classified by what it means for the write, because that decides what the ledger may say:
 *
 *   - `refused` — GitHub answered and did not do it (a 4xx). Nothing was filed;
 *   - `not-sent` — the request never reached GitHub (no route, no name, refused connection). Nothing was filed;
 *   - `no-answer` — it may have reached GitHub and no answer came back that can be trusted (a timeout, a reset, a 5xx).
 *     Whether it was filed is found out by the report's marker, never by sending it again.
 */

export interface GithubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  body: string;
  labels: string[];
  assignees: string[];
  closedAt?: string;
  /** GitHub lists pull requests as issues too; a report is never matched to one. */
  isPullRequest: boolean;
}

export interface IssueActivity {
  openPullRequests: IssueMention[];
  /** The newest comment saying someone is taking the issue ("claimed", "working on this"), by its author. */
  claimedBy?: string;
}

/** A comment that says someone has taken the issue, in the words this repository's contributors use. */
const CLAIM_COMMENT = /\b(claim(?:ed|ing)?|taking this|i(?:'|’)?ll take (?:this|it)|working on (?:this|it)|picking (?:this|it) up)\b|đang (?:làm|xử lý) (?:issue|việc) này/iu;

export interface GithubComment {
  id: number;
  url: string;
  body: string;
}

export interface FeedbackGithubClient {
  /** `GET /search/issues`: the issues a query finds, best match first. */
  searchIssues(query: string): Promise<GithubIssue[]>;
  /** The issue, or `undefined` when GitHub says there is none. */
  getIssue(number: number): Promise<GithubIssue | undefined>;
  createIssue(input: { title: string; body: string; labels: readonly string[] }): Promise<{ number: number; url: string }>;
  createComment(issueNumber: number, body: string): Promise<{ id: number; url: string }>;
  getComment(id: number): Promise<GithubComment | undefined>;
  /**
   * The login the token belongs to, or `undefined` when there is no token to ask about. A token GitHub will not name an
   * owner for (an App installation token answers `GET /user` with 403) throws a `refused` `FeedbackGithubError`.
   */
  viewerLogin(): Promise<string | undefined>;
  /**
   * The issue updated since `since` whose body carries `marker`, among those `creator` opened when given. `undefined`
   * only when GitHub's whole list was read; a list longer than the bounded scan throws `MarkerScanIncompleteError`,
   * because an unread page may hold it.
   */
  findIssueWithMarker(marker: string, since: Instant, creator?: string): Promise<GithubIssue | undefined>;
  /** The comment on `issueNumber` updated since `since` whose body carries `marker`; bounded the same way. */
  findCommentWithMarker(issueNumber: number, marker: string, since: Instant): Promise<GithubComment | undefined>;
  /** What GitHub's timeline shows of work on the issue: open pull requests referencing it, and anyone claiming it. */
  issueActivity(issueNumber: number): Promise<IssueActivity>;
}

/**
 * Where reports go, and with what. `withWriter` runs `use` with a client that writes as the person, or says why it
 * cannot; the token never leaves the callback. `reader` reads, with the token when the person allowed it and without
 * otherwise.
 */
export interface FeedbackGithub {
  repository: string;
  reader(): FeedbackGithubClient;
  withWriter<T>(use: (client: FeedbackGithubClient) => Promise<T>): { ok: true; result: Promise<T> } | { ok: false; reason: string };
}

export type GithubFailureKind = "refused" | "not-sent" | "no-answer";

export class FeedbackGithubError extends Error {
  readonly kind: GithubFailureKind;
  readonly status: number | undefined;
  /** Whether asking again later can help: a rate limit or an unreachable GitHub, not a refusal of the request itself. */
  readonly retryable: boolean;

  constructor(kind: GithubFailureKind, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "FeedbackGithubError";
    this.kind = kind;
    this.status = options.status;
    this.retryable = options.retryable ?? kind !== "refused";
  }
}

/**
 * GitHub answered, and its list is longer than the bounded scan reads: what was not read may hold the marker. Not a
 * failure to reach GitHub (asking again reads the same too-long list), so it is told apart from one.
 */
export class MarkerScanIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkerScanIncompleteError";
  }
}

/** The secret-broker consumer a report's token is used as, so the person can allow or refuse it by name. */
export const FEEDBACK_GITHUB_CONSUMER = "feedback:github";

const REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const MARKER_SCAN_PAGES = 3;

function causeCode(cause: unknown): string | undefined {
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** What a thrown fetch means for a write: never reached GitHub, or reached it and no answer came back. */
export function classifyFetchFailure(cause: unknown): FeedbackGithubError {
  const code = causeCode(cause);
  if (code !== undefined && CONNECT_ERROR_CODES.has(code)) {
    return new FeedbackGithubError("not-sent", `GitHub could not be reached (${code})`);
  }
  const name = cause instanceof Error ? cause.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new FeedbackGithubError("no-answer", `GitHub did not answer within ${String(REQUEST_TIMEOUT_MS / 1000)} seconds`);
  }
  return new FeedbackGithubError("no-answer", `the connection to GitHub ended without an answer${code === undefined ? "" : ` (${code})`}`);
}

/** What an HTTP status means: a 5xx may have done part of the work, a 4xx did not. */
export function classifyStatus(status: number, rateLimited: boolean): FeedbackGithubError {
  if (status >= 500) return new FeedbackGithubError("no-answer", `GitHub answered ${String(status)}`, { status });
  if (status === 429 || rateLimited) {
    return new FeedbackGithubError("refused", "GitHub's rate limit was reached; nothing was filed", { status, retryable: true });
  }
  if (status === 401) return new FeedbackGithubError("refused", "GitHub did not accept the token (401)", { status, retryable: false });
  if (status === 403 || status === 404) {
    return new FeedbackGithubError("refused", `the token may not write to ${FEEDBACK_REPOSITORY} (${String(status)})`, { status, retryable: false });
  }
  return new FeedbackGithubError("refused", `GitHub refused the request (${String(status)})`, { status, retryable: false });
}

interface RawIssue {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  html_url?: unknown;
  body?: unknown;
  labels?: unknown;
  assignees?: unknown;
  closed_at?: unknown;
  pull_request?: unknown;
}

function issueFromRaw(raw: RawIssue): GithubIssue | undefined {
  if (typeof raw.number !== "number" || typeof raw.title !== "string" || typeof raw.html_url !== "string") return undefined;
  const labels = Array.isArray(raw.labels)
    ? raw.labels.flatMap((label) => {
        const name = typeof label === "string" ? label : (label as { name?: unknown } | null)?.name;
        return typeof name === "string" ? [name] : [];
      })
    : [];
  const assignees = Array.isArray(raw.assignees)
    ? raw.assignees.flatMap((user) => {
        const login = (user as { login?: unknown } | null)?.login;
        return typeof login === "string" ? [login] : [];
      })
    : [];
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state === "closed" ? "closed" : "open",
    url: raw.html_url,
    body: typeof raw.body === "string" ? raw.body : "",
    labels,
    assignees,
    ...(typeof raw.closed_at === "string" ? { closedAt: raw.closed_at } : {}),
    isPullRequest: raw.pull_request !== undefined && raw.pull_request !== null,
  };
}

function commentFromRaw(raw: { id?: unknown; html_url?: unknown; body?: unknown }): GithubComment | undefined {
  if (typeof raw.id !== "number" || typeof raw.html_url !== "string") return undefined;
  return { id: raw.id, url: raw.html_url, body: typeof raw.body === "string" ? raw.body : "" };
}

/** Five minutes before `since`, so a write whose clock and GitHub's disagree a little is still in the scan. */
export function scanSince(since: Instant): string {
  return new Date(Date.parse(since) - 5 * 60_000).toISOString();
}

/** A REST client for one repository, over `fetch`, with the token (when given) in this request's header only. */
export function createGithubRestClient(options: {
  repository: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
}): FeedbackGithubClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/u, "");
  const repo = options.repository;

  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; value: unknown }> => {
    let response: Response;
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "clarkcant-feedback",
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw classifyFetchFailure(cause);
    }
    if (response.status === 404 && method === "GET") return { status: 404, value: undefined };
    if (!response.ok) {
      const rateLimited = response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
      throw classifyStatus(response.status, rateLimited);
    }
    try {
      return { status: response.status, value: await response.json() };
    } catch (cause) {
      // GitHub answered with a success status and an unreadable body: it did the work, and the body cannot say what.
      throw new FeedbackGithubError("no-answer", `GitHub's answer could not be read (${cause instanceof Error ? cause.message : String(cause)})`);
    }
  };

  const listPages = async <T>(path: string, read: (raw: unknown) => T | undefined, match: (item: T) => boolean): Promise<T | undefined> => {
    for (let page = 1; page <= MARKER_SCAN_PAGES; page += 1) {
      const { value } = await call("GET", `${path}&per_page=100&page=${String(page)}`);
      if (!Array.isArray(value)) return undefined;
      for (const raw of value) {
        const item = read(raw);
        if (item !== undefined && match(item)) return item;
      }
      if (value.length < 100) return undefined;
    }
    // Every page read was full, so the list goes on: what was not read may hold the marker, and "not found" here would
    // offer to file the report a second time. Saying GitHub could not be checked keeps it unknown instead.
    throw new MarkerScanIncompleteError(
      `GitHub listed more than ${String(MARKER_SCAN_PAGES * 100)} items changed since the attempt, too many to read through`,
    );
  };

  return {
    async searchIssues(query) {
      const { value } = await call("GET", `/search/issues?q=${encodeURIComponent(query)}&per_page=20`);
      const items = (value as { items?: unknown } | undefined)?.items;
      if (!Array.isArray(items)) return [];
      return items.flatMap((raw) => {
        const issue = issueFromRaw(raw as RawIssue);
        return issue === undefined || issue.isPullRequest ? [] : [issue];
      });
    },
    async getIssue(number) {
      const { value } = await call("GET", `/repos/${repo}/issues/${String(number)}`);
      return value === undefined ? undefined : issueFromRaw(value as RawIssue);
    },
    async createIssue(input) {
      const { value } = await call("POST", `/repos/${repo}/issues`, { title: input.title, body: input.body, labels: [...input.labels] });
      const issue = issueFromRaw(value as RawIssue);
      if (issue === undefined) throw new FeedbackGithubError("no-answer", "GitHub's answer named no issue");
      return { number: issue.number, url: issue.url };
    },
    async createComment(issueNumber, body) {
      const { value } = await call("POST", `/repos/${repo}/issues/${String(issueNumber)}/comments`, { body });
      const comment = commentFromRaw(value as { id?: unknown });
      if (comment === undefined) throw new FeedbackGithubError("no-answer", "GitHub's answer named no comment");
      return { id: comment.id, url: comment.url };
    },
    async getComment(id) {
      const { value } = await call("GET", `/repos/${repo}/issues/comments/${String(id)}`);
      return value === undefined ? undefined : commentFromRaw(value as { id?: unknown });
    },
    async viewerLogin() {
      if (options.token === undefined) return undefined;
      const { status, value } = await call("GET", "/user");
      // A token GitHub will not name an owner for (an App installation token, say) is refused here, not unanswered.
      if (status === 404) throw new FeedbackGithubError("refused", "GitHub would not say whose token this is (404)", { status, retryable: false });
      const login = (value as { login?: unknown } | undefined)?.login;
      if (typeof login !== "string" || login === "") throw new FeedbackGithubError("no-answer", "GitHub did not say whose token this is");
      return login;
    },
    async findIssueWithMarker(marker, since, creator) {
      // Only the person's own issues: a busy repository's other traffic is what would otherwise run past the scan.
      const by = creator === undefined ? "" : `&creator=${encodeURIComponent(creator)}`;
      return await listPages(
        `/repos/${repo}/issues?state=all&sort=created&direction=desc${by}&since=${encodeURIComponent(scanSince(since))}`,
        (raw) => issueFromRaw(raw as RawIssue),
        (issue) => !issue.isPullRequest && issue.body.includes(marker),
      );
    },
    async findCommentWithMarker(issueNumber, marker, since) {
      return await listPages(
        `/repos/${repo}/issues/${String(issueNumber)}/comments?since=${encodeURIComponent(scanSince(since))}`,
        (raw) => commentFromRaw(raw as { id?: unknown }),
        (comment) => comment.body.includes(marker),
      );
    },
    async issueActivity(issueNumber) {
      const { value } = await call("GET", `/repos/${repo}/issues/${String(issueNumber)}/timeline?per_page=100`);
      if (!Array.isArray(value)) return { openPullRequests: [] };
      const found = new Map<number, IssueMention>();
      let claimedBy: string | undefined;
      for (const event of value as Array<{ event?: unknown; body?: unknown; actor?: { login?: unknown }; user?: { login?: unknown }; source?: { issue?: RawIssue } }>) {
        if (event.event === "commented" && typeof event.body === "string" && CLAIM_COMMENT.test(event.body)) {
          const login = event.user?.login ?? event.actor?.login;
          if (typeof login === "string") claimedBy = login;
          continue;
        }
        if (event.event !== "cross-referenced") continue;
        const source = event.source?.issue === undefined ? undefined : issueFromRaw(event.source.issue);
        if (source === undefined || !source.isPullRequest || source.state !== "open") continue;
        found.set(source.number, { number: source.number, title: source.title.slice(0, 300), url: source.url });
      }
      return { openPullRequests: [...found.values()], ...(claimedBy === undefined ? {} : { claimedBy }) };
    },
  };
}

/**
 * The node's own GitHub for reports: ClarkCant's repository, the person's `github_token` through the secret broker.
 *
 * Read without the token when the person has not allowed it for reports; write only with it.
 */
export function createNodeFeedbackGithub(
  services: Pick<NodeServices, "runtime">,
  options: { fetch?: typeof globalThis.fetch; apiBase?: string } = {},
): FeedbackGithub {
  const repository = FEEDBACK_REPOSITORY;
  const broker = () =>
    createSecretBroker({
      db: services.runtime.db,
      principalId: services.runtime.identity.ownerPrincipalId,
      now: () => new Date().toISOString() as Instant,
    });
  const client = (token?: string): FeedbackGithubClient =>
    createGithubRestClient({
      repository,
      ...(token === undefined ? {} : { token }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.apiBase === undefined ? {} : { apiBase: options.apiBase }),
    });
  /*
   * A reader with the token wraps each call in its own broker use, so the value exists only for that request.
   * Without the token, a public repository still answers.
   */
  const withToken = <T>(use: (c: FeedbackGithubClient) => Promise<T>): Promise<T> => {
    const used = broker().withSecret({ name: GITHUB_TOKEN_SECRET_NAME, consumer: FEEDBACK_GITHUB_CONSUMER }, (token) => use(client(token)));
    return used.ok ? used.result : use(client());
  };
  return {
    repository,
    reader: () => ({
      searchIssues: (query) => withToken((c) => c.searchIssues(query)),
      getIssue: (number) => withToken((c) => c.getIssue(number)),
      createIssue: () => Promise.reject(new FeedbackGithubError("not-sent", "a reader does not write")),
      createComment: () => Promise.reject(new FeedbackGithubError("not-sent", "a reader does not write")),
      getComment: (id) => withToken((c) => c.getComment(id)),
      viewerLogin: () => withToken((c) => c.viewerLogin()),
      findIssueWithMarker: (marker, since, creator) => withToken((c) => c.findIssueWithMarker(marker, since, creator)),
      findCommentWithMarker: (issue, marker, since) => withToken((c) => c.findCommentWithMarker(issue, marker, since)),
      issueActivity: (issue) => withToken((c) => c.issueActivity(issue)),
    }),
    withWriter(use) {
      const used = broker().withSecret({ name: GITHUB_TOKEN_SECRET_NAME, consumer: FEEDBACK_GITHUB_CONSUMER }, (token) => use(client(token)));
      if (used.ok) return { ok: true, result: used.result };
      const reason =
        used.code === "SECRET_NOT_FOUND"
          ? `this node has no "${GITHUB_TOKEN_SECRET_NAME}" token to file it with`
          : used.code === "CONSUMER_NOT_ALLOWED"
            ? `the "${GITHUB_TOKEN_SECRET_NAME}" token is not allowed for reports (${FEEDBACK_GITHUB_CONSUMER})`
            : `the "${GITHUB_TOKEN_SECRET_NAME}" token could not be used (${used.code})`;
      return { ok: false, reason };
    },
  };
}
