import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type FeedbackRequest,
  type Instant,
  feedbackMarker,
  feedbackRequestSchema,
  readFeedbackMarker,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, writeRegisteredPreference } from "@clarkcant/core";
import { getEffect, getFeedbackReport, getTask, upsertTask } from "@clarkcant/storage";

import {
  checkHandlingEligibility,
  feedbackPublishDigest,
  fileFeedback,
  prepareFeedback,
  publishFeedback,
  runApprovedFeedbackPublish,
} from "../src/application/product-feedback.ts";
import { handleRequest } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createFakeGithub, type FakeGithub } from "../src/test-support/fake-github.ts";

/**
 * The product report service against an in-process GitHub.
 *
 * What is worth proving is what leaves the machine and when a report counts as filed: secrets and the home directory
 * never reach GitHub, a reproduction nobody gave is not invented, success is what GitHub was read back holding, and a
 * write whose answer never arrived is found again by its marker rather than sent twice.
 */

const AT = "2026-10-06T09:00:00.000Z" as Instant;
const at = (): Instant => AT;
const FAST = { readBackDelaysMs: [0, 0] };

let dir: string;
let services: NodeServices;
let github: FakeGithub;
let conversationId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-feedback-"));
  services = bootNodeServices({ dataDir: dir, label: "feedback test node" });
  github = createFakeGithub();
  services.feedbackGithub = github;
  const created = await handleRequest(
    { services, now: at },
    {
      method: "POST",
      path: "/conversations",
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: JSON.stringify({ title: "reports" }),
    },
  );
  conversationId = (created.body as { conversationId: string }).conversationId;
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function bug(description: string, extra: Partial<FeedbackRequest> = {}): FeedbackRequest {
  return feedbackRequestSchema.parse({ kind: "bug", description, source: "chat", ...extra });
}

function setExecution(value: Record<string, unknown>): void {
  const written = writeRegisteredPreference(
    { db: services.runtime.db, now: at },
    {
      principalId: services.runtime.identity.ownerPrincipalId,
      key: EXECUTION_POLICY_PREFERENCE_KEY,
      value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, ...value },
      source: "user",
    },
  );
  if (!written.ok) throw new Error(written.message);
}

async function prepared(request: FeedbackRequest) {
  const outcome = await prepareFeedback(services, { request, conversationId, at });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome;
}

describe("preparing a report", () => {
  it("redacts secrets and the home directory from everything that would leave the machine", async () => {
    // Assembled here so the file itself carries no token-shaped literal.
    const secret = ["ghp", "abcdefghijklmnop1234567890"].join("_");
    const { draft } = await prepared(
      bug(`Voice stops after ${secret} is pasted; log at ${join(homedir(), "projects", "private")}`, {
        error: { code: "VOICE_STALL", message: `stalled reading ${join(homedir(), "voice.log")} with ${secret}` },
      }),
    );

    expect(draft.body).not.toContain(secret);
    expect(draft.body).not.toContain(homedir());
    expect(draft.title).not.toContain(secret);
    expect(draft.diagnostics?.errorMessage).not.toContain(homedir());
    expect(draft.diagnostics?.errorFingerprint).toMatch(/^[a-f0-9]{12}$/u);
  });

  it("says a reproduction is not known instead of inventing one, and leaves out sections nobody spoke to", async () => {
    const { draft } = await prepared(bug("The orb freezes when the window is resized"));

    expect(draft.body).toContain("### Steps to reproduce\n\nNot known yet.");
    expect(draft.body).not.toContain("### What was expected");
    expect(draft.body).not.toContain("### Impact");
    expect(readFeedbackMarker(draft.body)).toBe(draft.reportId);
    expect(draft.reportId).toMatch(/^rpt_/u);
  });

  it("shares no diagnostics when the person turned them off", async () => {
    const { draft, diagnostics } = await prepared(bug("Sign-in loops", { includeDiagnostics: false }));

    expect(draft.diagnostics).toBeUndefined();
    expect(diagnostics).toEqual([]);
    expect(draft.body).not.toContain("### Environment");
  });

  it("records a feature's conflict with the philosophy rather than dropping it", async () => {
    const { draft } = await prepared(
      feedbackRequestSchema.parse({ kind: "feature", description: "Please remove the orb from the home screen", source: "voice" }),
    );

    expect(draft.philosophy?.verdict).toBe("material-conflict");
    expect(draft.body).toContain("### Philosophy fit");
    expect(draft.body).toContain("### Replaceability");
  });

  it("lets a model raise a concern about a feature but never talk one away", async () => {
    const { draft } = await prepared(
      feedbackRequestSchema.parse({
        kind: "feature",
        description: "Hide the orb for screenshots",
        source: "chat",
        philosophy: { verdict: "aligned" },
      }),
    );

    expect(draft.philosophy?.verdict).toBe("material-conflict");
  });

  it("finds an open duplicate by the error fingerprint and plans a comment on it instead of a new issue", async () => {
    const error = { code: "E_TTS", message: "speech synthesis timed out after 30000 ms" };
    const first = await fileFeedback(services, { request: bug("Clark goes silent mid-answer", { error }), conversationId, authority: { kind: "person" }, at }, FAST);
    expect(first.ok && first.publication.status).toBe("published");

    const { draft } = await prepared(bug("No voice at all in the middle of a reply", { error }));

    expect(draft.duplicateOf?.number).toBe(901);
    expect(draft.occurrence).toContain(feedbackMarker(draft.reportId));
  });

  it("keeps the report when GitHub search is unavailable, and says the search did not run", async () => {
    github.fail("search", { kind: "not-sent", times: 2 });
    const { draft } = await prepared(bug("Settings do not open"));

    expect(draft.relatedSearch.state).toBe("unavailable");
    expect(draft.related).toEqual([]);
  });
});

