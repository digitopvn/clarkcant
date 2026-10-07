import { describe, expect, it, vi } from "vitest";

import { createNodeCaller, nodeRefusal } from "../src/node-call.mjs";

/**
 * The host's calls to the node, with the node's token.
 *
 * A detached window answers its widget from the structure of a refusal - a stale state write carries the state and
 * revision the node holds - so the host must hand that structure on rather than a sentence made from it.
 */

const SESSION = { ok: true as const, baseUrl: "http://127.0.0.1:8765", token: "test-token-not-a-credential" };

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("a refusal from the node keeps its structure", () => {
  it("keeps the code, the node's sentence and the rest of the body as details", () => {
    const refusal = nodeRefusal(409, {
      code: "STATE_REVISION_CONFLICT",
      message: "the state changed since it was read",
      state: { text: "newer" },
      stateRevision: 7,
    });
    expect(refusal).toEqual({
      ok: false,
      refused: "the node refused: the state changed since it was read",
      status: 409,
      code: "STATE_REVISION_CONFLICT",
      details: { state: { text: "newer" }, stateRevision: 7 },
    });
  });

  it("says the status when the body is not a refusal the node wrote", () => {
    expect(nodeRefusal(502, undefined)).toEqual({ ok: false, refused: "the node refused: status 502", status: 502, code: "UNKNOWN", details: {} });
    expect(nodeRefusal(500, ["not", "an", "object"])).toMatchObject({ code: "UNKNOWN", details: {} });
  });
});

describe("calling the node", () => {
  it("sends the node's token from the host and answers the body", async () => {
    const send = vi.fn(async () => answer(200, { claimed: true }));
    const callNode = createNodeCaller({ readSession: () => SESSION, fetch: send });
    const result = await callNode("/conversations/c/widgets/w/live-owner", { method: "POST", body: { ownerToken: "o" } });
    expect(result).toEqual({ ok: true, body: { claimed: true } });
    expect(send).toHaveBeenCalledWith("http://127.0.0.1:8765/conversations/c/widgets/w/live-owner", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SESSION.token}` },
      body: JSON.stringify({ ownerToken: "o" }),
    });
  });

  it("hands a refusal on with the node's code and details", async () => {
    const callNode = createNodeCaller({
      readSession: () => SESSION,
      fetch: async () => answer(409, { code: "ALREADY_OWNED", message: "another surface holds the live view of this instance", heldBySurface: "pin" }),
    });
    expect(await callNode("/x", { method: "POST" })).toEqual({
      ok: false,
      refused: "the node refused: another surface holds the live view of this instance",
      status: 409,
      code: "ALREADY_OWNED",
      details: { heldBySurface: "pin" },
    });
  });

  it("tells an unreachable node apart from a refusal", async () => {
    const callNode = createNodeCaller({
      readSession: () => SESSION,
      fetch: async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
    });
    expect(await callNode("/x")).toMatchObject({ ok: false, code: "NODE_UNREACHABLE", refused: "the node could not be reached (ECONNREFUSED)" });
  });

  it("refuses before calling when there is no node session", async () => {
    const send = vi.fn();
    const callNode = createNodeCaller({ readSession: () => ({ ok: false, refused: "no --data-dir was given" }), fetch: send });
    expect(await callNode("/x")).toMatchObject({ ok: false, refused: "no --data-dir was given", code: "NO_NODE_SESSION" });
    expect(send).not.toHaveBeenCalled();
  });
});
