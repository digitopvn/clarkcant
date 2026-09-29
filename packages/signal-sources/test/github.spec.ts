import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SIGNAL_PAYLOAD_MAX_BYTES, signalInputSchema, type SignalInput } from "@clarkcant/contracts";
import { describe, expect, it } from "vitest";

import {
  type NormalizeResult,
  SignalPollError,
  type SourceDelivery,
  createGithubPoller,
  githubRepositoryFromRemote,
  githubWebhookAdapter,
  remoteMatchesRepository,
} from "../src/index.ts";

/*
 * The fixtures are real GitHub webhook payloads, from the payload examples octokit/webhooks records from GitHub itself
 * (MIT licensed), saved byte for byte.
 */
const FIXTURES = join(import.meta.dirname, "fixtures", "github");
const SECRET = "fixture webhook secret";
const NOW = "2026-09-29T10:00:00.000Z";
const context = { selfLogins: [] as string[], now: () => NOW };

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, `${name}.json`));
}

function sign(body: Uint8Array, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function delivery(event: string, body: Buffer, headers: Record<string, string> = {}): SourceDelivery {
  return {
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `d-${event}-1`,
      "x-hub-signature-256": sign(body),
      ...headers,
    },
    rawBody: body,
  };
}

function signalOf(result: NormalizeResult): SignalInput {
  if (result.kind !== "signal") throw new Error(`expected a signal, got ${result.kind}: ${"reason" in result ? result.reason : ""}`);
  // Every signal the adapter makes is one the node accepts as it is.
  expect(signalInputSchema.safeParse(result.signal).success).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.signal.payload))).toBeLessThan(SIGNAL_PAYLOAD_MAX_BYTES);
  return result.signal;
}

describe("verifying a delivery", () => {
  const body = fixture("issues.labeled");

  it("accepts the signature GitHub computes with the shared secret", () => {
    expect(githubWebhookAdapter.verify(delivery("issues", body), SECRET)).toEqual({ ok: true });
  });

  it("refuses a missing, malformed or wrong signature, and a body changed after signing", () => {
    const cases: SourceDelivery[] = [
      { headers: { "x-github-event": "issues" }, rawBody: body },
      delivery("issues", body, { "x-hub-signature-256": "sha1=abc" }),
      delivery("issues", body, { "x-hub-signature-256": "sha256=not-hex" }),
      delivery("issues", body, { "x-hub-signature-256": sign(body, "another secret") }),
      { ...delivery("issues", body), rawBody: Buffer.concat([body, Buffer.from(" ")]) },
    ];
    for (const refused of cases) expect(githubWebhookAdapter.verify(refused, SECRET).ok).toBe(false);
    // And a node with no secret accepts nothing, rather than everything.
    expect(githubWebhookAdapter.verify(delivery("issues", body), "").ok).toBe(false);
  });

  it("reads the signature header in any case", () => {
    const headers = { "X-Hub-Signature-256": sign(body) };
    expect(githubWebhookAdapter.verify({ headers, rawBody: body }, SECRET)).toEqual({ ok: true });
  });
});

