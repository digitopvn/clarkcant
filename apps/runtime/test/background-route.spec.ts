import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRequest, type GatewayDeps, type GatewayRequest } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { configureNodeWork, createWorkSupervisor, nodeWork, type WorkSupervisor } from "../src/work-supervisor.ts";

/**
 * Asking for background work directly.
 *
 * The decider is one way a background request happens; a person highlighting a passage and saying "do this elsewhere"
 * is the other, and it must not depend on the decider having an opinion. The success path needs a model, which this
 * node deliberately has none of, so what is asserted here is the contract around it: a body it cannot use is refused
 * with a reason, and a node that cannot run background work says so instead of accepting and doing nothing.
 */

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-bg-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  deps = { services, now: () => "2026-09-19T01:00:00.000Z" };
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const request: GatewayRequest = {
    method: "POST",
    path: "/background-sessions",
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
  const response = await handleRequest(deps, request);
  return { status: response.status, body: response.body as Record<string, unknown> };
}

describe("a background request", () => {
  it("is refused when it does not say what to run", async () => {
    const missingText = await post({ conversationId: "c1", text: "   " });
    expect(missingText.status).toBe(400);

    const missingConversation = await post({ text: "làm việc này" });
    expect(missingConversation.status).toBe(400);
  });

  it("is refused by a node with no model, rather than accepted and forgotten", async () => {
    // Accepting would be the worse failure: the caller would show a worker that never runs and never reports.
    const response = await post({ conversationId: "c1", text: "làm việc này" });
    expect(response.status).toBe(409);
    expect(String(response.body.message)).toContain("việc nền");
  });
});

describe("what is running, and stopping one piece of it", () => {
  let previous: WorkSupervisor;

  beforeEach(() => {
    previous = nodeWork();
    configureNodeWork(createWorkSupervisor({ backgroundLimit: () => 1 }));
  });

  afterEach(() => {
    configureNodeWork(previous);
  });

  async function call(method: string, path: string, query: Record<string, string> = {}) {
    const request: GatewayRequest = {
      method,
      path,
      query,
      headers: { authorization: `Bearer ${services.runtime.identity.localToken}`, "content-type": "application/json" },
      body: method === "POST" ? "{}" : "",
    };
    const response = await handleRequest(deps, request);
    return { status: response.status, body: response.body as Record<string, unknown> };
  }

  function held(conversationId: string): string {
    const started = nodeWork().submitBackground({
      conversationId,
      title: `work in ${conversationId}`,
      requestText: "x",
      run: (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason as Error))),
    });
    if (!started.accepted) throw new Error("should be admitted");
    return started.workId;
  }

  it("counts running and waiting work, with the limit it was admitted under", async () => {
    held("c1");
    held("c1");
    const response = await call("GET", "/background-sessions");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ running: 1, queued: 1, limit: 1 });
  });

  it("lists work per conversation without a pid or a path", async () => {
    const mine = held("c1");
    held("c2");

    const response = await call("GET", "/work", { conversationId: "c1" });
    const work = response.body.work as { workId: string }[];
    expect(work.map((entry) => entry.workId)).toEqual([mine]);
    expect(JSON.stringify(response.body)).not.toMatch(/"pid"|"cwd"/);
  });

  it("stops one piece of work by id and says what happened, and 404s an id it does not hold", async () => {
    const workId = held("c1");

    const stopped = await call("POST", `/work/${workId}/cancel`);
    expect(stopped).toMatchObject({ status: 200, body: { workId, outcome: "stopped" } });

    const unknown = await call("POST", "/work/nope/cancel");
    expect(unknown.status).toBe(404);
  });
});
