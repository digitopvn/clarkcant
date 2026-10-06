import { describe, expect, it } from "vitest";

import { type Instant, feedbackMarker } from "@clarkcant/contracts";

import {
  FeedbackGithubError,
  classifyFetchFailure,
  classifyStatus,
  createGithubRestClient,
} from "../src/application/feedback-github.ts";

/**
 * The GitHub REST client for product reports, against a scripted `fetch`.
 *
 * What matters is what each failure means for a write — refused (nothing filed), not sent, or sent with no answer —
 * because that decides whether a report is failed or must be found again by its marker, and that GitHub's own answers
 * are read the way the eligibility checks rely on.
 */

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

function scripted(route: Route): { fetch: typeof globalThis.fetch; seen: Array<{ url: URL; init: RequestInit }> } {
  const seen: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    seen.push({ url, init: init ?? {} });
    return await route(url, init ?? {});
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, seen };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

const REPO = "digitopvn/clarkcant";
const issue = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `issue ${String(number)}`,
  state: "open",
  html_url: `https://github.com/${REPO}/issues/${String(number)}`,
  body: "",
  labels: [],
  assignees: [],
  ...extra,
});

describe("what a failure means for a write", () => {
  it("reads 4xx as refused and 5xx as possibly done", () => {
    expect(classifyStatus(422, false)).toMatchObject({ kind: "refused", retryable: false });
    expect(classifyStatus(401, false)).toMatchObject({ kind: "refused", retryable: false });
    expect(classifyStatus(403, true)).toMatchObject({ kind: "refused", retryable: true });
    expect(classifyStatus(429, false)).toMatchObject({ kind: "refused", retryable: true });
    expect(classifyStatus(502, false)).toMatchObject({ kind: "no-answer" });
  });

  it("reads a connection that never opened as not sent, and a timeout as no answer", () => {
    expect(classifyFetchFailure(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })).kind).toBe("not-sent");
    expect(classifyFetchFailure(Object.assign(new Error("timed out"), { name: "TimeoutError" })).kind).toBe("no-answer");
    expect(classifyFetchFailure(new Error("socket hang up")).kind).toBe("no-answer");
  });
});

describe("the REST client", () => {
  it("sends the token in the request header only, and files with the given title, body and labels", async () => {
    const { fetch, seen } = scripted(() => json(issue(901), 201));
    const client = createGithubRestClient({ repository: REPO, token: "test-token-value", fetch });

    const created = await client.createIssue({ title: "bug: x", body: "b", labels: ["bug"] });

    expect(created).toEqual({ number: 901, url: `https://github.com/${REPO}/issues/901` });
    const [call] = seen;
    expect(call?.url.pathname).toBe(`/repos/${REPO}/issues`);
    expect((call?.init.headers as Record<string, string>).authorization).toBe("Bearer test-token-value");
    expect(JSON.parse(String(call?.init.body))).toEqual({ title: "bug: x", body: "b", labels: ["bug"] });
  });

  it("throws a refusal GitHub gave, so nothing is reported as filed", async () => {
    const { fetch } = scripted(() => json({ message: "Validation Failed" }, 422));
    const client = createGithubRestClient({ repository: REPO, token: "t", fetch });

    await expect(client.createIssue({ title: "x", body: "b", labels: [] })).rejects.toBeInstanceOf(FeedbackGithubError);
    await expect(client.createIssue({ title: "x", body: "b", labels: [] })).rejects.toMatchObject({ kind: "refused", status: 422 });
  });

  it("answers a missing issue as absent, not as an error", async () => {
    const { fetch } = scripted(() => json({ message: "Not Found" }, 404));
    expect(await createGithubRestClient({ repository: REPO, fetch }).getIssue(5)).toBeUndefined();
  });

  it("finds an issue by its marker, a little before the attempt, and skips pull requests", async () => {
    const marker = feedbackMarker("rpt_found");
    const { fetch, seen } = scripted(() =>
      json([issue(7, { body: marker, pull_request: {} }), issue(8, { body: `text\n${marker}` }), issue(9)]),
    );
    const found = await createGithubRestClient({ repository: REPO, fetch }).findIssueWithMarker(marker, "2026-10-06T09:00:00.000Z" as Instant);

    expect(found?.number).toBe(8);
    expect(seen[0]?.url.searchParams.get("since")).toBe("2026-10-06T08:55:00.000Z");
    expect(seen[0]?.url.searchParams.get("state")).toBe("all");
  });

  it("says GitHub could not be checked, not that the report is absent, when the list runs past the pages it reads", async () => {
    const marker = feedbackMarker("rpt_far");
    const full = Array.from({ length: 100 }, (_, index) => issue(1000 + index, { pull_request: {} }));
    const { fetch, seen } = scripted(() => json(full));

    await expect(
      createGithubRestClient({ repository: REPO, fetch }).findIssueWithMarker(marker, "2026-10-06T09:00:00.000Z" as Instant),
    ).rejects.toBeInstanceOf(FeedbackGithubError);
    expect(seen).toHaveLength(3);
  });

  it("answers absent once the last page of the list has been read", async () => {
    const marker = feedbackMarker("rpt_absent");
    const { fetch } = scripted((url) => json(url.searchParams.get("page") === "1" ? Array.from({ length: 100 }, (_, index) => issue(index + 1)) : [issue(500)]));

    expect(await createGithubRestClient({ repository: REPO, fetch }).findIssueWithMarker(marker, "2026-10-06T09:00:00.000Z" as Instant)).toBeUndefined();
  });

  it("reads open pull requests and a claim comment from the issue's timeline", async () => {
    const { fetch } = scripted(() =>
      json([
        { event: "commented", body: "Nice idea", user: { login: "bystander" } },
        { event: "commented", body: "I'll take this one", user: { login: "maintainer" } },
        { event: "cross-referenced", source: { issue: issue(40, { pull_request: {} }) } },
        { event: "cross-referenced", source: { issue: issue(41, { pull_request: {}, state: "closed" }) } },
        { event: "cross-referenced", source: { issue: issue(42) } },
      ]),
    );
    const activity = await createGithubRestClient({ repository: REPO, fetch }).issueActivity(12);

    expect(activity.claimedBy).toBe("maintainer");
    expect(activity.openPullRequests.map((pr) => pr.number)).toEqual([40]);
  });

  it("does not read a mention of a claim inside another word as a claim", async () => {
    const { fetch } = scripted(() => json([{ event: "commented", body: "This is a reclaimed disk issue", user: { login: "someone" } }]));
    expect((await createGithubRestClient({ repository: REPO, fetch }).issueActivity(12)).claimedBy).toBeUndefined();
  });
});
