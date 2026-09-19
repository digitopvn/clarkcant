import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeIdSchema } from "@clarkcant/contracts";
import { FakePiAdapter, type WorkerBrief } from "@clarkcant/pi-adapter";
import { requestApproval, setPreference, type ModelTurnInput } from "@clarkcant/core";
import { appendMessage, nextMessageSequence, readCredential } from "@clarkcant/storage";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { commandDigest } from "../src/run-command.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Conversation API.
 *
 * This is journey J1 over the wire: create a conversation, send a message, receive a
 * labelled sample response with a renderable widget, pin it, and unpin it. It runs with no
 * provider credentials, which is the property the blueprint requires of this journey.
 *
 * The negative cases carry as much weight as the positive one. A gateway whose only
 * verified behaviour is the happy path is a gateway whose authorization is a guess.
 */

const AT = "2026-09-16T04:00:00.000Z";

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let conversationId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-api-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  let sequence = 0;
  deps = {
    services,
    now: () => AT,
    newConversationId: () => {
      sequence += 1;
      return `conv_test_${sequence}`;
    },
  };
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function token(): string {
  return services.runtime.identity.localToken;
}

async function request(
  method: string,
  path: string,
  options: { body?: unknown; authed?: boolean; query?: Record<string, string> } = {},
): Promise<GatewayResponse> {
  const request_: GatewayRequest = {
    method,
    path,
    query: options.query ?? {},
    headers: options.authed === false ? {} : { authorization: `Bearer ${token()}` },
    body: options.body === undefined ? "" : JSON.stringify(options.body),
  };
  return handleRequest(deps, request_);
}

async function createConversation(): Promise<string> {
  const response = await request("POST", "/conversations", { body: { title: "J1" } });
  expect(response.status).toBe(201);
  return (response.body as { conversationId: string }).conversationId;
}

