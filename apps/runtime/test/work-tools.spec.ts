import { describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import { createWorkSupervisor, type WorkSupervisor } from "../src/work-supervisor.ts";
import { createWorkTools } from "../src/work-tools.ts";

const AT = "2026-09-24T07:00:00.000Z" as Instant;

function tools(supervisor: WorkSupervisor, conversationId?: string) {
  const [list, stop] = createWorkTools({
    ...(conversationId === undefined ? {} : { conversationId }),
    supervisor: () => supervisor,
  });
  if (list === undefined || stop === undefined) throw new Error("both tools are defined");
  const call = async (tool: typeof list, params: Record<string, unknown>) =>
    (await (tool.execute as (params: Record<string, unknown>) => Promise<{ text: string }>)(params)).text;
  return { list: (params: Record<string, unknown> = {}) => call(list, params), stop: (params: Record<string, unknown>) => call(stop, params) };
}

function supervisorWithWork(): { supervisor: WorkSupervisor; workId: string; stoppedTerminal: string[] } {
  const supervisor = createWorkSupervisor({ now: () => AT });
  const stoppedTerminal: string[] = [];
  const started = supervisor.submitBackground({
    conversationId: "conv-a",
    title: "summarise the report",
    requestText: "summarise the report",
    run: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason as Error))),
  });
  if (!started.accepted) throw new Error("should be admitted");
  supervisor.addSource({
    kind: "terminal",
    list: () => [{ workId: "term-1", kind: "terminal", title: "zsh", state: "running", conversationId: "conv-b", startedAt: AT }],
    cancel: (workId) => {
      stoppedTerminal.push(workId);
      return true;
    },
  });
  return { supervisor, workId: started.workId, stoppedTerminal };
}

describe("the agent's view of running work", () => {
  it("lists this conversation's work by default, and the whole node on request", async () => {
    const { supervisor, workId } = supervisorWithWork();
    const { list } = tools(supervisor, "conv-a");

    const mine = await list();
    expect(mine).toContain(workId);
    expect(mine).toContain("việc nền · đang chạy");
    expect(mine).not.toContain("term-1");

    expect(await list({ scope: "node" })).toContain("term-1");
  });

  it("never shows a pid, a working directory or an environment", async () => {
    const { supervisor } = supervisorWithWork();
    supervisor.addSource({
      kind: "command",
      list: () => [{ workId: "cmd-1", kind: "command", title: "sleep 60", state: "running", conversationId: "conv-a", startedAt: AT }],
      cancel: () => true,
    });
    const text = await tools(supervisor, "conv-a").list();
    expect(text).not.toMatch(/pid|cwd|PATH=/i);
  });

  it("says so when nothing is running", async () => {
    const { list } = tools(createWorkSupervisor({ now: () => AT }), "conv-a");
    expect(await list()).toBe("Nothing is running for this conversation.");
  });
});

describe("the agent stopping work", () => {
  it("stops one piece of work by the id the listing showed", async () => {
    const { supervisor, workId } = supervisorWithWork();
    const { stop } = tools(supervisor, "conv-a");

    expect(await stop({ workId })).toBe(`Stopped ${workId}.`);
    await Promise.resolve();
    expect(await stop({ workId })).toContain("had already ended");
  });

  it("does not close a person's terminal", async () => {
    const { supervisor, stoppedTerminal } = supervisorWithWork();
    const { stop } = tools(supervisor);

    expect(await stop({ workId: "term-1" })).toContain("the user closes it from its card");
    expect(stoppedTerminal).toEqual([]);
  });

  it("answers an unknown or missing id with how to find the right one", async () => {
    const { stop } = tools(createWorkSupervisor({ now: () => AT }));
    expect(await stop({ workId: "nope" })).toContain("call list_work");
    expect(await stop({})).toContain("workId is required");
  });
});
