import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CommandCard, SLASH_COMMANDS, commandCardSchema, instantSchema, parseSlashCommand } from "@clarkcant/contracts";
import { FakePiAdapter } from "@clarkcant/pi-adapter";
import { messagesSince, putPreference, readPreference } from "@clarkcant/storage";

import { readModelChoice } from "../src/application/model-choice.ts";
import { composerSuggestions } from "../src/composer-suggestions.ts";
import { handleRequest, type GatewayDeps } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * `/model`: the host answers with a card that carries the model picker, and nothing else. Opening it must never change
 * the model; the choice is applied by the page through `POST /model` once the person confirms it.
 */

const AT = instantSchema.parse("2026-10-08T06:00:00.000Z");

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let sequence = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-model-command-"));
  services = bootNodeServices({ dataDir: join(dir, "node"), label: "test node" });
  const adapter = new FakePiAdapter();
  services.modelCatalogue = () => adapter.catalogue();
  sequence = 0;
  deps = {
    services,
    now: () => AT,
    newConversationId: () => {
      sequence += 1;
      return `conv_model_${sequence}`;
    },
  };
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

async function command(text: string): Promise<{ text: string; card: CommandCard | undefined }> {
  const created = await call("POST", "/conversations", { title: "model" });
  const conversationId = (created.body as { conversationId: string }).conversationId;
  const response = await call("POST", `/conversations/${conversationId}/messages`, { text });
  expect(response.status).toBe(200);
  const last = messagesSince(services.runtime.db, conversationId, 0, 40).at(-1);
  expect(last?.role).toBe("assistant");
  const said = last?.blocks.find((block) => block.type === "text");
  const card = last?.blocks.find((block) => block.type === "command-card");
  return { text: said !== undefined && "content" in said ? String(said.content) : "", card: card as CommandCard | undefined };
}

function storedModel(): string | undefined {
  return readPreference(services.runtime.db, services.runtime.identity.ownerPrincipalId, "model", "node");
}

describe("/model", () => {
  it("is a slash command the composer offers", async () => {
    expect(SLASH_COMMANDS).toContain("model");
    expect(parseSlashCommand("/model")).toEqual({ command: "model", argument: "" });
    expect(parseSlashCommand("/Model  gpt 5 ")).toEqual({ command: "model", argument: "gpt 5" });
    const answer = await composerSuggestions(services, { trigger: "/", query: "mod" });
    expect(answer.suggestions.map((row) => row.label)).toContain("model");
  });

  it("answers with a host card carrying the model picker, and changes nothing", async () => {
    const before = storedModel();
    const { text, card } = await command("/model");

    expect(card?.command).toBe("model");
    expect(card?.owner).toBe("host");
    expect(card?.picker).toEqual({ kind: "model" });
    expect(card?.rows).toEqual([]);
    expect(commandCardSchema.safeParse(card).success).toBe(true);
    expect(text.length).toBeGreaterThan(0);
    expect(storedModel()).toBe(before);
  });

  it("names the model in use, and leaves it in use", async () => {
    services.currentModel = () => ({ provider: "fake", id: "fake-model" });
    const { text } = await command("/model");
    expect(text).toContain("fake/fake-model");
    expect(storedModel()).toBeUndefined();
  });

  it("carries the words after /model as what the picker searches for first", async () => {
    const { card } = await command("/model large");
    expect(card?.picker).toEqual({ kind: "model", query: "large" });
  });

  it("says plainly that nothing can be chosen on a node with no catalogue, and draws no picker", async () => {
    delete services.modelCatalogue;
    const { text, card } = await command("/model");
    expect(card).toBeUndefined();
    expect(text.length).toBeGreaterThan(0);
    expect(storedModel()).toBeUndefined();
  });
});

describe("the model a person chose, as a turn reads it", () => {
  const store = (value: string) =>
    putPreference(services.runtime.db, {
      principalId: services.runtime.identity.ownerPrincipalId,
      key: "model",
      value,
      scope: "node",
      source: "settings",
      at: AT,
    });

  it("keeps a model id that holds slashes of its own", () => {
    store("openrouter/anthropic/claude-sonnet");
    expect(readModelChoice(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toEqual({
      provider: "openrouter",
      id: "anthropic/claude-sonnet",
    });
  });

  it("reads nothing when no choice, or half of one, is stored", () => {
    expect(readModelChoice(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toBeUndefined();
    store("fake/");
    expect(readModelChoice(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toBeUndefined();
  });

  it("is what POST /model stores once the choice is checked against the catalogue", async () => {
    const chosen = await call("POST", "/model", { provider: "fake", id: "fake-model-large" });
    expect(chosen.status).toBe(200);
    expect(readModelChoice(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toEqual({ provider: "fake", id: "fake-model-large" });
    const refused = await call("POST", "/model", { provider: "fake", id: "no-such-model" });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(readModelChoice(services.runtime.db, services.runtime.identity.ownerPrincipalId)).toEqual({ provider: "fake", id: "fake-model-large" });
  });
});
