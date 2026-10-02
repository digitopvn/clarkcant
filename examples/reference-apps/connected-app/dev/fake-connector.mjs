/*
 * TEST/DEV FIXTURE — NOT A REAL PROVIDER.
 *
 * A fake connector for the connected-app package: a tiny OAuth server and a tiny task API, both on loopback, so the
 * whole connection path — consent, PKCE, the scope grant, refresh, revoke, the egress broker adding the token — can be
 * run and tested on one machine with no account anywhere. Every code and token it issues is a random test value that
 * lives only in this process's memory; it has no client secret at all (PKCE needs none).
 *
 * Two listeners, on purpose:
 *
 *   provider  http://127.0.0.1:<port>        what the package declares: /oauth/authorize, /oauth/token, /oauth/revoke,
 *                                            GET /api/me (the probe), GET /api/tasks (tasks.read),
 *                                            PATCH /api/tasks/:id (tasks.write).
 *   admin     http://127.0.0.1:<adminPort>   for tests only: change how the provider behaves, revoke every grant, count
 *                                            writes, list every secret issued. On its own port so a package whose
 *                                            endpoint allowlist names the provider can never reach it through the node.
 *
 * Run it by hand with `node dev/fake-connector.mjs` (FAKE_CONNECTOR_PORT, FAKE_CONNECTOR_ADMIN_PORT; 8880 and 8881 by
 * default), or import `startFakeConnector` from a test. Zero dependencies.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

/** The public client id the package declares. Public: a PKCE client has no secret to keep. */
export const FAKE_CLIENT_ID = "connected-app-dev";
/** What the fake provider can grant. */
export const FAKE_SCOPES = ["tasks.read", "tasks.write"];

const INITIAL_TASKS = [
  { id: "task-1", title: "Viết báo cáo tuần", done: false },
  { id: "task-2", title: "Gọi lại cho nhà cung cấp", done: false },
  { id: "task-3", title: "Dọn hộp thư", done: true },
];

function defaultMode() {
  return {
    /** Scopes the consent screen grants; null grants every scope that was asked for. */
    grantScopes: null,
    /** How long an access token lives. */
    accessTtlSeconds: 3600,
    /** Whether a refresh token is issued with a grant. */
    issueRefresh: true,
    /** When true, every refresh is refused with invalid_grant, as a provider does after the grant is gone. */
    refreshFails: false,
    /** A write is applied at once but answered only after this long, to stand in for a response lost in flight. */
    writeDelayMs: 0,
    /** When set, the consent screen answers this OAuth error instead of a code. */
    denyWith: null,
  };
}

function random(prefix) {
  return `${prefix}-${randomBytes(24).toString("base64url")}`;
}

