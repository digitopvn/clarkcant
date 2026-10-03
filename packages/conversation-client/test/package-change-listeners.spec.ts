import { describe, expect, it } from "vitest";

import { GatewayClient } from "../src/api.ts";

/**
 * Hearing about a package change this client made.
 *
 * The node does not push package changes, so a surface that draws something a package provides re-reads it when this
 * client changes a package. The claims: a change the node accepted is announced, one it refused is not, and a surface
 * that stopped listening is not called again.
 */

function clientAnswering(status: number): GatewayClient {
  return new GatewayClient({
    baseUrl: "http://127.0.0.1:8765",
    token: "tok",
    fetchImpl: (async () =>
      new Response(JSON.stringify(status === 200 ? { state: "active" } : { code: "NOT_INSTALLED", message: "no" }), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
}

describe("installPackage", () => {
  /** A client that records each body it sent, answering every call as installed. */
  function recording(): { client: GatewayClient; bodies: unknown[] } {
    const bodies: unknown[] = [];
    const client = new GatewayClient({
      baseUrl: "http://127.0.0.1:8765",
      token: "tok",
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
        return new Response(JSON.stringify({ state: "active" }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    return { client, bodies };
  }

  it("sends back the content digest a listing by a path showed, and nothing in its place when there was none", async () => {
    const { client, bodies } = recording();
    await client.installPackage("com.example.local", "1.0.0", "sha256:files-as-listed");
    await client.installPackage("com.acme.dashboard", "1.0.0");
    expect(bodies).toEqual([
      { packageId: "com.example.local", version: "1.0.0", contentDigest: "sha256:files-as-listed" },
      { packageId: "com.acme.dashboard", version: "1.0.0" },
    ]);
  });
});

describe("onPackagesChanged", () => {
  it("is called after an install and after an uninstall the node accepted", async () => {
    const client = clientAnswering(200);
    let calls = 0;
    client.onPackagesChanged(() => {
      calls += 1;
    });

    await client.installPackage("com.example.theme-dusk", "1.0.0");
    await client.changePackage("com.example.theme-dusk", "uninstall");

    expect(calls).toBe(2);
  });

  it("is not called when the node refused the change", async () => {
    const client = clientAnswering(404);
    let calls = 0;
    client.onPackagesChanged(() => {
      calls += 1;
    });

    await expect(client.changePackage("com.example.missing", "uninstall")).rejects.toThrow();

    expect(calls).toBe(0);
  });

  it("stops calling a listener that unsubscribed", async () => {
    const client = clientAnswering(200);
    let calls = 0;
    const stop = client.onPackagesChanged(() => {
      calls += 1;
    });
    stop();

    await client.changePackage("com.example.theme-dusk", "restore");

    expect(calls).toBe(0);
  });
});
