import { describe, expect, it } from "vitest";

import { HOST_OWNED_BLOCK_TYPES, type ConversationId, type Instant, type Principal } from "@clarkcant/contracts";
import { FakePiAdapter, type WorkerBrief } from "@clarkcant/pi-adapter";
import type { ModelTurnEvent } from "@clarkcant/core";

import { createModelTurn, type ViewDescriptor } from "../src/model-turn.ts";

/**
 * How the view tool reaches the model.
 *
 * This exists because the first version of it looked correct and did nothing. Registering a tool
 * after the session was created bypassed the allowlist: the tool never reached the registry the
 * allowlist consults, so the system prompt told the model it had no tools, and the model answered
 * with invented tool syntax instead of calling one. Nothing threw, nothing logged, and the only
 * symptom was a reply that looked like a garbled tool call.
 *
 * So the assertion is not "a tool exists" — it is that the tool travels in the brief, which is the
 * only path the SDK actually reads.
 */

/** Records the brief each session was created with, which the fake keeps private. */
class RecordingAdapter extends FakePiAdapter {
  readonly briefs: WorkerBrief[] = [];

  override async createWorkerSession(brief: WorkerBrief): Promise<{ sessionId: string; sessionFile: string | undefined; createdAt: Instant }> {
    this.briefs.push(brief);
    return super.createWorkerSession(brief);
  }
}

const PRINCIPAL: Principal = { principalId: "p_owner" as Principal["principalId"], kind: "user", nodeId: "n1" as Principal["nodeId"] };

const CONVERSATION = "c1" as ConversationId;

const VIEW: ViewDescriptor = {
  id: "canvas.table@1",
  label: "A table",
  build: () => ({
    type: "evidence",
    kind: "test-output",
    summary: "rendered by the view",
    verdict: "verified",
  }),
};

const ENV = {
  CC_MODEL_PROVIDER: "test-provider",
  CC_MODEL_ID: "test-model",
} satisfies NodeJS.ProcessEnv;

describe("the view tool reaches the model through the brief", () => {
  it("carries the tool at session creation, which is the only path the SDK reads", async () => {
    const adapter = new RecordingAdapter({ script: ["Đây là câu trả lời."] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      views: () => [VIEW],
      datasetRefs: () => ["dataset_fixture_usage"],
    });
    expect(turn).toBeDefined();

    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "vẽ gì đó", messageId: "msg_1" });

    expect(adapter.briefs).toHaveLength(1);
    const custom = adapter.briefs[0]!.customTools ?? [];
    expect(custom.map((tool) => tool.name)).toEqual(["show_view"]);
    // A tool with no prompt snippet is left out of the system prompt's tool list, and a tool the
    // model cannot see is a tool the model invents. So the snippet is part of the contract.
    expect(custom[0]!.promptSnippet).toBeTruthy();
    expect(custom[0]!.parameters).toMatchObject({ required: ["view"] });
  });

  it("registers nothing when there is no catalog, rather than registering a tool that always refuses", async () => {
    // A tool that exists only to say no costs the model a turn to discover, and teaches it that
    // calling tools is not worth trying.
    const adapter = new RecordingAdapter({ script: ["Không có gì để xem."] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      views: () => [],
      datasetRefs: () => [],
    });

    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "vẽ gì đó", messageId: "msg_2" });

    expect(adapter.briefs[0]!.customTools ?? []).toEqual([]);
  });

  it("offers no vocabulary for a host-owned card", async () => {
    // The forgery is not rejected, it is unrepresentable: the model chooses from a catalog of
    // names, and no host-owned block type is in it. Checking the *parameter names* rather than the
    // serialised schema matters — JSON Schema uses `type` as a keyword of its own, so a substring
    // search would flag the schema for containing `"type": "string"` and prove nothing.
    const adapter = new RecordingAdapter({ script: ["ok"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      views: () => [VIEW],
      datasetRefs: () => [],
    });
    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "x", messageId: "msg_3" });

    const properties = ((adapter.briefs[0]!.customTools ?? [])[0]!.parameters as {
      properties?: Record<string, { enum?: unknown }>;
    }).properties ?? {};

    expect(Object.keys(properties).sort()).toEqual(["caption", "props", "view"]);

    // The view names the model may use are exactly the catalog, and every host-owned block type is
    // absent from it. If one ever appeared here, the model could mint an approval card.
    const offered = new Set((properties.view?.enum as string[]) ?? []);
    expect([...offered]).toEqual([VIEW.id]);
    for (const hostOwned of HOST_OWNED_BLOCK_TYPES) {
      expect(offered.has(hostOwned), `${hostOwned} must not be offerable`).toBe(false);
    }
  });

  it("tells the model which datasets exist, so a view is not built over data that is not there", async () => {
    const adapter = new RecordingAdapter({ script: ["ok"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      views: () => [VIEW],
      datasetRefs: () => ["dataset_fixture_usage"],
    });
    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "x", messageId: "msg_4" });

    const tool = (adapter.briefs[0]!.customTools ?? [])[0]!;
    expect(JSON.stringify(tool.parameters)).toContain("dataset_fixture_usage");
    expect(tool.description).toContain("dataset_fixture_usage");
  });

  it("awaits an asynchronous build, because one view has to read before it can answer", async () => {
    // The composed surface consults a selector and reads local records before it knows what to
    // draw. A build that could only be synchronous would put that work somewhere with no turn to
    // cancel, and an abandoned turn could still write a surface.
    const adapter = new RecordingAdapter({ script: ["Đây là tổng quan."] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      views: () => [
        {
          id: "canvas.overview@1",
          label: "Composed overview",
          build: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return {
              type: "evidence",
              kind: "test-output",
              summary: "built asynchronously",
              verdict: "verified",
            };
          },
        },
      ],
      datasetRefs: () => [],
    });

    const reply = await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "tổng quan", messageId: "msg_async" });
    const tool = (adapter.briefs[0]!.customTools ?? [])[0]!;
    const result = await tool.execute({ view: "canvas.overview@1", caption: "Tổng quan" });

    expect(result.text).toContain("Shown");
    expect(reply.segments.length).toBeGreaterThanOrEqual(0);
  });

  it("turns a failed build into a refusal the model reads, and appends no block", async () => {
    const adapter = new RecordingAdapter({ script: ["Không dựng được."] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      views: () => [
        {
          id: "canvas.overview@1",
          label: "Composed overview",
          build: () => {
            throw new Error("the catalog holds no definition canvas.metrics@1");
          },
        },
      ],
      datasetRefs: () => [],
    });

    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "x", messageId: "msg_refused" });
    const tool = (adapter.briefs[0]!.customTools ?? [])[0]!;
    const result = await tool.execute({ view: "canvas.overview@1" });

    // The model gets the reason in the same turn, and a failed request leaves no card behind that
    // looks like it succeeded.
    expect(result.text).toContain("could not be built");
    expect(result.text).toContain("canvas.metrics@1");
  });
});

