import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initFromReference, runCli } from "../src/cli.ts";
import { runConformance } from "../src/conformance.ts";
import { packageFiles } from "../src/package-files.ts";
import { PLACEHOLDER_PROVIDER_ORIGIN, REFERENCE_TEMPLATES, referenceCopy } from "../src/reference-templates.ts";

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
      // Asking a provider to draw writes to it, which is also what lets the node send the start as a POST.
      capabilities: [{ ref: "com.example.my-images.image.generate@1", effectCategory: "external-write", execution: { kind: "job", version: 1 } }],
      egress: { secrets: [{ name: "IMAGE_PROVIDER_KEY" }], origins: [{ credential: { secret: "IMAGE_PROVIDER_KEY", scheme: "bearer" } }] },
    });
    // A placeholder that reaches no provider, never the loopback port the reference app's tests use.
    const origins = (tools?.egress as { origins: { origin: string }[] }).origins.map((entry) => entry.origin);
    expect(origins).toEqual([PLACEHOLDER_PROVIDER_ORIGIN]);
    expect(PLACEHOLDER_PROVIDER_ORIGIN).toMatch(/^https:\/\/[a-z.]+\.example\.com$/);
    expect(readFileSync(join(root, "clarkcant.json"), "utf8")).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(`Replace the provider origin before you publish.** \`clarkcant.json\` declares \`${PLACEHOLDER_PROVIDER_ORIGIN}\``);
    expect(json(root, "widgets/main/widget.json").effectCategories).toEqual(["read", "external-write"]);
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
    // Drawing locally reaches nothing outside, so the capability and the widget only read.
    expect(tools).toMatchObject({ capabilities: [{ ref: "com.example.my-images.image.generate@1", effectCategory: "read" }] });
    expect(json(root, "widgets/main/widget.json").effectCategories).toEqual(["read"]);

    const answer = await callService(root, "a red kite");
    expect(answer.progress).toEqual([1, 2, 3, 4]);
    expect(answer.result).toMatchObject({ content: [{ type: "text" }, { type: "image", mimeType: "image/png" }] });
    expect(answer.result).not.toHaveProperty("isError");
  });

  it("every reference template goes through the one copier, which renames, leaves the app's tests behind and resets the version", () => {
    for (const template of REFERENCE_TEMPLATES) {
      const parent = mkdtempSync(join(tmpdir(), "clark-reference-copier-"));
      created.push(parent);
      const root = join(parent, "copy");
      initFromReference(root, "com.example.copy", template);

      const copy = referenceCopy(template);
      const files = packageFiles(root).map((file) => file.path);
      expect(files, template).toContain("clarkcant.json");
      expect(files.some((path) => /^(test|dist)\//.test(path)), template).toBe(false);
      for (const { path, bytes } of packageFiles(root)) expect(bytes.toString("utf8"), `${template}: ${path}`).not.toContain(copy.referenceId);
      expect(json(root, "clarkcant.json"), template).toMatchObject({
        id: "com.example.copy",
        version: "0.1.0",
        displayName: copy.displayName,
        publisher: { id: "example", sourceUrl: copy.sourceUrl, license: "MIT" },
      });
      expect(json(root, "widgets/main/widget.json"), template).toMatchObject({ id: "com.example.copy.main@1", version: "0.1.0" });
      expect(readFileSync(join(root, "README.md"), "utf8"), template).toBe(copy.readme);
      expect(readFileSync(join(root, "LICENSE"), "utf8"), template).toBe("MIT\n");
    }
  });
});
