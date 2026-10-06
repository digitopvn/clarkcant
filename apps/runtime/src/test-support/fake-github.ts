import { FEEDBACK_REPOSITORY, type Instant } from "@clarkcant/contracts";

import {
  type FeedbackGithub,
  type FeedbackGithubClient,
  FeedbackGithubError,
  type GithubComment,
  type GithubIssue,
  type GithubFailureKind,
  type IssueActivity,
  scanSince,
} from "../application/feedback-github.ts";

/**
 * An in-process GitHub for product reports: issues and comments in memory, no network, no token.
 *
 * Used by the unit tests and by a node started with `CC_GITHUB_FIXTURE=1`, so the report journey can be exercised in a
 * browser without touching the real repository. It is a fake and says so: every URL it mints is under
 * `https://github.com/<repository>` like the real ones, but nothing it holds exists anywhere else.
 *
 * Faults are scripted per operation, so a test can make a create time out after GitHub kept it (the case the marker
 * exists for), refuse it, or never reach it. The marker lookups honour `since` as GitHub's lists do, with the same
 * allowance the real client asks for, so a window that starts too late misses the report here as it would there.
 */

export type FakeGithubOperation = "search" | "getIssue" | "createIssue" | "createComment" | "getComment" | "findIssue" | "findComment" | "activity";

export interface FakeGithubFault {
  kind: GithubFailureKind;
  status?: number;
  /** For a write that fails with no answer: whether GitHub kept it anyway. */
  applied?: boolean;
  /** How many calls the fault applies to; once by default. */
  times?: number;
}

export interface FakeGithub extends FeedbackGithub {
  issues: Map<number, GithubIssue & { comments: Array<GithubComment & { createdAt: string }>; createdAt: string; activity: IssueActivity }>;
  calls: Array<{ operation: FakeGithubOperation; detail?: string }>;
  /** Whether a writer is available: `false` behaves like a node with no `github_token`. */
  writable: boolean;
  fail(operation: FakeGithubOperation, fault: FakeGithubFault): void;
  seedIssue(issue: Partial<GithubIssue> & { title: string; body?: string; activity?: IssueActivity }): GithubIssue;
  /** Every call that wrote, in order. */
  writes(): Array<{ operation: FakeGithubOperation; detail?: string }>;
}