describe("publishing a report", () => {
  it("counts a report as filed only once GitHub is read back holding its marker", async () => {
    const { draft } = await prepared(bug("Transcript scrolls to the top on every message"));
    const outcome = await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at }, FAST);

    if (!outcome.ok || outcome.publication.status !== "published") throw new Error("not published");
    expect(outcome.publication.mode).toBe("created");
    expect(github.issues.get(outcome.publication.issue.number)?.body).toContain(feedbackMarker(draft.reportId));
    expect(github.calls.some((call) => call.operation === "getIssue")).toBe(true);
    const effect = getEffect(services.runtime.db, outcome.record.effectId ?? "");
    expect(effect?.state).toBe("confirmed");
  });

  it("answers a second publish of a filed report with what it is, and writes nothing", async () => {
    const { draft } = await prepared(bug("Export fails"));
    await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at }, FAST);
    const again = await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at }, FAST);

    expect(again.ok && again.publication.status).toBe("published");
    expect(github.writes()).toHaveLength(1);
  });

  it("stays unknown when GitHub answered but cannot be read back yet", async () => {
    github.fail("getIssue", { kind: "not-sent", times: 2 });
    const { draft } = await prepared(bug("Widget frame is blank"));
    const outcome = await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at }, FAST);

    expect(outcome.ok && outcome.publication.status).toBe("unknown");
    expect(getFeedbackReport(services.runtime.db, draft.reportId)?.status).toBe("unknown");
  });

  it("finds a write GitHub kept despite a timeout by its marker, and does not send it again", async () => {
    github.fail("createIssue", { kind: "no-answer", applied: true });
    const { draft } = await prepared(bug("Updates never finish downloading"));
    const outcome = await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at }, FAST);

    expect(outcome.ok && outcome.publication.status).toBe("published");
    expect(github.writes()).toHaveLength(1);
  });

  it("keeps a timed-out write unknown, and sends it again only once GitHub's list shows it absent after the grace", async () => {
    github.fail("createIssue", { kind: "no-answer", applied: false });
    const { draft } = await prepared(bug("The microphone indicator stays on"));
    const first = await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at }, FAST);
    expect(first.ok && first.publication.status).toBe("unknown");

    // Within the grace: looked for, not sent.
    const soon = await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at }, FAST);
    expect(soon.ok && soon.publication.status).toBe("unknown");
    expect(github.writes()).toHaveLength(1);

    // After it: absent from GitHub's own list, so this is the first time it is filed.
    const later = await publishFeedback(
      services,
      { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at },
      { ...FAST, reconcileGraceMs: 0 },
    );
    expect(later.ok && later.publication.status).toBe("published");
    expect(github.writes()).toHaveLength(2);
    expect([...github.issues.values()].filter((issue) => issue.body.includes(feedbackMarker(draft.reportId)))).toHaveLength(1);
  });

  it("does not send again while GitHub cannot be checked", async () => {
    github.fail("createIssue", { kind: "no-answer", applied: false });
    const { draft } = await prepared(bug("Diagnostics card is empty"));
    await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at }, FAST);
    github.fail("findIssue", { kind: "not-sent" });

    const checked = await publishFeedback(
      services,
      { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at },
      { ...FAST, reconcileGraceMs: 0 },
    );

    expect(checked.ok && checked.publication.status).toBe("unknown");
    expect(github.writes()).toHaveLength(1);
  });

  it("reports a refusal as failed, with nothing created", async () => {
    github.fail("createIssue", { kind: "refused", status: 422 });
    const { draft } = await prepared(bug("Theme picker crashes"));
    const outcome = await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at }, FAST);

    if (!outcome.ok || outcome.publication.status !== "failed") throw new Error("expected a failure");
    expect(outcome.publication.retryable).toBe(false);
    expect(github.issues.size).toBe(0);
    expect(getEffect(services.runtime.db, outcome.record.effectId ?? "")?.state).toBe("failed");
  });

  it("comments on the open duplicate instead of opening a second issue", async () => {
    const error = { code: "E_SYNC", message: "sync stalled at generation 4" };
    await fileFeedback(services, { request: bug("Sync stalls", { error }), conversationId, authority: { kind: "person" }, at }, FAST);
    const second = await fileFeedback(services, { request: bug("Sync never finishes", { error }), conversationId, authority: { kind: "person" }, at }, FAST);

    if (!second.ok || second.publication.status !== "published") throw new Error("not published");
    expect(second.publication.mode).toBe("commented");
    expect(second.publication.commentUrl).toContain("#issuecomment-");
    expect(github.issues.size).toBe(1);
  });

  it("hands back GitHub's prefilled new-issue page when this node has no token to file with", async () => {
    github.writable = false;
    const { draft } = await prepared(bug("Login with Codex fails"));
    const outcome = await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at }, FAST);

    if (!outcome.ok || outcome.publication.status !== "needs-access") throw new Error("expected needs-access");
    expect(outcome.publication.manualUrl).toMatch(/^https:\/\/github\.com\/digitopvn\/clarkcant\/issues\/new\?title=/u);
    expect(outcome.publication.manualUrl.length).toBeLessThanOrEqual(8000);
    expect(github.writes()).toHaveLength(0);
  });

  it("asks through the execution policy when Clark files, and files exactly what the approval covered", async () => {
    setExecution({ mode: "ask" });
    const { draft } = await prepared(bug("Search misses accented words"));
    const asked = await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "policy" }, at }, FAST);

    if (!asked.ok || asked.publication.status !== "approval-required") throw new Error("expected an approval request");
    expect(asked.approvalCard?.type).toBe("approval-card");
    expect(github.writes()).toHaveLength(0);

    const forged = await runApprovedFeedbackPublish(
      services,
      { payload: JSON.stringify({ kind: "feedback-publish", reportId: draft.reportId }), expectedDigest: "0".repeat(64), approvalId: asked.publication.approvalId, conversationId, at },
      FAST,
    );
    expect(forged.ok).toBe(false);

    const approved = await runApprovedFeedbackPublish(
      services,
      {
        payload: JSON.stringify({ kind: "feedback-publish", reportId: draft.reportId }),
        expectedDigest: feedbackPublishDigest(draft),
        approvalId: asked.publication.approvalId,
        conversationId,
        at,
      },
      FAST,
    );
    expect(approved.ok).toBe(true);
    expect(github.writes()).toHaveLength(1);
  });

  it("is refused by a policy that denies external writes, and sends nothing", async () => {
    setExecution({ rules: [{ effectCategory: "external-write", decision: "deny" }] });
    const filed = await fileFeedback(services, { request: bug("Undo does nothing"), conversationId, authority: { kind: "policy" }, at }, FAST);

    expect(filed.ok && filed.publication.status).toBe("refused");
    expect(github.writes()).toHaveLength(0);
  });
});

