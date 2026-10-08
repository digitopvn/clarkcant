import { mkdtempSync, rmSync } from "node:fs";
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { DEFAULT_EXECUTION_POLICY_CONFIG, type Instant } from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, createInstance, pinInstance, writeRegisteredPreference } from "@clarkcant/core";
import { TABLE } from "@clarkcant/data-canvas";
import { appendMessage, getNotification, listArtifactsForConversation, listAuditEvents, nextMessageSequence, readCredential } from "@clarkcant/storage";

import { readClarkVersion } from "../../../tools/release/clark-version.mjs";
import { attachApiSocket, type ApiSocket } from "../src/api-socket.ts";
import { isWidgetArtifactWritePayload } from "../src/application/machine-artifact-writes.ts";
import { isWidgetPerformPayload } from "../src/application/widget-actions.ts";
import { recordNodeNotice } from "../src/notices.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { MCP_PROTOCOL_VERSIONS } from "../src/open-interfaces.ts";
import { handleMcpRoute } from "../src/routes/mcp.ts";
import { createNodeServer } from "../src/server.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The open interfaces, driven the way a third-party app drives them: real HTTP to a real server, a real WebSocket.
 *
 * What these prove is the property the surfaces exist for — that each one reaches the same gateway under the same
 * token — so every describe block has its refusal beside its success.
 */

let dir: string;
let services: NodeServices;
let server: Server;
let socket: ApiSocket;
let base: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-open-"));
  services = bootNodeServices({ dataDir: dir, label: "open interfaces" });
  server = createNodeServer({ services, origin: "http://127.0.0.1", onWarning: () => undefined });
  socket = attachApiSocket({ server, services });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  await socket.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

function token(): string {
  return services.runtime.identity.localToken;
}

