import { PERSON_ONLY_REFUSAL, type ServiceConnectionRequirement, nowInstant } from "@clarkcant/contracts";
import { readDirectory, listInstalledPackages } from "@clarkcant/core";
import type { Database } from "@clarkcant/storage";

import type { PackageConnectionBroker } from "../package-connections.ts";
import { installedConnection, installedManifest } from "../package-resources.ts";
import type { ServiceHost } from "../service-host.ts";
import { type GatewayRequest, type GatewayResponse, SURFACE_HEADER, fail, json } from "./http.ts";

/**
 * A package's account connection, as the host's own Settings drives it.
 *
 *   GET  /packages/:id/connection         its status: state, scopes, why it is not usable. Never a token.
 *   POST /packages/:id/connection         start connecting: answers the provider's authorization URL, which the client
 *                                         opens in the system browser. Person-only (`isPersonOnlyRoute`).
 *   POST /packages/:id/connection/revoke  end it at the provider and on this node, at once.
 *   GET  /connections/callback/:id        where the provider sends the browser back. Public, before the gateway's token
 *                                         check, because a browser following a redirect carries no token: the single-use
 *                                         `state` the node issued is what authenticates it. Answers a page that never
 *                                         repeats the code.
 *
 * Every change is written to the service host's readiness at once, so a capability that needs the connection becomes
 * ready or not ready, with the reason, before the request answers.
 */
export interface ConnectionRouteDeps {
  services: {
    runtime: { db: Database; identity: { nodeId: string; ownerPrincipalId: string }; dataDir: string };
    conductor: { newId: (prefix: string) => string };
    serviceHost?: Pick<ServiceHost, "refreshAuthentication"> | undefined;
    connections?: PackageConnectionBroker | undefined;
  };
  request: GatewayRequest;
  segments: string[];
}

function cameThroughMachineSurface(request: GatewayRequest): boolean {
  const marker = request.headers[SURFACE_HEADER];
  return marker === "mcp" || marker === "relay";
}

/** The connection an installed package declares, or why there is none to work with. */
function declaredConnection(
  services: ConnectionRouteDeps["services"],
  packageId: string,
): { ok: true; connection: ServiceConnectionRequirement } | { ok: false; response: GatewayResponse } {
  const { runtime } = services;
  const installed = listInstalledPackages({
    db: runtime.db,
    nodeId: runtime.identity.nodeId,
    now: nowInstant,
    newId: services.conductor.newId,
  }).find((entry) => entry.packageId === packageId);
  if (installed === undefined) {
    return { ok: false, response: fail(404, "NOT_INSTALLED", `${packageId} is not installed on this node`) };
  }
  const manifest = installedManifest(installed, runtime.dataDir, readDirectory({ env: process.env, dataDir: runtime.dataDir }));
  if (manifest === "unreadable") {
    return { ok: false, response: fail(409, "MANIFEST_UNREADABLE", `this node cannot read ${packageId}'s manifest`) };
  }
  const connection = installedConnection(manifest);
  if (connection === undefined) {
    return { ok: false, response: fail(404, "NO_CONNECTION", `${packageId} does not connect to an account`) };
  }
  return { ok: true, connection };
}

/**
 * Where the provider sends the browser back: this node, over loopback, on the port the request came in on. A node
 * reached under any other name — through a relay, a tunnel or a LAN address — is refused, because the redirect has to
 * land on the machine whose browser is being sent, and a provider must never be told to send a code across a network.
 *
 * Each package gets its own callback path. A provider that sends a code back to one package's path cannot have been
 * asked by another package's authorization server pretending to be it (the OAuth mix-up attack): the node checks that
 * the authorization the state names was started for the package the path names, before the code goes anywhere.
 */
function loopbackRedirect(request: GatewayRequest, packageId: string): string | undefined {
  const raw = request.headers.host;
  const host = Array.isArray(raw) ? raw[0] : raw;
  if (host === undefined) return undefined;
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(host);
  if (match === null) return undefined;
  return `http://${match[1] ?? "127.0.0.1"}:${match[2] ?? ""}/connections/callback/${encodeURIComponent(packageId)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${String(character.charCodeAt(0))};`);
}

