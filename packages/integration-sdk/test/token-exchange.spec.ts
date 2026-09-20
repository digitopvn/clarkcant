import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createPkcePair, s256 } from "../src/index.ts";
import { exchangeAuthorizationCode, refreshAccessToken } from "../src/token-exchange.ts";

/**
 * The authorization-code exchange and the refresh loop (V09).
 *
 * These run against a token endpoint this test starts on loopback, and the point of that endpoint is that it checks
 * PKCE for real: it recomputes `s256(code_verifier)` from the verifier it is sent and compares it to the challenge
 * it was given when the authorization request was built. An implementation that sent the challenge instead of the
 * verifier, or a verifier that did not match, fails here rather than passing on a fixture that accepts anything.
 *
 * What this cannot prove is named in the ledger: no provider account exists, so the endpoint a live connection would
 * use has never been called.
 */

interface Received {
  grantType: string;
  codeVerifier: string | undefined;
  clientId: string;
  redirectUri: string | undefined;
  refreshToken: string | undefined;
  contentType: string;
}

let servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  servers = [];
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface TokenEndpoint {
  origin: string;
  endpoint: string;
  received: Received[];
  /** Set by the test before a call: the challenge the authorization request carried. */
  expectedChallenge: string;
}

/**
 * Start a token endpoint.
 *
 * `answer` decides what the endpoint replies with, so a test can drive a refusal or a partial grant without a second
 * server. A request whose verifier does not match the recorded challenge is answered `400 invalid_grant` — that is
 * what a real provider does, and it is the check that makes PKCE more than a formality.
 */
async function startTokenEndpoint(
  answer: (received: Received) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }> = () => ({
    status: 200,
    body: { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600, scope: "calendar.read" },
  }),
): Promise<TokenEndpoint> {
  const received: Received[] = [];
  const state: TokenEndpoint = { origin: "", endpoint: "", received, expectedChallenge: "" };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const body = await readBody(request);
      const form = new URLSearchParams(body);
      const record: Received = {
        grantType: form.get("grant_type") ?? "",
        codeVerifier: form.get("code_verifier") ?? undefined,
        clientId: form.get("client_id") ?? "",
        redirectUri: form.get("redirect_uri") ?? undefined,
        refreshToken: form.get("refresh_token") ?? undefined,
        contentType: request.headers["content-type"] ?? "",
      };
      received.push(record);

      if (record.grantType === "authorization_code" && record.codeVerifier !== undefined) {
        if (s256(record.codeVerifier) !== state.expectedChallenge) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
      }

      const answered = await answer(record);
      response.writeHead(answered.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answered.body));
    })();
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fixture endpoint did not bind a port");
  state.origin = `http://127.0.0.1:${String(address.port)}`;
  state.endpoint = `${state.origin}/token`;
  return state;
}

const DESCRIPTOR = { requestedScopes: ["calendar.read"], optionalScopes: [] };

