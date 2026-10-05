import { describe, expect, it } from "vitest";

import { main as attestMain, parseArguments } from "../attest-review.mjs";
import { evaluatePullRequest, pullRequestsForEvent } from "../evaluate-review-attestation.mjs";
import { GitHubRequestError } from "../github-rest.mjs";
import { REVIEW_ATTESTATION_CONTEXT, evaluateAttestations, formatAttestation, parseAttestation } from "../review-attestation.mjs";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const CODE = ["packages/core/src/index.ts", "README.md"];
const writers = new Set(["maintainer", "agent-account"]);
const isWriter = (login: string) => writers.has(login);

let nextId = 1;
function comment(author: string, body: string, minute: number) {
  const id = nextId++;
  return { id, author, body, createdAt: `2026-10-05T10:${String(minute).padStart(2, "0")}:00Z`, url: `https://example.invalid/c/${id}` };
}
const attest = (sha: string, result: string, reviewer = "agent:reviewer") => formatAttestation({ sha, result, reviewer });

function decide(comments: ReturnType<typeof comment>[], changedFiles: string[] | null = CODE) {
  return evaluateAttestations({ headSha: HEAD, changedFiles, comments, isWriter });
}

describe("evaluateAttestations", () => {
  it("passes a ready attestation for the exact head by a writer", () => {
    const result = decide([comment("agent-account", attest(HEAD, "ready"), 1)]);
    expect(result.state).toBe("success");
    expect(result.description).toBe("Ready: aaaaaaa reviewed by agent:reviewer (@agent-account)");
    expect(result.targetUrl).toMatch(/^https:\/\/example\.invalid\/c\//u);
  });

  it("leaves a stale attestation pending after a push moves the head", () => {
    const result = decide([comment("maintainer", attest(OLD, "ready"), 1)]);
    expect(result.state).toBe("pending");
    expect(result.description).toBe("Newest attestation (ready) is for bbbbbbb, not head aaaaaaa: review the new head");
  });

  it("fails when changes are required after an earlier ready", () => {
    const result = decide([comment("maintainer", attest(HEAD, "ready"), 1), comment("agent-account", attest(HEAD, "changes-required"), 2)]);
    expect(result.state).toBe("failure");
    expect(result.description).toMatch(/^Changes required at aaaaaaa by agent:reviewer/u);
  });

  it("passes when ready follows an earlier changes-required", () => {
    const result = decide([comment("agent-account", attest(OLD, "changes-required"), 1), comment("agent-account", attest(HEAD, "ready"), 2)]);
    expect(result.state).toBe("success");
  });

  it("orders by creation time, not by list order", () => {
    const result = decide([comment("agent-account", attest(HEAD, "ready"), 5), comment("maintainer", attest(HEAD, "changes-required"), 1)]);
    expect(result.state).toBe("success");
  });

  it("ignores attestations by accounts without write access, however recent", () => {
    const result = decide([
      comment("maintainer", attest(HEAD, "changes-required"), 1),
      comment("drive-by", attest(HEAD, "ready", "human:drive-by"), 2),
    ]);
    expect(result.state).toBe("failure");
    expect(decide([comment("drive-by", attest(HEAD, "ready"), 1)])).toMatchObject({
      state: "pending",
      description: expect.stringContaining("1 from accounts without write access ignored"),
    });
  });

  it("is pending with instructions when nothing is attested", () => {
    expect(decide([comment("maintainer", "Looks good to me", 1)])).toEqual({
      state: "pending",
      description: "No review attestation for aaaaaaa: run node tools/attest-review.mjs",
    });
  });

  it("does not count a malformed marker", () => {
    const result = decide([
      comment("maintainer", '<!-- clarkcant-review-attestation v1 {"sha":"short","result":"ready","reviewer":"agent:x"} -->', 1),
      comment("maintainer", "<!-- clarkcant-review-attestation v1 not json -->", 2),
    ]);
    expect(result).toMatchObject({ state: "pending", description: expect.stringContaining("(2 malformed)") });
  });

  it("passes a documentation and plans only change without an attestation", () => {
    const result = decide([], ["docs/guide.md", "plans/x/plan.md", "README.md"]);
    expect(result.state).toBe("success");
    expect(result.description).toMatch(/^Documentation and plans only/u);
  });

  it.each([
    ["a code path", ["docs/guide.md", "tools/x.mjs"]],
    ["REVIEW.md, which is policy rather than prose", ["REVIEW.md"]],
    ["an unavailable file list", null],
    ["an empty file list", []],
  ])("requires an attestation for %s", (_label, files) => {
    expect(decide([], files as string[] | null).state).toBe("pending");
  });

  it("keeps every description within GitHub's 140 characters", () => {
    const reviewer = `agent:${"x".repeat(60)}`;
    const login = "y".repeat(39);
    writers.add(login);
    const result = decide([comment(login, attest(HEAD, "changes-required", reviewer), 1)]);
    expect(result.description.length).toBeLessThanOrEqual(140);
  });
});

describe("parseAttestation and formatAttestation", () => {
  it("round-trips and records only sha, result and reviewer", () => {
    const body = attest(HEAD, "ready", "human:maintainer");
    expect(parseAttestation(body)).toEqual({ kind: "valid", sha: HEAD, result: "ready", reviewer: "human:maintainer" });
    expect(body).toMatch(/<!-- clarkcant-review-attestation v1 \{"sha":"a{40}","result":"ready","reviewer":"human:maintainer"\} -->$/u);
  });

  it.each([
    ["two markers", `${attest(HEAD, "ready")}\n${attest(HEAD, "ready")}`],
    ["an unknown version", '<!-- clarkcant-review-attestation v2 {"sha":"x"} -->'],
    ["an unknown result", `<!-- clarkcant-review-attestation v1 {"sha":"${HEAD}","result":"lgtm","reviewer":"agent:x"} -->`],
    ["an uppercase SHA", `<!-- clarkcant-review-attestation v1 {"sha":"${"A".repeat(40)}","result":"ready","reviewer":"agent:x"} -->`],
    ["a free-form reviewer", `<!-- clarkcant-review-attestation v1 {"sha":"${HEAD}","result":"ready","reviewer":"someone"} -->`],
    ["an array payload", "<!-- clarkcant-review-attestation v1 [] -->"],
  ])("treats %s as malformed", (_label, body) => {
    expect(parseAttestation(body).kind).toBe("malformed");
  });

  it("refuses to format an attestation the gate would not accept", () => {
    expect(() => formatAttestation({ sha: "abc", result: "ready", reviewer: "agent:x" })).toThrow(/sha/u);
    expect(() => formatAttestation({ sha: HEAD, result: "ready", reviewer: "bot" })).toThrow(/reviewer/u);
  });
});

describe("pullRequestsForEvent", () => {
  it("finds the PR for each trigger and every open PR for an empty manual run", () => {
    expect(pullRequestsForEvent("pull_request_target", { pull_request: { number: 12 } }, undefined)).toEqual([12]);
    expect(pullRequestsForEvent("issue_comment", { issue: { number: 12, pull_request: {} } }, undefined)).toEqual([12]);
    expect(pullRequestsForEvent("issue_comment", { issue: { number: 12 } }, undefined)).toEqual([]);
    expect(pullRequestsForEvent("workflow_dispatch", {}, " 34 ")).toEqual([34]);
    expect(pullRequestsForEvent("workflow_dispatch", {}, "")).toBeNull();
    expect(() => pullRequestsForEvent("workflow_dispatch", {}, "1; rm -rf /")).toThrow(/PR number/u);
    expect(() => pullRequestsForEvent("push", {}, undefined)).toThrow(/unsupported/u);
  });
});

describe("evaluatePullRequest", () => {
  function fakeGitHub({ files, comments, permissions, state = "open" }: {
    files: { filename: string, previous_filename?: string }[],
    comments: { id: number, user: { login: string }, created_at: string, body: string, html_url: string }[],
    permissions: Record<string, string>,
    state?: string,
  }) {
    const statuses: { sha: string, body: Record<string, unknown> }[] = [];
    const permissionLookups: string[] = [];
    const client = {
      async request(method: string, path: string, body?: unknown): Promise<unknown> {
        if (method === "GET" && path === "/repos/o/r/pulls/9") return { state, head: { sha: HEAD.toUpperCase() }, changed_files: files.length };
        const login = /^\/repos\/o\/r\/collaborators\/(.+)\/permission$/u.exec(path)?.[1];
        if (method === "GET" && login !== undefined) {
          permissionLookups.push(login);
          const permission = permissions[login];
          if (permission === undefined) throw new GitHubRequestError(method, path, 404, "Not Found");
          return { permission };
        }
        const sha = /^\/repos\/o\/r\/statuses\/([0-9a-f]+)$/u.exec(path)?.[1];
        if (method === "POST" && sha !== undefined && body) { statuses.push({ sha, body: body as Record<string, unknown> }); return {}; }
        throw new Error(`unexpected ${method} ${path}`);
      },
      async paginate(path: string): Promise<unknown[]> {
        if (path === "/repos/o/r/pulls/9/files") return files;
        if (path === "/repos/o/r/issues/9/comments") return comments;
        throw new Error(`unexpected list ${path}`);
      },
    };
    return { client, statuses, permissionLookups };
  }

  const apiComment = (id: number, login: string, body: string) => ({
    id, user: { login }, created_at: `2026-10-05T10:0${id}:00Z`, body, html_url: `https://example.invalid/${id}`,
  });

  it("sets the status on the live head and looks up only accounts that attested", async () => {
    const github = fakeGitHub({
      files: [{ filename: "tools/x.mjs" }],
      comments: [apiComment(1, "chatty", "a plain comment"), apiComment(2, "maintainer", attest(HEAD, "ready")), apiComment(3, "stranger", attest(HEAD, "changes-required"))],
      permissions: { maintainer: "admin" },
    });
    const result = await evaluatePullRequest({ client: github.client, repository: "o/r", number: 9, runUrl: "https://example.invalid/run" });
    expect(result?.state).toBe("success");
    expect(github.permissionLookups).toEqual(["maintainer", "stranger"]);
    expect(github.statuses).toEqual([{
      sha: HEAD,
      body: { state: "success", context: REVIEW_ATTESTATION_CONTEXT, description: expect.stringMatching(/^Ready/u), target_url: "https://example.invalid/2" },
    }]);
  });

  it("classifies both sides of a rename, so moving code into docs still needs a review", async () => {
    const github = fakeGitHub({ files: [{ filename: "docs/moved.md", previous_filename: "tools/moved.mjs" }], comments: [], permissions: {} });
    expect((await evaluatePullRequest({ client: github.client, repository: "o/r", number: 9 }))?.state).toBe("pending");
  });

  it("leaves a closed PR alone", async () => {
    const github = fakeGitHub({ files: [], comments: [], permissions: {}, state: "closed" });
    expect(await evaluatePullRequest({ client: github.client, repository: "o/r", number: 9 })).toBeNull();
    expect(github.statuses).toEqual([]);
  });
});

describe("attest-review CLI", () => {
  it("reads the head from the PR and posts the comment through stdin", () => {
    const calls: { command: string, args: string[], input: string | undefined }[] = [];
    const run = (command: string, args: string[], input?: string) => {
      calls.push({ command, args, input });
      return args[1] === "view" ? JSON.stringify({ headRefOid: HEAD, state: "OPEN" }) : "";
    };
    attestMain(["42", "--result", "ready", "--reviewer", "agent:reviewer", "--repo", "o/r"], { run, out: () => {} });
    expect(calls[0]).toEqual({ command: "gh", args: ["pr", "view", "42", "--repo", "o/r", "--json", "headRefOid,state"], input: undefined });
    expect(calls[1]?.args).toEqual(["pr", "comment", "42", "--repo", "o/r", "--body-file", "-"]);
    expect(parseAttestation(calls[1]?.input ?? "")).toMatchObject({ kind: "valid", sha: HEAD, result: "ready" });
  });

  it("refuses when the reviewed commit is no longer the PR head", () => {
    const run = (command: string, _args: string[]) => (command === "gh" ? JSON.stringify({ headRefOid: HEAD, state: "OPEN" }) : `${OLD}\n`);
    expect(() => attestMain(["42", "--result", "ready", "--reviewer", "agent:r", "--commit", "HEAD"], { run, out: () => {} }))
      .toThrow(/not PR 42's head/u);
  });

  it.each([
    [["--result", "ready", "--reviewer", "agent:r"]],
    [["42", "--result", "lgtm", "--reviewer", "agent:r"]],
    [["42", "--result", "ready"]],
    [["42", "--result", "ready", "--reviewer", "agent:r", "--force"]],
  ])("rejects incomplete or unknown arguments %j", (argv) => {
    expect(() => parseArguments(argv)).toThrow();
  });
});
