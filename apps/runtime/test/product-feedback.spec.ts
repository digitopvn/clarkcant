import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type FeedbackRequest,
  type Instant,
  feedbackMarker,
  feedbackRequestSchema,
  readFeedbackMarker,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, writeRegisteredPreference } from "@clarkcant/core";
import {
  allRows,
  deleteConversationRows,
  getEffect,
  getFeedbackReport,
  getTask,
  messagesSince,
  transaction,
  updateFeedbackReport,
  upsertTask,
} from "@clarkcant/storage";

import {
  type PublishIntent,
  type PublishOptions,
  checkHandlingEligibility,
  composeFeedback,
  prepareFeedback,
  publishFeedback,
} from "../src/application/product-feedback.ts";
import { handleRequest } from "../src/gateway.ts";
import { reconcileFeedbackAtStart } from "../src/routes/feedback.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createFakeGithub, type FakeGithub } from "../src/test-support/fake-github.ts";

/**
 * The product report service against an in-process GitHub.
 *
 * What is worth proving is what leaves the machine and when a report counts as filed: secrets and the home directory
 * never reach GitHub, a reproduction nobody gave is not invented, nothing is filed but by the person's press and only
 * as the execution policy allows, success is what GitHub was read back holding, and a write whose answer never arrived
 * is found again by its marker rather than sent twice — however often, and however late, anyone checks on it.
 */

const AT = "2026-10-06T09:00:00.000Z" as Instant;
const at = (): Instant => AT;
const FAST = { readBackDelaysMs: [0, 0] };
const MINUTE = 60_000;

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
  vi.useRealTimers();
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

/** The person's press: `send` (Create issue, Send again) or `check` (Check again). */
function press(reportId: string, intent: PublishIntent = "send", options: PublishOptions = FAST) {
  return publishFeedback(services, { reportId, conversationId, intent, at }, options);
}

async function filed(request: FeedbackRequest) {
  const { draft } = await prepared(request);
  return await press(draft.reportId);
}

