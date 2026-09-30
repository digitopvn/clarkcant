import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant, MessageRecord, MessageSurface } from "@clarkcant/contracts";
import { getTask } from "@clarkcant/storage";

import { browserTaskToolDepsFor } from "../src/bootstrap/model-bootstrap.ts";
import { createBrowserTaskTool, personTextOf } from "../src/browser-task-tool.ts";
import { createNodeTools } from "../src/node-tools.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { createTaskDispatcher, type TaskDispatcher, type TaskDispatcherDeps } from "../src/task-dispatch.ts";
import { nodeWorkerModel } from "../src/worker-model.ts";

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

let sequence = 0;

/** A stored message as the conversation keeps it; by default one the person typed into this node's composer. */
function message(
  text: string,
  options: { role?: MessageRecord["role"]; surface?: MessageSurface | null; authorNodeId?: string; blocks?: MessageRecord["blocks"] } = {},
): MessageRecord {
  sequence += 1;
  const surface = options.surface === undefined ? "composer" : options.surface;
  return {
    messageId: `msg_${String(sequence)}`,
    conversationId,
    role: options.role ?? "user",
    blocks: options.blocks ?? [{ type: "text", format: "plain", content: text, streaming: false }],
    authorNodeId: options.authorNodeId ?? services.runtime.identity.nodeId,
    createdAt: AT,
    delivery: "accepted",
    ...(surface === null ? {} : { surface }),
  };
}

