import { describe, expect, it, vi } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import type { ModelTurnEvent } from "@clarkcant/core";
import { FakePiAdapter, type WorkerBrief, type WorkerSessionHandle } from "@clarkcant/pi-adapter";

import { createModelTurn, type ViewDescriptor } from "../src/model-turn.ts";

const VIEW: ViewDescriptor = {
  id: "canvas.table@1",
  label: "A table",
  build: () => ({ type: "evidence", kind: "test-output", summary: "rendered by the view", verdict: "verified" }),
};

/**
 * Changing the model, in the only way Pi allows it.
 *
 * Pi resolves a model when a session is created, so a change cannot be applied to the session underneath a running
 * turn. What these tests hold is the answer this code gives instead: the change creates a successor generation at
 * the turn boundary, the conversation keeps its thread, and a model that has not changed costs nothing at all.
 */
class CountingAdapter extends FakePiAdapter {
  readonly handoffs: { sessionId: string; brief: WorkerBrief }[] = [];

  override async handoff(
    sessionId: string,
    brief: WorkerBrief,
  ): Promise<{ successor: WorkerSessionHandle; note: string }> {
    this.handoffs.push({ sessionId, brief });
    return await super.handoff(sessionId, brief);
  }
}

const PRINCIPAL: Principal = {
  principalId: "p_owner" as Principal["principalId"],
  kind: "user",
  nodeId: "n1" as Principal["nodeId"],
};
const CONVERSATION = "c1" as ConversationId;
const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;

async function say(
  turn: NonNullable<Awaited<ReturnType<typeof createModelTurn>>>,
  text: string,
  messageId: string,
): Promise<void> {
  await turn.answer({ conversationId: CONVERSATION, principal: PRINCIPAL, text, messageId });
}

describe("a changed model", () => {
  it("becomes a new generation at the turn boundary, and the brief travels with it", async () => {
    const adapter = new CountingAdapter({ script: ["ok", "ok", "ok", "ok"] });
    let preferred = { provider: "fake", id: "fake-model" };
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => preferred });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    // Nothing changed, so nothing happened: a handoff per turn would throw away a warm session every message.
    expect(adapter.handoffs).toHaveLength(0);

    preferred = { provider: "fake-other", id: "fake-other-model" };
    await say(turn, "hai", "msg_2");

    expect(adapter.handoffs).toHaveLength(1);
    // The successor runs the model the person chose, and carries the same goal — a generation is a new session, not
    // a new assistant with a new job.
    expect(adapter.handoffs[0]?.brief.model).toEqual({ provider: "fake-other", id: "fake-other-model" });
    expect(adapter.handoffs[0]?.brief.goal).toBe("Answer the user in this conversation.");
  });

  it("hands off once, not once per turn, while the choice stays the same", async () => {
    const adapter = new CountingAdapter({ script: ["ok", "ok", "ok", "ok", "ok"] });
    let preferred = { provider: "fake", id: "fake-model" };
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => preferred });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    preferred = { provider: "fake-other", id: "fake-other-model" };
    await say(turn, "hai", "msg_2");
    await say(turn, "ba", "msg_3");

    expect(adapter.handoffs).toHaveLength(1);
  });

  it("gives the live turn the tool activity and the view after a handoff, briefs the successor and lets the previous session go", async () => {
    const adapter = new CountingAdapter({
      script: ["một", { callTool: { name: "show_view", params: { view: VIEW.id } }, reply: "đây" }],
    });
    const disposed = vi.spyOn(adapter, "dispose");
    let preferred = { provider: "fake", id: "fake-model" };
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      model: () => preferred,
      views: () => [VIEW],
      history: async () => [{ role: "user", text: "câu hỏi trước đó" }],
    });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");

    preferred = { provider: "fake-other", id: "fake-other-model" };
    const events: ModelTurnEvent[] = [];
    const reply = await turn.answer({
      conversationId: CONVERSATION,
      principal: PRINCIPAL,
      text: "hai",
      messageId: "msg_2",
      onEvent: (event) => events.push(event),
    });

    expect(adapter.handoffs).toHaveLength(1);
    // The tool the successor called reports to the turn the person is watching, and its view lands in that reply.
    expect(events.filter((event) => event.type === "tool-start").map((event) => (event as { name: string }).name)).toEqual([
      "show_view",
    ]);
    expect(reply.segments.some((segment) => segment.kind === "block")).toBe(true);
    // The successor knows nothing of the thread, so its first prompt carries the recap.
    const successor = adapter.allPrompts().at(-1) ?? "";
    expect(successor).toContain("câu hỏi trước đó");
    // And the previous generation is let go rather than kept alive for as long as the process runs.
    expect(disposed).toHaveBeenCalledWith(adapter.handoffs[0]?.sessionId);
  });

  it("waits for the running turn to end before handing off, so its session is not let go underneath it", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai", "ba"] });
    const disposed = vi.spyOn(adapter, "dispose");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = adapter.prompt.bind(adapter);
    vi.spyOn(adapter, "prompt").mockImplementationOnce(async (sessionId, text) => {
      await gate;
      await original(sessionId, text);
    });
    let preferred = { provider: "fake", id: "fake-model" };
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => preferred });
    if (turn === undefined) throw new Error("the model turn was not built");

    const running = say(turn, "một", "msg_1");
    await vi.waitFor(() => expect(turn.running()).toEqual([CONVERSATION]));
    preferred = { provider: "fake-other", id: "fake-other-model" };
    const joining = say(turn, "hai", "msg_2");
    // The message joined the running turn's session (the held first prompt has not been recorded yet): nothing was
    // handed off and nothing was let go.
    await vi.waitFor(() => expect(adapter.promptsFor("fake-session-1")).toEqual([expect.stringContaining("hai")]));
    expect(adapter.handoffs).toHaveLength(0);
    expect(disposed).not.toHaveBeenCalled();
    release();
    await Promise.all([running, joining]);

    // The next turn to start is the boundary, and the change is made there.
    await say(turn, "ba", "msg_3");
    expect(adapter.handoffs).toHaveLength(1);
  });

  it("does nothing when nobody has expressed a preference", async () => {
    // A node with no pool runs the configured model, and "no preference" is not a change to apply.
    const adapter = new CountingAdapter({ script: ["ok", "ok"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter, model: () => undefined });
    if (turn === undefined) throw new Error("the model turn was not built");

    await say(turn, "một", "msg_1");
    await say(turn, "hai", "msg_2");
    expect(adapter.handoffs).toHaveLength(0);
  });
});