const withMarker = (reportId: string) => [...github.issues.values()].filter((issue) => issue.body.includes(feedbackMarker(reportId)));

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

  it("pings nobody: a handle in the person's words no longer reads as a mention", async () => {
    const { draft } = await prepared(bug("Ask @octocat why sync stalls"));

    expect(draft.body).not.toMatch(/(^|[^\p{L}\p{N}_])@octocat/u);
    expect(draft.body).toContain(`@${String.fromCodePoint(0x2060)}octocat`);
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

  it("does not call a widget showing token usage a conflict", async () => {
    const { draft } = await prepared(
      feedbackRequestSchema.parse({ kind: "feature", description: "Widgets should show token usage per turn", source: "chat" }),
    );

    expect(draft.philosophy?.verdict).toBe("aligned");
    expect(draft.body).not.toContain("material conflict");
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
    const first = await filed(bug("Clark goes silent mid-answer", { error }));
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

describe("what Clark, voice and /report bug … do with a report", () => {
  it("prepare it and show the exact issue on the host's card, and send nothing", async () => {
    const composed = await composeFeedback(services, { request: bug("The transcript jumps when a widget loads"), conversationId, at });

    if (!composed.ok) throw new Error(composed.text);
    const [card] = composed.blocks as Array<Record<string, unknown>>;
    expect(card).toMatchObject({ type: "feedback-card", owner: "host", stage: "compose", reportId: composed.draft.reportId, title: composed.draft.title });
    expect((card?.preview as { body: string }).body).toBe(composed.draft.body);
    expect(getFeedbackReport(services.runtime.db, composed.draft.reportId)?.status).toBe("draft");
    expect(github.writes()).toHaveLength(0);
  });

  it.each([
    ["vi", "Cuộc trò chuyện vẫn là bề mặt chính", "tiêu đề và mô tả gần như trùng"],
    ["en", "Conversation stays the primary surface", "nearly the same title and description"],
  ])("word a feature's fit and why issues look related in the person's language (%s) on the card", async (language, invariant, basis) => {
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: at },
      { principalId: services.runtime.identity.ownerPrincipalId, key: "experience.language", value: language, source: "user" },
    );
    if (!written.ok) throw new Error(written.message);
    github.seedIssue({ title: "feat: sessions sidebar", body: "A permanent sidebar listing sessions" });
    const composed = await composeFeedback(services, {
      request: feedbackRequestSchema.parse({ kind: "feature", description: "Add a permanent sidebar listing my sessions", source: "chat" }),
      conversationId,
      at,
    });

    if (!composed.ok) throw new Error(composed.text);
    const card = composed.blocks[0] as { philosophy?: { constraints: Array<{ invariant: string }> }; related?: Array<{ basis: string }> };
    // The issue keeps the English its rules are written in; the card reads in the person's language.
    expect(composed.draft.philosophy?.constraints[0]?.invariant).toBe("Conversation stays the primary surface");
    expect(composed.draft.body).toContain("Conversation stays the primary surface");
    expect(card.philosophy?.constraints[0]?.invariant).toBe(invariant);
    expect(card.related?.[0]?.basis).toBe(basis);
  });
});

describe("publishing a report on the person's press", () => {
  it("counts a report as filed only once GitHub is read back holding its marker", async () => {
    const { draft } = await prepared(bug("Transcript scrolls to the top on every message"));
    const outcome = await press(draft.reportId);

    if (!outcome.ok || outcome.publication.status !== "published") throw new Error("not published");
    expect(outcome.publication.mode).toBe("created");
    expect(github.issues.get(outcome.publication.issue.number)?.body).toContain(feedbackMarker(draft.reportId));
    expect(github.calls.some((call) => call.operation === "getIssue")).toBe(true);
    const effect = getEffect(services.runtime.db, outcome.record.effectId ?? "");
    expect(effect?.state).toBe("confirmed");
  });

  it("answers a second press on a filed report with what it is, and writes nothing", async () => {
    const { draft } = await prepared(bug("Export fails"));
    await press(draft.reportId);
    const again = await press(draft.reportId);

    expect(again.ok && again.publication.status).toBe("published");
    expect(github.writes()).toHaveLength(1);
  });

  it("stays unknown when GitHub answered but cannot be read back yet", async () => {
    github.fail("getIssue", { kind: "not-sent", times: 2 });
    const { draft } = await prepared(bug("Widget frame is blank"));
    const outcome = await press(draft.reportId);

    expect(outcome.ok && outcome.publication.status).toBe("unknown");
    expect(getFeedbackReport(services.runtime.db, draft.reportId)?.status).toBe("unknown");
  });

  it("finds a write GitHub kept despite a timeout by its marker, and does not send it again", async () => {
    github.fail("createIssue", { kind: "no-answer", applied: true });
    const { draft } = await prepared(bug("Updates never finish downloading"));
    const outcome = await press(draft.reportId);

    expect(outcome.ok && outcome.publication.status).toBe("published");
    expect(github.writes()).toHaveLength(1);
  });

  it("files once however late and however often a timed-out write is checked on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(AT);
    vi.setSystemTime(start);
    // GitHub kept the issue, its answer never arrived, and it could not be looked up straight after.
    github.fail("createIssue", { kind: "no-answer", applied: true });
    github.fail("findIssue", { kind: "not-sent" });
    const { draft } = await prepared(bug("The mic indicator stays lit after a call"));
    const first = await press(draft.reportId);
    expect(first.ok && first.publication.status).toBe("unknown");

    // Ten minutes on, GitHub cannot be read: still unknown, nothing sent.
    vi.setSystemTime(start + 10 * MINUTE);
    github.fail("findIssue", { kind: "not-sent" });
    const offline = await press(draft.reportId, "check");
    expect(offline.ok && offline.publication.status).toBe("unknown");

    // Ten more minutes, long past the grace and past where a window anchored on the last check would begin: the
    // window is the attempt's own, so the issue GitHub kept is found — by a check and by a send alike.
    vi.setSystemTime(start + 20 * MINUTE);
    const sent = await press(draft.reportId, "send");
    expect(sent.ok && sent.publication.status).toBe("published");
    expect(github.writes()).toHaveLength(1);
    expect(withMarker(draft.reportId)).toHaveLength(1);
  });

  it("checks without sending, says when GitHub was seen not to hold it, and sends again only on Send again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse(AT);
    vi.setSystemTime(start);
    github.fail("createIssue", { kind: "no-answer", applied: false });
    const { draft } = await prepared(bug("The microphone indicator stays on"));
    const first = await press(draft.reportId);
    expect(first.ok && first.publication.status).toBe("unknown");

    // Within the grace: looked for, not sent — and a send press does no more than look.
    expect((await press(draft.reportId, "check")).ok).toBe(true);
    const soon = await press(draft.reportId, "send");
    expect(soon.ok && soon.publication.status).toBe("unknown");
    expect(github.writes()).toHaveLength(1);

    // After it: absent from GitHub's own list, so it never arrived. Saying so sends nothing.
    vi.setSystemTime(start + 5 * MINUTE);
    const absent = await press(draft.reportId, "check");
    if (!absent.ok || absent.publication.status !== "failed") throw new Error("expected the absence to be established");
    expect(absent.publication.retryable).toBe(true);
    expect(github.writes()).toHaveLength(1);
    expect(getEffect(services.runtime.db, absent.record.effectId ?? "")?.state).toBe("failed");

    // Checking again on an established absence still sends nothing.
    const recheck = await press(draft.reportId, "check");
    expect(recheck.ok && recheck.publication.status).toBe("failed");
    expect(github.writes()).toHaveLength(1);

    // Send again: the first time it is filed.
    const resent = await press(draft.reportId, "send");
    expect(resent.ok && resent.publication.status).toBe("published");
    expect(github.writes()).toHaveLength(2);
    expect(withMarker(draft.reportId)).toHaveLength(1);
  });

  it("has nothing to check on a report that was never sent", async () => {
    const { draft } = await prepared(bug("Nothing sent yet"));
    const checked = await press(draft.reportId, "check");

    expect(checked).toMatchObject({ ok: false, status: 409, code: "NOTHING_SENT" });
    expect(github.calls.some((call) => call.operation === "findIssue")).toBe(false);
  });

  it("does not send again while GitHub cannot be checked", async () => {
    github.fail("createIssue", { kind: "no-answer", applied: false });
    const { draft } = await prepared(bug("Diagnostics card is empty"));
    await press(draft.reportId);
    github.fail("findIssue", { kind: "not-sent" });

    const checked = await press(draft.reportId, "send", { ...FAST, reconcileGraceMs: 0 });

    expect(checked.ok && checked.publication.status).toBe("unknown");
    expect(github.writes()).toHaveLength(1);
  });

  it("reports a refusal as failed, with nothing created", async () => {
    github.fail("createIssue", { kind: "refused", status: 422 });
    const { draft } = await prepared(bug("Theme picker crashes"));
    const outcome = await press(draft.reportId);

    if (!outcome.ok || outcome.publication.status !== "failed") throw new Error("expected a failure");
    expect(outcome.publication.retryable).toBe(false);
    expect(github.issues.size).toBe(0);
    expect(getEffect(services.runtime.db, outcome.record.effectId ?? "")?.state).toBe("failed");
  });

  it("comments on the open duplicate instead of opening a second issue", async () => {
    const error = { code: "E_SYNC", message: "sync stalled at generation 4" };
    await filed(bug("Sync stalls", { error }));
    const second = await filed(bug("Sync never finishes", { error }));

    if (!second.ok || second.publication.status !== "published") throw new Error("not published");
    expect(second.publication.mode).toBe("commented");
    expect(second.publication.commentUrl).toContain("#issuecomment-");
    expect(github.issues.size).toBe(1);
  });

  it("hands back GitHub's prefilled new-issue page when this node has no token to file with", async () => {
    github.writable = false;
    const { draft } = await prepared(bug("Login with Codex fails"));
    const outcome = await press(draft.reportId);

    if (!outcome.ok || outcome.publication.status !== "needs-access") throw new Error("expected needs-access");
    expect(outcome.publication.manualUrl).toMatch(/^https:\/\/github\.com\/digitopvn\/clarkcant\/issues\/new\?title=/u);
    expect(outcome.publication.manualUrl.length).toBeLessThanOrEqual(8000);
    expect(github.writes()).toHaveLength(0);
  });

  it("hands back the prefilled page for a report too long for a URL, whatever characters it is written in", async () => {
    github.writable = false;
    const { draft } = await prepared(bug("😀".repeat(1990)));
    const outcome = await press(draft.reportId);

    if (!outcome.ok || outcome.publication.status !== "needs-access") throw new Error("expected needs-access");
    expect(outcome.publication.manualUrl.length).toBeLessThanOrEqual(8000);
    expect(() => decodeURIComponent(outcome.publication.status === "needs-access" ? outcome.publication.manualUrl : "")).not.toThrow();
  });

  it("is refused by a policy that denies external writes, though the person pressed, and sends nothing", async () => {
    setExecution({ rules: [{ effectCategory: "external-write", decision: "deny" }] });
    const { draft } = await prepared(bug("Undo does nothing"));
    const outcome = await press(draft.reportId);

    expect(outcome.ok && outcome.publication.status).toBe("refused");
    expect(getFeedbackReport(services.runtime.db, draft.reportId)?.publication?.status).toBe("refused");
    expect(github.writes()).toHaveLength(0);
  });

  it("is refused while every effect on this node is prohibited", async () => {
    setExecution({ prohibition: "all" });
    const { draft } = await prepared(bug("Pins vanish after restart"));
    const outcome = await press(draft.reportId);

    expect(outcome.ok && outcome.publication.status).toBe("refused");
    expect(github.writes()).toHaveLength(0);
  });

  it("takes the press as the answer a policy that asks first wants, and keeps the record of it", async () => {
    setExecution({ mode: "ask" });
    const { draft } = await prepared(bug("Search misses accented words"));
    const outcome = await press(draft.reportId);

    expect(outcome.ok && outcome.publication.status).toBe("published");
    expect(github.writes()).toHaveLength(1);
    const executed = allRows<{ document: string }>(services.runtime.db, "SELECT document FROM events WHERE kind = 'effect.executed'").map(
      (row) => JSON.parse(row.document) as { category: string; because: string },
    );
    expect(executed).toEqual(expect.arrayContaining([expect.objectContaining({ category: "external-write", because: expect.stringContaining("pressed") })]));
  });
});

