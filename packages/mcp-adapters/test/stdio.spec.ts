import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { connectStdio } from "../src/stdio.ts";
import type { StdioMcpTransport } from "../src/stdio.ts";
import { normalizeMcpTool, toolSetDigest } from "../src/index.ts";

/**
 * stdio transport tests.
 *
 * These run a real MCP server as a real child process and speak the real protocol to it. A mock
 * would agree with whatever the transport does; a process can refuse to.
 *
 * The failure modes matter as much as the happy path, so the fixture can be told to hang, crash,
 * print a banner, return a malformed tool, and report a tool-level error. Each of those has a
 * distinct correct outcome, and a transport that turns them all into "something went wrong" is
 * not usable from an application.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "fixtures", "reference-server.mjs");

const open: StdioMcpTransport[] = [];

function connect(mode?: string, requestTimeoutMs = 5_000): Promise<StdioMcpTransport> {
  return connectStdio({
    serverId: "reference",
    command: process.execPath,
    args: [SERVER],
    ...(mode === undefined ? {} : { env: { MCP_FIXTURE_MODE: mode } }),
    requestTimeoutMs,
  }).then((transport) => {
    open.push(transport);
    return transport;
  });
}

afterEach(async () => {
  // Every transport is closed even when a test fails, so a crashed fixture cannot leak a process
  // into the next test.
  await Promise.all(open.splice(0).map((transport) => transport.close()));
});

describe("the handshake", () => {
  it("reports what the server said it speaks", async () => {
    const transport = await connect();
    const handshake = transport.handshake;
    expect(handshake?.protocolVersion).toBe("2025-06-18");
    expect(handshake?.serverInfo.name).toBe("clarkcant-reference-server");
  });

  it("refuses to start twice on the same transport", async () => {
    const transport = await connect();
    await expect(transport.start()).rejects.toThrow(/already started/);
  });
});

describe("tools come back validated", () => {
  it("lists the server's tools", async () => {
    const transport = await connect();
    const tools = await transport.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "write_note"]);
  });

  it("rejects a tool that does not match the protocol shape, naming it", async () => {
    const transport = await connect("malformed");
    await expect(transport.listTools()).rejects.toThrow(/broken/);
  });

  it("normalises a live server's tools into capabilities", async () => {
    const transport = await connect();
    const tools = await transport.listTools();

    const echo = normalizeMcpTool("reference", tools.find((tool) => tool.name === "echo")!);
    // The server claims read-only, idempotent, closed-world, so this may skip approval.
    expect(echo.effectCategory).toBe("read");
    expect(echo.safeWithoutApproval).toBe(true);
    expect(echo.capabilityRef).toBe("mcp.reference.echo@1");

    const writeNote = normalizeMcpTool("reference", tools.find((tool) => tool.name === "write_note")!);
    // This one claims nothing, and a tool that does not claim to be a read is treated as a write.
    expect(writeNote.effectCategory).toBe("external-write");
    expect(writeNote.safeWithoutApproval).toBe(false);
  });

  it("digests a tool set so a changed schema invalidates prior consent", async () => {
    const transport = await connect();
    const tools = await transport.listTools();
    const digest = toolSetDigest(tools);
    // Prefixed with the algorithm, so a digest recorded under one scheme is not mistaken for a
    // digest from another.
    expect(digest.startsWith("sha256:")).toBe(true);
    expect(digest.slice("sha256:".length)).toHaveLength(64);
    expect(toolSetDigest(tools)).toBe(digest);
    // A tool set that changed shape must not digest the same, or prior consent would carry over.
    expect(toolSetDigest(tools.slice(0, 1))).not.toBe(digest);
  });
});

describe("calling a tool", () => {
  it("returns the text the server produced", async () => {
    const transport = await connect();
    await expect(transport.callTool("echo", { text: "hello" })).resolves.toEqual({
      content: "hello",
    });
  });

  it("surfaces a tool-level failure in the server's own words", async () => {
    const transport = await connect("toolerror");
    // The protocol distinguishes "the tool failed" from "the transport failed", and the caller
    // needs the server's explanation rather than a generic error.
    await expect(transport.callTool("write_note", { text: "x" })).rejects.toThrow(/read-only today/);
  });

  it("surfaces a JSON-RPC error for an unknown tool", async () => {
    const transport = await connect();
    await expect(transport.callTool("nope", {})).rejects.toThrow(/unknown tool nope/);
  });
});

describe("failure modes each settle", () => {
  it("times out a server that stops answering, instead of hanging", async () => {
    const transport = await connect("hang", 300);
    await expect(transport.listTools()).rejects.toThrow(/did not answer tools\/list within 300 ms/);
  });

  it("rejects everything in flight when the server dies, and keeps its stderr", async () => {
    const transport = await connect("crash");
    await expect(transport.callTool("write_note", { text: "x" })).rejects.toThrow(/exited with code 3/);
    // The server's own explanation is what makes the failure diagnosable.
    expect(transport.stderrTail).toContain("crashing on purpose");
  });

  it("tolerates a server that prints a banner to stdout", async () => {
    const transport = await connect("banner");
    // A chatty server is common and is not a protocol violation worth failing over.
    const tools = await transport.listTools();
    expect(tools).toHaveLength(2);
  });

  it("refuses to send anything after it was closed", async () => {
    const transport = await connect();
    await transport.close();
    await expect(transport.listTools()).rejects.toThrow(/not running|was closed/);
  });

  it("closes a second time without complaining, so cleanup is idempotent", async () => {
    const transport = await connect();
    await transport.close();
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
