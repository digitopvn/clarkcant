import { describe, expect, it } from "vitest";

import { HOST_OWNED_BLOCK_TYPES, type ConversationId, type Instant, type Principal } from "@clarkcant/contracts";
import { FakePiAdapter, type WorkerBrief } from "@clarkcant/pi-adapter";

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
});