describe("after a restart", () => {
  function stopMidSend(reportId: string): void {
    // What a process that died between handing the write to GitHub and hearing back leaves behind.
    const moved = updateFeedbackReport(services.runtime.db, {
      reportId,
      status: "publishing",
      publication: { status: "unknown", reportId, reason: "sending" },
      at: new Date().toISOString() as Instant,
    });
    if (!moved) throw new Error("the report did not move");
  }

  const cardsIn = () =>
    messagesSince(services.runtime.db, conversationId, 0)
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === "feedback-card") as Array<{ stage: string; publication?: { status: string } }>;

  it("finds a report GitHub kept by its marker and says so in its conversation, sending nothing", async () => {
    const { draft } = await prepared(bug("Window snaps back after a resize"));
    stopMidSend(draft.reportId);
    github.seedIssue({ title: draft.title, body: draft.body });

    const swept = await reconcileFeedbackAtStart(services, FAST);

    expect(swept).toEqual({ checked: 1, announced: 1 });
    expect(getFeedbackReport(services.runtime.db, draft.reportId)?.status).toBe("published");
    expect(cardsIn().map((card) => card.publication?.status)).toEqual(["published"]);
    expect(github.writes()).toHaveLength(0);
  });

  it("establishes that a report never arrived once the grace has passed, and leaves sending it again to the person", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(AT));
    const { draft } = await prepared(bug("Fonts render blurry"));
    stopMidSend(draft.reportId);
    vi.setSystemTime(Date.parse(AT) + 10 * MINUTE);

    await reconcileFeedbackAtStart(services, FAST);

    const record = getFeedbackReport(services.runtime.db, draft.reportId);
    expect(record?.status).toBe("failed");
    expect(record?.publication).toMatchObject({ status: "failed", retryable: true });
    expect(cardsIn().map((card) => card.publication?.status)).toEqual(["failed"]);
    expect(github.writes()).toHaveLength(0);
  });

  it("says nothing new about a report already known to be unknown that is still unknown", async () => {
    github.fail("getIssue", { kind: "not-sent", times: 2 });
    github.fail("createIssue", { kind: "no-answer", applied: false });
    const { draft } = await prepared(bug("Badge count is wrong"));
    await press(draft.reportId);

    const swept = await reconcileFeedbackAtStart(services, FAST);

    expect(swept).toEqual({ checked: 1, announced: 0 });
    expect(github.writes()).toHaveLength(1);
  });
});

describe("deleting the conversation", () => {
  it("takes its reports with it", async () => {
    const outcome = await filed(bug("Tray menu is empty"));
    if (!outcome.ok) throw new Error("not filed");

    transaction(services.runtime.db, () => deleteConversationRows(services.runtime.db, conversationId));

    expect(getFeedbackReport(services.runtime.db, outcome.record.reportId)).toBeUndefined();
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
    const outcome = await filed(bug("Window loses focus"));
    if (!outcome.ok || outcome.publication.status !== "published") throw new Error("not published");
    const number = outcome.publication.issue.number;
    // A real task this node holds, reused as the shape of unfinished work.
    const task = getTask(services.runtime.db, getEffect(services.runtime.db, outcome.record.effectId ?? "")?.taskId ?? "");
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
