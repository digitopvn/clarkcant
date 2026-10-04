import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ConversationId, Principal } from "@clarkcant/contracts";
import { FakePiAdapter, type ToolDefinition } from "@clarkcant/pi-adapter";

import { type DecideDeps } from "../src/jev-decider.ts";
import { type JevConfig, type JevTransport, createJevBudget } from "../src/jev-selector.ts";
import { createModelTurn } from "../src/model-turn.ts";
import {
  CORE_TOOLS,
  TOOL_FAMILIES,
  hintedFamilies,
  planToolDisclosure,
  toolDisclosureFromEnv,
} from "../src/tool-disclosure.ts";

/**
 * Which tools a turn is offered.
 *
 * What has to hold: off unless asked for; never a tool the session was not created with; the tools that let a turn
 * recover (ask, remember, look back, show) are always there; within a session the set only grows, because each change
 * is a new prompt prefix; and when nothing points anywhere the turn gets everything.
 */

const REGISTERED = [
  ...CORE_TOOLS,
  ...Object.values(TOOL_FAMILIES).flatMap((family) => family.tools),
  "some_future_tool",
];

describe("the switch", () => {
  it("is off unless progressive is asked for by name", () => {
    expect(toolDisclosureFromEnv({})).toBe("all");
    expect(toolDisclosureFromEnv({ CLARKCANT_TOOL_DISCLOSURE: "Progressive" })).toBe("progressive");
    expect(toolDisclosureFromEnv({ CLARKCANT_TOOL_DISCLOSURE: "progresive" })).toBe("all");
  });
});

describe("hints", () => {
  it("reads Vietnamese with or without diacritics, and English, by whole word", () => {
    expect([...hintedFamilies("Chạy git log giúp mình")]).toEqual(["terminal"]);
    expect([...hintedFamilies("chay git log giup minh")]).toEqual(["terminal"]);
    expect([...hintedFamilies("Open settings and switch to the dark theme")]).toEqual(["interface"]);
    expect(hintedFamilies("Mỗi ngày nhắc mình uống nước").has("automation")).toBe(true);
    // "runtime" contains "run", but not as a word.
    expect(hintedFamilies("what is a runtime").has("terminal")).toBe(false);
  });
});

describe("one turn's plan", () => {
  it("changes nothing when disclosure is off", async () => {
    const plan = await planToolDisclosure({ mode: "all", registered: REGISTERED, current: undefined, text: "chạy git log", usedLastTurn: [] });
    expect(plan).toEqual({ active: undefined, families: [], reason: "all" });
  });

  it("offers the core, tools in no family and the hinted family on a session's first turn", async () => {
    const plan = await planToolDisclosure({ mode: "progressive", registered: REGISTERED, current: undefined, text: "chạy git log", usedLastTurn: [] });
    expect(plan.reason).toBe("hinted");
    expect(plan.families).toEqual(["terminal"]);
    expect(plan.active).toEqual([...CORE_TOOLS, ...(TOOL_FAMILIES.terminal?.tools ?? []), "some_future_tool"]);
  });

  it("only grows within a session, and keeps what was used last turn", async () => {
    const first = await planToolDisclosure({ mode: "progressive", registered: REGISTERED, current: undefined, text: "chạy git log", usedLastTurn: [] });
    const second = await planToolDisclosure({
      mode: "progressive",
      registered: REGISTERED,
      current: first.active,
      text: "mở cài đặt giao diện",
      usedLastTurn: ["run_command"],
    });
    expect(second.families).toEqual(["interface", "terminal"]);
    for (const tool of first.active ?? []) expect(second.active).toContain(tool);
    // A turn that needs nothing new leaves the session's tools — and the cached prefix — alone.
    const third = await planToolDisclosure({ mode: "progressive", registered: REGISTERED, current: second.active, text: "cảm ơn", usedLastTurn: [] });
    expect(third).toMatchObject({ active: undefined, reason: "unchanged" });
  });

  it("offers everything when nothing points anywhere and no selector is asked", async () => {
    const plan = await planToolDisclosure({ mode: "progressive", registered: REGISTERED, current: undefined, text: "chào bạn", usedLastTurn: [] });
    expect(plan.reason).toBe("no-hint");
    expect(plan.active).toEqual(REGISTERED);
  });

  it("never offers a tool the session was not created with", async () => {
    const registered = ["ask_user", "run_command"];
    const plan = await planToolDisclosure({
      mode: "progressive",
      registered,
      current: undefined,
      text: "chạy lệnh, mở cài đặt, cài gói, xem hộp thư",
      usedLastTurn: ["control_app"],
    });
    expect(plan.active).toEqual(registered);
  });

  it("lets an opted-in selector name one family when the words do not", async () => {
    const jev = selector("family:inbox");
    const plan = await planToolDisclosure({
      mode: "progressive",
      registered: REGISTERED,
      current: undefined,
      text: "có gì mới không",
      usedLastTurn: [],
      decider: jev.deps,
    });
    expect(jev.calls()).toBe(1);
    expect(plan.reason).toBe("selector");
    expect(plan.families).toEqual(["inbox"]);
    expect(plan.active).toContain("read_inbox");
    expect(plan.active).not.toContain("run_command");
  });

  it("offers everything when the selector does not decide", async () => {
    const jev = selector("none");
    const plan = await planToolDisclosure({
      mode: "progressive",
      registered: REGISTERED,
      current: undefined,
      text: "có gì mới không",
      usedLastTurn: [],
      decider: jev.deps,
    });
    expect(plan.reason).toBe("no-hint");
    expect(plan.active).toEqual(REGISTERED);
  });
});

