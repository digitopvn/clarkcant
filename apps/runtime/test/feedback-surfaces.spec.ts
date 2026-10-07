import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type FeedbackCard,
  type Instant,
  SLASH_COMMANDS,
  feedbackCardSchema,
  feedbackMarker,
  isPersonOnlyRoute,
  parseSlashCommand,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, writeRegisteredPreference } from "@clarkcant/core";
import { messagesSince } from "@clarkcant/storage";

import { reportArgument } from "../src/application/slash-commands.ts";
import { createFeedbackTool } from "../src/feedback-tool.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { SURFACE_HEADER } from "../src/routes/http.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createFakeGithub, type FakeGithub } from "../src/test-support/fake-github.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

/**
 * Every way of reporting reaches the one report service: `/report`, the composer's routes, and `report_feedback` for a
 * sentence or voice. Clark's ways prepare and show; only the person's press on the publish route files, and each ends
 * in the same truthful result card, against an in-process GitHub.
 */

const AT = "2026-10-06T09:00:00.000Z" as Instant;

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let github: FakeGithub;
let conversationId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-feedback-surfaces-"));
  services = bootNodeServices({ dataDir: dir, label: "feedback surfaces node" });
  github = createFakeGithub();
  services.feedbackGithub = github;
  deps = { services, now: () => AT };
  const created = await call("POST", "/conversations", { title: "reports" });
  conversationId = (created.body as { conversationId: string }).conversationId;
});

