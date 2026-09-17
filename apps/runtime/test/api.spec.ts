import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeIdSchema } from "@clarkcant/contracts";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
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
      body: { text: "cho tui xem biểu đồ" },
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
    await request("POST", `/conversations/${conversationId}/messages`, { body: { text: "cho tui xem bảng" } });
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
    await request("POST", `/conversations/${conversationId}/messages`, { body: { text: "cho tui xem biểu đồ" } });
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