export function createFakeGithub(options: { repository?: string; writable?: boolean; now?: () => Instant } = {}): FakeGithub {
  const repository = options.repository ?? FEEDBACK_REPOSITORY;
  const now = options.now ?? ((): Instant => new Date().toISOString() as Instant);
  const issues: FakeGithub["issues"] = new Map();
  const calls: FakeGithub["calls"] = [];
  const faults = new Map<FakeGithubOperation, FakeGithubFault & { left: number }>();
  let nextIssue = 900;
  let nextComment = 5000;

  const fault = (operation: FakeGithubOperation): (FakeGithubFault & { left: number }) | undefined => {
    const found = faults.get(operation);
    if (found === undefined) return undefined;
    found.left -= 1;
    if (found.left <= 0) faults.delete(operation);
    return found;
  };
  const raise = (found: FakeGithubFault): never => {
    throw new FeedbackGithubError(found.kind, `fake GitHub: scripted ${found.kind}${found.status === undefined ? "" : ` (${String(found.status)})`}`, {
      ...(found.status === undefined ? {} : { status: found.status }),
    });
  };
  const view = (issue: GithubIssue): GithubIssue => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.url,
    body: issue.body,
    labels: [...issue.labels],
    assignees: [...issue.assignees],
    ...(issue.closedAt === undefined ? {} : { closedAt: issue.closedAt }),
    isPullRequest: issue.isPullRequest,
  });
  const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);

  const client: FeedbackGithubClient = {
    async searchIssues(query) {
      calls.push({ operation: "search", detail: query });
      const found = fault("search");
      if (found !== undefined) raise(found);
      const terms = words(query.replace(/\brepo:\S+|\bis:\S+|\bOR\b/gu, " "));
      return [...issues.values()]
        .filter((issue) => {
          const text = `${issue.title} ${issue.body}`.toLowerCase();
          return terms.some((term) => text.includes(term));
        })
        .map(view);
    },
    async getIssue(number) {
      calls.push({ operation: "getIssue", detail: String(number) });
      const found = fault("getIssue");
      if (found !== undefined) raise(found);
      const issue = issues.get(number);
      return issue === undefined ? undefined : view(issue);
    },
    async createIssue(input) {
      calls.push({ operation: "createIssue", detail: input.title });
      const found = fault("createIssue");
      const keep = found === undefined || (found.kind === "no-answer" && found.applied === true);
      let created: { number: number; url: string } | undefined;
      if (keep) {
        nextIssue += 1;
        const issue = {
          number: nextIssue,
          title: input.title,
          state: "open" as const,
          url: `https://github.com/${repository}/issues/${String(nextIssue)}`,
          body: input.body,
          labels: [...input.labels],
          assignees: [],
          isPullRequest: false,
          comments: [],
          createdAt: now(),
          activity: { openPullRequests: [] },
        };
        issues.set(issue.number, issue);
        created = { number: issue.number, url: issue.url };
      }
      if (found !== undefined) raise(found);
      return created as { number: number; url: string };
    },
    async createComment(issueNumber, body) {
      calls.push({ operation: "createComment", detail: String(issueNumber) });
      const found = fault("createComment");
      const issue = issues.get(issueNumber);
      if (issue === undefined) throw new FeedbackGithubError("refused", "fake GitHub: no such issue (404)", { status: 404 });
      const keep = found === undefined || (found.kind === "no-answer" && found.applied === true);
      let created: { id: number; url: string } | undefined;
      if (keep) {
        nextComment += 1;
        const comment = { id: nextComment, url: `${issue.url}#issuecomment-${String(nextComment)}`, body, createdAt: now() };
        issue.comments.push(comment);
        created = { id: comment.id, url: comment.url };
      }
      if (found !== undefined) raise(found);
      return created as { id: number; url: string };
    },
    async getComment(id) {
      calls.push({ operation: "getComment", detail: String(id) });
      const found = fault("getComment");
      if (found !== undefined) raise(found);
      for (const issue of issues.values()) {
        const comment = issue.comments.find((entry) => entry.id === id);
        if (comment !== undefined) return { id: comment.id, url: comment.url, body: comment.body };
      }
      return undefined;
    },
    async findIssueWithMarker(marker, since) {
      calls.push({ operation: "findIssue", detail: marker });
      const found = fault("findIssue");
      if (found !== undefined) raise(found);
      const from = Date.parse(scanSince(since));
      const issue = [...issues.values()].find((entry) => Date.parse(entry.createdAt) >= from && entry.body.includes(marker));
      return issue === undefined ? undefined : view(issue);
    },
    async findCommentWithMarker(issueNumber, marker, since) {
      calls.push({ operation: "findComment", detail: marker });
      const found = fault("findComment");
      if (found !== undefined) raise(found);
      const from = Date.parse(scanSince(since));
      const comment = issues.get(issueNumber)?.comments.find((entry) => Date.parse(entry.createdAt) >= from && entry.body.includes(marker));
      return comment === undefined ? undefined : { id: comment.id, url: comment.url, body: comment.body };
    },
    async issueActivity(issueNumber) {
      calls.push({ operation: "activity", detail: String(issueNumber) });
      const found = fault("activity");
      if (found !== undefined) raise(found);
      const activity = issues.get(issueNumber)?.activity ?? { openPullRequests: [] };
      return { openPullRequests: [...activity.openPullRequests], ...(activity.claimedBy === undefined ? {} : { claimedBy: activity.claimedBy }) };
    },
  };

  const fake: FakeGithub = {
    repository,
    issues,
    calls,
    writable: options.writable ?? true,
    reader: () => client,
    withWriter(use) {
      if (!fake.writable) return { ok: false, reason: 'this node has no "github_token" token to file it with' };
      return { ok: true, result: use(client) };
    },
    fail(operation, entry) {
      faults.set(operation, { ...entry, left: entry.times ?? 1 });
    },
    seedIssue(seed) {
      const number = seed.number ?? (nextIssue += 1);
      const issue = {
        number,
        title: seed.title,
        state: seed.state ?? "open",
        url: seed.url ?? `https://github.com/${repository}/issues/${String(number)}`,
        body: seed.body ?? "",
        labels: seed.labels ?? [],
        assignees: seed.assignees ?? [],
        ...(seed.closedAt === undefined ? {} : { closedAt: seed.closedAt }),
        isPullRequest: seed.isPullRequest ?? false,
        comments: [],
        createdAt: now(),
        activity: seed.activity ?? { openPullRequests: [] },
      };
      issues.set(number, issue);
      return view(issue);
    },
    writes: () => calls.filter((call) => call.operation === "createIssue" || call.operation === "createComment"),
  };
  return fake;
}