describe("normalizing each event GitHub sends", () => {
  it("an issue labelled, with the label and the repository a condition names", () => {
    const signal = signalOf(githubWebhookAdapter.normalize(delivery("issues", fixture("issues.labeled")), context));
    expect(signal.topic).toBe("github.issue.labeled");
    expect(signal.source).toEqual({ kind: "external", provider: "github", sourceId: "github:github.com/Codertocat/Hello-World" });
    expect(signal.subject).toMatchObject({ type: "issue", id: "1", refs: { repository: "Codertocat/Hello-World", host: "github.com" } });
    expect(signal.payload).toMatchObject({ action: "labeled", number: 1, label: "bug", labels: ["bug"], author: "Codertocat" });
    expect(signal.dedupeKey).toBe("delivery:d-issues-1");
    expect(signal.occurredAt).toBe("2019-05-15T15:20:18.000Z");
    expect(signal.provenance).toMatchObject({ via: "github webhook", actor: "Codertocat", selfGenerated: false, deliveryId: "d-issues-1" });
  });

  it("an issue opened and edited", () => {
    expect(signalOf(githubWebhookAdapter.normalize(delivery("issues", fixture("issues.opened")), context))).toMatchObject({
      topic: "github.issue.opened",
      subject: { type: "issue", id: "1" },
    });
    expect(signalOf(githubWebhookAdapter.normalize(delivery("issues", fixture("issues.edited")), context))).toMatchObject({
      topic: "github.issue.edited",
      subject: { type: "issue", id: "1" },
    });
  });

  it("a pull request opened and pushed to", () => {
    const opened = signalOf(githubWebhookAdapter.normalize(delivery("pull_request", fixture("pull_request.opened")), context));
    expect(opened.topic).toBe("github.pull_request.opened");
    expect(opened.subject).toMatchObject({ type: "pull_request", id: "2", refs: { repository: "Codertocat/Hello-World", headRef: "changes", baseRef: "master" } });
    const pushed = signalOf(githubWebhookAdapter.normalize(delivery("pull_request", fixture("pull_request.synchronize")), context));
    expect(pushed.topic).toBe("github.pull_request.synchronize");
    expect(pushed.payload).toMatchObject({ number: 2, headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821" });
  });

  it("a comment on an issue, and a review comment on a pull request", () => {
    const comment = signalOf(githubWebhookAdapter.normalize(delivery("issue_comment", fixture("issue_comment.created")), context));
    expect(comment.topic).toBe("github.issue_comment.created");
    expect(comment.subject).toMatchObject({ type: "issue", id: "1" });
    expect(comment.payload).toMatchObject({ commentId: 492700400, author: "Codertocat", onPullRequest: false });
    const review = signalOf(
      githubWebhookAdapter.normalize(delivery("pull_request_review_comment", fixture("pull_request_review_comment.created")), context),
    );
    expect(review.topic).toBe("github.pull_request_review_comment.created");
    expect(review.subject).toMatchObject({ type: "pull_request", id: "2" });
    expect(review.payload).toMatchObject({ commentId: 284312630, path: "README.md" });
  });

  it("a workflow run and a check suite finishing", () => {
    const run = signalOf(githubWebhookAdapter.normalize(delivery("workflow_run", fixture("workflow_run.completed")), context));
    expect(run.topic).toBe("github.workflow_run.completed");
    expect(run.subject).toMatchObject({ type: "workflow_run", id: "289782451", refs: { repository: "octo-org/octo-repo" } });
    expect(run.payload).toMatchObject({ conclusion: "success", headBranch: "master", pullRequests: [2] });
    const suite = signalOf(githubWebhookAdapter.normalize(delivery("check_suite", fixture("check_suite.completed")), context));
    expect(suite.topic).toBe("github.check_suite.completed");
    expect(suite.subject).toMatchObject({ type: "check_suite", id: "118578147" });
    expect(suite.payload).toMatchObject({ conclusion: "success" });
  });

  it("keeps GitHub's full payload out of the signal", () => {
    const signal = signalOf(githubWebhookAdapter.normalize(delivery("pull_request", fixture("pull_request.opened")), context));
    expect(signal.payload).not.toHaveProperty("pull_request");
    expect(signal.payload).not.toHaveProperty("repository");
    expect(Buffer.byteLength(JSON.stringify(signal))).toBeLessThan(fixture("pull_request.opened").byteLength / 4);
  });

  it("reads a form-encoded delivery the same as a JSON one", () => {
    const json = fixture("issues.labeled");
    const form = Buffer.from(new URLSearchParams({ payload: json.toString("utf8") }).toString());
    const result = githubWebhookAdapter.normalize(
      delivery("issues", form, { "content-type": "application/x-www-form-urlencoded" }),
      context,
    );
    expect(signalOf(result).topic).toBe("github.issue.labeled");
  });

  it("marks what this node's own account did as self-generated, whatever the case", () => {
    const signal = signalOf(
      githubWebhookAdapter.normalize(delivery("issues", fixture("issues.labeled")), { ...context, selfLogins: [" codertocat "] }),
    );
    expect(signal.provenance).toMatchObject({ actor: "Codertocat", selfGenerated: true });
  });

  it("answers a ping, ignores events it does not turn into signals, and refuses what GitHub does not send", () => {
    expect(githubWebhookAdapter.normalize(delivery("ping", fixture("ping")), context)).toEqual({ kind: "ping" });
    expect(githubWebhookAdapter.normalize(delivery("star", Buffer.from('{"action":"created"}')), context).kind).toBe("ignored");
    const body = fixture("issues.labeled");
    expect(githubWebhookAdapter.normalize({ headers: { "x-github-delivery": "d" }, rawBody: body }, context).kind).toBe("invalid");
    expect(githubWebhookAdapter.normalize({ headers: { "x-github-event": "issues" }, rawBody: body }, context).kind).toBe("invalid");
    expect(githubWebhookAdapter.normalize(delivery("issues", Buffer.from("not json")), context).kind).toBe("invalid");
    expect(githubWebhookAdapter.normalize(delivery("issues", Buffer.from('{"action":"labeled"}')), context).kind).toBe("invalid");
  });
});

describe("the repository a clone points at", () => {
  it("reads the remote forms git writes, and never returns credentials", () => {
    for (const remote of [
      "https://github.com/acme/widgets.git",
      "https://github.com/acme/widgets",
      `https://${["x-access-token", "redacted"].join(":")}@github.com/acme/widgets.git`,
      "git@github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets.git",
      "https://github.com/acme/widgets/",
    ]) {
      expect(githubRepositoryFromRemote(remote)).toEqual({ host: "github.com", fullName: "acme/widgets" });
    }
    expect(githubRepositoryFromRemote("/home/me/widgets")).toBeUndefined();
    expect(githubRepositoryFromRemote("https://github.com/acme")).toBeUndefined();
  });

  it("matches the repository a signal names, case-insensitively, on the same host", () => {
    expect(remoteMatchesRepository("git@github.com:Acme/Widgets.git", "acme/widgets", "github.com")).toBe(true);
    expect(remoteMatchesRepository("git@github.com:acme/other.git", "acme/widgets", "github.com")).toBe(false);
    expect(remoteMatchesRepository("https://gitlab.com/acme/widgets.git", "acme/widgets", "github.com")).toBe(false);
  });
});

describe("polling a repository GitHub cannot deliver to", () => {
  const issuesPayload = JSON.parse(fixture("issues.labeled").toString("utf8")) as Record<string, unknown>;
  function events(ids: string[]): unknown[] {
    // Newest first, the way the Events API lists them.
    return [...ids].reverse().map((id) => ({
      id,
      type: id === "103" ? "WatchEvent" : "IssuesEvent",
      actor: { login: "someone" },
      repo: { name: "Codertocat/Hello-World" },
      payload: { action: "labeled", issue: issuesPayload.issue, label: issuesPayload.label },
      created_at: "2026-09-29T09:00:00Z",
    }));
  }

  it("starts from now, then returns what is new, oldest first, with its own dedupe keys", async () => {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    let listed = events(["100", "101"]);
    const fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
      requests.push({ url, headers: init?.headers ?? {} });
      return new Response(JSON.stringify(listed), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const poller = createGithubPoller({ repository: "Codertocat/Hello-World", fetch, token: "t", selfLogins: [], now: () => NOW });

    const first = await poller.poll(undefined);
    expect(first).toEqual({ signals: [], cursor: "101" });

    listed = events(["100", "101", "102", "103", "104"]);
    const second = await poller.poll(first.cursor);
    expect(second.cursor).toBe("104");
    expect(second.signals.map((signal) => signal.dedupeKey)).toEqual(["event:102", "event:104"]);
    expect(second.signals[0]).toMatchObject({
      topic: "github.issue.labeled",
      source: { sourceId: "github:github.com/Codertocat/Hello-World" },
      subject: { refs: { repository: "Codertocat/Hello-World" } },
      provenance: { via: "github poll", actor: "someone" },
    });
    for (const signal of second.signals) expect(signalInputSchema.safeParse(signal).success).toBe(true);

    expect(requests[0]?.url).toBe("https://api.github.com/repos/Codertocat/Hello-World/events?per_page=100");
    expect(requests[0]?.headers.authorization).toBe("Bearer t");
  });

  it("reports GitHub refusing, so the caller tries again later", async () => {
    const fetch = (async () => new Response("{}", { status: 403 })) as unknown as typeof globalThis.fetch;
    const poller = createGithubPoller({ repository: "acme/widgets", fetch, selfLogins: [], now: () => NOW });
    await expect(poller.poll("1")).rejects.toThrow(/403/);
  });

  it("sends the previous tag back, and takes a 304 as nothing new without moving the cursor", async () => {
    const sent: (string | undefined)[] = [];
    let answer = (): Response =>
      new Response(JSON.stringify(events(["100"])), { status: 200, headers: { etag: 'W/"one"', "x-poll-interval": "60" } });
    const fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      sent.push(init?.headers?.["if-none-match"]);
      return answer();
    }) as unknown as typeof globalThis.fetch;
    const poller = createGithubPoller({ repository: "Codertocat/Hello-World", fetch, selfLogins: [], now: () => NOW });

    const first = await poller.poll(undefined);
    expect(first).toEqual({ signals: [], cursor: "100", etag: 'W/"one"', pollIntervalSeconds: 60 });

    answer = () => new Response(null, { status: 304, headers: { "x-poll-interval": "90" } });
    const second = await poller.poll(first.cursor, { etag: 'W/"one"' });
    expect(second).toEqual({ signals: [], cursor: "100", etag: 'W/"one"', pollIntervalSeconds: 90 });
    expect(sent).toEqual([undefined, 'W/"one"']);
  });

  it("tells a rate limit from a refusal, with when GitHub takes requests again", async () => {
    let answer = (): Response =>
      new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1790000000" } });
    const fetch = (async () => answer()) as unknown as typeof globalThis.fetch;
    const poller = createGithubPoller({ repository: "acme/widgets", fetch, selfLogins: [], now: () => NOW });

    await expect(poller.poll("1")).rejects.toMatchObject({
      name: "SignalPollError",
      status: 403,
      rateLimited: true,
      retryAt: new Date(1_790_000_000_000).toISOString(),
    });

    answer = () => new Response("{}", { status: 429, headers: { "retry-after": "120" } });
    await expect(poller.poll("1")).rejects.toMatchObject({
      status: 429,
      rateLimited: true,
      retryAt: new Date(Date.parse(NOW) + 120_000).toISOString(),
    });

    // A private repository without a token is a 404, and nothing about it says to wait.
    answer = () => new Response("{}", { status: 404 });
    const refused = await poller.poll("1").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SignalPollError);
    expect(refused).toMatchObject({ status: 404, rateLimited: false, retryAt: undefined });
  });
});