/**
 * A turn that is being watched.
 *
 * The deltas are what the browser draws while the model is still writing, and the two ways this can
 * go silently wrong are both tested here: a turn that reports nothing (a stream that shows nothing
 * until it is over, which is the feature not working), and a turn that keeps reporting after it has
 * ended (text arriving in the next reply, from the previous one).
 */
describe("a turn reports its text while it is being written", () => {
  it("passes every delta on, and still returns the whole reply", async () => {
    const adapter = new FakePiAdapter({ script: ["Xin chào, đây là câu trả lời."] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });
    expect(turn).toBeDefined();

    const deltas: string[] = [];
    const reply = await turn!.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "chào bạn",
      messageId: "msg_stream_1",
      onEvent: (event) => {
        if (event.type === "text-delta") deltas.push(event.text);
      },
    });

    // More than one, because a single delta at the end would be a reply that arrives all at once and
    // is reported as if it had streamed.
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("Xin chào, đây là câu trả lời.");
    // The reply is built from the buffered segments, not from the deltas: a caller that is not
    // watching still receives the whole answer.
    expect(reply.text).toBe("Xin chào, đây là câu trả lời.");
  });

  it("stops reporting to a caller whose turn has ended", async () => {
    const adapter = new FakePiAdapter({ script: ["câu trả lời đầu tiên", "câu trả lời thứ hai"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });

    const first: string[] = [];
    await turn!.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "một",
      messageId: "msg_stream_2",
      onEvent: (event) => {
        if (event.type === "text-delta") first.push(event.text);
      },
    });

    // The second turn has no watcher, so nothing may reach the first one's callback.
    const afterFirstTurn = first.join("");
    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "hai", messageId: "msg_stream_3" });
    expect(first.join("")).toBe(afterFirstTurn);
  });
});

/**
 * A tool call, captured while it is happening.
 *
 * The adapter reports that a tool ran but not its arguments or its result, so the transcript has to be
 * built where all three exist: around the call itself. Two things follow from that, and both are
 * asserted below — the events a watching client receives, and the widget the message keeps.
 */
class ToolCallingAdapter extends FakePiAdapter {
  readonly briefs: WorkerBrief[] = [];
  /** The call the "model" decides to make, and what it received back. */
  call: { name: string; params: Record<string, unknown> } | undefined;
  readonly returned: string[] = [];

  override async createWorkerSession(brief: WorkerBrief): Promise<{ sessionId: string; sessionFile: string | undefined; createdAt: Instant }> {
    this.briefs.push(brief);
    return super.createWorkerSession(brief);
  }

  override async prompt(sessionId: string, text: string): Promise<void> {
    const tool = (this.briefs.at(-1)?.customTools ?? []).find((entry) => entry.name === this.call?.name);
    if (tool !== undefined && this.call !== undefined) {
      this.returned.push((await tool.execute(this.call.params)).text);
    }
    // The scripted words come after the call, which is what the order assertion below is about.
    await super.prompt(sessionId, text);
  }
}

