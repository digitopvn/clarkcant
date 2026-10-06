import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type FeedbackCard,
  type Instant,
  SLASH_COMMANDS,
  feedbackCardSchema,
  feedbackMarker,
  isPersonOnlyRoute,
  parseSlashCommand,
} from "@clarkcant/contracts";
import { messagesSince } from "@clarkcant/storage";

import { reportArgument } from "../src/application/slash-commands.ts";
import { createFeedbackTool } from "../src/feedback-tool.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createFakeGithub, type FakeGithub } from "../src/test-support/fake-github.ts";

/**
 * Every way of reporting reaches the one report service: `/report`, the composer's routes, and `report_feedback` for a
 * sentence or voice. Each is proven here to end in the same truthful result card, against an in-process GitHub.
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

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function call(method: string, path: string, body?: unknown) {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
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

  it("files a bug from its words and answers with the issue it was read back as", async () => {
    const response = await call("POST", `/conversations/${conversationId}/messages`, { text: "/report bug the orb freezes after waking from sleep" });
    expect(response.status).toBe(200);

    const card = feedbackCards().at(-1);
    expect(card?.stage).toBe("result");
    expect(card?.publication?.status).toBe("published");
    expect(card?.eligibility).toMatchObject({ eligible: false, code: "handling-unavailable" });
    const [issue] = [...github.issues.values()];
    expect(issue?.title).toBe("bug: the orb freezes after waking from sleep");
    expect(issue?.body).toContain("Not known yet.");
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

  it("refuses a report that is not valid, and one that does not exist", async () => {
    const invalid = await call("POST", "/feedback/reports", { request: { kind: "bug", description: "", source: "composer" } });
    expect(invalid.status).toBe(400);

    const missing = await call("POST", "/feedback/reports/rpt_missing/publish", { conversationId });
    expect(missing.status).toBe(404);
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

  it("files from voice through the same service, and records that it came by voice", async () => {
    const result = await run({ kind: "bug", description: "Clark stops listening after a long pause" }, "voice");

    const card = feedbackCardSchema.parse(result.hostCard);
    expect(card.publication?.status).toBe("published");
    const [issue] = [...github.issues.values()];
    expect(issue?.body).toContain("_Filed from ClarkCant (voice)._");
  });

  it("puts the composer in the conversation on compose, and files nothing", async () => {
    const result = await run({ action: "compose", kind: "feature", description: "Export a conversation as Markdown" });

    expect(feedbackCardSchema.parse(result.hostCard).stage).toBe("compose");
    expect(github.writes()).toHaveLength(0);
  });

  it("refuses a report that is not valid, and says nothing was filed", async () => {
    const result = await run({ kind: "complaint", description: "x" });

    expect(result.text).toContain("Nothing was filed");
    expect(github.writes()).toHaveLength(0);
  });
});