function challengeOf(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function isLoopbackRedirect(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.hash === "";
  } catch {
    return false;
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(text);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}

/**
 * Start the fake provider and its admin listener. Port 0 picks a free port for either.
 *
 * @param {{ port?: number, adminPort?: number }} [options]
 */
export async function startFakeConnector(options = {}) {
  let mode = defaultMode();
  let tasks = INITIAL_TASKS.map((task) => ({ ...task }));
  let writes = 0;
  let reads = 0;
  /** code -> { challenge, redirectUri, scopes, used } */
  const codes = new Map();
  /** One grant per consent: its tokens are revoked together. */
  const grants = new Map();
  /** access token -> { grantId, expiresAt } */
  const accessTokens = new Map();
  /** refresh token -> grantId */
  const refreshTokens = new Map();
  /** Every code and token ever issued, so a test can prove none of them leaked anywhere. */
  const issued = [];

  function issue(grantId) {
    const grant = grants.get(grantId);
    const access = random("fake-access");
    issued.push(access);
    accessTokens.set(access, { grantId, expiresAt: Date.now() + mode.accessTtlSeconds * 1000 });
    const answer = {
      access_token: access,
      token_type: "Bearer",
      expires_in: mode.accessTtlSeconds,
      scope: grant.scopes.join(" "),
    };
    if (mode.issueRefresh) {
      const refresh = random("fake-refresh");
      issued.push(refresh);
      refreshTokens.set(refresh, grantId);
      answer.refresh_token = refresh;
    }
    return answer;
  }

  function revokeGrant(grantId) {
    const grant = grants.get(grantId);
    if (grant !== undefined) grant.revoked = true;
  }

  /** The grant behind a bearer token, or why there is none (401). */
  function authorize(request) {
    const header = String(request.headers.authorization ?? "");
    const match = /^Bearer (\S+)$/.exec(header);
    if (match === null) return { ok: false, why: "no bearer token" };
    const access = accessTokens.get(match[1]);
    if (access === undefined) return { ok: false, why: "unknown token" };
    const grant = grants.get(access.grantId);
    if (grant === undefined || grant.revoked) return { ok: false, why: "the grant was revoked" };
    if (access.expiresAt <= Date.now()) return { ok: false, why: "the token expired" };
    return { ok: true, grant };
  }

  async function provider(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (request.method === "GET" && path === "/oauth/authorize") {
      const query = url.searchParams;
      const redirectUri = query.get("redirect_uri") ?? "";
      // Nothing is ever redirected to a URI that is not loopback: a code must not leave the machine.
      if (!isLoopbackRedirect(redirectUri)) return send(response, 400, { error: "invalid_request", error_description: "redirect_uri must be loopback" });
      if (query.get("client_id") !== FAKE_CLIENT_ID) return send(response, 400, { error: "unauthorized_client" });
      const back = new URL(redirectUri);
      const state = query.get("state");
      if (state !== null) back.searchParams.set("state", state);
      const challenge = query.get("code_challenge") ?? "";
      if (query.get("response_type") !== "code" || query.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
        back.searchParams.set("error", "invalid_request");
      } else if (mode.denyWith !== null) {
        back.searchParams.set("error", String(mode.denyWith));
      } else {
        const asked = (query.get("scope") ?? "").split(" ").filter((scope) => FAKE_SCOPES.includes(scope));
        const scopes = asked.filter((scope) => mode.grantScopes === null || mode.grantScopes.includes(scope));
        const code = random("fake-code");
        issued.push(code);
        codes.set(code, { challenge, redirectUri, scopes, used: false });
        back.searchParams.set("code", code);
      }
      // The consent is automatic: this is where a real provider would show its own page to the person.
      response.writeHead(302, { location: back.toString(), "cache-control": "no-store" });
      response.end();
      return;
    }

    if (request.method === "POST" && path === "/oauth/token") {
      const form = new URLSearchParams(await readBody(request));
      if (form.get("client_id") !== FAKE_CLIENT_ID) return send(response, 401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        if (code === undefined || code.used) return send(response, 400, { error: "invalid_grant" });
        code.used = true;
        if (code.redirectUri !== form.get("redirect_uri")) return send(response, 400, { error: "invalid_grant" });
        if (challengeOf(form.get("code_verifier") ?? "") !== code.challenge) return send(response, 400, { error: "invalid_grant" });
        const grantId = random("grant");
        grants.set(grantId, { scopes: code.scopes, revoked: false });
        return send(response, 200, issue(grantId));
      }
      if (form.get("grant_type") === "refresh_token") {
        const token = form.get("refresh_token") ?? "";
        const grantId = refreshTokens.get(token);
        const grant = grantId === undefined ? undefined : grants.get(grantId);
        if (grant === undefined || grant.revoked || mode.refreshFails) return send(response, 400, { error: "invalid_grant" });
        // Rotated: the refresh token just used cannot be used again.
        refreshTokens.delete(token);
        return send(response, 200, issue(grantId));
      }
      return send(response, 400, { error: "unsupported_grant_type" });
    }

    if (request.method === "POST" && path === "/oauth/revoke") {
      const form = new URLSearchParams(await readBody(request));
      const token = form.get("token") ?? "";
      const grantId = refreshTokens.get(token) ?? accessTokens.get(token)?.grantId;
      if (grantId !== undefined) revokeGrant(grantId);
      // RFC 7009: an unknown token is answered 200 as well.
      return send(response, 200, {});
    }

    if (path.startsWith("/api/")) {
      const auth = authorize(request);
      if (!auth.ok) return send(response, 401, { error: "invalid_token", error_description: auth.why }, { "www-authenticate": 'Bearer error="invalid_token"' });
      const needs = (scope) => {
        if (auth.grant.scopes.includes(scope)) return true;
        send(response, 403, { error: "insufficient_scope", scope }, { "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}"` });
        return false;
      };
      if (request.method === "GET" && path === "/api/me") return send(response, 200, { id: "fake-user", name: "Người dùng thử" });
      if (request.method === "GET" && path === "/api/tasks") {
        if (!needs("tasks.read")) return;
        reads += 1;
        return send(response, 200, { tasks });
      }
      const match = /^\/api\/tasks\/([A-Za-z0-9-]{1,40})$/.exec(path);
      if (request.method === "PATCH" && match !== null) {
        if (!needs("tasks.write")) return;
        let body;
        try {
          body = JSON.parse(await readBody(request));
        } catch {
          return send(response, 400, { error: "invalid_json" });
        }
        const title = typeof body?.title === "string" ? body.title.trim() : "";
        if (title.length === 0 || title.length > 200) return send(response, 422, { error: "title must be 1 to 200 characters" });
        const task = tasks.find((candidate) => candidate.id === match[1]);
        if (task === undefined) return send(response, 404, { error: "no such task" });
        // Applied first, answered after the delay: the write took effect even if the answer never arrives.
        task.title = title;
        writes += 1;
        if (mode.writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, mode.writeDelayMs));
        if (!response.destroyed) send(response, 200, { task });
        return;
      }
      return send(response, 404, { error: "not found" });
    }

    send(response, 404, { error: "not found" });
  }

  async function admin(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (request.method === "POST" && path === "/admin/mode") {
      let patch;
      try {
        patch = JSON.parse((await readBody(request)) || "{}");
      } catch {
        return send(response, 400, { error: "invalid_json" });
      }
      const allowed = Object.keys(defaultMode());
      for (const [key, value] of Object.entries(patch ?? {})) if (allowed.includes(key)) mode[key] = value;
      return send(response, 200, { mode });
    }
    if (request.method === "POST" && path === "/admin/revoke-all") {
      for (const grantId of grants.keys()) revokeGrant(grantId);
      return send(response, 200, {});
    }
    if (request.method === "POST" && path === "/admin/expire-all") {
      for (const access of accessTokens.values()) access.expiresAt = 0;
      return send(response, 200, {});
    }
    if (request.method === "POST" && path === "/admin/reset") {
      mode = defaultMode();
      tasks = INITIAL_TASKS.map((task) => ({ ...task }));
      writes = 0;
      reads = 0;
      return send(response, 200, {});
    }
    if (request.method === "GET" && path === "/admin/stats") return send(response, 200, { reads, writes, tasks, mode });
    if (request.method === "GET" && path === "/admin/secrets") return send(response, 200, { secrets: issued });
    send(response, 404, { error: "not found" });
  }

  const wrap = (handler) => (request, response) => {
    handler(request, response).catch(() => {
      if (!response.headersSent) send(response, 400, { error: "invalid_request" });
      else response.destroy();
    });
  };
  const providerServer = createServer(wrap(provider));
  const adminServer = createServer(wrap(admin));
  const port = await listen(providerServer, options.port ?? 0);
  const adminPort = await listen(adminServer, options.adminPort ?? 0);

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    adminOrigin: `http://127.0.0.1:${String(adminPort)}`,
    clientId: FAKE_CLIENT_ID,
    /** Every code and token issued so far. */
    secrets: () => [...issued],
    stats: () => ({ reads, writes, tasks: tasks.map((task) => ({ ...task })) }),
    setMode: (patch) => {
      for (const [key, value] of Object.entries(patch)) if (key in mode) mode[key] = value;
    },
    revokeAll: () => {
      for (const grantId of grants.keys()) revokeGrant(grantId);
    },
    close: () =>
      Promise.all(
        [providerServer, adminServer].map(
          (server) =>
            new Promise((resolve) => {
              server.closeAllConnections?.();
              server.close(() => resolve(undefined));
            }),
        ),
      ).then(() => undefined),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connector = await startFakeConnector({
    port: Number(process.env.FAKE_CONNECTOR_PORT ?? 8880),
    adminPort: Number(process.env.FAKE_CONNECTOR_ADMIN_PORT ?? 8881),
  });
  process.stdout.write(`fake connector (TEST/DEV FIXTURE, not a real provider) on ${connector.origin}, admin on ${connector.adminOrigin}\n`);
  const stop = () => {
    void connector.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
