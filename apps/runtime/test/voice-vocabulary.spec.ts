import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Instant, instantSchema, nodeIdSchema } from "@clarkcant/contracts";
import { recordVoiceTranscript } from "@clarkcant/core";
import { createConversation, migrate, openDatabase, upsertProject } from "@clarkcant/storage";
import { afterEach, describe, expect, it } from "vitest";

import type { NodeServices } from "../src/services.ts";
import { conversationProject, languageHintsFor, voiceRecognitionContext } from "../src/voice-vocabulary.ts";

/**
 * The session vocabulary, from what the node actually holds: its projects, the active project's manifest and branch,
 * the conversation, its skills and its model. Only terms leave; the text that ranked them and any path to a project
 * never do.
 */

const AT = instantSchema.parse("2026-10-06T03:00:00.000Z") as Instant;
const NODE = nodeIdSchema.parse("node_vocabulary");
const CONVERSATION = "conv_vocabulary" as never;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-vocabulary-"));
  made.push(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@acme/voice-lab", dependencies: { zod: "4.0.0" }, devDependencies: { vitest: "5.0.0" } }),
  );
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/feat/468-code-switching\n");
  return dir;
}

function servicesWith(dir: string, extra: Partial<NodeServices> = {}, said = "trong voice-lab, "): NodeServices {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  createConversation(db, { conversationId: CONVERSATION, homeNodeId: NODE, title: "vocabulary", at: AT });
  upsertProject(db, {
    projectId: "project_1",
    nodeId: NODE,
    path: dir,
    name: "voice-lab",
    aliases: ["phòng thí nghiệm giọng nói"],
    gitRemote: undefined,
    markers: ["package.json"],
    kind: "code",
    mtime: 0,
    lastUsedAt: AT,
    indexedAt: AT,
  });
  // Used more recently than voice-lab, and not what this conversation is about.
  const elsewhere = mkdtempSync(join(tmpdir(), "cc-vocabulary-other-"));
  made.push(elsewhere);
  writeFileSync(join(elsewhere, "package.json"), JSON.stringify({ name: "@acme/unrelated-shop", dependencies: { stripe: "1.0.0" } }));
  upsertProject(db, {
    projectId: "project_2",
    nodeId: NODE,
    path: elsewhere,
    name: "unrelated-shop",
    aliases: [],
    gitRemote: undefined,
    markers: ["package.json"],
    kind: "code",
    mtime: 0,
    lastUsedAt: "2026-10-06T04:00:00.000Z",
    indexedAt: AT,
  });
  let counter = 0;
  const conductor = { db, nodeId: NODE, now: () => AT, newId: (prefix: string) => `${prefix}_${String(++counter).padStart(6, "0")}` };
  // Assembled at run time, so the repository's own secret scan does not read a test fixture as a leaked key.
  const secret = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
  recordVoiceTranscript(conductor as never, {
    conversationId: CONVERSATION,
    userText: `${said}sửa \`useVoiceSession\` trong packages/voice-adapters/src/index.ts cho issue #468, token ${secret}`,
    assistantText: "",
    at: AT,
  });
  return {
    runtime: { db, identity: { nodeId: NODE, ownerPrincipalId: "owner" } },
    conductor,
    skills: { list: async () => [{ name: "code-review", description: "", source: "personal", revision: "1" }], body: async () => ({}) as never },
    currentModel: () => ({ provider: "anthropic", id: "claude-opus-5-5" }),
    ...extra,
  } as unknown as NodeServices;
}

describe("the session vocabulary", () => {
  it("draws on projects, the manifest, the branch, the conversation, skills and the model", async () => {
    const dir = projectDir();
    const context = await voiceRecognitionContext(servicesWith(dir), { conversationId: CONVERSATION, locale: "vi" });
    const texts = context.terms.map((term) => term.text);

    expect(context.languageHints).toEqual(["vi-VN", "en-US"]);
    for (const expected of ["voice-lab", "@acme/voice-lab", "zod", "vitest", "feat/468-code-switching", "useVoiceSession", "packages/voice-adapters/src/index.ts", "#468", "code-review", "claude-opus-5-5", "anthropic"]) {
      expect(texts).toContain(expected);
    }
  });

  it("reads the manifest of the project the conversation is about, not the node's most recently used one", async () => {
    const dir = projectDir();
    const texts = (await voiceRecognitionContext(servicesWith(dir), { conversationId: CONVERSATION, locale: "vi" })).terms.map((term) => term.text);
    expect(texts).toContain("@acme/voice-lab");
    expect(texts).not.toContain("@acme/unrelated-shop");
    expect(texts).not.toContain("stripe");
  });

  it("reads no manifest or branch when the conversation names no project", async () => {
    const dir = projectDir();
    const texts = (await voiceRecognitionContext(servicesWith(dir, {}, ""), { conversationId: CONVERSATION, locale: "vi" })).terms.map((term) => term.text);
    for (const unsaid of ["@acme/voice-lab", "@acme/unrelated-shop", "stripe", "feat/468-code-switching"]) expect(texts).not.toContain(unsaid);
    // Project names are still words this node expects to hear.
    expect(texts).toEqual(expect.arrayContaining(["voice-lab", "unrelated-shop"]));
  });

  it("finds a project by name or alias as a whole word, the newest mention winning", () => {
    const projects = [
      { name: "voice-lab", aliases: ["phòng lab"] },
      { name: "shop", aliases: [] },
    ];
    expect(conversationProject(projects, ["mở voice-lab", "giờ qua shop"])?.name).toBe("shop");
    expect(conversationProject(projects, ["giờ qua shop", "quay lại phòng lab"])?.name).toBe("voice-lab");
    expect(conversationProject(projects, ["voice-labs và workshop"])).toBeUndefined();
    expect(conversationProject(projects, [])).toBeUndefined();
  });

  it("never sends a secret, a project's absolute path, or the conversation text", async () => {
    const dir = projectDir();
    const context = await voiceRecognitionContext(servicesWith(dir), { conversationId: CONVERSATION, locale: "vi" });
    const serialized = JSON.stringify(context);

    expect(serialized).not.toContain("sk-ant");
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain("sửa");
  });

  it("still answers when a source is slow or broken: the glossary alone is a valid vocabulary", async () => {
    const services = servicesWith(join(tmpdir(), "cc-vocabulary-missing-project"), {
      skills: { list: () => new Promise(() => undefined), body: async () => ({}) as never } as never,
      extensions: async () => {
        throw new Error("extensions unavailable");
      },
      currentModel: () => {
        throw new Error("no model");
      },
    } as Partial<NodeServices>);

    const started = Date.now();
    const context = await voiceRecognitionContext(services, { conversationId: undefined, locale: "en" });

    expect(Date.now() - started).toBeLessThan(2500);
    expect(context.languageHints).toEqual(["en-US", "vi-VN"]);
    expect(context.terms.map((term) => term.text)).toContain("TypeScript");
  });

  it("puts the person's language first and English second", () => {
    expect(languageHintsFor("vi")).toEqual(["vi-VN", "en-US"]);
    expect(languageHintsFor("en")).toEqual(["en-US", "vi-VN"]);
  });
});