afterEach(async () => {
  services.runtime.close();
  await removeTestDirectory(dir);
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}`, ...headers },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

/** The feedback cards the host wrote into the conversation, newest last. */
function feedbackCards(): FeedbackCard[] {
  return messagesSince(services.runtime.db, conversationId, 0, 100)
    .flatMap((message) => message.blocks)
    .filter((block) => block.type === "feedback-card")
    .map((block) => feedbackCardSchema.parse(block));
}

describe("/report", () => {
  it("is a known command, offered by the composer's autocomplete", () => {
    expect(SLASH_COMMANDS).toContain("report");
    expect(parseSlashCommand("/report bug the orb froze")).toEqual({ command: "report", argument: "bug the orb froze" });
  });

  it("reads the kind from the first word, in English or Vietnamese", () => {
    expect(reportArgument("bug the orb froze")).toEqual({ kind: "bug", text: "the orb froze" });
    expect(reportArgument("feature dark mode for widgets")).toEqual({ kind: "feature", text: "dark mode for widgets" });
    expect(reportArgument("lỗi giọng nói bị ngắt")).toEqual({ kind: "bug", text: "giọng nói bị ngắt" });
    expect(reportArgument("tính năng xuất PDF")).toEqual({ kind: "feature", text: "xuất PDF" });
    expect(reportArgument("bugs everywhere")).toEqual({ text: "bugs everywhere" });
    expect(reportArgument("")).toEqual({ text: "" });
  });

  it("summons the Feedback Composer when it names no report, and files nothing", async () => {
    const response = await call("POST", `/conversations/${conversationId}/messages`, { text: "/report" });
    expect(response.status).toBe(200);

    const [card] = feedbackCards();
    expect(card?.stage).toBe("compose");
    expect(card?.repository).toBe("digitopvn/clarkcant");
    expect(card?.diagnostics.length).toBeGreaterThan(0);
    expect(github.writes()).toHaveLength(0);
  });

  it("prepares a bug from its words and shows the exact issue, filing it only on the person's press", async () => {
    const response = await call("POST", `/conversations/${conversationId}/messages`, { text: "/report bug the orb freezes after waking from sleep" });
    expect(response.status).toBe(200);

    const draft = feedbackCards().at(-1);
    expect(draft?.stage).toBe("compose");
    expect(draft?.title).toBe("bug: the orb freezes after waking from sleep");
    expect(draft?.preview?.body).toContain("Not known yet.");
    expect(github.writes()).toHaveLength(0);

    const pressed = await call("POST", `/feedback/reports/${draft?.reportId ?? ""}/publish`, { conversationId, answers: draft?.cardId });
    expect(pressed.status).toBe(200);
    const result = feedbackCards().at(-1);
    expect(result?.stage).toBe("result");
    expect(result?.answers).toBe(draft?.cardId);
    expect(result?.publication?.status).toBe("published");
    expect(result?.eligibility).toMatchObject({ eligible: false, code: "handling-unavailable" });
    const [issue] = [...github.issues.values()];
    expect(issue?.title).toBe("bug: the orb freezes after waking from sleep");
    expect(issue?.body).toBe(draft?.preview?.body);
  });
});

describe("the report routes", () => {
  it("prepares a draft without filing it, then publishes it into the conversation", async () => {
    const prepared = await call("POST", "/feedback/reports", {
      request: { kind: "feature", description: "Let me pin a widget to the top of a conversation", source: "composer" },
      conversationId,
    });
    expect(prepared.status).toBe(201);
    const { draft } = prepared.body as { draft: { reportId: string; body: string } };
    expect(draft.body).toContain(feedbackMarker(draft.reportId));
    expect(github.writes()).toHaveLength(0);

    const read = await call("GET", `/feedback/reports/${draft.reportId}`);
    expect((read.body as { status: string }).status).toBe("draft");

    const published = await call("POST", `/feedback/reports/${draft.reportId}/publish`, { conversationId });
    expect(published.status).toBe(200);
    expect((published.body as { publication: { status: string } }).publication.status).toBe("published");
    expect(feedbackCards().at(-1)?.publication?.status).toBe("published");
  });

  it("checks on a report without sending it, and has nothing to check on one never sent", async () => {
    github.fail("createIssue", { kind: "no-answer", applied: false });
    const prepared = await call("POST", "/feedback/reports", { request: { kind: "bug", description: "Dock icon bounces forever", source: "composer" }, conversationId });
    const { draft } = prepared.body as { draft: { reportId: string } };

    const never = await call("POST", `/feedback/reports/${draft.reportId}/publish`, { conversationId, intent: "check" });
    expect(never.status).toBe(409);
    expect(github.writes()).toHaveLength(0);

    const sent = await call("POST", `/feedback/reports/${draft.reportId}/publish`, { conversationId });
    expect((sent.body as { publication: { status: string } }).publication.status).toBe("unknown");
    const checked = await call("POST", `/feedback/reports/${draft.reportId}/publish`, { conversationId, intent: "check" });
    expect((checked.body as { publication: { status: string } }).publication.status).toBe("unknown");
    expect(github.writes()).toHaveLength(1);
  });

  it("lets the execution policy refuse the person's press, and says so on the card", async () => {
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => AT },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, prohibition: "all" },
        source: "user",
      },
    );
    if (!written.ok) throw new Error(written.message);
    const prepared = await call("POST", "/feedback/reports", { request: { kind: "bug", description: "Clipboard paste loses images", source: "composer" }, conversationId });
    const { draft } = prepared.body as { draft: { reportId: string } };

    const pressed = await call("POST", `/feedback/reports/${draft.reportId}/publish`, { conversationId });

    expect(pressed.status).toBe(200);
    expect(feedbackCards().at(-1)?.publication?.status).toBe("refused");
    expect(github.writes()).toHaveLength(0);
  });

  it("refuses a report that is not valid, and one that does not exist", async () => {
    const invalid = await call("POST", "/feedback/reports", { request: { kind: "bug", description: "", source: "composer" } });
    expect(invalid.status).toBe(400);

    const missing = await call("POST", "/feedback/reports/rpt_missing/publish", { conversationId });
    expect(missing.status).toBe(404);

    const unknownIntent = await call("POST", "/feedback/reports/rpt_missing/publish", { conversationId, intent: "approve" });
    expect(unknownIntent.status).toBe(400);
  });

  it("offers Send anyway only on the person's own surface, for a report checking cannot settle", async () => {
    github.fail("createIssue", { kind: "no-answer", applied: false });
    const prepared = await call("POST", "/feedback/reports", { request: { kind: "bug", description: "Clock widget drifts", source: "composer" }, conversationId });
    const { draft } = prepared.body as { draft: { reportId: string } };
    await call("POST", `/feedback/reports/${draft.reportId}/publish`, { conversationId });
    github.overlongLists = true;
    await call("POST", `/feedback/reports/${draft.reportId}/publish`, { conversationId, intent: "check" });
    const beyond = feedbackCards().at(-1);
    expect(beyond?.publication).toMatchObject({ status: "unknown", inconclusive: expect.any(Object) });

    for (const surface of ["mcp", "relay"]) {
      const asked = await call("POST", `/feedback/reports/${draft.reportId}/publish`, { conversationId, intent: "send-anyway" }, { [SURFACE_HEADER]: surface });
      expect(asked.status, surface).toBe(403);
      expect((asked.body as { code?: string }).code, surface).toBe("PERSON_ONLY");
    }
    expect(github.writes()).toHaveLength(1);

    github.overlongLists = false;
    const pressed = await call("POST", `/feedback/reports/${draft.reportId}/publish`, { conversationId, intent: "send-anyway", answers: beyond?.cardId });
    expect(pressed.status).toBe(200);
    expect(feedbackCards().at(-1)?.publication?.status).toBe("published");
    expect(github.writes()).toHaveLength(2);
  });

  it("keeps publishing to the person: a machine surface cannot file a report", () => {
    expect(isPersonOnlyRoute("POST", "/feedback/reports/rpt_abc/publish")).toBe(true);
    expect(isPersonOnlyRoute("POST", "//feedback//reports//rpt_abc//publish/")).toBe(true);
    expect(isPersonOnlyRoute("POST", "/feedback/reports")).toBe(false);
  });
});

describe("report_feedback", () => {
  function tool(channel: "voice" | "chat" = "chat") {
    return createFeedbackTool({ services: () => services, conversationId, channel: () => channel, now: () => AT });
  }

  async function run(params: Record<string, unknown>, channel: "voice" | "chat" = "chat") {
    const execute = tool(channel).execute as (input: Record<string, unknown>) => Promise<{ text: string; hostCard?: Record<string, unknown>; hostBlocks?: unknown[] }>;
    return await execute(params);
  }

  it("prepares from voice through the same service and shows it; the person's press files it, marked as voice", async () => {
    const result = await run({ kind: "bug", description: "Clark stops listening after a long pause" }, "voice");

    const card = feedbackCardSchema.parse(result.hostCard);
    expect(card.stage).toBe("compose");
    expect(card.preview?.body).toContain("_Filed from ClarkCant (voice)._");
    expect(result.text).toContain("Do not say it was filed");
    expect(github.writes()).toHaveLength(0);

    await call("POST", `/feedback/reports/${card.reportId ?? ""}/publish`, { conversationId, answers: card.cardId });
    const [issue] = [...github.issues.values()];
    expect(issue?.body).toBe(card.preview?.body);
  });

  it("never files, even when a call still asks it to, and says so", async () => {
    const result = await run({ action: "file", kind: "feature", description: "Export a conversation as Markdown" });

    expect(feedbackCardSchema.parse(result.hostCard).stage).toBe("compose");
    expect(result.text).toContain("no longer files reports");
    expect(github.writes()).toHaveLength(0);
  });

  it("offers no way to file in its contract", () => {
    const parameters = tool().parameters as { properties: Record<string, unknown> };

    expect(parameters.properties).not.toHaveProperty("action");
    expect(tool().description).toContain("It does not file anything");
  });

  it("refuses a report that is not valid, and says nothing was prepared or filed", async () => {
    const result = await run({ kind: "complaint", description: "x" });

    expect(result.text).toContain("Nothing was prepared or filed");
    expect(github.writes()).toHaveLength(0);
  });
});