/** The page the system browser shows after a provider redirect. Static text; never the code, state or a token. */
function callbackPage(status: number, title: string, message: string): GatewayResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f6f4;color:#1b1b1b}main{max-width:32rem;padding:2rem}@media (prefers-color-scheme:dark){body{background:#141414;color:#eee}}</style></head>
<body><main><h1 data-connection-result="${status === 200 ? "connected" : "failed"}">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>You can close this tab and return to ClarkCant.</p></main></body></html>`;
  return {
    status,
    body: null,
    binary: {
      bytes: Buffer.from(html, "utf8"),
      contentType: "text/html; charset=utf-8",
      cache: "no-store",
      headers: {
        // The page's own URL carries the code until the tab closes; nothing it loads may be sent that URL.
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    },
  };
}

/** The public callback. Called before the gateway's token check. */
export async function handleConnectionCallback(deps: ConnectionRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments, services } = deps;
  if (!(segments[0] === "connections" && segments[1] === "callback" && request.method === "GET")) return undefined;
  if (segments.length !== 3) return callbackPage(400, "Not connected", "This is not a connection this node started. Start it again from Settings.");
  let packageId: string;
  try {
    packageId = decodeURIComponent(segments[2] ?? "");
  } catch {
    return callbackPage(400, "Not connected", "This is not a connection this node started. Start it again from Settings.");
  }
  if (services.connections === undefined) {
    return callbackPage(503, "Not connected", "This node does not connect accounts for packages.");
  }
  const result = await services.connections.complete(packageId, request.query);
  if (result.packageId !== undefined) services.serviceHost?.refreshAuthentication?.(result.packageId);
  if (!result.ok) return callbackPage(400, "Not connected", result.message);
  const scopes = result.status.state === "partial" ? ` It did not grant ${result.status.missingScopes.join(", ")}, so what needs that is unavailable.` : "";
  return callbackPage(200, `Connected to ${result.status.displayName}`, `${result.status.displayName} is connected.${scopes}`);
}

export async function handleConnectionRoutes(deps: ConnectionRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments, services } = deps;
  const isConnection = segments[0] === "packages" && segments[2] === "connection";
  if (!isConnection || (segments.length !== 3 && segments.length !== 4)) return undefined;
  if (segments.length === 4 && segments[3] !== "revoke") return undefined;

  let packageId: string;
  try {
    packageId = decodeURIComponent(segments[1] ?? "");
  } catch {
    return fail(400, "INVALID_SCHEMA", "the package id in the path is not valid percent-encoding");
  }
  const broker = services.connections;

  if (segments.length === 3 && request.method === "GET") {
    const declared = declaredConnection(services, packageId);
    if (!declared.ok) return declared.response;
    if (broker === undefined) return fail(503, "CONNECTIONS_UNAVAILABLE", "this node does not connect accounts for packages");
    return json(200, { connection: broker.status(packageId, declared.connection) });
  }

  if (segments.length === 3 && request.method === "POST") {
    if (cameThroughMachineSurface(request)) return fail(403, PERSON_ONLY_REFUSAL.code, PERSON_ONLY_REFUSAL.message);
    const declared = declaredConnection(services, packageId);
    if (!declared.ok) return declared.response;
    if (broker === undefined) return fail(503, "CONNECTIONS_UNAVAILABLE", "this node does not connect accounts for packages");
    const redirectUri = loopbackRedirect(request, packageId);
    if (redirectUri === undefined) {
      return fail(
        409,
        "CONNECT_ON_THIS_MACHINE",
        `${declared.connection.displayName} can be connected only from the machine this node runs on, where its browser can come back to it`,
      );
    }
    const started = broker.start({ packageId, connection: declared.connection, redirectUri });
    if (!started.ok) return fail(409, started.code, started.message);
    return json(200, { authorizationUrl: started.authorizationUrl });
  }

  if (segments.length === 4 && request.method === "POST") {
    const declared = declaredConnection(services, packageId);
    if (!declared.ok) return declared.response;
    if (broker === undefined) return fail(503, "CONNECTIONS_UNAVAILABLE", "this node does not connect accounts for packages");
    const status = await broker.revoke(packageId, declared.connection);
    services.serviceHost?.refreshAuthentication?.(packageId);
    return json(200, { connection: status });
  }

  return undefined;
}
