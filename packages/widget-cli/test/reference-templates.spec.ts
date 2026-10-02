import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import { runConformance } from "../src/conformance.ts";
import { packageFiles } from "../src/package-files.ts";

/**
 * `clark widget init --template ai-generator | ui-with-service`: a working copy of the reference image generator,
 * under the new package's own ids. Working means it passes the conformance suite and packs, and its service answers.
 */

const created: string[] = [];
afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function scaffold(template: string): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "clark-reference-template-"));
  created.push(parent);
  const root = join(parent, "my-images");
  expect(await runCli(["widget", "init", root, "--template", template])).toBe(0);
  return root;
}

function json(root: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;
}

/** One `tools/call` to the scaffolded service over standard streams, as the node makes it, without offering egress. */
async function callService(root: string, prompt: string): Promise<{ progress: number[]; result: Record<string, unknown> }> {
  const child = spawn(process.execPath, [join(root, "service", "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
  const progress: number[] = [];
  try {
    return await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("the service did not answer")), 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
          const message = JSON.parse(buffer.slice(0, index)) as { id?: number; method?: string; params?: { progress: number }; result?: Record<string, unknown> };
          buffer = buffer.slice(index + 1);
          if (message.method === "notifications/progress") progress.push(message.params?.progress ?? -1);
          if (message.id === 2) {
            clearTimeout(timer);
            resolve({ progress, result: message.result ?? {} });
          }
        }
      });
      const send = (payload: unknown) => child.stdin.write(`${JSON.stringify(payload)}\n`);
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "generate_image", arguments: { prompt }, _meta: { progressToken: "p1" } } });
    });
  } finally {
    child.kill();
  }
}

describe("the reference image generator templates", () => {
  it("ai-generator: the whole app, renamed, with its provider and the key the host adds", async () => {
    const root = await scaffold("ai-generator");
    const report = runConformance(root);
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(report.ok).toBe(true);
    expect(await runCli(["widget", "pack", root])).toBe(0);

    const manifest = json(root, "clarkcant.json");
    expect(manifest).toMatchObject({ id: "com.example.my-images", version: "0.1.0", publisher: { id: "example" } });
    const tools = (manifest.facets as Record<string, unknown>[])[1];
    expect(tools).toMatchObject({
      id: "com.example.my-images.service",
      capabilities: [{ ref: "com.example.my-images.image.generate@1", execution: { kind: "job", version: 1 } }],
      egress: { secrets: [{ name: "IMAGE_PROVIDER_KEY" }], origins: [{ credential: { secret: "IMAGE_PROVIDER_KEY", scheme: "bearer" } }] },
    });
    expect(json(root, "widgets/main/widget.json")).toMatchObject({ id: "com.example.my-images.main@1", version: "0.1.0" });
    // Nothing still names the reference package, and none of its tests came along.
    for (const { path, bytes } of packageFiles(root)) {
      expect(path.startsWith("test/")).toBe(false);
      expect(bytes.toString("utf8"), path).not.toContain("com.clarkcant.reference");
    }
    // Without the node's egress the service says so instead of reaching anything itself.
    const answer = await callService(root, "a red kite");
    expect(answer.result).toMatchObject({ isError: true, content: [{ text: "The node does not make provider requests for this service." }] });
  });

  it("ui-with-service: the same widget and job, with a service that draws the image itself", async () => {
    const root = await scaffold("ui-with-service");
    expect(runConformance(root).ok).toBe(true);
    const tools = (json(root, "clarkcant.json").facets as Record<string, unknown>[])[1];
    expect(tools).not.toHaveProperty("egress");
    expect(tools).toMatchObject({ capabilities: [{ ref: "com.example.my-images.image.generate@1" }] });

    const answer = await callService(root, "a red kite");
    expect(answer.progress).toEqual([1, 2, 3, 4]);
    expect(answer.result).toMatchObject({ content: [{ type: "text" }, { type: "image", mimeType: "image/png" }] });
    expect(answer.result).not.toHaveProperty("isError");
  });
});
