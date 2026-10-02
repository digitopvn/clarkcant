import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FAKE_CLIENT_ID, startFakeConnector } from "../dev/fake-connector.mjs";

/**
 * The fake connector is a test fixture, but the connection path's tests are only as honest as it is: a fake that
 * accepted a wrong verifier, a reused code or a revoked token would let the node's checks pass without being exercised.
 * These hold it to the parts of OAuth the node relies on.
 */

type Connector = Awaited<ReturnType<typeof startFakeConnector>>;
let connector: Connector;

beforeAll(async () => {
  connector = await startFakeConnector();
});
afterAll(async () => {
  await connector.close();
});
beforeEach(async () => {
  await fetch(`${connector.adminOrigin}/admin/reset`, { method: "POST" });
});

const REDIRECT = "http://127.0.0.1:4100/connections/callback";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function authorize(overrides: Record<string, string> = {}): Promise<{ location: URL; verifier: string }> {
  const { verifier, challenge } = pkce();
  const url = new URL("/oauth/authorize", connector.origin);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: FAKE_CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: "tasks.read tasks.write",
    state: "state-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { redirect: "manual" });
  expect(response.status).toBe(302);
  return { location: new URL(response.headers.get("location") ?? ""), verifier };
}

async function token(form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL("/oauth/token", connector.origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: FAKE_CLIENT_ID, ...form }).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function connect(scope = "tasks.read tasks.write"): Promise<Record<string, unknown>> {
  const { location, verifier } = await authorize({ scope });
  const exchanged = await token({
    grant_type: "authorization_code",
    code: location.searchParams.get("code") ?? "",
    code_verifier: verifier,
    redirect_uri: REDIRECT,
  });
  expect(exchanged.status).toBe(200);
  return exchanged.body;
}

function api(path: string, access: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(path, connector.origin), {
    ...init,
    headers: { authorization: `Bearer ${String(access)}`, "content-type": "application/json" },
  });
}

describe("the fake connector's consent", () => {
  it("redirects only to a loopback URI, with the state it was given", async () => {
    const { location } = await authorize();
    expect(location.origin).toBe("http://127.0.0.1:4100");
    expect(location.searchParams.get("state")).toBe("state-1");
    expect(location.searchParams.get("code")).toMatch(/^fake-code-/);

    const elsewhere = await fetch(
      `${connector.origin}/oauth/authorize?response_type=code&client_id=${FAKE_CLIENT_ID}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}`,
      { redirect: "manual" },
    );
    expect(elsewhere.status).toBe(400);
  });

  it("refuses an authorization without an S256 challenge", async () => {
    const { location } = await authorize({ code_challenge_method: "plain" });
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("grants only the scopes its mode allows, and says so in the token response", async () => {
    connector.setMode({ grantScopes: ["tasks.read"] });
    const grant = await connect();
    expect(grant.scope).toBe("tasks.read");
  });

  it("answers a denial as an OAuth error instead of a code", async () => {
    connector.setMode({ denyWith: "access_denied" });
    const { location } = await authorize();
    expect(location.searchParams.get("error")).toBe("access_denied");
  });
});

describe("the fake connector's token endpoint", () => {
  it("checks the PKCE verifier and the redirect, and takes a code once", async () => {
    const { location, verifier } = await authorize();
    const code = location.searchParams.get("code") ?? "";
    expect((await token({ grant_type: "authorization_code", code, code_verifier: "wrong-verifier", redirect_uri: REDIRECT })).status).toBe(400);

    const second = await authorize();
    const secondCode = second.location.searchParams.get("code") ?? "";
    expect(
      (await token({ grant_type: "authorization_code", code: secondCode, code_verifier: second.verifier, redirect_uri: "http://127.0.0.1:1/other" })).status,
    ).toBe(400);

    const third = await authorize();
    const thirdCode = third.location.searchParams.get("code") ?? "";
    const form = { grant_type: "authorization_code", code: thirdCode, code_verifier: third.verifier, redirect_uri: REDIRECT };
    expect((await token(form)).status).toBe(200);
    expect((await token(form)).status).toBe(400);
    expect(verifier).not.toBe(third.verifier);
  });

  it("rotates the refresh token, and refuses one after a revoke or when told to", async () => {
    const grant = await connect();
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: String(grant.refresh_token) });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(grant.access_token);
    // The one just used cannot be used again.
    expect((await token({ grant_type: "refresh_token", refresh_token: String(grant.refresh_token) })).status).toBe(400);

    connector.setMode({ refreshFails: true });
    expect((await token({ grant_type: "refresh_token", refresh_token: String(refreshed.body.refresh_token) })).status).toBe(400);
  });

  it("revokes the whole grant from either token", async () => {
    const grant = await connect();
    const revoked = await fetch(new URL("/oauth/revoke", connector.origin), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: String(grant.refresh_token), client_id: FAKE_CLIENT_ID }).toString(),
    });
    expect(revoked.status).toBe(200);
    expect((await api("/api/me", grant.access_token)).status).toBe(401);
    expect((await token({ grant_type: "refresh_token", refresh_token: String(grant.refresh_token) })).status).toBe(400);
  });
});