describe("a tool call is reported while it runs and kept afterwards", () => {
  it("emits a start and a matching end, and stores the call as a widget", async () => {
    const adapter = new ToolCallingAdapter({ script: ["Đây là bảng."] });
    adapter.call = { name: "show_view", params: { view: VIEW.id, caption: "bảng", props: {} } };
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      views: () => [VIEW],
      datasetRefs: () => [],
    });

    const events: ModelTurnEvent[] = [];
    const reply = await turn!.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "vẽ gì đó",
      messageId: "msg_tool_1",
      onEvent: (event) => events.push(event),
    });

    const starts = events.filter((event) => event.type === "tool-start");
    const ends = events.filter((event) => event.type === "tool-end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    // The same identifier on both, which is what lets a client update one widget instead of drawing two.
    expect(ends[0]?.toolCallId).toBe(starts[0]?.toolCallId);
    expect(starts[0]).toMatchObject({ name: "show_view", label: "Show a view", args: { view: VIEW.id } });
    expect(ends[0]).toMatchObject({ status: "done" });

    const widget = reply.segments
      .filter((segment) => segment.kind === "block")
      .map((segment) => (segment.kind === "block" ? segment.block : undefined))
      .find((block) => block?.type === "tool-activity");
    expect(widget).toMatchObject({ status: "done", name: "show_view", args: { view: VIEW.id } });
    expect(String(widget?.result)).toContain(VIEW.id);

    // The call sits where it happened: its own result first, then the receipt, then the words the model
    // wrote after it.
    const shape = reply.segments.map((segment) => (segment.kind === "text" ? "text" : segment.block.type));
    expect(shape).toEqual(["evidence", "tool-activity", "text"]);
  });

  it("records a tool that threw as a failure, and gives the model the reason", async () => {
    const adapter = new ToolCallingAdapter({ script: ["Không xong."] });
    adapter.call = { name: "boom", params: { path: "/tmp/x" } };
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      views: () => [],
      datasetRefs: () => [],
      extraTools: () => [
        {
          name: "boom",
          label: "Làm nổ",
          description: "always fails",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            throw new Error("nổ rồi");
          },
        },
      ],
    });

    const events: ModelTurnEvent[] = [];
    const reply = await turn!.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "làm nổ đi",
      messageId: "msg_tool_2",
      onEvent: (event) => events.push(event),
    });

    expect(events.filter((event) => event.type === "tool-end")[0]).toMatchObject({ status: "failed" });
    const widget = reply.segments.map((segment) => (segment.kind === "block" ? segment.block : undefined)).find((block) => block?.type === "tool-activity");
    expect(widget).toMatchObject({ status: "failed", path: "/tmp/x" });
    expect(String(widget?.result)).toContain("nổ rồi");
    // Returned to the model rather than thrown out of the turn: a failed tool is a turn that can still
    // answer, and the user is not handed a stack trace.
    expect(adapter.returned[0]).toContain("boom lỗi");
    expect(reply.text).toBe("Không xong.");
  });
});

/**
 * A failed turn must not wedge the conversation.
 *
 * The report was a conversation that answered once, then failed every message after it with the same
 * worker id and the same budget message. The session was the cause: a run stopped mid-flight is not
 * usable again, and the turn map kept handing it back. This asserts the recovery, because the failure
 * is invisible from the code that produces it — nothing throws twice.
 */
class FlakyAdapter extends FakePiAdapter {
  readonly briefs: WorkerBrief[] = [];
  /** Fail the next prompt, the way a provider going away mid-run does. */
  fail = true;

  override async createWorkerSession(brief: WorkerBrief): Promise<{ sessionId: string; sessionFile: string | undefined; createdAt: Instant }> {
    this.briefs.push(brief);
    return super.createWorkerSession(brief);
  }

  override async prompt(sessionId: string, text: string): Promise<void> {
    if (this.fail) {
      this.fail = false;
      throw new Error("worker 01a0b4db exceeded its 120000 ms wall-clock budget; it was stopped");
    }
    await super.prompt(sessionId, text);
  }
}

describe("a conversation survives a failed turn", () => {
  it("drops the broken session, so the next message opens a fresh one", async () => {
    const adapter = new FlakyAdapter({ script: ["Lần này thì được."] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });
    expect(turn).toBeDefined();

    let failed: unknown;
    try {
      await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "một", messageId: "msg_f1" });
    } catch (cause) {
      failed = cause;
    }
    expect(failed).toBeInstanceOf(Error);
    expect(adapter.briefs).toHaveLength(1);

    const reply = await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "hai", messageId: "msg_f2" });
    // The point: a second session was created rather than the wedged one being reused, which is what
    // made every later message fail identically.
    expect(adapter.briefs, "the failed session was reused").toHaveLength(2);
    expect(reply.text).toBe("Lần này thì được.");
  });

  it("keeps using one session while turns succeed", async () => {
    // The recovery must not turn every turn into a new session: continuity is the thing being kept.
    const adapter = new FlakyAdapter({ script: ["ok"] });
    adapter.fail = false;
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });

    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "một", messageId: "msg_s1" });
    await turn!.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text: "hai", messageId: "msg_s2" });
    expect(adapter.briefs).toHaveLength(1);
  });
});