describe("the family map names real tools", () => {
  it("every tool it names is defined somewhere in the runtime", () => {
    const sourceDir = join(import.meta.dirname, "..", "src");
    const source = readdirSync(sourceDir, { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".ts"))
      .map((path) => readFileSync(join(sourceDir, path), "utf8"))
      .join("\n");
    const named = [...CORE_TOOLS, ...Object.values(TOOL_FAMILIES).flatMap((family) => family.tools)];
    const missing = named.filter((tool) => !source.includes(`"${tool}"`));
    expect(missing).toEqual([]);
    // One family per tool: a tool in two would be switched on by either, which is a family in disguise.
    expect(new Set(named).size).toBe(named.length);
  });
});

describe("the model turn applies the plan through the adapter", () => {
  const PRINCIPAL: Principal = { principalId: "p_owner" as Principal["principalId"], kind: "user", nodeId: "n1" as Principal["nodeId"] };
  const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;

  class CountingAdapter extends FakePiAdapter {
    readonly calls: string[][] = [];
    override async setActiveTools(sessionId: string, toolNames: readonly string[]): Promise<void> {
      this.calls.push([...toolNames]);
      await super.setActiveTools(sessionId, toolNames);
    }
  }

  const tool = (name: string): ToolDefinition => ({
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ text: name }),
  });

  it("narrows on the first turn, grows when asked, and leaves the tools alone otherwise", async () => {
    const adapter = new CountingAdapter({ script: ["một", "hai", "ba"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      extraTools: () => [tool("ask_user"), tool("run_command"), tool("control_app"), tool("read_inbox")],
      toolDisclosure: async (input) => await planToolDisclosure({ mode: "progressive", ...input }),
    });
    const ask = async (text: string, messageId: string): Promise<void> => {
      await turn!.answer({ conversationId: "c1" as ConversationId, principal: PRINCIPAL, text, messageId });
    };
    await ask("chạy git status", "m1");
    expect(adapter.activeToolNames("fake-session-1")).toEqual(["ask_user", "run_command"]);
    await ask("cảm ơn", "m2");
    expect(adapter.calls).toHaveLength(1);
    await ask("mở cài đặt", "m3");
    expect(adapter.activeToolNames("fake-session-1")).toEqual(["ask_user", "run_command", "control_app"]);
    expect(adapter.calls).toHaveLength(2);
  });

  it("offers everything, unchanged, when no plan is configured", async () => {
    const adapter = new CountingAdapter({ script: ["một"] });
    const turn = await createModelTurn({
      env: ENV,
      cwd: process.cwd(),
      adapter,
      extraTools: () => [tool("ask_user"), tool("run_command")],
    });
    await turn!.answer({ conversationId: "c1" as ConversationId, principal: PRINCIPAL, text: "chạy git status", messageId: "m1" });
    expect(adapter.calls).toEqual([]);
  });
});

function config(): JevConfig {
  return {
    enabled: true,
    localOnly: false,
    apiKey: "sk-test-not-a-real-key",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    endpointRefusal: undefined,
    model: "jev-1.13.0",
    timeoutMs: 4000,
    maxCallsPerTurn: 2,
    policyVersion: "2026-09-17",
    confidenceFloor: 0.85,
    marginFloor: 0.2,
    noulOnFloor: 0.85,
    noulOffFloor: 0.15,
  };
}

/** A selector that always picks `choice`, with a distribution over every offered option. */
function selector(choice: string): { deps: DecideDeps; calls: () => number } {
  let calls = 0;
  const transport: JevTransport = async (request) => {
    calls += 1;
    const body = request.body as { questions: Record<string, { criteria?: Record<string, unknown> }> };
    const id = Object.keys(body.questions)[0] ?? "q";
    const options = [...new Set([...Object.keys(body.questions[id]?.criteria ?? {}), "none", choice])];
    const rest = 0.03 / (options.length - 1);
    const probabilities = Object.fromEntries(options.map((option) => [option, option === choice ? 0.97 : rest]));
    return { status: 200, body: { model: "jev-1.13.0", answers: { [id]: { type: "choice", choice, probabilities } } } };
  };
  const conf = config();
  return { deps: { jev: { config: conf, transport }, budget: () => createJevBudget(conf) }, calls: () => calls };
}
