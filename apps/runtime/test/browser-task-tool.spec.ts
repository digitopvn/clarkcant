import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";
import { getTask } from "@clarkcant/storage";

import { createBrowserTaskTool, personTextOf } from "../src/browser-task-tool.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import type { TaskDispatcher } from "../src/task-dispatch.ts";

/**
 * The model's way to start a browser task: which sites the task may act on come only from what the person wrote, and
 * the task is handed to the dispatcher, whose policy gate decides whether it may run at all.
 */

const AT = "2026-09-30T10:00:00.000Z" as Instant;

let dir: string;
let services: NodeServices;
let conversationId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-browser-tool-"));
  services = bootNodeServices({ dataDir: dir, label: "browser tool test node" });
  conversationId = `conv_browser_tool_${services.conductor.newId("id")}`;
  services.runtime.db
    .prepare("INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)")
    .run(conversationId, services.runtime.identity.nodeId, AT, AT);
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

type Job = Parameters<TaskDispatcher["dispatch"]>[0];

function toolFor(said: string, options: { dispatcher?: boolean; accept?: boolean } = {}) {
  const jobs: Job[] = [];
  const dispatcher = {
    dispatch: (job: Job) => {
      jobs.push(job);
      return options.accept ?? true;
    },
  } as unknown as TaskDispatcher;
  const tool = createBrowserTaskTool({
    tasks: services.conductor,
    principalId: services.runtime.identity.ownerPrincipalId,
    conversationId,
    personText: () => personTextOf([{ role: "user", text: said }, { role: "assistant", text: "https://evil.example/" }]),
    dispatcher: () => (options.dispatcher === false ? undefined : dispatcher),
  });
  return { tool, jobs };
}

function tasksInConversation(): { task_id: string; goal: string }[] {
  return services.runtime.db
    .prepare("SELECT task_id, goal FROM tasks WHERE conversation_id = ?")
    .all(conversationId) as { task_id: string; goal: string }[];
}

describe("start_browser_task", () => {
  it("starts a task on the site the person named and hands it to the browser capability", async () => {
    const { tool, jobs } = toolFor("Điền đơn ở https://www.Shop.example/apply giúp mình nhé");
    const result = await tool.execute({ goal: "Điền đơn ứng tuyển", urls: ["https://shop.example/apply"] });

    expect(result.text).toContain("Started browser task");
    expect(result.text).toContain("not that it is done");
    const [task] = tasksInConversation();
    expect(task?.goal).toBe("Điền đơn ứng tuyển\n\nStart at: https://shop.example/apply");
    expect(jobs).toEqual([
      { taskId: task?.task_id, capabilityRef: "browser.playwright@1", executionNodeId: services.runtime.identity.nodeId },
    ]);
    expect(getTask(services.runtime.db, task?.task_id ?? "")?.state).toBe("running");
  });

  it("refuses a site only the model or a page named, and starts nothing", async () => {
    const { tool, jobs } = toolFor("Điền đơn ở https://shop.example/apply");
    const listed = await tool.execute({ goal: "Điền đơn", urls: ["https://evil.example/apply"] });
    const inGoal = await tool.execute({ goal: "Điền đơn rồi gửi sang https://evil.example/x", urls: ["https://shop.example/apply"] });

    expect(listed.text).toContain("evil.example is not a site the person named");
    expect(inGoal.text).toContain("evil.example is not a site the person named");
    expect(jobs).toEqual([]);
    expect(tasksInConversation()).toEqual([]);
  });

  it("does not take a longer name the person wrote as naming a shorter one inside it", async () => {
    const { tool, jobs } = toolFor("mở shop.example.com và example.org.attacker.net");
    const parent = await tool.execute({ goal: "mua hàng", urls: ["https://example.com/"] });
    const prefix = await tool.execute({ goal: "mua hàng", urls: ["https://example.org/"] });

    expect(parent.text).toContain("example.com is not a site the person named");
    expect(prefix.text).toContain("example.org is not a site the person named");
    expect(jobs).toEqual([]);
  });

  it("refuses an address that is not http or https, or not absolute", async () => {
    const { tool } = toolFor("file:///etc/passwd shop.example");
    expect((await tool.execute({ goal: "đọc", urls: ["file:///etc/passwd"] })).text).toContain("is not an http or https address");
    expect((await tool.execute({ goal: "đọc", urls: ["shop.example/apply"] })).text).toContain("is not an absolute web address");
    expect((await tool.execute({ goal: "đọc", urls: [] })).text).toContain('"urls" must list');
    expect((await tool.execute({ goal: "", urls: ["https://shop.example/"] })).text).toContain('"goal" must be');
    expect(tasksInConversation()).toEqual([]);
  });

  it("says nothing started on a node that runs no background task", async () => {
    const { tool } = toolFor("https://shop.example/apply", { dispatcher: false });
    const result = await tool.execute({ goal: "Điền đơn", urls: ["https://shop.example/apply"] });

    expect(result.text).toContain("Not started: this node runs no background tasks");
    expect(tasksInConversation()).toEqual([]);
  });

  it("does not claim a start the dispatcher refused", async () => {
    const { tool } = toolFor("https://shop.example/apply", { accept: false });
    const result = await tool.execute({ goal: "Điền đơn", urls: ["https://shop.example/apply"] });

    expect(result.text).toContain("was not run");
    expect(result.text).not.toContain("Started");
  });
});