async function mcp(body: unknown, authed = true): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authed ? { authorization: `Bearer ${token()}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: text === "" ? null : (JSON.parse(text) as unknown) };
}

describe("discovery", () => {
  it("describes every surface without a token and without the node's identity", async () => {
    const response = await fetch(`${base}/.well-known/clarkcant.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as { surfaces: Record<string, { endpoint?: string }> };
    expect(Object.keys(document.surfaces).sort()).toEqual(["api", "cli", "mcp", "websocket"]);
    expect(document.surfaces.mcp?.endpoint).toBe("/mcp");
    expect(document.surfaces.websocket?.endpoint).toBe("/ws");
    expect(JSON.stringify(document)).not.toContain(services.runtime.identity.nodeId);
    expect(JSON.stringify(document)).not.toContain(token());
  });

  it("tells a tool up front that a person's decisions are refused on the machine surfaces", async () => {
    const discovery = (await (await fetch(`${base}/.well-known/clarkcant.json`)).json()) as Record<string, unknown>;
    expect(discovery.personDecisions).toEqual({
      refusedOn: ["websocket", "mcp", "cli api"],
      refusal: { status: 403, code: "PERSON_ONLY" },
    });
  });

  it("serves an OpenAPI 3.1 document naming the stable routes", async () => {
    const response = await fetch(`${base}/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe("3.1.0");
    for (const path of [
      "/conversations",
      "/conversations/{conversationId}/messages",
      "/conversations/{conversationId}/messages/stream",
      "/conversations/{conversationId}/timeline",
      "/signals",
      "/signals/github",
      "/signals/webhook/{source}",
      "/automations",
      "/stop",
      "/conversations/{conversationId}/widgets/{instanceId}/jobs",
      "/conversations/{conversationId}/widgets/{instanceId}/jobs/{jobId}",
      "/conversations/{conversationId}/widgets/{instanceId}/browser-tokens",
      "/conversations/{conversationId}/widgets/{instanceId}/browser-tokens/{session}",
    ]) {
      expect(document.paths).toHaveProperty([path]);
    }
  });

  it("lists every refusal of a map tile, and says when its key refusal carries offline", async () => {
    const document = (await (await fetch(`${base}/openapi.json`)).json()) as {
      paths: Record<string, { get: { description: string; responses: Record<string, { description: string; content?: unknown }> } }>;
    };
    const tile = document.paths["/map-tiles/{z}/{x}/{y}"]?.get;
    expect(tile).toBeDefined();
    for (const code of [
      "404 MAP_TILES_OFF",
      "404 MAP_TILE_MISSING",
      "400 MAP_TILE_OUT_OF_BOUNDS",
      "429 MAP_TILES_RATE_LIMITED",
      "502 MAP_TILE_FAILED or MAP_TILE_REFUSED",
      "503 MAP_TILE_KEY_UNAVAILABLE",
    ]) {
      expect(tile?.description).toContain(code);
    }
    expect(tile?.description).toContain("when the key is in place but the node's secret store refuses to hand it over, the 503 has no offline");
    expect(tile?.description).toContain("whether the node finds that before asking the provider or while handing the key over");
    for (const [status, codes] of [
      ["400", ["MAP_TILE_OUT_OF_BOUNDS"]],
      ["404", ["MAP_TILES_OFF", "MAP_TILE_MISSING"]],
      ["429", ["MAP_TILES_RATE_LIMITED"]],
      ["502", ["MAP_TILE_FAILED", "MAP_TILE_REFUSED"]],
      ["503", ["MAP_TILE_KEY_UNAVAILABLE"]],
    ] as const) {
      for (const code of codes) expect(tile?.responses[status]?.description, status).toContain(code);
      expect(JSON.stringify(tile?.responses[status]?.content), status).toContain("#/components/schemas/Error");
    }
    expect(tile?.responses["503"]?.content).toEqual({
      "application/json": {
        schema: {
          allOf: [
            { $ref: "#/components/schemas/Error" },
            { properties: { offline: { type: "string", enum: ["key-unavailable", "key-origin-mismatch"] } } },
          ],
        },
      },
    });
  });

  it("lets a browser preflight carry the MCP headers", async () => {
    const response = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    expect(response.headers.get("access-control-allow-headers")).toContain("mcp-protocol-version");
  });
});

describe("MCP endpoint", () => {
  it("refuses a caller without the token, exactly as HTTP does", async () => {
    const answered = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, false);
    expect(answered.status).toBe(401);
  });

  it("negotiates a protocol version and lists the tools, with no approval tool among them", async () => {
    const initialized = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(initialized.status).toBe(200);
    // The server introduces itself as this build of Clark: the one canonical version, not a literal of its own.
    const clark = readClarkVersion(fileURLToPath(new URL("../../../", import.meta.url)));
    expect(initialized.body).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "clarkcant", version: clark } } });

    const unknownVersion = await mcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(unknownVersion.body).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSIONS[0] } });

    const listed = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const names = (listed.body as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "ask_clark",
        "list_conversations",
        "read_conversation",
        "answer_question",
        "stop_reply",
        "stop_all_work",
      ]),
    );
    expect(names.some((name) => name.includes("approv"))).toBe(false);
    // Installing a package is the person's too: no tool installs one or decides an install.
    expect(names.some((name) => name.includes("install") || name.includes("package"))).toBe(false);
    expect(
      (await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "install_package", arguments: { packageId: "com.example.x" } } })).body,
    ).toMatchObject({ error: { code: -32602 } });
  });

  it("acknowledges a notification with a bare 202", async () => {
    const answered = await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(answered.status).toBe(202);
    expect(answered.text).toBe("");
  });

  it("answers unknown methods and unknown tools as JSON-RPC errors", async () => {
    expect((await mcp({ jsonrpc: "2.0", id: 1, method: "resources/list" })).body).toMatchObject({ error: { code: -32601 } });
    expect(
      (await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "approve_everything", arguments: {} } })).body,
    ).toMatchObject({ error: { code: -32602 } });
  });

  it("asks Clark through the same conversation routes, and continues the conversation it returns", async () => {
    const asked = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_clark", arguments: { text: "hello Clark" } } });
    const result = (asked.body as { result: { isError?: boolean; structuredContent: { conversationId: string } } }).result;
    expect(result.isError).toBeUndefined();
    const conversationId = result.structuredContent.conversationId;
    expect(conversationId).toMatch(/^conv_/);

    const listed = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_conversations", arguments: {} } });
    expect(JSON.stringify(listed.body)).toContain(conversationId);

    const read = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_conversation", arguments: { conversationId } },
    });
    const text = (read.body as { result: { content: { text: string }[] } }).result.content[0]?.text ?? "";
    expect(text).toContain("hello Clark");
  });

  it("hands back a cursor that reads, as `after`, exactly the messages written since", async () => {
    type Read = { result: { content: { text: string }[]; structuredContent: { cursor: number; messages: unknown[] } } };
    const ask = async (text: string, conversationId?: string): Promise<string> => {
      const asked = await mcp({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ask_clark", arguments: { text, ...(conversationId === undefined ? {} : { conversationId }) } },
      });
      return (asked.body as { result: { structuredContent: { conversationId: string } } }).result.structuredContent.conversationId;
    };
    const read = async (conversationId: string, after?: number): Promise<Read["result"]> =>
      ((
        await mcp({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "read_conversation", arguments: { conversationId, ...(after === undefined ? {} : { after }) } },
        })
      ).body as Read).result;

    const conversationId = await ask("first question");
    await ask("second question", conversationId);
    const before = await read(conversationId);
    expect(before.structuredContent.messages).toHaveLength(4);
    // The cursor is a message position, not the event cursor, which runs ahead of it.
    expect(before.structuredContent.cursor).toBe(4);

    await ask("third question", conversationId);
    const since = await read(conversationId, before.structuredContent.cursor);
    expect(since.structuredContent.messages).toHaveLength(2);
    expect(since.content[0]?.text).toContain("third question");
    expect(since.content[0]?.text).not.toContain("second question");

    const nothingNew = await read(conversationId, since.structuredContent.cursor);
    expect(nothingNew.structuredContent.messages).toEqual([]);
    expect(nothingNew.structuredContent.cursor).toBe(since.structuredContent.cursor);
    expect(nothingNew.content[0]?.text).toBe("No messages after 6.");

    // A cursor past the newest message - a guess, or the event cursor this tool used to hand back - comes back as the
    // newest message, so the next message written is not skipped.
    let clamped = 0;
    for (const inflated of [18, 999_999]) {
      const stale = await read(conversationId, inflated);
      expect(stale.structuredContent.messages).toEqual([]);
      expect(stale.structuredContent.cursor).toBe(6);
      clamped = stale.structuredContent.cursor;
    }
    await ask("fourth question", conversationId);
    const afterStale = await read(conversationId, clamped);
    expect(afterStale.content[0]?.text).toContain("fourth question");
    expect(afterStale.structuredContent.cursor).toBe(8);
  });

  it("delivers a message stored while a stale cursor is being read, on the next read", async () => {
    const created = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_conversation", arguments: {} } });
    const conversationId = (created.body as { result: { structuredContent: { conversationId: string } } }).result.structuredContent
      .conversationId;
    const store = (content: string): void => {
      appendMessage(
        services.runtime.db,
        {
          messageId: services.conductor.newId("msg") as never,
          conversationId: conversationId as never,
          role: "user",
          blocks: [{ type: "text", format: "plain", content, streaming: false }],
          authorNodeId: services.runtime.identity.nodeId,
          createdAt: "2026-10-06T00:00:00.000Z" as never,
          delivery: "accepted",
        },
        nextMessageSequence(services.runtime.db, conversationId),
      );
    };
    store("already there");

    type Result = { result: { content: { text: string }[]; structuredContent: { cursor: number; messages: unknown[] } } };
    const gateway: GatewayDeps = { services, now: () => "2026-10-06T00:00:00.000Z", newConversationId: () => "conv_unused" };
    // The tool's reads go through this dispatch, so a message can be stored between its first timeline read and the next.
    let timelineReads = 0;
    const readThroughRace = async (after: number): Promise<Result["result"]> => {
      const answered = await handleMcpRoute({
        request: {
          method: "POST",
          path: "/mcp",
          query: {},
          headers: { authorization: `Bearer ${token()}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_conversation", arguments: { conversationId, after } } }),
        },
        dispatch: async (inner) => {
          const response = await handleRequest(gateway, inner);
          if (inner.path.endsWith("/timeline")) {
            timelineReads += 1;
            if (timelineReads === 1) store("stored between the reads");
          }
          return response;
        },
      });
      return (answered?.body as Result).result;
    };

    const stale = await readThroughRace(999_999);
    expect(stale.structuredContent.messages).toEqual([]);
    expect(stale.structuredContent.cursor).toBe(1);
    const next = await readThroughRace(stale.structuredContent.cursor);
    expect(next.content[0]?.text).toContain("stored between the reads");
    expect(next.structuredContent.cursor).toBe(2);
  });

  it("reads the newest messages of a long conversation when no cursor is given", async () => {
    const created = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_conversation", arguments: {} } });
    const conversationId = (created.body as { result: { structuredContent: { conversationId: string } } }).result.structuredContent
      .conversationId;
    // Longer than one page, so the first page ends far from the newest message.
    for (let index = 1; index <= 230; index += 1) {
      appendMessage(
        services.runtime.db,
        {
          messageId: services.conductor.newId("msg") as never,
          conversationId: conversationId as never,
          role: "user",
          blocks: [{ type: "text", format: "plain", content: `message ${String(index)}`, streaming: false }],
          authorNodeId: services.runtime.identity.nodeId,
          createdAt: "2026-10-06T00:00:00.000Z" as never,
          delivery: "accepted",
        },
        nextMessageSequence(services.runtime.db, conversationId),
      );
    }
    const read = await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_conversation", arguments: { conversationId } },
    });
    type Result = { result: { content: { text: string }[]; structuredContent: { cursor: number; hasNewer: boolean; messages: unknown[] } } };
    const result = (read.body as Result).result;
    expect(result.content[0]?.text).toContain("message 230");
    expect(result.content[0]?.text).not.toContain("message 1\n");
    expect(result.structuredContent).toMatchObject({ cursor: 230, hasNewer: false });

    // Reading forward from the start says when more is left, and the cursor reads exactly the rest.
    const page = async (after: number) =>
      ((await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_conversation", arguments: { conversationId, after } } }))
        .body as Result).result.structuredContent;
    const first = await page(0);
    expect(first).toMatchObject({ cursor: 200, hasNewer: true });
    expect(first.messages).toHaveLength(200);
    const rest = await page(first.cursor);
    expect(rest).toMatchObject({ cursor: 230, hasNewer: false });
    expect(rest.messages).toHaveLength(30);
  });

  it("stops one conversation's reply through the same route as the Stop button, and says when there was none", async () => {
    const asked = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_clark", arguments: { text: "hi" } } });
    const conversationId = (asked.body as { result: { structuredContent: { conversationId: string } } }).result
      .structuredContent.conversationId;

    // The reply above has already ended, so the honest answer is that nothing was stopped.
    const stopped = await mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "stop_reply", arguments: { conversationId } },
    });
    expect(stopped.body).toMatchObject({ result: { structuredContent: { stopped: false } } });

    const missing = await mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "stop_reply", arguments: { conversationId: "conv_missing" } },
    });
    expect(missing.body).toMatchObject({ result: { isError: true } });
  });

  it("passes a route's refusal back as a tool error in the route's own words", async () => {
    const read = await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_conversation", arguments: { conversationId: "conv_missing" } },
    });
    expect(read.body).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(read.body)).toContain("RESOURCE_NOT_FOUND");
  });

  it("refuses an empty batch, an oversized batch and an id that is not a string or a number", async () => {
    const empty = await mcp([]);
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({ error: { code: -32600 } });

    const oversized = await mcp(Array.from({ length: 33 }, (_, index) => ({ jsonrpc: "2.0", id: index, method: "ping" })));
    expect(oversized.body).toMatchObject({ error: { code: -32600 } });

    expect((await mcp({ jsonrpc: "2.0", id: { nested: true }, method: "ping" })).body).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it("offers confirmed on answer_question and refuses a conversationId that is not a string", async () => {
    const listed = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const answer = (listed.body as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } }).result.tools.find(
      (tool) => tool.name === "answer_question",
    );
    expect(answer?.inputSchema.properties.confirmed).toEqual({ type: "boolean" });

    const asked = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask_clark", arguments: { text: "hi", conversationId: 7 } } });
    expect(asked.body).toMatchObject({ result: { isError: true } });
    // Refused before any route ran, so no conversation was started by accident.
    const conversations = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_conversations", arguments: {} } });
    expect(JSON.stringify(conversations.body)).not.toContain("conv_");
  });

  it("reads the inbox and acts on a notice through the inbox's own route, but never gives the person's answer about an effect", async () => {
    const { notificationId } = recordNodeNotice(services, {
      sourceKind: "background",
      category: "result",
      severity: "success",
      title: "Việc nền đã xong",
      dedupKey: "background:bg_mcp",
      at: new Date().toISOString() as Instant,
    });
    const tool = (id: number, name: string, args: Record<string, unknown>) =>
      mcp({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

    const read = await tool(1, "read_inbox", {});
    expect(JSON.stringify(read.body)).toContain(notificationId);

    const dismissed = await tool(2, "act_on_notice", { noticeId: notificationId, action: "dismiss" });
    expect(dismissed.body).toMatchObject({
      result: { structuredContent: { noticeId: notificationId, action: "dismiss", outcome: "done" } },
    });
    expect(getNotification(services.runtime.db, services.runtime.identity.ownerPrincipalId, notificationId)?.dismissed).toBe(true);

    const stale = await tool(3, "act_on_notice", { noticeId: notificationId, action: "dismiss" });
    expect(stale.body).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(stale.body)).toContain("RESOURCE_NOT_FOUND");

    const answer = await tool(4, "act_on_notice", { noticeId: notificationId, action: "reconcile-confirmed" });
    expect(answer.body).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(answer.body)).toContain("PERSON_ONLY");

    expect((await tool(5, "act_on_notice", { action: "dismiss" })).body).toMatchObject({ result: { isError: true } });

    // Installing an update is the person's: not offered, and refused with the reason when named anyway.
    const listedTools = await mcp({ jsonrpc: "2.0", id: 6, method: "tools/list" });
    const actTool = (listedTools.body as { result: { tools: { name: string; inputSchema: { properties: { action?: { enum?: string[] } } } }[] } }).result.tools.find(
      (entry) => entry.name === "act_on_notice",
    );
    expect(actTool?.inputSchema.properties.action?.enum).toContain("restore");
    expect(actTool?.inputSchema.properties.action?.enum).not.toContain("update");
    const update = await tool(7, "act_on_notice", { noticeId: notificationId, action: "update" });
    expect(update.body).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(update.body)).toContain("PERSON_ONLY");
    expect(JSON.stringify(update.body)).toContain("press Update");

    // The dismissal above can be undone from here too, within its window.
    const restored = await tool(8, "act_on_notice", { noticeId: notificationId, action: "restore" });
    expect(restored.body).toMatchObject({ result: { structuredContent: { noticeId: notificationId, action: "restore", outcome: "done" } } });
    expect(getNotification(services.runtime.db, services.runtime.identity.ownerPrincipalId, notificationId)?.dismissed).toBe(false);
  });

  it("does not accept GET, because the server never speaks first", async () => {
    const response = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token()}` } });
    expect(response.status).toBe(405);
  });
});

/** A socket with a queue of the frames it has received, so a test can wait for the next one. */
async function openSocket(): Promise<{ send: (frame: unknown) => void; next: () => Promise<Record<string, unknown>>; close: () => void; closed: Promise<number> }> {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  const frames: Record<string, unknown>[] = [];
  const waiting: ((frame: Record<string, unknown>) => void)[] = [];
  ws.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiting.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: () => {
      const queued = frames.shift();
      return queued ? Promise.resolve(queued) : new Promise((resolve) => waiting.push(resolve));
    },
    close: () => ws.close(),
    closed,
  };
}

describe("WebSocket gateway", () => {
  it("closes a socket whose first frame is not a valid token", async () => {
    const client = await openSocket();
    client.send({ type: "auth", token: "wrong" });
    expect(await client.next()).toMatchObject({ type: "error", code: "UNAUTHENTICATED" });
    expect(await client.closed).toBe(4401);
  });

  it("closes an unauthenticated socket whose first frame is not even a JSON object", async () => {
    const client = await openSocket();
    client.send("not a frame");
    expect(await client.next()).toMatchObject({ type: "error", code: "UNAUTHENTICATED" });
    expect(await client.closed).toBe(4401);
  });

  it("does not relay an approval decision, which is the person's to make", async () => {
    const client = await openSocket();
    client.send({ type: "auth", token: token() });
    await client.next();
    client.send({ type: "request", id: "d", method: "POST", path: "/conversations/conv_x/approvals/appr_y/decide", body: { decision: "granted", digest: "z" } });
    expect(await client.next()).toMatchObject({ type: "response", id: "d", status: 403, body: { code: "PERSON_ONLY" } });
    client.send({ type: "request", id: "p", method: "POST", path: "/packages/approvals/appr_y/decision", body: {} });
    expect(await client.next()).toMatchObject({ type: "response", id: "p", status: 403, body: { code: "PERSON_ONLY" } });
    client.close();
  });

  it("does not relay a grant, an app-intent confirmation, a peer's trust or a file export either, under any spelling", async () => {
    const client = await openSocket();
    client.send({ type: "auth", token: token() });
    await client.next();
    const decisions = [
      "/app-intents/confirm",
      // The screen's report on an agent's app-control action: a machine surface forging it could tell the
      // model the screen changed when it did not.
      "/app-intents/host-control/ctl_x",
      // The screen's report on what a widget did when Clark asked it: forged, it would tell the model a widget acted.
      "/app-intents/widget-perform/perform_x",
      "/peers/node_x/confirm",
      "/grants",
      // A running task's approval has no card, but deciding it is the same person's decision.
      "/tasks/task_x/approvals/appr_x/decide",
      // The gateway drops empty segments, so a doubled slash reaches the same route and is refused the same way.
      "//conversations//conv_x/approvals/appr_x/decide/",
      // A table's CSV is a whole dataset handed over as a file; it is downloaded by the person, not by a relay.
      "/conversations/conv_x/widgets/winst_x/export",
      // Saying an unknown effect took effect would let an AI client clear its own task's uncertainty.
      "/effects/eff_x/reconcile",
      "//effects//eff_x/reconcile/",
      // Save As writes an artifact onto the person's machine; picking a file grants a widget bytes. Both the person's.
      "/artifacts/art_x/export",
      "//artifacts//art_x/export/",
      "/conversations/conv_x/widgets/winst_x/artifacts/pick",
      // Installing a package puts new code on the machine and grants it what its manifest asks for.
      "/packages/install",
      "//packages//install/",
      "/packages/install?packageId=com.example.x",
      // A widget dev session installs a folder's package, and so do its rebuild and placement.
      "/widget-dev/sessions",
      "//widget-dev//sessions/",
      "/widget-dev/sessions/wdev_x/rebuild",
      "/widget-dev/sessions/wdev_x/place",
      // Taking back which folders Clark may develop in is the person's, as choosing them is.
      "/widget-dev/chosen-folders/forget",
      "//widget-dev//chosen-folders//forget/",
      "/conversations/conv_x/delete",
      "//conversations//conv_x//delete/?ignored=1",
    ];
    for (const [index, path] of decisions.entries()) {
      client.send({ type: "request", id: index, method: "POST", path, body: {} });
      expect(await client.next()).toMatchObject({ type: "response", id: index, status: 403, body: { code: "PERSON_ONLY" } });
    }
    // Stop stays reachable: refusing decisions must not take away the way to end work.
    client.send({ type: "request", id: 99, method: "POST", path: "/stop" });
    expect(await client.next()).toMatchObject({ type: "response", id: 99, status: 200 });
    client.close();
  });

  it("does not relay the map tile policy's write, its undo, or its key, and leaves them as they were", async () => {
    const client = await openSocket();
    client.send({ type: "auth", token: token() });
    await client.next();
    const provider = { origin: "https://evil.example", template: "/{z}/{x}/{y}.png", attribution: "x", maxZoom: 3 };
    const refused: [string, string, unknown][] = [
      ["PUT", "/preferences/maps.tilePolicy", { value: provider }],
      ["PUT", "//preferences//maps.tilePolicy/", { value: provider }],
      ["POST", "/preferences/maps.tilePolicy/undo", {}],
      ["PUT", "/map-tiles/key", { origin: "https://evil.example", value: "relayed-key" }],
      ["DELETE", "//map-tiles//key/", undefined],
    ];
    for (const [index, [method, path, body]] of refused.entries()) {
      client.send({ type: "request", id: index, method, path, ...(body === undefined ? {} : { body }) });
      expect(await client.next(), `${method} ${path}`).toMatchObject({ type: "response", id: index, status: 403, body: { code: "PERSON_ONLY" } });
    }
    // Reading them stays reachable, and shows nothing changed.
    client.send({ type: "request", id: "policy", method: "GET", path: "/map-tiles" });
    expect(await client.next()).toMatchObject({ type: "response", id: "policy", status: 200, body: { provider: null, offline: "no-provider" } });
    client.send({ type: "request", id: "key", method: "GET", path: "/map-tiles/key" });
    expect(await client.next()).toMatchObject({ type: "response", id: "key", status: 200, body: { key: null } });
    client.close();
  });

  it("does not relay storing or removing a credential, says it was the relay that refused, and leaves the key as it was", async () => {
    const owner = services.runtime.identity.ownerPrincipalId;
    const saved = await fetch(`${base}/credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: [{ name: "typesafe", value: "persons-key" }] }),
    });
    expect(saved.status).toBe(201);
    const client = await openSocket();
    client.send({ type: "auth", token: token() });
    await client.next();
    const refused: [string, string, unknown][] = [
      ["DELETE", "/credentials/typesafe", undefined],
      ["DELETE", "//credentials//typesafe/", undefined],
      ["POST", "/credentials", { fields: [{ name: "typesafe", value: "relayed-key" }] }],
      ["PUT", "/credentials", { fields: [{ name: "gemini", value: "relayed-key" }] }],
    ];
    for (const [index, [method, path, body]] of refused.entries()) {
      client.send({ type: "request", id: index, method, path, ...(body === undefined ? {} : { body }) });
      const frame = await client.next();
      expect(frame, `${method} ${path}`).toMatchObject({ type: "response", id: index, status: 403, body: { code: "PERSON_ONLY", surface: "relay" } });
      const message = (frame.body as { message: string }).message;
      expect(message).toContain("WebSocket relay");
      expect(message).toContain("person");
      expect(message).not.toContain("relayed-key");
    }
    client.close();
    expect(readCredential(services.runtime.db, owner, "typesafe")).toBe("persons-key");
    expect(readCredential(services.runtime.db, owner, "gemini")).toBeUndefined();
  });

  it("echoes a numeric id as a number", async () => {
    const client = await openSocket();
    client.send({ type: "auth", token: token() });
    await client.next();
    client.send({ type: "request", id: 7, method: "GET", path: "/node" });
    expect((await client.next()).id).toBe(7);
    client.close();
  });

  it("answers a request frame with the gateway's own response", async () => {
    const client = await openSocket();
    client.send({ type: "auth", token: token() });
    expect(await client.next()).toMatchObject({ type: "ready", protocol: "clarkcant.ws.v1" });

    client.send({ type: "request", id: "a", method: "POST", path: "/conversations", body: { title: "over ws" } });
    const created = await client.next();
    expect(created).toMatchObject({ type: "response", id: "a", status: 201 });

    client.send({ type: "request", id: "b", method: "GET", path: "/conversations/conv_missing/timeline" });
    expect(await client.next()).toMatchObject({ type: "response", id: "b", status: 404, body: { code: "RESOURCE_NOT_FOUND" } });

    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    client.close();
  });

  it("relays a streamed answer as event frames, then a final response", async () => {
    const client = await openSocket();
    client.send({ type: "auth", token: token() });
    await client.next();
    client.send({ type: "request", id: "c", method: "POST", path: "/conversations", body: {} });
    const conversationId = ((await client.next()).body as { conversationId: string }).conversationId;

    client.send({ type: "request", id: "s", method: "POST", path: `/conversations/${conversationId}/messages/stream`, body: { text: "hi" } });
    const events: Record<string, unknown>[] = [];
    for (;;) {
      const frame = await client.next();
      expect(frame.id).toBe("s");
      if (frame.type === "response") {
        expect(frame).toMatchObject({ status: 200, body: null });
        break;
      }
      events.push(frame);
    }
    expect(events.at(-1)).toMatchObject({ type: "event", event: "done" });
    client.close();
  });

  it("refuses a malformed request frame without closing the socket", async () => {
    const client = await openSocket();
    client.send({ type: "auth", token: token() });
    await client.next();
    client.send({ type: "request", id: "x", method: "TRACE", path: "/node" });
    expect(await client.next()).toMatchObject({ type: "error", id: "x", code: "INVALID_FRAME" });
    client.send({ type: "request", id: "y", method: "GET", path: "/node" });
    expect(await client.next()).toMatchObject({ type: "response", id: "y", status: 200 });
    client.close();
  });
});