function toolFor(said: string | readonly MessageRecord[], options: { dispatcher?: boolean; accept?: boolean } = {}) {
  const jobs: Job[] = [];
  const dispatcher = {
    dispatch: (job: Job) => {
      jobs.push(job);
      return options.accept ?? true;
    },
  } as unknown as TaskDispatcher;
  const messages =
    typeof said === "string"
      ? [message(said), message("https://evil.example/", { role: "assistant", surface: null })]
      : said;
  const tool = createBrowserTaskTool({
    tasks: services.conductor,
    principalId: services.runtime.identity.ownerPrincipalId,
    conversationId,
    personText: () => personTextOf(messages, services.runtime.identity.nodeId),
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
    expect(task?.goal).toBe("Điền đơn ứng tuyển\n\nBắt đầu từ: https://shop.example/apply");
    expect(jobs).toEqual([
      { taskId: task?.task_id, capabilityRef: "browser.playwright@1", executionNodeId: services.runtime.identity.nodeId },
    ]);
    const stored = getTask(services.runtime.db, task?.task_id ?? "");
    expect(stored?.state).toBe("running");
    // The checked sites travel on the task itself; the dispatcher lets the browser onto these and nothing else.
    expect(stored?.origin).toEqual({
      kind: "interactive",
      principalId: services.runtime.identity.ownerPrincipalId,
      sites: ["https://shop.example"],
    });
  });

  it("refuses an address with a user name or password in front of its host, in any spelling", async () => {
    const { tool, jobs } = toolFor("Điền đơn ở https://shop.example/apply và http://127.0.0.1:8080");
    for (const url of [
      "https://shop.example'@evil.example/",
      "https://shop.example(@evil.example/",
      "https://shop.example)@evil.example/",
      "https://user:pass@shop.example/",
      // The loopback form: a reader sees a local address ending in "(", a parser sees shop.example with a user name.
      "http://127.0.0.1:8080(@shop.example/",
    ]) {
      const result = await tool.execute({ goal: "Điền đơn", urls: [url] });
      expect(result.text, url).toContain("with a user name or password in front of its host");
    }
    // Written into the goal instead of the list, it is refused all the same.
    const inGoal = await tool.execute({
      goal: "Điền đơn ở https://x@shop.example/apply",
      urls: ["https://shop.example/apply"],
    });
    expect(inGoal.text).toContain("with a user name or password in front of its host");
    expect(jobs).toEqual([]);
    expect(tasksInConversation()).toEqual([]);
  });

  it("refuses a request too long to store whole instead of cutting it, wherever the cut would land", async () => {
    const { tool, jobs } = toolFor("Điền đơn ở https://shop.example/apply");
    // Sized so that a cut at the task's 4000-character limit would fall inside the second address's host, leaving
    // `https://shop.e` — a different site than the one that was checked.
    const first = `https://shop.example/${"a".repeat(1950)}`;
    const goal = "x".repeat(2000);
    const whole = `${goal}\n\nBắt đầu từ: ${first} https://shop.example/second`;
    expect(whole.slice(0, 4000).endsWith("https://shop.e")).toBe(true);
    const result = await tool.execute({ goal, urls: [first, "https://shop.example/second"] });

    expect(result.text).toContain("shorten the goal");
    expect(jobs).toEqual([]);
    expect(tasksInConversation()).toEqual([]);
  });

  it("takes a plain http address only when the person wrote http themselves", async () => {
    const named = toolFor("Điền đơn ở shop.example");
    const plain = await named.tool.execute({ goal: "Điền đơn", urls: ["http://shop.example/apply"] });
    expect(plain.text).toContain("not as a plain http address; use https");

    const typed = toolFor("Điền đơn ở http://shop.example/apply");
    const allowed = await typed.tool.execute({ goal: "Điền đơn", urls: ["http://shop.example/apply"] });
    expect(allowed.text).toContain("Started browser task");
    expect(named.jobs).toEqual([]);
  });

  it("reads a site only from the person's own words on this node's composer or voice", async () => {
    const node = services.runtime.identity.nodeId;
    const text = (content: string): MessageRecord["blocks"] => [{ type: "text", format: "plain", content, streaming: false }];
    const messages = [
      message("https://relay.example/", { surface: null }),
      message("https://peer.example/", { authorNodeId: "node_elsewhere" }),
      message("https://assistant.example/", { role: "assistant", surface: null }),
      message("", {
        blocks: [
          ...text("mở trang voice.example giúp mình"),
          { type: "artifact", artifactId: "art_1", title: "https://artifact.example/", mediaType: "text/plain" } as never,
        ],
        surface: "voice",
      }),
      message("mở https://composer.example/"),
    ];
    const said = personTextOf(messages, node);

    expect(said).toContain("composer.example");
    expect(said).toContain("voice.example");
    for (const other of ["relay.example", "peer.example", "assistant.example", "artifact.example"]) {
      expect(said).not.toContain(other);
    }
    const { tool, jobs } = toolFor(messages);
    const relayed = await tool.execute({ goal: "Điền đơn", urls: ["https://relay.example/"] });
    expect(relayed.text).toContain("relay.example is not a site the person named");
    expect(jobs).toEqual([]);
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

  it("is offered to a model turn only on a node whose dispatched workers run its model", () => {
    const toolNames = (): string[] => {
      const browserTasks = browserTaskToolDepsFor(services, {
        principalId: services.runtime.identity.ownerPrincipalId,
        conversationId,
      });
      return createNodeTools({
        search: services.search,
        projects: services.projects,
        ...(browserTasks === undefined ? {} : { browserTasks }),
      }).map((tool) => tool.name);
    };
    const dispatcherWith = (workerModel: TaskDispatcherDeps["workerModel"]): TaskDispatcher =>
      createTaskDispatcher({
        conductor: services.conductor,
        projectRoots: () => [dir],
        ownedRoots: () => [dir],
        onSettled: () => undefined,
        ...(workerModel === undefined ? {} : { workerModel }),
      });
    const configured = {
      workerModel: async () => ({ provider: "openai", id: "gpt-test", via: "configured" as const }),
    };

    // No dispatcher: nothing runs a background task here.
    expect(toolNames()).not.toContain("start_browser_task");
    // A dispatcher and a configured model: the tool is offered.
    services.taskDispatch = dispatcherWith(nodeWorkerModel({ modelTurn: configured, env: {}, storedCredential: () => undefined }));
    expect(toolNames()).toContain("start_browser_task");
    // A dispatcher on a node with no model configured: a task could be started, but nothing could do it.
    services.taskDispatch = dispatcherWith(nodeWorkerModel({ modelTurn: undefined, env: {}, storedCredential: () => undefined }));
    expect(toolNames()).not.toContain("start_browser_task");
    // The scripted worker is not a model either.
    services.taskDispatch = dispatcherWith(undefined);
    expect(toolNames()).not.toContain("start_browser_task");
  });

  it("does not claim a start the dispatcher refused", async () => {
    const { tool } = toolFor("https://shop.example/apply", { accept: false });
    const result = await tool.execute({ goal: "Điền đơn", urls: ["https://shop.example/apply"] });

    expect(result.text).toContain("was not run");
    expect(result.text).not.toContain("Started");
  });
});
