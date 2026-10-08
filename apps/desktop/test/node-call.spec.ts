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

  it("adds a caller's headers without letting them replace the host's credential", async () => {
    const send = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => answer(200, {}));
    const callNode = createNodeCaller({ readSession: () => SESSION, fetch: send });
    await callNode("/x", { headers: { "x-clarkcant-surface": "composer", authorization: "Bearer forged" } });
    expect(send.mock.calls[0]?.[1]?.headers).toEqual({
      "x-clarkcant-surface": "composer",
      "content-type": "application/json",
      authorization: `Bearer ${SESSION.token}`,
    });
  });

  it("drops a caller's header the host sets, in any spelling, so the two values are never joined", async () => {
    const send = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => answer(200, {}));
    const callNode = createNodeCaller({ readSession: () => SESSION, fetch: send });
    await callNode("/x", {
      headers: { "X-ClarkCant-Surface": "composer", Authorization: "Bearer forged", AUTHORIZATION: "Bearer forged", "Content-Type": "text/plain" },
    });
    const sent = send.mock.calls[0]?.[1]?.headers;
    expect(sent).toEqual({
      "x-clarkcant-surface": "composer",
      "content-type": "application/json",
      authorization: `Bearer ${SESSION.token}`,
    });
    // What the node reads, after the fetch layer folds names together.
    const folded = new Headers(sent);
    expect(folded.get("authorization")).toBe(`Bearer ${SESSION.token}`);
    expect(folded.get("content-type")).toBe("application/json");
  });

  it("gives up on a node that sends its status and never finishes the body", async () => {
    const callNode = createNodeCaller({
      readSession: () => SESSION,
      fetch: async (_url: URL | RequestInfo, init?: RequestInit) =>
        ({
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            }),
        }) as unknown as Response,
    });
    expect(await callNode("/x", { timeoutMs: 20 })).toMatchObject({ ok: false, code: "NODE_TIMEOUT" });
  });

  it("gives up on a call the node accepts and never answers, and says so", async () => {
    const callNode = createNodeCaller({
      readSession: () => SESSION,
      fetch: (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    expect(await callNode("/x", { timeoutMs: 20 })).toMatchObject({ ok: false, code: "NODE_TIMEOUT" });
  });

  it("refuses before calling when there is no node session", async () => {
    const send = vi.fn();
    const callNode = createNodeCaller({ readSession: () => ({ ok: false, refused: "no --data-dir was given" }), fetch: send });
    expect(await callNode("/x")).toMatchObject({ ok: false, refused: "no --data-dir was given", code: "NO_NODE_SESSION" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("an export from the node", () => {
  it("answers the bytes, unparsed, with the node's name and type for them", async () => {
    const callNode = createNodeCaller({
      readSession: () => SESSION,
      fetch: async () =>
        new Response("hello", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": 'attachment; filename="notes.txt"' },
        }),
    });
    const result = await callNode("/artifacts/art_1/export", { method: "POST", body: {}, binary: true });
    expect(result).toMatchObject({ ok: true, contentType: "text/plain; charset=utf-8", contentDisposition: 'attachment; filename="notes.txt"' });
    expect(result.ok && "bytes" in result ? Buffer.from(result.bytes as Uint8Array).toString("utf8") : undefined).toBe("hello");
  });

  it("still reads a refusal as the node's JSON", async () => {
    const callNode = createNodeCaller({
      readSession: () => SESSION,
      fetch: async () => answer(403, { code: "ARTIFACT_NOT_OWNED", message: "not yours" }),
    });
    expect(await callNode("/artifacts/art_1/export", { method: "POST", binary: true })).toMatchObject({ ok: false, code: "ARTIFACT_NOT_OWNED" });
  });
});