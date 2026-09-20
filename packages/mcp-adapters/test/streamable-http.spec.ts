import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { type StreamableHttpMcpTransport, connectStreamableHttp } from "../src/streamable-http.ts";

/**
 * streamable-HTTP transport tests.
 *
 * These start a real MCP server on a real port and speak the real protocol to it. A mock would agree
 * with whatever the transport does; a server can refuse to.
 *
 * The failure modes matter as much as the happy path, so the fixture can be told to answer with an
 * event stream, to return a malformed tool, to report a tool-level error, to never answer, to
 * redirect, and to hand out no session at all. Each has a distinct correct outcome, and a transport
 * that turns them all into "something went wrong" is not usable from an application.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "fixtures", "reference-http-server.mjs");

const open: StreamableHttpMcpTransport[] = [];
const servers: ChildProcess[] = [];

/** Start the fixture and wait for the port it announces on stdout. */
async function startServer(mode?: string): Promise<string> {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(mode === undefined ? {} : { MCP_FIXTURE_MODE: mode }) },
  });
  servers.push(child);

  const port = await new Promise<number>((resolve, reject) => {
    let buffer = "";
    const giveUp = setTimeout(() => reject(new Error("the fixture server never announced a port")), 10_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const parsed = JSON.parse(line) as { port?: number };
          if (typeof parsed.port === "number" && parsed.port > 0) {
            clearTimeout(giveUp);
            resolve(parsed.port);
            return;
          }
        } catch {
          // Not the announcement. A chatty server is not this test's business.
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(giveUp);
      reject(error);
    });
  });

  return `http://127.0.0.1:${String(port)}/mcp`;
}

async function connect(mode?: string, requestTimeoutMs = 5_000): Promise<StreamableHttpMcpTransport> {
  const url = await startServer(mode);
  const transport = await connectStreamableHttp({ serverId: "reference", url, requestTimeoutMs });
  open.push(transport);
  return transport;
}

afterEach(async () => {
  // Every transport is closed and every server killed even when a test fails, so a hung fixture
  // cannot leak a port into the next test.
  await Promise.all(open.splice(0).map((transport) => transport.close()));
  for (const child of servers.splice(0)) child.kill();
});

describe("the handshake over HTTP", () => {
  it("reports what the server said it speaks, and keeps the session it was given", async () => {
    const transport = await connect();
    expect(transport.handshake?.protocolVersion).toBe("2025-06-18");
    expect(transport.handshake?.serverInfo.name).toBe("clarkcant-reference-http-server");
    // The session id is what every later request has to echo, and the fixture refuses a request
    // that forgets it - so a transport that dropped it could not list a tool.
    expect(transport.sessionId).toBe("session_reference_1");
  });

  it("works against a server that hands out no session at all", async () => {
    const transport = await connect("nosession");
    expect(transport.sessionId).toBeUndefined();
    expect((await transport.listTools()).map((tool) => tool.name)).toEqual(["echo", "write_note"]);
  });

  it("refuses to use a transport that was closed", async () => {
    const transport = await connect();
    await transport.close();
    await expect(transport.listTools()).rejects.toThrow(/closed/);
  });
});

describe("tools come back validated", () => {
  it("lists the server's tools", async () => {
    const transport = await connect();
    const tools = await transport.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "write_note"]);
    // The one that claims nothing must not be read as read-only just because it did not say so.
    const write = tools.find((tool) => tool.name === "write_note");
    expect(write?.annotations?.readOnlyHint).not.toBe(true);
  });

  it("calls a tool and returns its text", async () => {
    const transport = await connect();
    const result = await transport.callTool("echo", { text: "hello over http" });
    expect(result.content).toBe("hello over http");
  });
});

describe("a reply that arrives as an event stream", () => {
  it("is read from the stream rather than expected as JSON", async () => {
    const transport = await connect("sse");
    // The fixture sends a progress event before the answer, so a client that reads the first
    // `data:` line and stops would fail here rather than pass by accident.
    const tools = await transport.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo", "write_note"]);
  });
});

describe("failure modes", () => {
  it("settles a request the server never answers", async () => {
    const transport = await connect("hang", 1_000);
    await expect(transport.listTools()).rejects.toThrow(/did not answer within 1000 ms/);
  });

  it("refuses a redirect instead of following it", async () => {
    // The fixture redirects to its own other path, which answers the protocol normally. A client
    // that followed would therefore succeed, which is what makes this a test of the refusal rather
    // than of a failure that a followed redirect would also produce.
    const url = await startServer("redirect");
    await expect(connectStreamableHttp({ serverId: "reference", url, requestTimeoutMs: 5_000 })).rejects.toThrow();
  });

  it("names the tool that did not match the protocol shape", async () => {
    const transport = await connect("malformed");
    await expect(transport.listTools()).rejects.toThrow(/tool broken/);
  });

  it("surfaces a tool that reports its own failure", async () => {
    const transport = await connect("toolerror");
    await expect(transport.callTool("echo", { text: "x" })).rejects.toThrow(/reported an error: echo failed on purpose/);
  });
});