describe("whether Clark may handle a filed issue", () => {
  it("never says yes in this build, and names the missing backend", async () => {
    const issue = github.seedIssue({ title: "bug: tray icon missing", body: "Tray icon is gone" });
    const eligibility = await checkHandlingEligibility(services, { issueNumber: issue.number, at });

    if (eligibility.eligible) throw new Error("must not be eligible");
    expect(eligibility.code).toBe("handling-unavailable");
    expect(eligibility.blockers.map((blocker) => blocker.number)).toEqual(expect.arrayContaining([402, 508]));
  });

  it.each([
    ["issue-closed", { state: "closed" as const }],
    ["epic", { title: "Epic: rework voice" }],
    ["assigned", { assignees: ["someone"] }],
    ["in-progress", { labels: ["in progress"] }],
    ["external-gate", { labels: ["external-gate"] }],
    ["blocked", { labels: ["blocked"] }],
    ["open-pull-request", { activity: { openPullRequests: [{ number: 77 }] } }],
    ["in-progress", { activity: { openPullRequests: [], claimedBy: "@maintainer" } }],
  ])("rules an issue out as %s", async (code, seed) => {
    const issue = github.seedIssue({ title: "bug: something", body: "", ...seed });
    const eligibility = await checkHandlingEligibility(services, { issueNumber: issue.number, at });

    expect(eligibility.eligible).toBe(false);
    if (!eligibility.eligible) expect(eligibility.code).toBe(code);
  });

  it("names an open blocker the issue says it depends on", async () => {
    const blocker = github.seedIssue({ title: "feat: background backend" });
    const issue = github.seedIssue({ title: "bug: retries", body: `Blocked by #${String(blocker.number)}` });
    const eligibility = await checkHandlingEligibility(services, { issueNumber: issue.number, at });

    if (eligibility.eligible) throw new Error("must not be eligible");
    expect(eligibility.code).toBe("blocked");
    expect(eligibility.blockers[0]?.number).toBe(blocker.number);
  });

  it("suggests planning and splitting an epic", async () => {
    const issue = github.seedIssue({ title: "Epic: voice everywhere", labels: ["epic"] });
    const eligibility = await checkHandlingEligibility(services, { issueNumber: issue.number, at });

    expect(!eligibility.eligible && eligibility.suggestion).toBe("plan-split");
  });

  it("sees Clark's own unfinished work on the issue, and not work on an issue whose number only starts the same", async () => {
    const { draft } = await prepared(bug("Window loses focus"));
    const filed = await publishFeedback(services, { reportId: draft.reportId, conversationId, authority: { kind: "person" }, at }, FAST);
    if (!filed.ok || filed.publication.status !== "published") throw new Error("not published");
    const number = filed.publication.issue.number;
    // A real task this node holds, reused as the shape of unfinished work.
    const task = getTask(services.runtime.db, getEffect(services.runtime.db, filed.record.effectId ?? "")?.taskId ?? "");
    if (task === undefined) throw new Error("the publish left no task");

    upsertTask(services.runtime.db, { ...task, taskId: services.conductor.newId("task"), state: "running", goal: `Fix #${String(number)}0 first` });
    const other = await checkHandlingEligibility(services, { issueNumber: number, at });
    expect(!other.eligible && other.code).toBe("handling-unavailable");

    upsertTask(services.runtime.db, { ...task, taskId: services.conductor.newId("task"), state: "running", goal: `Fix #${String(number)} now` });
    const busy = await checkHandlingEligibility(services, { issueNumber: number, at });
    expect(!busy.eligible && busy.code).toBe("active-clark-work");
  });

  it("leaves a request in conflict with the philosophy to a person", async () => {
    const issue = github.seedIssue({ title: "feat: hide the orb" });
    const eligibility = await checkHandlingEligibility(services, {
      issueNumber: issue.number,
      philosophy: { verdict: "material-conflict", constraints: [] },
      at,
    });

    expect(!eligibility.eligible && eligibility.code).toBe("philosophy-conflict");
  });

  it("says when GitHub could not be read rather than guessing", async () => {
    github.fail("getIssue", { kind: "not-sent" });
    const eligibility = await checkHandlingEligibility(services, { issueNumber: 1, at });

    expect(!eligibility.eligible && eligibility.code).toBe("unreadable");
  });
});
