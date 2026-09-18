import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRequest, type GatewayDeps, type GatewayRequest } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

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
