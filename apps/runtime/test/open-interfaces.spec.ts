import { mkdtempSync, rmSync } from "node:fs";
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { attachApiSocket, type ApiSocket } from "../src/api-socket.ts";
import { MCP_PROTOCOL_VERSIONS } from "../src/open-interfaces.ts";
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
      "/stop",
    ]) {
      expect(document.paths).toHaveProperty([path]);
    }
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
    expect(initialized.body).toMatchObject({ id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "clarkcant" } } });

    const unknownVersion = await mcp({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(unknownVersion.body).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSIONS[0] } });

    const listed = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const names = (listed.body as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["ask_clark", "list_conversations", "read_conversation", "answer_question", "stop_all_work"]),
    );
    expect(names.some((name) => name.includes("approv"))).toBe(false);
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
