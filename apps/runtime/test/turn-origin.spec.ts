import { mkdtempSync, rmSync } from "node:fs";
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CapabilityRef,
  DEFAULT_EXECUTION_POLICY_CONFIG,
  type ExecutionPolicyConfig,
  type Instant,
  type MapTileProvider,
  type TurnOrigin,
} from "@clarkcant/contracts";
import { EXECUTION_POLICY_PREFERENCE_KEY, readExecutionPolicy, registerCapability, writeRegisteredPreference } from "@clarkcant/core";
import { allRows, appendAuditEvent, latestMessages, listAuditEvents } from "@clarkcant/storage";

import { invokeCapability } from "../src/application/capability-invoke.ts";
import { appendHostReply } from "../src/routes/conversations.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { createMapTilesTool } from "../src/map-tiles-tool.ts";
import { createNodeTools } from "../src/node-tools.ts";
import { classifyCommand, ownedResources } from "../src/preflight.ts";
import { createNodeServer } from "../src/server.ts";
import type { ServiceHost } from "../src/service-host.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * Who started a turn (#427).
 *
 * The owner's decision: treat a turn an AI client or a script started like the person's own, and only record where it
 * came from. So the origin is recorded from what the gateway already knows — the surface mark the node's own MCP
 * endpoint, relay and composer put on a request — and never from the body; with the default policy every decision is
 * the one the person's own turn would get; and a person who wants more can opt in, through the one policy, to being
 * asked before a risky effect such a turn causes.
 */