/**
 * A widget instance's artifact writes, carried by a machine surface (#355).
 *
 * The owner's decision: a relay, an MCP client or `clarkcant api` may write as a widget only through the execution
 * policy, and every such write is audited. The person's own app is unchanged.
 */
describe("widget artifact writes on machine surfaces", () => {
  const TEXT = "ghi chú của widget\n";
  const SECRET_TEXT = "nội dung không được vào nhật ký";

  function setPolicy(value: Record<string, unknown>): void {
    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => new Date().toISOString() as Instant },
      {
        principalId: services.runtime.identity.ownerPrincipalId,
        key: EXECUTION_POLICY_PREFERENCE_KEY,
        value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, ...value },
        source: "user",
      },
    );
    if (!written.ok) throw new Error(written.message);
  }

  async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** A conversation holding one widget instance, and the instance's artifact route. */
  async function widget(): Promise<{ conversationId: string; route: string }> {
    const created = await http("POST", "/conversations", { title: "tệp widget" });
    const conversationId = created.body.conversationId as string;
    const instanceId = createInstance(services.conductor, {
      definition: TABLE,
      packageDigest: "sha256:table",
      ownerPrincipalId: services.runtime.identity.ownerPrincipalId as never,
      props: { title: "Tệp", datasetRef: "dataset_none", columns: ["name"] },
    }).instanceId;
    expect(pinInstance(services.conductor, { conversationId, instanceId, displayMode: "compact", maxPins: 64 }).ok).toBe(true);
    return { conversationId, route: `/conversations/${conversationId}/widgets/${instanceId}/artifacts` };
  }

  async function relayed(): Promise<{ request: (method: string, path: string, body?: unknown, extra?: Record<string, unknown>) => Promise<Record<string, unknown>>; close: () => void }> {
    const client = await openSocket();
    client.send({ type: "auth", token: token() });
    await client.next();
    let id = 0;
    return {
      request: async (method, path, body, extra = {}) => {
        id += 1;
        client.send({ type: "request", id, method, path, ...(body === undefined ? {} : { body }), ...extra });
        return client.next();
      },
      close: () => client.close(),
    };
  }

  function artifactAudit(): { summary: string; outcome: string; ref?: string }[] {
    return listAuditEvents(services.runtime.db, services.runtime.identity.ownerPrincipalId)
      .filter((event) => event.kind === "widget-artifact")
      .reverse();
  }

  const MCP = { "x-clarkcant-surface": "mcp" };

  async function blocksOf(conversationId: string): Promise<Record<string, unknown>[]> {
    const timeline = await http("GET", `/conversations/${conversationId}/timeline`);
    return (timeline.body.messages as { blocks: Record<string, unknown>[] }[]).flatMap((message) => message.blocks);
  }

  async function cardOf(conversationId: string, approvalId: string): Promise<Record<string, unknown> | undefined> {
    return (await blocksOf(conversationId)).find((block) => block.type === "approval-card" && block.approvalId === approvalId);
  }

  /** The person deciding on their own surface, with the digest the card showed them. */
  async function decide(conversationId: string, approvalId: string, decision = "granted"): Promise<{ status: number; body: Record<string, unknown> }> {
    const card = await cardOf(conversationId, approvalId);
    return http("POST", `/conversations/${conversationId}/approvals/${approvalId}/decide`, { decision, digest: card?.operationDigest });
  }

  function receiptOf(blocks: Record<string, unknown>[], approvalId: string): Record<string, unknown> | undefined {
    return blocks.find(
      (block) => block.type === "tool-activity" && block.name === "widget_artifact_write" && (block.args as { approvalId?: string } | undefined)?.approvalId === approvalId,
    );
  }

  function approvalOf(body: unknown): string {
    return (body as { approvalRequired: { approvalId: string } }).approvalRequired.approvalId;
  }

  function artifactIdOf(body: unknown): string {
    return (body as { artifactRef: { artifactId: string } }).artifactRef.artifactId;
  }

  function chunk(text: string, offset = 0): { offset: number; contentBase64: string } {
    return { offset, contentBase64: Buffer.from(text).toString("base64") };
  }

  it("runs a relay's writes under Autonomous, audits each without the bytes, and asks before deleting a finished file", async () => {
    const { conversationId, route } = await widget();
    const relay = await relayed();

    const created = await relay.request("POST", route, { mimeType: "text/plain", name: "ghi-chu.txt" });
    expect(created).toMatchObject({ type: "response", status: 201 });
    const artifactId = artifactIdOf(created.body);
    const body = chunk(TEXT + SECRET_TEXT);
    expect(await relay.request("POST", `${route}/${artifactId}/chunks`, body)).toMatchObject({ status: 200 });
    expect(await relay.request("POST", `${route}/${artifactId}/finalize`)).toMatchObject({ status: 200 });
    expect(await relay.request("POST", `${route}/${artifactId}/attach`, {})).toMatchObject({ status: 201 });

    // A finished file may be the person's only copy: deleting it is destructive, so it is asked about even here.
    const asked = await relay.request("DELETE", `${route}/${artifactId}`);
    expect(asked).toMatchObject({ status: 202, body: { outcome: "approval-required", operation: "discard" } });
    expect(await cardOf(conversationId, approvalOf(asked.body))).toMatchObject({ effectCategory: "destructive", decision: "pending" });
    expect(listArtifactsForConversation(services.runtime.db, conversationId).map((artifact) => artifact.artifactId)).toContain(artifactId);

    // An unfinished file the same relay started is its own to drop.
    const scratch = await relay.request("POST", route, { mimeType: "text/plain" });
    const scratchId = artifactIdOf(scratch.body);
    expect(await relay.request("DELETE", `${route}/${scratchId}`)).toMatchObject({ status: 200, body: { discarded: true, artifactId: scratchId } });
    relay.close();

    const audit = artifactAudit();
    expect(audit.map((event) => /\(relay, (\w+)\)/.exec(event.summary)?.[1])).toEqual(["create", "write", "finalize", "attach", "discard", "create", "discard"]);
    expect(audit.map((event) => event.outcome)).toEqual(["done", "done", "done", "done", "pending", "done", "done"]);
    expect(audit[4]?.summary).toContain("destructive");
    expect(audit[6]?.summary).toContain("run by the execution policy (autonomous, local-write");
    for (const event of audit) {
      expect(event.summary).not.toContain(SECRET_TEXT);
      expect(event.summary).not.toContain(body.contentBase64);
    }
    // The activity stream shows each write the policy ran, once the broker accepted it.
    const activity = services.runtime.db
      .prepare("SELECT count(*) AS n FROM events WHERE kind = 'effect.executed' AND conversation_id = ?")
      .get(conversationId) as { n: number };
    expect(activity.n).toBe(6);
  });

  it("asks before deleting a finished file, or one another client started, under Guarded too", async () => {
    setPolicy({ mode: "guarded" });
    const { route } = await widget();
    const fromApp = artifactIdOf((await http("POST", route, { mimeType: "text/plain" })).body);
    const asked = await http("DELETE", `${route}/${fromApp}`, undefined, MCP);
    expect(asked).toMatchObject({ status: 202, body: { operation: "discard" } });
    // Deleting a local widget file does not reach past this machine, and the caller is told what it is instead.
    expect(asked.body.message).not.toContain("reaches past this machine");
    expect(asked.body.message).toContain("no other copy");

    const finished = artifactIdOf((await http("POST", route, { mimeType: "text/plain" }, MCP)).body);
    expect((await http("POST", `${route}/${finished}/finalize`, {}, MCP)).status).toBe(200);
    expect(await http("DELETE", `${route}/${finished}`, undefined, MCP)).toMatchObject({ status: 202 });

    const started = artifactIdOf((await http("POST", route, { mimeType: "text/plain" }, MCP)).body);
    expect(await http("DELETE", `${route}/${started}`, undefined, { "x-clarkcant-surface": "cli-api" })).toMatchObject({ status: 202 });
    expect(await http("DELETE", `${route}/${started}`, undefined, MCP)).toMatchObject({ status: 200 });
  });

  it("asks once per file under Ask every time, keeps bytes off the card, and lets the approved file be written and finished", async () => {
    setPolicy({ mode: "ask" });
    const { conversationId, route } = await widget();
    const relay = await relayed();

    const asked = await relay.request("POST", route, { mimeType: "text/plain", name: "ghi-chu.txt" });
    expect(asked).toMatchObject({ status: 202, body: { outcome: "approval-required", operation: "create" } });
    const approvalId = approvalOf(asked.body);
    expect(listArtifactsForConversation(services.runtime.db, conversationId)).toEqual([]);
    const card = await cardOf(conversationId, approvalId);
    expect(card).toMatchObject({ owner: "host", approvalId, effectCategory: "local-write", decision: "pending" });
    expect(card?.operationDescription).toContain("Một client qua WebSocket relay muốn tạo một tệp text/plain");

    // The client that asked cannot decide its own request.
    expect(
      await relay.request("POST", `/conversations/${conversationId}/approvals/${approvalId}/decide`, { decision: "granted", digest: card?.operationDigest }),
    ).toMatchObject({ status: 403, body: { code: "PERSON_ONLY" } });
    expect(artifactAudit().map((event) => event.outcome)).toEqual(["pending"]);

    // The person approves the file, once.
    const decided = await decide(conversationId, approvalId);
    expect(decided.status).toBe(200);
    const made = listArtifactsForConversation(services.runtime.db, conversationId);
    expect(made).toHaveLength(1);
    const artifactId = made[0]?.artifactId ?? "";
    expect(receiptOf(await blocksOf(conversationId), approvalId)).toMatchObject({
      status: "done",
      args: { approvalId, decision: "granted", operation: "create", artifactId },
    });

    // Its chunks, one far past what any card could hold, and its finalize run under that one approval, each audited.
    const large = Buffer.alloc(48_000, 65);
    expect(await relay.request("POST", `${route}/${artifactId}/chunks`, { offset: 0, contentBase64: large.toString("base64") })).toMatchObject({ status: 200 });
    const secret = chunk(SECRET_TEXT, large.byteLength);
    expect(await relay.request("POST", `${route}/${artifactId}/chunks`, secret)).toMatchObject({ status: 200 });
    expect(await relay.request("POST", `${route}/${artifactId}/finalize`)).toMatchObject({ status: 200 });
    expect(artifactAudit().filter((event) => event.summary.includes(`covered by the person's approval on card ${approvalId}`))).toHaveLength(3);

    // The finalize ended that right: a later chunk is not covered, and the broker refuses it before any card.
    const after = await relay.request("POST", `${route}/${artifactId}/chunks`, chunk(TEXT, large.byteLength + Buffer.byteLength(SECRET_TEXT)));
    expect(after.status).toBeGreaterThanOrEqual(400);

    // Attaching and deleting are each the person's to decide on their own card.
    const attach = await relay.request("POST", `${route}/${artifactId}/attach`, {});
    expect(attach).toMatchObject({ status: 202, body: { operation: "attach" } });
    expect((await decide(conversationId, approvalOf(attach.body))).status).toBe(200);
    expect(receiptOf(await blocksOf(conversationId), approvalOf(attach.body))).toMatchObject({ status: "done", args: { operation: "attach", artifactId } });

    const discard = await relay.request("DELETE", `${route}/${artifactId}`);
    expect(discard).toMatchObject({ status: 202, body: { operation: "discard" } });
    expect(await cardOf(conversationId, approvalOf(discard.body))).toMatchObject({ effectCategory: "destructive" });
    expect((await decide(conversationId, approvalOf(discard.body))).status).toBe(200);
    expect(listArtifactsForConversation(services.runtime.db, conversationId).map((artifact) => artifact.artifactId)).not.toContain(artifactId);
    relay.close();

    // No byte that was written is anywhere in the conversation.
    const everything = JSON.stringify(await blocksOf(conversationId));
    expect(everything).not.toContain(SECRET_TEXT);
    expect(everything).not.toContain(secret.contentBase64);
    expect(everything).not.toContain(large.toString("base64").slice(0, 64));
    expect(everything).not.toContain("contentBase64");
  });

  it("asks for write access to a file the widget started, and the approval covers the file rather than a stale chunk", async () => {
    setPolicy({ mode: "ask" });
    const { conversationId, route } = await widget();
    const artifactId = artifactIdOf((await http("POST", route, { mimeType: "text/plain" })).body);

    const asked = await http("POST", `${route}/${artifactId}/chunks`, chunk(TEXT), MCP);
    expect(asked).toMatchObject({ status: 202, body: { operation: "write" } });
    const approvalId = approvalOf(asked.body);
    const card = await cardOf(conversationId, approvalId);
    expect(card?.payload).not.toContain("contentBase64");
    expect(card?.payload).not.toContain("offset");

    // The widget writes before the person decides.
    expect((await http("POST", `${route}/${artifactId}/chunks`, chunk(TEXT))).status).toBe(200);
    expect((await decide(conversationId, approvalId)).status).toBe(200);
    expect(receiptOf(await blocksOf(conversationId), approvalId)).toMatchObject({ status: "done", args: { operation: "write", artifactId } });

    // The chunk the client first sent no longer follows the file: refused, never stored twice.
    expect(await http("POST", `${route}/${artifactId}/chunks`, chunk(TEXT), MCP)).toMatchObject({ status: 409, body: { code: "ARTIFACT_OFFSET_MISMATCH" } });
    expect(artifactAudit().at(-1)?.summary).toContain("refused by the broker with ARTIFACT_OFFSET_MISMATCH");
    expect((await http("POST", `${route}/${artifactId}/chunks`, chunk(TEXT, Buffer.byteLength(TEXT)), MCP)).status).toBe(200);
    expect(listArtifactsForConversation(services.runtime.db, conversationId)[0]?.sizeBytes).toBe(Buffer.byteLength(TEXT) * 2);
  });

  it("holds an approved file's write right for that relay connection alone, in that conversation, until it expires", async () => {
    setPolicy({ mode: "ask" });
    const { conversationId, route } = await widget();
    const instanceId = route.split("/")[4] ?? "";
    const asker = await relayed();
    const sibling = await relayed();

    const asked = await asker.request("POST", route, { mimeType: "text/plain" });
    const approvalId = approvalOf(asked.body);
    // The card names who the right goes to before the person approves it, and the receipt says it again.
    expect((await cardOf(conversationId, approvalId))?.operationDescription).toContain("chỉ kết nối WebSocket relay đó được ghi và hoàn tất");
    expect((await decide(conversationId, approvalId)).status).toBe(200);
    const receipt = receiptOf(await blocksOf(conversationId), approvalId);
    expect(receipt?.label).toContain("chỉ kết nối WebSocket relay đó được ghi và hoàn tất tệp này");
    const artifactId = (receipt?.args as { artifactId: string }).artifactId;

    // Another relay connection, MCP and clarkcant api are each asked, not let through on the asker's right.
    expect(await sibling.request("POST", `${route}/${artifactId}/chunks`, chunk(TEXT))).toMatchObject({ status: 202, body: { operation: "write" } });
    expect(await http("POST", `${route}/${artifactId}/chunks`, chunk(TEXT), MCP)).toMatchObject({ status: 202 });
    expect(await http("POST", `${route}/${artifactId}/chunks`, chunk(TEXT), { "x-clarkcant-surface": "cli-api" })).toMatchObject({ status: 202 });
    // A plain HTTP caller naming the relay, even with a connection id of its own, is not the asker either.
    expect(
      await http("POST", `${route}/${artifactId}/chunks`, chunk(TEXT), { "x-clarkcant-surface": "relay", "x-clarkcant-surface-connection": "00000000-0000-4000-8000-000000000000" }),
    ).toMatchObject({ status: 202 });

    // Nor does the right reach another file of the same widget, or the same widget pinned in another conversation.
    const other = artifactIdOf((await http("POST", route, { mimeType: "text/plain" })).body);
    expect(await asker.request("POST", `${route}/${other}/chunks`, chunk(TEXT))).toMatchObject({ status: 202 });
    const elsewhere = (await http("POST", "/conversations", { title: "nơi khác" })).body.conversationId as string;
    expect(pinInstance(services.conductor, { conversationId: elsewhere, instanceId, displayMode: "compact", maxPins: 64 }).ok).toBe(true);
    expect(await asker.request("POST", `/conversations/${elsewhere}/widgets/${instanceId}/artifacts/${artifactId}/chunks`, chunk(TEXT))).toMatchObject({ status: 202 });
    // Nor another widget instance, whose share does not hold the file at all.
    const { route: otherRoute } = await widget();
    expect((await asker.request("POST", `${otherRoute}/${artifactId}/chunks`, chunk(TEXT))).status).not.toBe(200);

    // The asker itself writes under it.
    expect(await asker.request("POST", `${route}/${artifactId}/chunks`, chunk(TEXT))).toMatchObject({ status: 200 });

    // Past the right's 15 minutes, the asker is asked again.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 16 * 60_000);
      expect(await asker.request("POST", `${route}/${artifactId}/chunks`, chunk(TEXT, Buffer.byteLength(TEXT)))).toMatchObject({ status: 202 });
    } finally {
      vi.useRealTimers();
    }
    asker.close();
    sibling.close();
    expect(listArtifactsForConversation(services.runtime.db, conversationId).find((artifact) => artifact.artifactId === artifactId)?.sizeBytes).toBe(
      Buffer.byteLength(TEXT),
    );
  });

  it("ends the write right on a discard, and treats a file another connection started as not the asker's to drop", async () => {
    setPolicy({ mode: "ask" });
    const { conversationId, route } = await widget();
    const asker = await relayed();
    const sibling = await relayed();
    const asked = await asker.request("POST", route, { mimeType: "text/plain" });
    expect((await decide(conversationId, approvalOf(asked.body))).status).toBe(200);
    const artifactId = (receiptOf(await blocksOf(conversationId), approvalOf(asked.body))?.args as { artifactId: string }).artifactId;
    expect(await asker.request("POST", `${route}/${artifactId}/chunks`, chunk(TEXT))).toMatchObject({ status: 200 });

    // Another connection dropping it would delete what it did not start: destructive, and worded for what it is.
    const foreign = await sibling.request("DELETE", `${route}/${artifactId}`);
    expect(foreign).toMatchObject({ status: 202, body: { operation: "discard" } });
    expect((foreign.body as { message: string }).message).not.toContain("reaches past this machine");
    expect((foreign.body as { message: string }).message).toContain("ask every time");
    expect(await cardOf(conversationId, approvalOf(foreign.body))).toMatchObject({ effectCategory: "destructive" });

    // The asker's own discard of its unfinished file is a local write, which Ask every time still asks about.
    const own = await asker.request("DELETE", `${route}/${artifactId}`);
    expect(own).toMatchObject({ status: 202 });
    const ownCard = await cardOf(conversationId, approvalOf(own.body));
    expect(ownCard).toMatchObject({ effectCategory: "local-write" });
    expect(ownCard?.operationDescription).toContain("do chính kết nối này bắt đầu");
    expect((await decide(conversationId, approvalOf(own.body))).status).toBe(200);
    expect(listArtifactsForConversation(services.runtime.db, conversationId)).toEqual([]);

    // The right went with the file: the next chunk is not covered by it.
    const coveredBefore = artifactAudit().filter((event) => event.summary.includes("covered by the person's approval")).length;
    expect((await asker.request("POST", `${route}/${artifactId}/chunks`, chunk(TEXT, Buffer.byteLength(TEXT)))).status).not.toBe(200);
    expect(artifactAudit().filter((event) => event.summary.includes("covered by the person's approval"))).toHaveLength(coveredBefore);
    asker.close();
    sibling.close();
  });

  it("refuses an approved discard as stale when the file was finished after its card was shown", async () => {
    setPolicy({ mode: "ask" });
    const { conversationId, route } = await widget();
    const relay = await relayed();
    const asked = await relay.request("POST", route, { mimeType: "text/plain" });
    expect((await decide(conversationId, approvalOf(asked.body))).status).toBe(200);
    const artifactId = (receiptOf(await blocksOf(conversationId), approvalOf(asked.body))?.args as { artifactId: string }).artifactId;

    const discard = await relay.request("DELETE", `${route}/${artifactId}`);
    expect(await cardOf(conversationId, approvalOf(discard.body))).toMatchObject({ effectCategory: "local-write" });
    // The person's app finishes the file before the card is decided: deleting it now would take a finished file.
    expect((await http("POST", `${route}/${artifactId}/finalize`, {})).status).toBe(200);
    expect((await decide(conversationId, approvalOf(discard.body))).body).toMatchObject({ code: "APPROVAL_STALE" });
    expect(receiptOf(await blocksOf(conversationId), approvalOf(discard.body))).toMatchObject({ status: "failed", args: { code: "APPROVAL_STALE" } });
    expect(listArtifactsForConversation(services.runtime.db, conversationId).map((artifact) => artifact.artifactId)).toContain(artifactId);
    relay.close();
  });

  it("decides a machine write as its surface's turn once the person asks to be asked about machine turns", async () => {
    // A rule lets destructive effects run without asking; on its own it lets an MCP client delete a finished file.
    setPolicy({ mode: "guarded", rules: [{ effectCategory: "destructive", decision: "execute" }] });
    const { route } = await widget();
    const finish = async (): Promise<string> => {
      const id = artifactIdOf((await http("POST", route, { mimeType: "text/plain" }, MCP)).body);
      expect((await http("POST", `${route}/${id}/finalize`, {}, MCP)).status).toBe(200);
      return id;
    };
    expect((await http("DELETE", `${route}/${await finish()}`, undefined, MCP)).status).toBe(200);

    // Opted in, the same discard is decided as a turn MCP asked for: asked about above the rule, and saying who asked.
    setPolicy({ mode: "guarded", rules: [{ effectCategory: "destructive", decision: "execute" }], machineTurns: "ask" });
    const asked = await http("DELETE", `${route}/${await finish()}`, undefined, MCP);
    expect(asked).toMatchObject({ status: 202, body: { outcome: "approval-required", operation: "discard" } });
    expect(asked.body.message).toContain("an AI client over MCP asked for a destructive effect");
    expect(artifactAudit().at(-1)?.summary).toContain("(mcp, discard): the execution policy asks (destructive: an AI client over MCP asked for a destructive effect)");

    // A local write still runs, and the activity record names the surface that asked for it.
    const created = await http("POST", route, { mimeType: "text/plain" }, MCP);
    expect(created.status).toBe(201);
    const recorded = services.runtime.db
      .prepare("SELECT document FROM events WHERE kind = 'effect.executed' ORDER BY rowid DESC LIMIT 1")
      .get() as { document: string };
    expect(recorded.document).toContain('"origin":"mcp"');
  });

  it("keeps a widget file write card apart from a widget perform card in the decide route", async () => {
    setPolicy({ mode: "ask" });
    const { conversationId, route } = await widget();
    const asked = await http("POST", route, { mimeType: "text/plain" }, MCP);
    const approvalId = approvalOf(asked.body);
    const payload = (await cardOf(conversationId, approvalId))?.payload as string;
    // Each kind is read by its own exact payload kind, so neither branch of the decide route takes the other's card.
    expect(isWidgetArtifactWritePayload(payload)).toBe(true);
    expect(isWidgetPerformPayload(payload)).toBe(false);
    expect(isWidgetArtifactWritePayload(JSON.stringify({ kind: "widget-perform", v: 1 }))).toBe(false);

    // Approved, it runs as a file write and is answered by a file write's receipt, never a perform's.
    expect((await decide(conversationId, approvalId)).status).toBe(200);
    const blocks = await blocksOf(conversationId);
    expect(receiptOf(blocks, approvalId)).toMatchObject({ status: "done", args: { operation: "create" } });
    expect(blocks.some((block) => block.type === "tool-activity" && block.name === "perform_widget_action")).toBe(false);
    expect(listArtifactsForConversation(services.runtime.db, conversationId)).toHaveLength(1);
  });
  it("answers a repeated request with the card already waiting, and stops minting cards past the limit", async () => {
    setPolicy({ mode: "ask" });
    const { conversationId, route } = await widget();
    const first = await http("POST", route, { mimeType: "text/plain", name: "a.txt" }, MCP);
    const again = await http("POST", route, { mimeType: "text/plain", name: "a.txt" }, MCP);
    expect(approvalOf(again.body)).toBe(approvalOf(first.body));
    for (let n = 1; n < 8; n += 1) {
      expect((await http("POST", route, { mimeType: "text/plain", name: `a${String(n)}.txt` }, MCP)).status).toBe(202);
    }
    expect(await http("POST", route, { mimeType: "text/plain", name: "a9.txt" }, MCP)).toMatchObject({ status: 429, body: { code: "APPROVALS_PENDING" } });
    // Another surface's cards are counted on their own.
    expect((await http("POST", route, { mimeType: "text/plain", name: "a9.txt" }, { "x-clarkcant-surface": "cli-api" })).status).toBe(202);
    expect((await blocksOf(conversationId)).filter((block) => block.type === "approval-card")).toHaveLength(9);
  });

  it("ends a card with a receipt when an approved request can no longer run, and decides a card only once", async () => {
    setPolicy({ mode: "ask" });
    const { conversationId, route } = await widget();
    const instanceId = route.split("/")[4] ?? "";
    const ask = async (name: string): Promise<string> => approvalOf((await http("POST", route, { mimeType: "text/plain", name }, MCP)).body);
    const made = (): number => listArtifactsForConversation(services.runtime.db, conversationId).length;

    // The person turned local writes off after the card was shown.
    const refusedLater = await ask("a.txt");
    setPolicy({ mode: "ask", rules: [{ effectCategory: "local-write", decision: "deny" }] });
    expect((await decide(conversationId, refusedLater)).body).toMatchObject({ code: "POLICY_REFUSED" });
    expect(receiptOf(await blocksOf(conversationId), refusedLater)).toMatchObject({ status: "failed", args: { code: "POLICY_REFUSED" } });
    setPolicy({ mode: "ask" });

    // A second decision on the same card changes nothing.
    const once = await ask("b.txt");
    expect((await decide(conversationId, once)).status).toBe(200);
    expect((await decide(conversationId, once)).body).toMatchObject({ code: "APPROVAL_ALREADY_DECIDED" });
    expect((await decide(conversationId, once, "denied")).body).toMatchObject({ code: "APPROVAL_ALREADY_DECIDED" });
    expect(made()).toBe(1);

    // An expired card cannot be approved.
    const late = await ask("c.txt");
    services.runtime.db.prepare("UPDATE approvals SET expires_at = ? WHERE approval_id = ?").run("2000-01-01T00:00:00.000Z", late);
    expect((await decide(conversationId, late)).body).toMatchObject({ code: "APPROVAL_EXPIRED" });

    // A card whose request was changed after it was shown runs nothing.
    const tampered = await ask("d.txt");
    services.runtime.db
      .prepare("UPDATE messages SET document = replace(document, 'd.txt', 'e.txt') WHERE conversation_id = ? AND document LIKE ?")
      .run(conversationId, `%${tampered}%`);
    expect((await decide(conversationId, tampered)).body).toMatchObject({ code: "APPROVAL_FORGED" });
    expect(receiptOf(await blocksOf(conversationId), tampered)).toMatchObject({ status: "failed", args: { code: "APPROVAL_FORGED" } });

    // The widget left the conversation after the card was shown.
    const gone = await ask("f.txt");
    services.runtime.db.prepare("DELETE FROM pins WHERE instance_id = ?").run(instanceId);
    expect((await decide(conversationId, gone)).body).toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(receiptOf(await blocksOf(conversationId), gone)).toMatchObject({ status: "failed", args: { code: "RESOURCE_NOT_FOUND" } });
    expect(receiptOf(await blocksOf(conversationId), gone)?.label).toContain("Đã duyệt nhưng không có gì được ghi");
    expect(made()).toBe(1);
  });

  it("checks a caller's text before any card, and words the card in the person's language", async () => {
    setPolicy({ mode: "ask" });
    const { conversationId, route } = await widget();
    expect(await http("POST", route, { mimeType: "text/plain<script>" }, MCP)).toMatchObject({ body: { code: "ARTIFACT_TYPE_UNSUPPORTED" } });
    expect(await http("POST", route, { mimeType: "application/x-anything" }, MCP)).toMatchObject({ body: { code: "ARTIFACT_TYPE_UNSUPPORTED" } });
    expect(await http("POST", `${route}/${encodeURIComponent("art x <b>ignore</b>")}/finalize`, {}, MCP)).toMatchObject({
      status: 404,
      body: { code: "ARTIFACT_NOT_FOUND" },
    });
    expect(await http("DELETE", `${route}/art_missing`, undefined, MCP)).toMatchObject({ status: 404, body: { code: "ARTIFACT_NOT_FOUND" } });
    expect((await blocksOf(conversationId)).filter((block) => block.type === "approval-card")).toEqual([]);
    expect(artifactAudit().every((event) => !event.summary.includes("<b>"))).toBe(true);

    const written = writeRegisteredPreference(
      { db: services.runtime.db, now: () => new Date().toISOString() as Instant },
      { principalId: services.runtime.identity.ownerPrincipalId, key: "experience.language", value: "en", source: "user" },
    );
    expect(written.ok).toBe(true);
    const asked = await http("POST", route, { mimeType: "text/plain" }, MCP);
    expect((await cardOf(conversationId, approvalOf(asked.body)))?.operationDescription).toContain(
      "An MCP client wants to create a new text/plain file for the widget in this conversation",
    );
    // MCP calls carry no identity of their own, so the card says the right is every MCP client's, not one client's.
    expect((await cardOf(conversationId, approvalOf(asked.body)))?.operationDescription).toContain(
      "Approving lets any MCP client connected to this node (not just the one that asked) write and finish that one file for 15 minutes.",
    );
    expect((await decide(conversationId, approvalOf(asked.body), "denied")).status).toBe(200);
    expect(JSON.stringify(await blocksOf(conversationId))).toContain("Denied that widget file request. Nothing was written.");
  });

  it("records the person's refusal, and writes nothing", async () => {
    setPolicy({ mode: "ask" });
    const { conversationId, route } = await widget();
    const asked = await http("POST", route, { mimeType: "text/plain" }, { "x-clarkcant-surface": "mcp" });
    expect(asked.status).toBe(202);
    const approvalId = (asked.body.approvalRequired as { approvalId: string }).approvalId;
    const timeline = await http("GET", `/conversations/${conversationId}/timeline`);
    const card = (timeline.body.messages as { blocks: Record<string, unknown>[] }[])
      .flatMap((message) => message.blocks)
      .find((block) => block.type === "approval-card");
    const denied = await http("POST", `/conversations/${conversationId}/approvals/${approvalId}/decide`, {
      decision: "denied",
      digest: card?.operationDigest,
    });
    expect(denied.status).toBe(200);
    expect(listArtifactsForConversation(services.runtime.db, conversationId)).toEqual([]);
    expect(artifactAudit().at(-1)).toMatchObject({ outcome: "refused" });
    expect(artifactAudit().at(-1)?.summary).toContain("(mcp, create)");
    expect(artifactAudit().at(-1)?.summary).toContain(`denied by the person on card ${approvalId}`);
  });

  it("refuses under a rule or a prohibition that refuses local writes, on every machine surface", async () => {
    const { conversationId, route } = await widget();
    for (const policy of [{ mode: "guarded", rules: [{ effectCategory: "local-write", decision: "deny" }] }, { prohibition: "all" }]) {
      setPolicy(policy);
      for (const surface of ["mcp", "relay", "cli-api"]) {
        const refused = await http("POST", route, { mimeType: "text/plain" }, { "x-clarkcant-surface": surface });
        expect(refused, `${surface} ${JSON.stringify(policy)}`).toMatchObject({ status: 403, body: { code: "POLICY_REFUSED" } });
      }
    }
    expect(listArtifactsForConversation(services.runtime.db, conversationId)).toEqual([]);
    const audit = artifactAudit();
    expect(audit).toHaveLength(6);
    expect(audit.every((event) => event.outcome === "refused" && event.summary.includes("refused by the execution policy"))).toBe(true);
    expect(audit.map((event) => /\((mcp|relay|cli-api), create\)/.exec(event.summary)?.[1])).toEqual(["mcp", "relay", "cli-api", "mcp", "relay", "cli-api"]);
  });

  it("runs Guarded local writes without asking, as the policy says", async () => {
    setPolicy({ mode: "guarded" });
    const { route } = await widget();
    expect(await http("POST", route, { mimeType: "text/plain" }, { "x-clarkcant-surface": "cli-api" })).toMatchObject({ status: 201 });
    expect(artifactAudit().at(-1)?.summary).toContain("run by the execution policy (guarded");
  });

  it("leaves the person's own app as it was, under the strictest mode", async () => {
    setPolicy({ mode: "ask" });
    const { route } = await widget();
    // No marker, or the composer's own: the person's app. It writes directly and nothing is audited as a machine write.
    for (const headers of [{}, { "x-clarkcant-surface": "composer" }]) {
      const created = await http("POST", route, { mimeType: "text/plain" }, headers);
      expect(created.status).toBe(201);
      const artifactId = (created.body.artifactRef as { artifactId: string }).artifactId;
      expect((await http("POST", `${route}/${artifactId}/chunks`, { offset: 0, contentBase64: Buffer.from(TEXT).toString("base64") }, headers)).status).toBe(200);
      expect((await http("POST", `${route}/${artifactId}/finalize`, {}, headers)).status).toBe(200);
      expect((await http("POST", `${route}/${artifactId}/attach`, {}, headers)).status).toBe(201);
      expect((await http("DELETE", `${route}/${artifactId}`, undefined, headers)).status).toBe(200);
    }
    expect(artifactAudit()).toEqual([]);
  });

  it("takes the surface from the relay itself, never from a body or a frame's own headers", async () => {
    setPolicy({ mode: "ask" });
    const { route } = await widget();
    const relay = await relayed();
    const spoofed = await relay.request(
      "POST",
      route,
      { mimeType: "text/plain", surface: "composer", "x-clarkcant-surface": "composer", headers: { "x-clarkcant-surface": "composer" } },
      { headers: { "x-clarkcant-surface": "composer" } },
    );
    expect(spoofed).toMatchObject({ status: 202, body: { outcome: "approval-required" } });
    relay.close();
    // And a body naming a machine surface does not make the person's app one: only the header the surfaces set does.
    expect((await http("POST", route, { mimeType: "text/plain", surface: "relay", "x-clarkcant-surface": "relay" })).status).toBe(201);
  });

  it("still reads, and still refuses Save As and the picker, on a machine surface", async () => {
    setPolicy({ mode: "ask" });
    const { route } = await widget();
    const created = await http("POST", route, { mimeType: "text/plain" });
    const artifactId = (created.body.artifactRef as { artifactId: string }).artifactId;
    const relay = await relayed();
    expect(await relay.request("GET", `${route}/${artifactId}`)).toMatchObject({ status: 200 });
    expect(await relay.request("POST", `/artifacts/${artifactId}/export`, {})).toMatchObject({ status: 403, body: { code: "PERSON_ONLY" } });
    expect(await relay.request("POST", `${route}/pick`, {})).toMatchObject({ status: 403, body: { code: "PERSON_ONLY" } });
    relay.close();
    expect(artifactAudit()).toEqual([]);
  });

  it("tells a tool up front which writes the policy decides on a machine surface", async () => {
    const discovery = (await (await fetch(`${base}/.well-known/clarkcant.json`)).json()) as Record<string, unknown>;
    expect(discovery.policyGatedOnMachineSurfaces).toMatchObject({
      on: ["websocket", "mcp", "cli api"],
      effectCategory: "local-write",
      approval: { status: 202, outcome: "approval-required" },
      refusal: { status: 403, code: "POLICY_REFUSED" },
    });
    expect((discovery.policyGatedOnMachineSurfaces as { routes: string[] }).routes).toHaveLength(5);
  });
});