describe("the fake connector's API", () => {
  it("answers the probe, a read and a write for a token with the scopes", async () => {
    const grant = await connect();
    expect((await api("/api/me", grant.access_token)).status).toBe(200);
    const listed = (await (await api("/api/tasks", grant.access_token)).json()) as { tasks: { id: string }[] };
    expect(listed.tasks.map((task) => task.id)).toEqual(["task-1", "task-2", "task-3"]);
    const written = await api("/api/tasks/task-2", grant.access_token, { method: "PATCH", body: JSON.stringify({ title: "Đã gọi" }) });
    expect(written.status).toBe(200);
    expect(connector.stats().writes).toBe(1);
    expect(connector.stats().tasks.find((task: { id: string }) => task.id === "task-2")?.title).toBe("Đã gọi");
  });

  it("answers 401 for no token, an unknown one and an expired one, and 403 naming a missing scope", async () => {
    expect((await fetch(new URL("/api/me", connector.origin))).status).toBe(401);
    expect((await api("/api/me", "fake-access-unknown")).status).toBe(401);

    const reader = await connect("tasks.read");
    const refused = await api("/api/tasks/task-1", reader.access_token, { method: "PATCH", body: JSON.stringify({ title: "x" }) });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { scope: string }).scope).toBe("tasks.write");

    await fetch(`${connector.adminOrigin}/admin/expire-all`, { method: "POST" });
    expect((await api("/api/me", reader.access_token)).status).toBe(401);
  });

  it("applies a slow write before it answers, so a lost answer still changed the account", async () => {
    const grant = await connect();
    connector.setMode({ writeDelayMs: 400 });
    const controller = new AbortController();
    const pending = api("/api/tasks/task-1", grant.access_token, { method: "PATCH", body: JSON.stringify({ title: "Chậm" }), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(connector.stats().writes).toBe(1);
    expect(connector.stats().tasks[0]?.title).toBe("Chậm");
  });
});

describe("the fake connector's admin port", () => {
  it("is not reachable on the provider's origin, which is the one a package declares", async () => {
    expect((await fetch(new URL("/admin/secrets", connector.origin))).status).toBe(404);
    expect(connector.adminOrigin).not.toBe(connector.origin);
  });

  it("lists every code and token it issued, so a test can look for them anywhere", async () => {
    const grant = await connect();
    const listed = (await (await fetch(`${connector.adminOrigin}/admin/secrets`)).json()) as { secrets: string[] };
    expect(listed.secrets).toContain(grant.access_token);
    expect(listed.secrets).toContain(grant.refresh_token);
    expect(listed.secrets.some((secret) => secret.startsWith("fake-code-"))).toBe(true);
  });
});
