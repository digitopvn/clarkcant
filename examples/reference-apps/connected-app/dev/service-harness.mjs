/*
 * TEST/DEV FIXTURE — a stand-in for the node, for testing this package's service on its own.
 *
 * It starts `service/server.mjs` over standard streams the way the node does, offers it `clarkcant/egress`, and answers
 * its `clarkcant/egress.fetch` requests the way the node's broker does for a connection: only to the connection's
 * declared endpoints, with the account's access token added as `authorization: Bearer …` by this harness, never by the
 * service. It does none of the node's other work (policy, the effect ledger, readiness, redaction), so it proves what
 * the service sends and how it reads the answers, not that a node would let the call run.
 *
 * Zero dependencies, so a package scaffolded from this one can run its tests with `node --test`.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PACKAGE = new URL("../", import.meta.url);

/** The package's connection, as its manifest declares it. */
export function declaredConnection() {
  const manifest = JSON.parse(readFileSync(new URL("clarkcant.json", PACKAGE), "utf8"));
  return manifest.facets.find((facet) => facet.kind === "tools")?.connection;
}

/**
 * Start the service. `token()` answers the access token to add, or undefined to refuse the request as the node would
 * for a connection that is not usable. `rebase(url)` may point a declared endpoint at the fake connector's real port.
 */
export function startService({ token, rebase = (url) => url, methodsAllowed = ["GET", "HEAD", "PATCH", "POST", "PUT", "DELETE"] }) {
  const connection = declaredConnection();
  const endpoints = new Set(connection.endpoints);
  const child = spawn(process.execPath, [fileURLToPath(new URL("service/server.mjs", PACKAGE))], { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  /** Every egress request the service asked for, as it asked: proof it never sent a credential of its own. */
  const egressRequests = [];
  let nextId = 0;
  let buffer = "";

  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  async function answerEgress(message) {
    const params = message.params ?? {};
    egressRequests.push(params);
    let url;
    try {
      url = new URL(params.url);
    } catch {
      return write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "not a URL" } });
    }
    if (!endpoints.has(url.origin)) {
      return write({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: `${url.origin} is not a declared endpoint` } });
    }
    const method = params.method ?? "GET";
    if (!methodsAllowed.includes(method)) {
      return write({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: `${method} is not allowed for this call` } });
    }
    const bearer = await token();
    if (bearer === undefined) {
      return write({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "the connection is not usable" } });
    }
    const headers = { ...(params.headers ?? {}), authorization: `Bearer ${bearer}` };
    const body = params.body === undefined ? undefined : Buffer.from(params.body.data, params.body.encoding);
    const response = await fetch(rebase(url.toString()), { method, headers, ...(body === undefined ? {} : { body }) });
    const bytes = Buffer.from(await response.arrayBuffer());
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { status: response.status, headers: {}, body: { encoding: "base64", data: bytes.toString("base64") } },
    });
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.length === 0) continue;
      const message = JSON.parse(line);
      if (message.method === "clarkcant/egress.fetch") {
        void answerEgress(message);
        continue;
      }
      const resolve = waiting.get(message.id);
      if (resolve !== undefined) {
        waiting.delete(message.id);
        resolve(message);
      }
    }
  });

  function request(method, params) {
    nextId += 1;
    const id = nextId;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      write({ jsonrpc: "2.0", id, method, params });
    });
  }

  const ready = request("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "service-harness", version: "1.0.0" },
    capabilities: { experimental: { "clarkcant/egress": { version: 1 } } },
  });

  return {
    egressRequests,
    async tools() {
      await ready;
      return (await request("tools/list", {})).result.tools;
    },
    /** Call one tool; answers `{ text, isError }`. */
    async call(name, args = {}) {
      await ready;
      const answer = await request("tools/call", { name, arguments: args });
      return { text: answer.result?.content?.[0]?.text ?? "", isError: answer.result?.isError === true };
    },
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}

/**
 * Connect to the fake connector the way the node does — PKCE, state, the code exchanged at the token endpoint — and
 * answer the tokens. For tests only: on a node, this happens in the host and the tokens never leave it.
 */
export async function connectToFake(connector, { scopes } = {}) {
  const { createHash, randomBytes } = await import("node:crypto");
  const connection = declaredConnection();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const redirectUri = "http://127.0.0.1:1/connections/callback";
  const authorize = new URL("/oauth/authorize", connector.origin);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", connection.authorization.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", (scopes ?? connection.scopes.map((entry) => entry.scope)).join(" "));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  const consent = await fetch(authorize, { redirect: "manual" });
  const back = new URL(consent.headers.get("location") ?? "");
  if (back.searchParams.get("state") !== state) throw new Error("the fake connector answered another state");
  const code = back.searchParams.get("code");
  if (code === null) throw new Error(`the fake connector answered ${back.searchParams.get("error") ?? "no code"}`);
  const response = await fetch(new URL("/oauth/token", connector.origin), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: connection.authorization.clientId,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!response.ok) throw new Error(`the token endpoint answered ${String(response.status)}`);
  return await response.json();
}
