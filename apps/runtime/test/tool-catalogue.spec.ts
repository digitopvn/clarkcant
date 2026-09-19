import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";
import { PI_BUILTIN_TOOLS, nodeToolCatalogue, registerNodeTools } from "../src/tool-catalogue.ts";

/**
 * The Tools tab's source.
 *
 * The list has to be the node's own rather than something an interface assembled, because the question it answers is
 * "what can this machine actually do" - and a list invented by the half of the system that is asking is a list that
 * agrees with itself.
 */

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-tools-"));
  services = bootNodeServices({ dataDir: dir, label: "test node" });
  deps = { services, now: () => "2026-09-19T01:00:00.000Z" };
});

afterEach(() => {
  registerNodeTools([]);
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string): Promise<GatewayResponse> {
  const request: GatewayRequest = {
    method: "GET",
    path,
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: "",
  };
  return handleRequest(deps, request);
}

describe("the tools a node reports", () => {
  it("offers nothing before the node's tools have been built", () => {
    // A node whose tools were never built has none to offer. An interface that filled the gap with a list of its own
    // would be describing a node that is not the one running.
    expect(nodeToolCatalogue()).toEqual([]);
  });

  it("reports the harness's own tools and the agent's separately", async () => {
    registerNodeTools([{ name: "run_command", label: "Chạy một lệnh", description: "Sau khi bạn duyệt." }]);

    const response = await get("/tools");
    expect(response.status).toBe(200);
    const body = response.body as {
      self?: { name?: string }[];
      agent?: { name?: string }[];
      agentNote?: string;
    };
    expect(body.self?.map((tool) => tool.name)).toEqual(["run_command"]);
    expect(body.agent?.map((tool) => tool.name)).toEqual(PI_BUILTIN_TOOLS.map((tool) => tool.name));
    // The note is part of the answer: a list of built-ins without it reads as the whole of what the agent can do.
    expect(body.agentNote).toBeTruthy();
  });
});