describe("exchanging an authorization code", () => {
  it("sends the verifier whose challenge the provider recorded, and reads the grant back", async () => {
    const endpoint = await startTokenEndpoint();
    const pair = createPkcePair();
    // The authorization request already went out with this challenge; the endpoint recomputes it from the verifier.
    endpoint.expectedChallenge = pair.challenge;

    const result = await exchangeAuthorizationCode({
      endpoint: endpoint.endpoint,
      allowedOrigins: [endpoint.origin],
      clientId: "client_1",
      redirectUri: "http://127.0.0.1:9000/callback",
      code: "code_1",
      verifier: pair.verifier,
      expectedState: "state_1",
      receivedState: "state_1",
      descriptor: DESCRIPTOR,
      fetchImpl: fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.accessToken).toBe("at_1");
    expect(result.grant.refreshToken).toBe("rt_1");
    expect(result.grant.expiresInSeconds).toBe(3600);
    expect(result.grant.scopes.status).toBe("full");
    expect(endpoint.received).toHaveLength(1);
    expect(endpoint.received[0]?.grantType).toBe("authorization_code");
    // The verifier, not the challenge: sending the challenge would be sending the thing the provider must not see
    // until the token request, and it is the failure a fixture that accepts anything would hide.
    expect(endpoint.received[0]?.codeVerifier).toBe(pair.verifier);
    expect(endpoint.received[0]?.contentType).toContain("application/x-www-form-urlencoded");
  });

  it("does not send a code that arrived with a state this node did not issue", async () => {
    const endpoint = await startTokenEndpoint();
    const pair = createPkcePair();
    endpoint.expectedChallenge = pair.challenge;

    const result = await exchangeAuthorizationCode({
      endpoint: endpoint.endpoint,
      allowedOrigins: [endpoint.origin],
      clientId: "client_1",
      redirectUri: "http://127.0.0.1:9000/callback",
      code: "code_from_someone_else",
      verifier: pair.verifier,
      expectedState: "state_1",
      receivedState: "state_2",
      descriptor: DESCRIPTOR,
      fetchImpl: fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.code).toBe("STATE_MISMATCH");
    // The assertion that makes this about ordering rather than about a message: nothing was sent at all.
    expect(endpoint.received).toHaveLength(0);
  });

  it("reports a grant that came back with fewer scopes than were asked for", async () => {
    const endpoint = await startTokenEndpoint(() => ({
      status: 200,
      body: { access_token: "at_1", scope: "calendar.freebusy" },
    }));
    const pair = createPkcePair();
    endpoint.expectedChallenge = pair.challenge;

    const result = await exchangeAuthorizationCode({
      endpoint: endpoint.endpoint,
      allowedOrigins: [endpoint.origin],
      clientId: "client_1",
      redirectUri: "http://127.0.0.1:9000/callback",
      code: "code_1",
      verifier: pair.verifier,
      expectedState: "state_1",
      receivedState: "state_1",
      descriptor: DESCRIPTOR,
      fetchImpl: fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.grant.scopes.status : "").toBe("partial");
    expect(result.ok ? result.grant.scopes.missingRequired : []).toEqual(["calendar.read"]);
  });

  it("refuses a 200 that carries no access token", async () => {
    const endpoint = await startTokenEndpoint(() => ({ status: 200, body: { token_type: "Bearer" } }));
    const pair = createPkcePair();
    endpoint.expectedChallenge = pair.challenge;

    const result = await exchangeAuthorizationCode({
      endpoint: endpoint.endpoint,
      allowedOrigins: [endpoint.origin],
      clientId: "client_1",
      redirectUri: "http://127.0.0.1:9000/callback",
      code: "code_1",
      verifier: pair.verifier,
      expectedState: "state_1",
      receivedState: "state_1",
      descriptor: DESCRIPTOR,
      fetchImpl: fetch,
    });

    expect(result.ok ? "" : result.code).toBe("INVALID_RESPONSE");
  });

  it("refuses an endpoint outside the declared allowlist before anything is sent", async () => {
    const result = await exchangeAuthorizationCode({
      endpoint: "https://tokens.example.com/token",
      allowedOrigins: ["https://accounts.example.com"],
      clientId: "client_1",
      redirectUri: "http://127.0.0.1:9000/callback",
      code: "code_1",
      verifier: "verifier_1",
      expectedState: "state_1",
      receivedState: "state_1",
      descriptor: DESCRIPTOR,
      fetchImpl: fetch,
    });

    expect(result.ok ? "" : result.code).toBe("ENDPOINT_REFUSED");
  });

  it("refuses a plaintext endpoint that is not on this machine", async () => {
    const result = await exchangeAuthorizationCode({
      endpoint: "http://tokens.example.com/token",
      allowedOrigins: ["http://tokens.example.com"],
      clientId: "client_1",
      redirectUri: "http://127.0.0.1:9000/callback",
      code: "code_1",
      verifier: "verifier_1",
      expectedState: "state_1",
      receivedState: "state_1",
      descriptor: DESCRIPTOR,
      fetchImpl: fetch,
    });

    expect(result.ok ? "" : result.code).toBe("ENDPOINT_REFUSED");
    expect(result.ok ? "" : result.message).toContain("not HTTPS");
  });

  it("gives up on an endpoint that does not answer, rather than waiting forever", async () => {
    const endpoint = await startTokenEndpoint(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return { status: 200, body: { access_token: "too_late" } };
    });
    const pair = createPkcePair();
    endpoint.expectedChallenge = pair.challenge;

    const result = await exchangeAuthorizationCode({
      endpoint: endpoint.endpoint,
      allowedOrigins: [endpoint.origin],
      clientId: "client_1",
      redirectUri: "http://127.0.0.1:9000/callback",
      code: "code_1",
      verifier: pair.verifier,
      expectedState: "state_1",
      receivedState: "state_1",
      descriptor: DESCRIPTOR,
      fetchImpl: fetch,
      timeoutMs: 60,
    });

    expect(result.ok ? "" : result.code).toBe("TIMED_OUT");
  });
});

describe("refreshing a token", () => {
  it("sends the refresh grant and reads the new access token back", async () => {
    const endpoint = await startTokenEndpoint(() => ({
      status: 200,
      body: { access_token: "at_2", expires_in: 1800, scope: "calendar.read" },
    }));

    const result = await refreshAccessToken({
      endpoint: endpoint.endpoint,
      allowedOrigins: [endpoint.origin],
      clientId: "client_1",
      refreshToken: "rt_1",
      descriptor: DESCRIPTOR,
      fetchImpl: fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.grant.accessToken : "").toBe("at_2");
    // A refresh that issued no new refresh token leaves the connection unable to be refreshed again silently, and
    // saying that is the point: the field stays undefined rather than repeating the old one.
    expect(result.ok ? result.grant.refreshToken : "unset").toBeUndefined();
    expect(endpoint.received[0]?.grantType).toBe("refresh_token");
    expect(endpoint.received[0]?.refreshToken).toBe("rt_1");
  });
});