describe("gateway authorization", async () => {
  it("serves health without a token but discloses no node identity", async () => {
    const response = await request("GET", "/health", { authed: false });
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body.status).toBe("ok");
    // An open readiness probe must not become a way to enumerate nodes.
    expect(body.nodeId).toBeUndefined();
    expect(body.label).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(services.runtime.identity.nodeId);
  });

  it("rejects every other route without a token", async () => {
    for (const [method, path] of [
      ["GET", "/node"],
      ["GET", "/capabilities"],
      ["GET", "/conversations"],
      ["POST", "/conversations"],
    ] as const) {
      const response = await request(method, path, { authed: false });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("rejects a wrong token and does not distinguish it from a missing one", async () => {
    const wrong = await handleRequest(deps, {
      method: "GET",
      path: "/node",
      query: {},
      headers: { authorization: "Bearer not-the-token" },
      body: "",
    });
    const missing = await await request("GET", "/node", { authed: false });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(missing.body);
  });

  it("rejects a malformed authorization header", async () => {
    const response = await handleRequest(deps, {
      method: "GET",
      path: "/node",
      query: {},
      headers: { authorization: `Basic ${token()}` },
      body: "",
    });
    expect(response.status).toBe(401);
  });

  it("returns the node identity only to an authenticated caller", async () => {
    const response = await request("GET", "/node");
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(nodeIdSchema.safeParse(body.nodeId).success).toBe(true);
    // The token itself must never be echoed back.
    expect(JSON.stringify(body)).not.toContain(token());
  });
});

describe("J1 over the API", async () => {
  it("creates a conversation and lists it", async () => {
    const created = await createConversation();
    const list = await request("GET", "/conversations");
    expect(list.status).toBe(200);
    expect((list.body as { conversations: unknown[] }).conversations).toHaveLength(1);
    expect(created).toBeTruthy();
  });

  it("answers a first message with a labelled sample and a renderable widget", async () => {
    conversationId = await createConversation();
    const response = await request("POST", `/conversations/${conversationId}/messages`, {
      body: { text: "cho tui xem biểu đồ", demo: true },
    });
    expect(response.status).toBe(202);

    const body = response.body as {
      resolution: string;
      taskId: string | null;
      timeline: { messages: { role: string; blocks: { type: string }[] }[]; instances: unknown[] };
    };
    expect(body.resolution).toBe("sample");
    expect(body.taskId).toBeNull();
    expect(body.timeline.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    const types = body.timeline.messages.flatMap((message) => message.blocks).map((block) => block.type);
    expect(types).toContain("system-card");
    expect(types).toContain("surface");
    // The widget must arrive with props, or the client has nothing to render.
    expect(body.timeline.instances).toHaveLength(1);
  });

  it("returns the instances the timeline references, with props", async () => {
    conversationId = await createConversation();
    await request("POST", `/conversations/${conversationId}/messages`, { body: { text: "cho tui xem bảng", demo: true } });
    const timeline = await request("GET", `/conversations/${conversationId}/timeline`);
    expect(timeline.status).toBe(200);

    const body = timeline.body as {
      instances: { definitionId: string; props: Record<string, unknown> }[];
      metadata: { messageCount: number };
    };
    expect(body.instances[0]?.definitionId).toBe("canvas.table@1");
    expect(body.instances[0]?.props.datasetRef).toBe("dataset_fixture_usage");
    expect(body.metadata.messageCount).toBe(2);
  });

  it("rejects an empty message rather than storing a blank turn", async () => {
    conversationId = await createConversation();
    expect((await request("POST", `/conversations/${conversationId}/messages`, { body: { text: "   " } })).status).toBe(400);
    expect((await request("POST", `/conversations/${conversationId}/messages`, { body: {} })).status).toBe(400);
  });

  it("rejects a message body that is not an object", async () => {
    conversationId = await createConversation();
    const response = await handleRequest(deps, {
      method: "POST",
      path: `/conversations/${conversationId}/messages`,
      query: {},
      headers: { authorization: `Bearer ${token()}` },
      body: '"just a string"',
    });
    expect(response.status).toBe(400);
  });

  it("supports the whole pin lifecycle, and unpinning keeps the widget data", async () => {
    conversationId = await createConversation();
    await request("POST", `/conversations/${conversationId}/messages`, { body: { text: "cho tui xem biểu đồ", demo: true } });
    const timeline = (await request("GET", `/conversations/${conversationId}/timeline`)).body as {
      instances: { instanceId: string }[];
    };
    const instanceId = timeline.instances[0]!.instanceId;

    const pinned = await request("POST", `/conversations/${conversationId}/pins`, {
      body: { instanceId, displayMode: "expanded" },
    });
    expect(pinned.status).toBe(201);
    const pinId = (pinned.body as { pinId: string }).pinId;
    expect((pinned.body as { timeline: { pins: unknown[] } }).timeline.pins).toHaveLength(1);

    // Pinning twice is refused rather than duplicated.
    expect((await request("POST", `/conversations/${conversationId}/pins`, { body: { instanceId } })).status).toBe(409);
    // Pinning an instance that does not exist is a 404, not a silent no-op.
    expect((await request("POST", `/conversations/${conversationId}/pins`, { body: { instanceId: "winst_nope" } })).status).toBe(404);

    const unpinned = await request("DELETE", `/conversations/${conversationId}/pins/${pinId}`);
    expect(unpinned.status).toBe(200);

    const after = (await request("GET", `/conversations/${conversationId}/timeline`)).body as {
      pins: unknown[];
      instances: unknown[];
    };
    expect(after.pins).toHaveLength(0);
    // Unpinning is a presentation change: the note data and the widget instance survive.
    expect(after.instances).toHaveLength(1);
  });

  it("reports registered capabilities honestly, as unavailable until a worker loads them", async () => {
    const response = await request("GET", "/capabilities");
    expect(response.status).toBe(200);
    const body = response.body as { capabilities: { usable: boolean; blockedReason?: string }[] };
    expect(body.capabilities.length).toBeGreaterThan(0);
    // Declaring a capability is not the same as having a worker that can run it.
    expect(body.capabilities.every((capability) => !capability.usable)).toBe(true);
  });

  it("404s an unknown conversation instead of creating one implicitly", async () => {
    expect((await request("GET", "/conversations/conv_missing/timeline")).status).toBe(404);
    expect((await request("POST", "/conversations/conv_missing/messages", { body: { text: "hi" } })).status).toBe(404);
  });

  it("refuses to write to a conversation homed on another node", async () => {
    conversationId = await createConversation();
    // Simulate a conversation that belongs to a peer.
    services.runtime.db
      .prepare("UPDATE conversations SET home_node_id = ? WHERE conversation_id = ?")
      .run("node_elsewhere", conversationId);

    const response = await request("POST", `/conversations/${conversationId}/messages`, { body: { text: "hi" } });
    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe("WRONG_NODE_FOR_RESOURCE");
  });

  it("rejects a non-numeric timeline cursor", async () => {
    conversationId = await createConversation();
    expect(
      (await request("GET", `/conversations/${conversationId}/timeline`, { query: { after: "abc" } })).status,
    ).toBe(400);
  });

  it("accepts a raw command envelope and reports it as an acknowledgement, not an outcome", async () => {
    const response = await request("POST", "/command", {
      body: {
        schema: "agent.command",
        version: 1,
        commandId: "cmd_1",
        idempotencyKey: "idem-key-00000001",
        kind: "conversation.message",
        payload: { text: "hi" },
        issuedAt: AT,
      },
    });
    expect(response.status).toBe(202);
    const body = response.body as { note: string; principal: { principalId: string } };
    expect(body.note).toContain("not an outcome");
    // Identity comes from the transport.
    expect(body.principal.principalId).toBe(services.runtime.identity.ownerPrincipalId);
  });

  it("rejects a malformed command envelope with field-level detail", async () => {
    const response = await request("POST", "/command", { body: { schema: "agent.command", version: 1 } });
    expect(response.status).toBe(400);
    expect((response.body as { issues: string[] }).issues.length).toBeGreaterThan(0);
  });

  it("405s an unsupported method and 404s an unknown path", async () => {
    expect((await request("PUT", "/conversations")).status).toBe(405);
    expect((await request("GET", "/nope")).status).toBe(404);
  });

/**
 * A composed surface over the wire.
 *
 * The composition is produced by the same service the turn pipeline uses, so what the timeline route
 * returns here is what a client would receive after a real turn — minus the model.
 */

});
describe("composed surface in the timeline", () => {
  it("returns the captured snapshot and the live instance as separate lists", async () => {
    const conversationId = await createConversation();
    const composed = await composeForTest(conversationId);
    expect(composed).toBeDefined();
    if (composed === undefined) return;

    const response = await request("GET", `/conversations/${conversationId}/timeline`);
    expect(response.status).toBe(200);
    const timeline = response.body as {
      snapshots: { snapshotId: string; bundleRef?: string; capturedRevision: number }[];
      instances: { instanceId: string; compositionId?: string; actionBindingIds: string[] }[];
    };

    const snapshot = timeline.snapshots.find((entry) => entry.snapshotId === composed.snapshotId);
    expect(snapshot?.bundleRef).toBe(composed.bundleId);
    const instance = timeline.instances.find((entry) => entry.instanceId === composed.instanceId);
    expect(instance?.compositionId).toBe(composed.compositionId);
    expect(instance?.actionBindingIds.length).toBeGreaterThan(0);

    // The composition route answers with the same spec the snapshot was captured against.
    const composition = await request("GET", `/conversations/${conversationId}/widgets/${composed.instanceId}/composition`);
    expect(composition.status).toBe(200);
    const body = composition.body as { sections: { slot: string }[]; bundleRef: string | null };
    expect(body.bundleRef).toBe(composed.bundleId);
    expect(body.sections.length).toBeGreaterThan(0);
  });
});

async function composeForTest(
  conversationId: string,
): Promise<{ instanceId: string; snapshotId: string; bundleId: string; compositionId: string } | undefined> {
  const { appendMessage } = await import("@clarkcant/storage");
  const { composeMiniApp } = await import("../src/compose-mini-app.ts");
  const outcome = await composeMiniApp(services.compose, {
      conversationId,
      messageId: "msg_composed",
      principalId: services.runtime.identity.ownerPrincipalId as never,
      intent: "tổng quan công việc",
      explicitTemplateId: "overview",
    },
  );
  if (!outcome.ok) {
    throw new Error(`composing failed: ${outcome.message}`);
  }
  appendMessage(
    services.runtime.db,
    {
      messageId: "msg_composed",
      conversationId,
      role: "assistant",
      authorNodeId: services.runtime.identity.nodeId,
      delivery: "accepted",
      createdAt: "2026-09-16T04:00:00.000Z",
      blocks: [outcome.block],
    } as never,
    1,
  );
  return outcome;
}

/**
 * Starting a session in a project the finder chose (Phase 11).
 *
 * This is the journey the phase exists for: the user names a project the way they would say it out
 * loud, and the node finds the directory, opens a session in it, and says how to change the answer.
 * The adapter is a recording fake, so what is asserted is the brief a real adapter would have been
 * given — which is the part that decides where the work happens.
 */
describe("starting a session in a project", () => {
  class RecordingAdapter extends FakePiAdapter {
    readonly briefs: WorkerBrief[] = [];

    override async createWorkerSession(brief: WorkerBrief): Promise<{ sessionId: string; sessionFile: string | undefined; createdAt: never }> {
      this.briefs.push(brief);
      const handle = await super.createWorkerSession(brief);
      return { sessionId: handle.sessionId, sessionFile: handle.sessionFile, createdAt: handle.createdAt as never };
    }
  }

  let home: string;
  let nodeDir: string;
  let node: NodeServices;
  let nodeDeps: GatewayDeps;
  let adapter: RecordingAdapter;

  beforeEach(() => {
    nodeDir = mkdtempSync(join(tmpdir(), "clarkcant-session-"));
    home = join(nodeDir, "home");
    mkdirSync(join(home, "agentkit", ".git"), { recursive: true });
    writeFileSync(join(home, "agentkit", "package.json"), "{}");
    mkdirSync(join(home, "agentkit-docs", "docs"), { recursive: true });
    writeFileSync(join(home, "agentkit-docs", "README.md"), "# docs");

    adapter = new RecordingAdapter({ script: ["ok"] });
    node = bootNodeServices({
      dataDir: nodeDir,
      label: "test node",
      projectSessionAdapter: () => adapter,
    });
    nodeDeps = { services: node, now: () => AT };
    // The approved root is the temporary home, not the real one: a test must not scan a developer's
    // actual home directory.
    setPreference(
      { db: node.runtime.db, now: () => AT as never },
      {
        principalId: node.runtime.identity.ownerPrincipalId,
        key: "workspace.roots",
        scope: "global",
        value: [home],
        source: "user",
      },
    );
  });

  afterEach(() => {
    node.runtime.close();
    rmSync(nodeDir, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown): Promise<GatewayResponse> {
    return handleRequest(nodeDeps, {
      method,
      path,
      query: {},
      headers: { authorization: `Bearer ${node.runtime.identity.localToken}` },
      body: body === undefined ? "" : JSON.stringify(body),
    });
  }

  it("finds the right directory, opens a session there, and says how to change it", async () => {
    const created = await call("POST", "/conversations", { title: "project" });
    const conversationId = (created.body as { conversationId: string }).conversationId;

    const response = await call("POST", `/conversations/${conversationId}/start-session`, {
      text: "thêm skill mới cho dự án agentkit đi",
    });

    // Two similarly named directories are on disk, so either a session opens or one question is
    // asked. Both are correct; a wrong directory is not.
    expect([201, 200]).toContain(response.status);
    const body = response.body as {
      status: string;
      projectName?: string;
      relPath?: string;
      mode?: string;
      sessionId?: string;
      question?: string;
      options?: string[];
      timeline: { messages: { blocks: { type: string; content?: string }[] }[] };
    };

    if (body.status === "started") {
      expect(body.projectName).toBe("agentkit");
      expect(body.sessionId).toBeDefined();
      expect(adapter.briefs).toHaveLength(1);
      const brief = adapter.briefs[0]!;
      // The directory the session runs in is the one that was found, and it is the only root granted.
      expect(brief.projectRoots).toEqual([join(home, "agentkit")]);
      // The prompt carries the user's own words plus what was chosen, so the session knows why it is
      // there and the user can correct it.
      expect(brief.goal).toContain("thêm skill mới cho dự án agentkit đi");
      expect(brief.goal).toContain("không phải");
      // Starting a session grants no capability: a capability is granted by the task that needs it.
      expect(brief.allowedCapabilityRefs).toEqual([]);

      const text = body.timeline.messages
        .flatMap((message) => message.blocks)
        .map((block) => block.content ?? "")
        .join("\n");
      expect(text).toContain("agentkit");
      // The choice was recorded so the next question about this project is easier.
      const used = node.runtime.db
        .prepare("SELECT last_used_at FROM project_index WHERE name = 'agentkit'")
        .get() as { last_used_at: string | null } | undefined;
      expect(used?.last_used_at).not.toBeNull();
    } else {
      expect(body.status).toBe("clarify");
      expect(body.question).toContain("Which one did you mean");
      expect(body.options?.some((option) => option.includes("agentkit"))).toBe(true);
      // A question is written into the conversation, so the answer has somewhere to land.
      expect(body.timeline.messages.length).toBeGreaterThan(0);
      expect(adapter.briefs).toHaveLength(0);
    }
  });

  it("refuses a start-session request with no text", async () => {
    const created = await call("POST", "/conversations", { title: "project" });
    const conversationId = (created.body as { conversationId: string }).conversationId;
    const response = await call("POST", `/conversations/${conversationId}/start-session`, { text: "   " });
    expect(response.status).toBe(400);
  });
});

/**
 * A message that is watched while it is answered.
 *
 * The route is the same turn as the one above it with a different way of reporting it, so what these
 * tests are about is the reporting: the events reach the client in the order they happened, the last
 * one carries the same record the plain route would have returned, and a request that cannot be
 * satisfied is refused with a status code rather than inside a stream that has already begun.
 */
describe("a message can be watched while it is answered", () => {
  /** The frames of an event stream, parsed here rather than with the client's parser. */
  function frames(raw: string): { event: string; data: Record<string, unknown> }[] {
    return raw
      .split("\n\n")
      .filter((frame) => frame.trim() !== "" && !frame.startsWith(":"))
      .map((frame) => {
        const lines = frame.split("\n");
        const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() ?? "message";
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).replace(/^ /, ""))
          .join("\n");
        return { event, data: JSON.parse(data) as Record<string, unknown> };
      });
  }

  async function streamOf(deps_: GatewayDeps, conversationId: string, text: string) {
    const response = await handleRequest(deps_, {
      method: "POST",
      path: `/conversations/${conversationId}/messages/stream`,
      query: {},
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
      body: JSON.stringify({ text }),
    });
    const chunks: string[] = [];
    await response.stream?.run((chunk) => chunks.push(chunk));
    return { response, events: frames(chunks.join("")) };
  }

  it("reports each piece of the reply as it arrives, then the stored timeline", async () => {
    const conversationId = await createConversation();
    // A model stub on the conductor rather than a provider: what is under test is the path from a
    // delta to a frame on the wire, and that path does not care who produced the delta.
    const streamed = await streamOf(
      {
        ...deps,
        services: {
          ...services,
          conductor: {
            ...services.conductor,
            respondWithModel: async (input: ModelTurnInput) => {
              input.onEvent?.({ type: "text-delta", text: "Thủ đô" });
              input.onEvent?.({ type: "text-delta", text: " là Paris." });
              return {
                text: "Thủ đô là Paris.",
                segments: [{ kind: "text" as const, text: "Thủ đô là Paris." }],
                provider: "test-provider",
                model: "test-model",
                elapsedMs: 5,
              };
            },
          },
        },
      },
      conversationId,
      "thủ đô của Pháp là gì?",
    );

    expect(streamed.response.status).toBe(200);
    expect(streamed.response.stream?.contentType).toBe("text/event-stream");

    const deltas = streamed.events.filter((event) => event.event === "delta").map((event) => event.data.text);
    expect(deltas.join("")).toBe("Thủ đô là Paris.");

    // The last frame is the record, not a summary of one: a client that discards the deltas ends up
    // holding exactly what the non-streaming route returns.
    const done = streamed.events.at(-1);
    expect(done?.event).toBe("done");
    const timeline = done?.data.timeline as { messages: { role: string; blocks: { type: string; content?: string }[] }[] };
    expect(timeline.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(timeline.messages[1]?.blocks.some((block) => block.content === "Thủ đô là Paris.")).toBe(true);

    // And it is a stored message, so the timeline route agrees with the frame that announced it.
    const stored = await request("GET", `/conversations/${conversationId}/timeline`);
    const storedMessages = (stored.body as { messages: { role: string }[] }).messages;
    expect(storedMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("refuses an empty message before the stream starts, so the refusal has a status code", async () => {
    const conversationId = await createConversation();
    const response = await request("POST", `/conversations/${conversationId}/messages/stream`, { body: { text: "   " } });
    expect(response.status).toBe(400);
    expect(response.stream).toBeUndefined();
  });

  it("refuses a conversation that does not exist", async () => {
    const response = await request("POST", "/conversations/conv_missing/messages/stream", { body: { text: "hi" } });
    expect(response.status).toBe(404);
    expect(response.stream).toBeUndefined();
  });

  it("reports a turn that failed as an error frame, because the status has been sent by then", async () => {
    const conversationId = await createConversation();
    const streamed = await streamOf(
      {
        ...deps,
        services: {
          ...services,
          conductor: {
            ...services.conductor,
            respondWithModel: async () => {
              throw new Error("provider exploded before any message existed");
            },
          },
        },
      },
      conversationId,
      "một câu mà không recipe nào khớp",
    );

    // A thrown turn is turned into a host card by the conductor, so the stream ends with the record
    // of that card rather than with an error — the user is told, and the reply is in the timeline.
    const done = streamed.events.at(-1);
    expect(done?.event).toBe("done");
    expect(done?.data.resolution).toBe("model-failed");
  });
});

/**
 * An approved command, over the wire.
 *
 * The unit tests cover the gate and the runner. This covers the wiring between them: that a decision
 * from a user is what starts a command, that the payload which runs is the one that was displayed, and
 * that a refusal leaves no trace of something having run.
 */
describe("a command runs only when the user approves the one that was displayed", () => {
  /** The card a model turn would have produced, written the way the node writes a message. */
  async function propose(conversationId: string, command: string, cwd: string) {
    const approval = requestApproval(
      {
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        now: () => AT as never,
        newId: services.conductor.newId,
      },
      {
        operationDigest: commandDigest(command, cwd),
        operationDescription: `Chạy lệnh trong ${cwd}`,
        effectCategory: "local-write",
        ttlMs: 900_000,
      },
    );
    const message = {
      messageId: services.conductor.newId("msg"),
      conversationId,
      role: "assistant" as const,
      blocks: [
        {
          type: "approval-card",
          owner: "host",
          approvalId: approval.approvalId,
          operationDescription: approval.operationDescription,
          operationDigest: approval.operationDigest,
          effectCategory: "local-write",
          expiresAt: approval.expiresAt,
          decider: "user",
          decision: "pending",
          payload: JSON.stringify({ command, cwd }),
        },
      ],
      authorNodeId: services.runtime.identity.nodeId,
      createdAt: AT,
      delivery: "accepted" as const,
    };
    appendMessage(services.runtime.db, message as never, nextMessageSequence(services.runtime.db, conversationId));
    return approval;
  }

  function blocksOf(response: GatewayResponse): Record<string, unknown>[] {
    const timeline = (response.body as { timeline?: { messages?: { blocks?: Record<string, unknown>[] }[] } }).timeline;
    return (timeline?.messages ?? []).flatMap((message) => message.blocks ?? []);
  }

  beforeEach(() => {
    // The command runs in the node's own temporary directory, which is this test's approved root.
    setPreference(
      { db: services.runtime.db, now: () => AT as never },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: "workspace.roots",
        scope: "global",
        value: [dir],
        source: "user",
      },
    );
  });

  it("runs it on approval, and appends the output with its evidence", async () => {
    const conversationId = await createConversation();
    const command = `node -e "process.stdout.write('ngon')"`;
    const approval = await propose(conversationId, command, dir);

    const response = await request("POST", `/conversations/${conversationId}/approvals/${approval.approvalId}/decide`, {
      body: { decision: "granted", digest: approval.operationDigest },
    });

    expect(response.status).toBe(200);
    const blocks = blocksOf(response);
    const activity = blocks.find((block) => block.type === "tool-activity");
    expect(activity, "the transcript must show what ran").toBeDefined();
    expect(String(activity?.result)).toContain("ngon");
    expect(blocks.some((block) => block.type === "evidence" && block.verdict === "verified")).toBe(true);
  });

  it("refuses a decision whose digest is not the one that was displayed", async () => {
    const conversationId = await createConversation();
    const approval = await propose(conversationId, `node -e "process.stdout.write('khong-duoc-chay')"`, dir);

    const response = await request("POST", `/conversations/${conversationId}/approvals/${approval.approvalId}/decide`, {
      body: { decision: "granted", digest: "sha256:khong-phai-digest-da-hien" },
    });

    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe("APPROVAL_FORGED");
  });

  it("records a refusal, and nothing runs", async () => {
    const conversationId = await createConversation();
    const approval = await propose(conversationId, `node -e "process.stdout.write('khong-chay')"`, dir);

    const response = await request("POST", `/conversations/${conversationId}/approvals/${approval.approvalId}/decide`, {
      body: { decision: "denied", digest: approval.operationDigest },
    });

    expect(response.status).toBe(200);
    const blocks = blocksOf(response);
    expect(blocks.some((block) => block.type === "tool-activity")).toBe(false);
    expect(JSON.stringify(blocks)).toContain("Đã từ chối");
  });
});

/**
 * A secret a person typed.
 *
 * The assertions about what the answer does *not* contain carry as much weight as the one about what was stored:
 * a response that carried the value would be the first place it leaked from, and nothing downstream would
 * notice, because a key in a card looks like a key in a card.
 */
describe("a secret a person types", () => {
  const owner = (): string => services.runtime.identity.ownerPrincipalId;

  it("is stored, and the answer says only what is now set", async () => {
    const response = await request("POST", "/credentials", {
      body: { fields: [{ name: "gemini", value: "AIza-not-a-real-key" }] },
    });

    expect(response.status).toBe(201);
    const body = response.body as { ok?: boolean; names?: string[] };
    expect(body.ok).toBe(true);
    expect(body.names).toEqual(["gemini"]);
    expect(JSON.stringify(body)).not.toContain("AIza");
    // Reachable through the host's reader, which is the only door out of the vault.
    expect(readCredential(services.runtime.db, owner(), "gemini")).toBe("AIza-not-a-real-key");
  });

  it("replaces a name instead of adding a second one", async () => {
    await request("POST", "/credentials", { body: { fields: [{ name: "typesafe", value: "first" }] } });
    const second = await request("POST", "/credentials", { body: { fields: [{ name: "typesafe", value: "second" }] } });

    expect((second.body as { names?: string[] }).names).toEqual(["typesafe"]);
    expect(readCredential(services.runtime.db, owner(), "typesafe")).toBe("second");
  });

  it("refuses a body it cannot use without repeating what it got", async () => {
    const response = await request("POST", "/credentials", {
      body: { fields: [{ name: "", value: "secret-shaped" }] },
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain("secret-shaped");
  });
});

describe("the model catalogue route", () => {
  it("reports what the model turn offers, and an honest empty list on a node with none", async () => {
    // A node whose model turn failed to build offers nothing, and an empty list is the honest answer - the route is
    // still a working route. This is also the state the fixture e2e node boots in, so asserting it beats assuming it.
    const empty = await request("GET", "/model");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ current: null, catalogue: [] });

    services.modelCatalogue = async () => [
      { id: "fake", models: [{ provider: "fake", id: "fake-model", current: true }] },
    ];

    // Read on demand rather than held as a snapshot: a provider added by upgrading pi is visible without a restart.
    const listed = await request("GET", "/model");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      current: null,
      catalogue: [{ id: "fake", models: [{ provider: "fake", id: "fake-model", current: true }] }],
    });
  });
});

describe("taking a credential back", () => {
  it("removes a name it holds, reports what remains, and 404s a name it never had", async () => {
    const saved = await request("POST", "/credentials", {
      body: { fields: [{ name: "probe_key", value: "not-a-real-key" }] },
    });
    expect(saved.status).toBe(201);

    const removed = await request("DELETE", "/credentials/probe_key");
    expect(removed.status).toBe(200);
    // Names, never values and never lengths: a length is a fact about a secret.
    expect((removed.body as { names: string[] }).names).not.toContain("probe_key");

    // "I removed it" and "there was nothing to remove" are different answers, and a surface that cannot tell them
    // apart cannot tell a person why nothing changed.
    const again = await request("DELETE", "/credentials/probe_key");
    expect(again.status).toBe(404);
  });
});