const AT = "2026-10-04T03:00:00.000Z" as Instant;

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
let conversationId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-turn-origin-"));
  services = bootNodeServices({ dataDir: dir, label: "turn origin node" });
  deps = { services, now: () => AT };
  const created = await request("POST", "/conversations", { title: "origin" });
  conversationId = (created.body as { conversationId: string }).conversationId;
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method,
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}`, ...headers },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

const owner = (): string => services.runtime.identity.ownerPrincipalId;
const now = (): Instant => AT;

function setPolicy(value: Partial<ExecutionPolicyConfig>): void {
  const written = writeRegisteredPreference(
    { db: services.runtime.db, now },
    { principalId: owner(), key: EXECUTION_POLICY_PREFERENCE_KEY, value: { ...DEFAULT_EXECUTION_POLICY_CONFIG, ...value }, source: "user" },
  );
  if (!written.ok) throw new Error(written.message);
}

function originOf(text: string, inConversation = conversationId): TurnOrigin | undefined {
  return latestMessages(services.runtime.db, inConversation, 50)
    .filter((message) => message.role === "user")
    .find((message) => message.blocks.some((block) => block.type === "text" && block.content === text))?.origin;
}

describe("the origin is recorded when the message is accepted", () => {
  async function post(text: string, surface?: string, extra: Record<string, unknown> = {}): Promise<void> {
    const answered = await request(
      "POST",
      `/conversations/${conversationId}/messages`,
      { text, demo: true, ...extra },
      surface === undefined ? {} : { "x-clarkcant-surface": surface },
    );
    expect(answered.status).toBe(202);
  }

  it("records the composer as the person, and each machine surface by name", async () => {
    await post("từ ô soạn thảo", "composer");
    await post("từ relay", "relay");
    await post("từ MCP", "mcp");
    await post("từ một script");
    expect(originOf("từ ô soạn thảo")).toBe("person");
    expect(originOf("từ relay")).toBe("relay");
    expect(originOf("từ MCP")).toBe("mcp");
    // A token holder with no mark is the CLI or the API.
    expect(originOf("từ một script")).toBe("cli-api");
  });

  it("ignores an origin a body claims, so a machine surface can never say it is the person", async () => {
    await post("giả làm người", "mcp", { origin: "person", surface: "composer" });
    await post("không đánh dấu, tự nhận là người", undefined, { origin: "person" });
    // A mark only the node itself sets is not one a client can borrow either.
    await post("tự nhận là giọng nói", "voice", { origin: "person" });
    expect(originOf("giả làm người")).toBe("mcp");
    expect(originOf("không đánh dấu, tự nhận là người")).toBe("cli-api");
    expect(originOf("tự nhận là giọng nói")).toBe("cli-api");
  });

  it("records a turn an AI client started with MCP ask_clark as mcp", async () => {
    const server: Server = createNodeServer({ services, origin: "http://127.0.0.1", onWarning: () => undefined });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${services.runtime.identity.localToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ask_clark", arguments: { text: "hỏi qua MCP", origin: "person" } },
        }),
      });
      const asked = (await response.json()) as { result: { structuredContent: { conversationId: string } } };
      expect(originOf("hỏi qua MCP", asked.result.structuredContent.conversationId)).toBe("mcp");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("run_command", () => {
  function commandTool(origin: TurnOrigin): { execute: (params: Record<string, unknown>) => Promise<{ text: string; hostCard?: Record<string, unknown> }> } {
    const ledger = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now, newId: services.conductor.newId };
    const tool = createNodeTools({
      search: services.search,
      projects: services.projects,
      origin: () => origin,
      command: {
        approvals: () => ledger,
        autonomy: () => readExecutionPolicy({ db: services.runtime.db, now }, owner()),
        resources: () => ownedResources([dir, process.cwd()]),
        fallbackCwd: () => dir,
        newId: () => services.conductor.newId("tool"),
        effectAudit: () => ({ deps: ledger, principalId: owner(), conversationId }),
      },
    }).find((candidate) => candidate.name === "run_command");
    if (tool === undefined) throw new Error("run_command is not registered");
    return tool as never;
  }

  const LOCAL = `node -e "process.stdout.write('origin-ran')"`;
  const RISKY = "git push origin main";

  it("decides a machine-surface turn exactly as the person's with the default policy", async () => {
    expect(classifyCommand(RISKY).effectCategory).toBe("external-write");
    for (const origin of ["person", "mcp"] as const) {
      const ran = await commandTool(origin).execute({ command: LOCAL, cwd: dir });
      expect(ran.hostCard, origin).toBeUndefined();
      expect(ran.text, origin).toContain("origin-ran");
    }
    // A mode that asks asks both of them, with nothing run: the card is the same card, saying who asked.
    setPolicy({ mode: "ask" });
    const person = await commandTool("person").execute({ command: RISKY, cwd: dir });
    const machine = await commandTool("mcp").execute({ command: RISKY, cwd: dir });
    expect(person.hostCard?.type).toBe("approval-card");
    expect(machine.hostCard?.type).toBe("approval-card");
    expect(machine.hostCard?.effectCategory).toBe(person.hostCard?.effectCategory);
    expect(person.hostCard?.origin).toBe("person");
    expect(machine.hostCard?.origin).toBe("mcp");
  });

  it("asks for a risky command a machine-surface turn caused when the person opted in, and runs nothing", async () => {
    setPolicy({ machineTurns: "ask" });
    const asked = await commandTool("cli-api").execute({ command: RISKY, cwd: dir });
    expect(asked.hostCard?.type).toBe("approval-card");
    expect(asked.hostCard?.origin).toBe("cli-api");
    expect(allRows<{ kind: string }>(services.runtime.db, "SELECT kind FROM events WHERE stream = 'activity'")).toEqual([]);
    // A local write is not a risky effect, so it still runs, and its activity row and audit entry say who asked.
    const ran = await commandTool("mcp").execute({ command: LOCAL, cwd: dir });
    expect(ran.text).toContain("origin-ran");
    const effects = (await request("GET", "/activity")).body as { effects: { origin?: string }[] };
    expect(effects.effects.map((effect) => effect.origin)).toEqual(["mcp"]);
  });
});

describe("an approval of a program's command", () => {
  it("keeps the program's origin on the turn that carries on, so its next risky step is still asked about", async () => {
    // Ask every time, so even a local command raises a card; the opt-in is on, as a person relying on it would have it.
    setPolicy({ mode: "ask", machineTurns: "ask" });
    const ledger = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now, newId: services.conductor.newId };
    const toolFor = (origin: TurnOrigin) => {
      const tool = createNodeTools({
        search: services.search,
        projects: services.projects,
        origin: () => origin,
        command: {
          approvals: () => ledger,
          autonomy: () => readExecutionPolicy({ db: services.runtime.db, now }, owner()),
          resources: () => ownedResources([dir, process.cwd()]),
          fallbackCwd: () => dir,
          newId: () => services.conductor.newId("tool"),
        },
      }).find((candidate) => candidate.name === "run_command");
      if (tool === undefined) throw new Error("run_command is not registered");
      return tool as unknown as { execute: (params: Record<string, unknown>) => Promise<{ hostCard?: Record<string, unknown> }> };
    };

    const asked = await toolFor("mcp").execute({ command: `node -e "process.stdout.write('approved-ran')"`, cwd: dir });
    const card = asked.hostCard as { type: "approval-card"; approvalId: string; operationDigest: string; origin?: string };
    expect(card).toMatchObject({ type: "approval-card", origin: "mcp" });
    appendHostReply(services, { conversationId, blocks: [card as never], at: AT });

    const decided = await request("POST", `/conversations/${conversationId}/approvals/${card.approvalId}/decide`, {
      decision: "granted",
      digest: card.operationDigest,
    });
    expect(decided.status).toBe(200);

    // The person decided, but the record keeps who asked.
    const audited = listAuditEvents(services.runtime.db, owner()).filter((entry) => entry.ref === card.approvalId);
    expect(audited.map((entry) => entry.origin)).toEqual(["mcp"]);
    // The turn that carries on is still the program's, not the person's.
    const continued = originOf("Lệnh đã được duyệt và đã chạy xong.");
    expect(continued).toBe("mcp");
    // So the next risky step that turn takes is asked about again, rather than run on the strength of one approval.
    setPolicy({ machineTurns: "ask" });
    const next = await toolFor(continued as TurnOrigin).execute({ command: "git push origin main", cwd: dir });
    expect(next.hostCard).toMatchObject({ type: "approval-card", origin: "mcp" });
  });
});

describe("a capability invocation", () => {
  const REF = "com.example.mail.send@1" as CapabilityRef;
  const calls: string[] = [];

  function serviceHost(): ServiceHost {
    return {
      reconcile: async () => undefined,
      call: async (ref) => {
        calls.push(ref);
        return { content: "sent" };
      },
      serves: (ref) => (ref === REF ? { packageId: "com.example.mail", generationId: "com.example.mail@1.0.0:code_1" } : undefined),
      stopAll: async () => 0,
      status: () => [],
    };
  }

  function invoke(origin: TurnOrigin) {
    return invokeCapability(
      {
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        principalId: owner(),
        newId: services.conductor.newId,
        serviceHost: serviceHost(),
        now,
      },
      { ref: REF, args: {}, source: "agent", conversationId, origin },
    );
  }

  beforeEach(() => {
    calls.length = 0;
    registerCapability(
      { db: services.runtime.db, nodeId: services.runtime.identity.nodeId },
      {
        ref: REF,
        executionNodeId: services.runtime.identity.nodeId,
        summary: "Send a mail",
        resourceKinds: [],
        effectCategory: "communication",
        supportsCancellation: false,
        requiresConnection: false,
        readiness: { installed: true, loaded: true, authenticated: true, authorized: true, healthy: true },
        uiAffordances: [],
      },
    );
  });

  it("decides a machine-surface turn exactly as the person's with the default policy", async () => {
    const person = await invoke("person");
    const machine = await invoke("relay");
    expect(person.kind).toBe(machine.kind);
    expect(machine.kind).toBe("done");
    expect(calls).toEqual([REF, REF]);
  });

  it("asks before a machine-surface turn's risky call when the person opted in, and the card says who asked", async () => {
    setPolicy({ machineTurns: "ask" });
    const asked = await invoke("mcp");
    expect(asked.kind).toBe("approval-required");
    if (asked.kind !== "approval-required") return;
    expect(asked.card.origin).toBe("mcp");
    expect(calls).toEqual([]);
    // The person's own turn is unchanged by the opt-in.
    expect((await invoke("person")).kind).toBe("done");
  });
});

describe("set_map_tiles", () => {
  const PROVIDER: MapTileProvider = {
    origin: "https://tiles.example",
    template: "/styles/basic/{z}/{x}/{y}.png",
    attribution: "© Example contributors",
    maxZoom: 17,
  };

  function tool(origin: TurnOrigin) {
    return createMapTilesTool({
      deps: () => ({
        db: services.runtime.db,
        nodeId: services.runtime.identity.nodeId,
        now,
        newId: services.conductor.newId,
        principalId: owner(),
      }),
      conversationId,
      channel: () => "chat",
      origin: () => origin,
    });
  }

  it("decides a machine-surface turn exactly as the person's with the default policy, and records who asked", async () => {
    const person = await tool("person").execute({ action: "set", ...PROVIDER });
    const machine = await tool("mcp").execute({ action: "set", ...PROVIDER, origin: "https://tiles2.example" });
    expect(person.hostCard).toBeUndefined();
    expect(machine.hostCard).toBeUndefined();
    const effects = (await request("GET", "/activity")).body as { effects: { origin?: string }[] };
    expect(effects.effects.map((effect) => effect.origin).sort()).toEqual(["mcp", "person"]);
  });

  it("asks for a machine-surface turn when the person opted in, and the card says who asked", async () => {
    setPolicy({ machineTurns: "ask" });
    const asked = await tool("relay").execute({ action: "set", ...PROVIDER });
    expect(asked.hostCard).toMatchObject({ type: "approval-card", origin: "relay", effectCategory: "external-write" });
    expect((await tool("person").execute({ action: "set", ...PROVIDER })).hostCard).toBeUndefined();
  });
});

describe("the opt-in is a view of the one policy", () => {
  async function machineTurns(): Promise<unknown> {
    const listed = (await request("GET", "/preferences")).body as { preferences: { key: string; value: unknown }[] };
    return listed.preferences.find((preference) => preference.key === "execution.machineTurns")?.value;
  }

  it("defaults to the person's own policy, and is written, read and undone through the policy", async () => {
    expect(await machineTurns()).toBe("as-person");
    const written = await request("PUT", "/preferences/execution.machineTurns", { value: "ask" });
    expect(written).toMatchObject({ status: 200, body: { preference: { key: "execution.machineTurns", value: "ask" } } });
    expect(readExecutionPolicy({ db: services.runtime.db, now }, owner()).machineTurns).toBe("ask");
    expect(await machineTurns()).toBe("ask");
    expect((await request("POST", "/preferences/execution.machineTurns/undo", {})).status).toBe(200);
    expect(readExecutionPolicy({ db: services.runtime.db, now }, owner()).machineTurns).toBeUndefined();
    expect((await request("PUT", "/preferences/execution.machineTurns", { value: "never" })).status).toBe(400);
  });

  it("undoes only this choice, and not a change to the mode written after it", async () => {
    expect((await request("PUT", "/preferences/execution.machineTurns", { value: "ask" })).status).toBe(200);
    expect((await request("PUT", "/preferences/execution.mode", { value: "ask" })).status).toBe(200);
    // The last policy write changed the mode, not this choice: there is nothing of this key to undo, and the mode stays.
    const refused = await request("POST", "/preferences/execution.machineTurns/undo", {});
    expect(refused).toMatchObject({ status: 200, body: { undone: false } });
    expect(readExecutionPolicy({ db: services.runtime.db, now }, owner())).toMatchObject({ mode: "ask", machineTurns: "ask" });

    // A write that did change it is undone, and only this axis moves.
    setPolicy({ mode: "ask", machineTurns: "ask" });
    expect((await request("PUT", "/preferences/execution.machineTurns", { value: "as-person" })).status).toBe(200);
    const undone = await request("POST", "/preferences/execution.machineTurns/undo", {});
    expect(undone).toMatchObject({ status: 200, body: { undone: true, preference: { value: "ask" } } });
    expect(readExecutionPolicy({ db: services.runtime.db, now }, owner())).toMatchObject({ mode: "ask", machineTurns: "ask" });
  });

  it("survives a save of the autonomy settings, which do not name it", async () => {
    setPolicy({ machineTurns: "ask" });
    const settings = ((await request("GET", "/autonomy")).body as { settings: Record<string, unknown> }).settings;
    expect((await request("POST", "/autonomy", { settings })).status).toBe(200);
    expect(readExecutionPolicy({ db: services.runtime.db, now }, owner()).machineTurns).toBe("ask");
  });
});

describe("the activity log and the audit trail name the origin", () => {
  it("drops an origin the host does not record rather than passing it through", async () => {
    services.runtime.db
      .prepare(
        `INSERT INTO events (event_id, source_node_id, stream, source_sequence, kind, document, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("evt_forged", services.runtime.identity.nodeId, "activity", 1, "effect.executed", JSON.stringify({ origin: "god" }), AT);
    const effects = (await request("GET", "/activity")).body as { effects: Record<string, unknown>[] };
    expect(effects.effects[0]).not.toHaveProperty("origin");
  });

  it("writes the origin into the audit entry of a command, and reads it back", async () => {
    const ledger = { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now, newId: services.conductor.newId };
    const tool = createNodeTools({
      search: services.search,
      projects: services.projects,
      origin: () => "relay",
      command: {
        approvals: () => ledger,
        autonomy: () => DEFAULT_EXECUTION_POLICY_CONFIG,
        resources: () => ownedResources([dir, process.cwd()]),
        fallbackCwd: () => dir,
        newId: () => services.conductor.newId("tool"),
        // The node's own sink, the way the bootstrap wires it: one row in the audit log per finished command.
        audit: (event) =>
          appendAuditEvent(services.runtime.db, {
            auditId: services.conductor.newId("audit"),
            principalId: owner(),
            nodeId: services.runtime.identity.nodeId,
            kind: "command",
            at: AT,
            summary: event.summary,
            outcome: event.outcome,
            ...(event.origin === undefined ? {} : { origin: event.origin }),
          }),
      },
    }).find((candidate) => candidate.name === "run_command");
    if (tool === undefined) throw new Error("run_command is not registered");
    await tool.execute({ command: `node -e "process.stdout.write('audited')"`, cwd: dir });
    const entries = listAuditEvents(services.runtime.db, owner());
    expect(entries.map((entry) => entry.origin)).toEqual(["relay"]);
  });
});
