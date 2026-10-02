import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EGRESS_ERROR_CODES, type EffectCategory, type Instant, type ServiceEgress } from "@clarkcant/contracts";
import { McpServerRequestError } from "@clarkcant/mcp-adapters";
import { type Database, deleteCredential, migrate, openDatabase } from "@clarkcant/storage";

import { storeCredentialFields } from "../src/application/credential-vault.ts";
import { createSecretBroker } from "../src/secret-broker.ts";
import {
  type EgressAuditEvent,
  type EgressHandlerDeps,
  egressAllowsPrivateNetwork,
  egressRequestHandler,
  egressSecretProblem,
  isPrivateNetworkHost,
  packageConsumer,
  secretForms,
} from "../src/service-egress.ts";

/**
 * Egress for a package service, against a real HTTP server on loopback.
 *
 * The provider here is a plain `node:http` server that records what reached it, so every assertion about the secret
 * is checked where it matters: on the wire to the provider (it is there, for the declared origin only) and in what the
 * service gets back (it is not, even when the provider echoes it).
 */

const AT = "2026-10-01T09:00:00.000Z" as Instant;
const OWNER = "owner_1";
const PACKAGE = "com.example.search";

let dir: string;
let db: Database;
let server: Server;
let port: number;
let secret: string;
let seen: { url: string; headers: IncomingHttpHeaders }[];
let audit: EgressAuditEvent[];
let hold: (() => void)[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-egress-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  // Generated here, so no value in this file could be mistaken for a real key.
  secret = `fake-${randomBytes(16).toString("hex")}`;
  seen = [];
  audit = [];
  hold = [];
  server = createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    const path = request.url ?? "/";
    if (path === "/redirect") {
      response.writeHead(302, { location: "https://elsewhere.example/steal" }).end();
      return;
    }
    if (path === "/large") {
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.alloc(3 * 1024 * 1024, 1));
      return;
    }
    if (path === "/hold") {
      response.writeHead(200);
      response.write("partial");
      hold.push(() => response.end());
      return;
    }
    if (path === "/echo-encoded") {
      // A provider that echoes the credential encoded: JSON with `\/` escaping, URL-encoded, and inside base64.
      const sent = String(request.headers.authorization ?? "");
      const escaped = JSON.stringify(sent).replaceAll("/", "\\/");
      const inspected = Buffer.from(JSON.stringify({ sub: "me", authorization: sent })).toString("base64");
      const urlSafe = Buffer.from(`token=${sent}`).toString("base64url");
      response.writeHead(200, { "content-type": "application/json", "x-echo-url": encodeURIComponent(sent) });
      response.end(`{"escaped":${escaped},"url":"${encodeURIComponent(sent)}","inspected":"${inspected}","urlSafe":"${urlSafe}"}`);
      return;
    }
    if (path === "/encoding") {
      response.writeHead(200, { "content-type": "text/plain" }).end(String(request.headers["accept-encoding"] ?? ""));
      return;
    }
    // A careless provider: it repeats the credential it was sent, in a header and in the body.
    const echoed = String(request.headers.authorization ?? "");
    response.writeHead(200, { "content-type": "application/json", "x-echo": echoed, "set-cookie": "session=1" });
    response.end(JSON.stringify({ ok: true, youSent: echoed }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const release of hold) release();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Two declared origins on the same provider: only the first gets the credential. */
function egress(): ServiceEgress {
  return {
    version: 1,
    secrets: [{ name: "SEARCH_API_KEY", purpose: "Authenticates searches." }],
    origins: [
      {
        origin: `http://127.0.0.1:${String(port)}`,
        purpose: "Runs searches.",
        credential: { secret: "SEARCH_API_KEY", header: "authorization", scheme: "bearer" },
      },
      { origin: `http://localhost:${String(port)}`, purpose: "Fetches thumbnails." },
    ],
  };
}

function storeSecret(consumer: string): void {
  let ids = 0;
  const outcome = storeCredentialFields(
    { db, ownerPrincipalId: OWNER, nodeId: "node_1", newId: (prefix) => `${prefix}_${String(++ids)}` },
    [{ name: "SEARCH_API_KEY", value: secret, kind: "token", consumer }],
  );
  expect(outcome.ok).toBe(true);
}

/**
 * The handler for one running service, during a call decided as `effects` (a read, unless a test says otherwise).
 * The provider here is on loopback, so the node setting that allows those origins is on unless a test turns it off.
 */
function handler(
  inCall: AbortController | null = new AbortController(),
  options: Partial<Pick<EgressHandlerDeps, "allowPrivateNetwork" | "now" | "rate" | "refusalWindowMs">> & { effects?: EffectCategory[] } = {},
) {
  const { effects = ["read"], ...rest } = options;
  return egressRequestHandler({
    packageId: PACKAGE,
    egress: egress(),
    secrets: createSecretBroker({ db, principalId: OWNER, now: () => AT }),
    secretProblem: (name) => egressSecretProblem({ db, principalId: OWNER }, PACKAGE, name),
    inCall: () => (inCall === null ? undefined : { signal: inCall.signal, effects }),
    audit: (event) => audit.push(event),
    allowPrivateNetwork: true,
    ...rest,
  });
}

function fetchParams(url: string, extra: Record<string, unknown> = {}) {
  return { method: "clarkcant/egress.fetch", params: { version: 1, url, ...extra }, signal: new AbortController().signal };
}

async function refusal(promise: Promise<unknown>): Promise<McpServerRequestError> {
  const caught = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(caught).toBeInstanceOf(McpServerRequestError);
  return caught as McpServerRequestError;
}

const decode = (data: string): string => Buffer.from(data, "base64").toString("utf8");

describe("egress for a package service", () => {
  it("adds the declared credential for the declared origin, and returns nothing that holds it", async () => {
    storeSecret(packageConsumer(PACKAGE));
    const result = await handler()(fetchParams(`http://127.0.0.1:${String(port)}/search?q=x`));

    // On the wire to the provider, the host added the key.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${secret}`);
    // In what the service gets back, the provider's echo is gone, from headers and body alike, and so is its cookie.
    expect(result.status).toBe(200);
    expect(result.headers["x-echo"]).toBe("[redacted]");
    expect(result.headers).not.toHaveProperty("set-cookie");
    expect(JSON.parse(decode(result.body.data))).toEqual({ ok: true, youSent: "[redacted]" });
    expect(JSON.stringify(result)).not.toContain(secret);

    // The trail names the package, the origin and the secret, never the path or the value.
    expect(audit).toEqual([
      { packageId: PACKAGE, method: "GET", origin: `http://127.0.0.1:${String(port)}`, secret: "SEARCH_API_KEY", outcome: "done", status: 200 },
    ]);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain("q=x");
  });

  it("sends no credential to a declared origin that does not name one", async () => {
    storeSecret(packageConsumer(PACKAGE));
    const result = await handler()(fetchParams(`http://localhost:${String(port)}/thumb`));
    expect(result.status).toBe(200);
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("refuses an origin the package did not declare, before anything is sent", async () => {
    storeSecret(packageConsumer(PACKAGE));
    const error = await refusal(handler()(fetchParams(`http://[::1]:${String(port)}/search`)));
    expect(error.code).toBe(EGRESS_ERROR_CODES.originNotDeclared);
    expect(seen).toEqual([]);
    expect(audit[0]).toMatchObject({ outcome: "refused", origin: `http://[::1]:${String(port)}` });
  });

  it("refuses a url that carries credentials of its own", async () => {
    const error = await refusal(handler()(fetchParams(`http://user:pw@127.0.0.1:${String(port)}/`)));
    expect(error.code).toBe(EGRESS_ERROR_CODES.invalid);
    expect(seen).toEqual([]);
  });

  it("answers only while the host is calling the service", async () => {
    storeSecret(packageConsumer(PACKAGE));
    const error = await refusal(handler(null)(fetchParams(`http://127.0.0.1:${String(port)}/search`)));
    expect(error.code).toBe(EGRESS_ERROR_CODES.notInCall);
    expect(seen).toEqual([]);
  });

  it("does not use a secret the person did not store for this package, even one any consumer may use", async () => {
    storeSecret("");
    const error = await refusal(handler()(fetchParams(`http://127.0.0.1:${String(port)}/search`)));
    expect(error.code).toBe(EGRESS_ERROR_CODES.credentialUnavailable);
    expect(error.message).toBe("the secret SEARCH_API_KEY is not stored for this package");
    expect(seen).toEqual([]);
  });

  it("says a secret was never provided, and that one taken back has no value, without reading either", () => {
    expect(egressSecretProblem({ db, principalId: OWNER }, PACKAGE, "SEARCH_API_KEY")).toBe(
      "the secret SEARCH_API_KEY has not been provided on this node",
    );
    storeSecret(packageConsumer(PACKAGE));
    expect(egressSecretProblem({ db, principalId: OWNER }, PACKAGE, "SEARCH_API_KEY")).toBeUndefined();
    storeSecret("command:gh");
    expect(egressSecretProblem({ db, principalId: OWNER }, PACKAGE, "SEARCH_API_KEY")).toBe(
      "the secret SEARCH_API_KEY is not stored for this package",
    );
    storeSecret(`command:gh,${packageConsumer(PACKAGE)}`);
    expect(egressSecretProblem({ db, principalId: OWNER }, PACKAGE, "SEARCH_API_KEY")).toBe(
      "the secret SEARCH_API_KEY is not allowed to be sent as a request header",
    );
    storeSecret(packageConsumer(PACKAGE));
    deleteCredential(db, OWNER, "SEARCH_API_KEY");
    expect(egressSecretProblem({ db, principalId: OWNER }, PACKAGE, "SEARCH_API_KEY")).toBe("the secret SEARCH_API_KEY has no value on this node");
  });

  it("drops headers only the host's client sets, and the service's own attempt at the credential header", async () => {
    storeSecret(packageConsumer(PACKAGE));
    await handler()(
      fetchParams(`http://127.0.0.1:${String(port)}/search`, {
        headers: { Authorization: "Bearer mine", cookie: "a=1", "x-forwarded-for": "10.0.0.1", "proxy-authorization": "p", accept: "application/json" },
      }),
    );
    const headers = seen[0]?.headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${secret}`);
    expect(headers.cookie).toBeUndefined();
    expect(headers["x-forwarded-for"]).toBeUndefined();
    expect(headers["proxy-authorization"]).toBeUndefined();
    expect(headers.accept).toBe("application/json");
  });

  it("returns a redirect as it came instead of following it with the credential", async () => {
    storeSecret(packageConsumer(PACKAGE));
    const result = await handler()(fetchParams(`http://127.0.0.1:${String(port)}/redirect`));
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe("https://elsewhere.example/steal");
    expect(seen).toHaveLength(1);
  });

  it("refuses a response larger than its bound, and a request body larger than its own", async () => {
    storeSecret(packageConsumer(PACKAGE));
    const large = await refusal(handler()(fetchParams(`http://127.0.0.1:${String(port)}/large`)));
    expect(large.code).toBe(EGRESS_ERROR_CODES.tooLarge);
    const body = { encoding: "base64", data: Buffer.alloc(1024 * 1024 + 1).toString("base64") };
    const sent = await refusal(
      handler(undefined, { effects: ["external-write"] })(fetchParams(`http://127.0.0.1:${String(port)}/search`, { method: "POST", body })),
    );
    expect(sent.code).toBe(EGRESS_ERROR_CODES.tooLarge);
    expect(seen.map((entry) => entry.url)).toEqual(["/large"]);
  });

  it("stops a request when the call it serves ends", async () => {
    storeSecret(packageConsumer(PACKAGE));
    const call = new AbortController();
    const pending = handler(call)(fetchParams(`http://127.0.0.1:${String(port)}/hold`));
    await expect.poll(() => seen.length).toBe(1);
    call.abort(new Error("the call was cancelled"));
    const error = await refusal(pending);
    expect(error.code).toBe(EGRESS_ERROR_CODES.stopped);
    expect(audit.at(-1)).toMatchObject({ outcome: "stopped", secret: "SEARCH_API_KEY" });
  });

  it("answers method-not-found for anything but the egress request", async () => {
    const error = await refusal(handler()({ method: "clarkcant/other", params: {}, signal: new AbortController().signal }));
    expect(error.code).toBe(-32601);
  });
});

describe("what a call lets egress do", () => {
  const url = () => `http://127.0.0.1:${String(port)}/items`;
  const write = (method: string) => fetchParams(url(), { method, body: { encoding: "utf8", data: "{}" } });

  it("answers only GET and HEAD during a call decided as a read, and says why the rest are refused", async () => {
    storeSecret(packageConsumer(PACKAGE));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const error = await refusal(handler()(write(method)));
      expect(error.code).toBe(EGRESS_ERROR_CODES.effectNotAllowed);
      expect(error.message).toContain(`a ${method} egress request changes something at the provider`);
      expect(error.message).toContain("decided as read");
    }
    // Nothing reached the provider, so the key was never sent for a write.
    expect(seen).toEqual([]);
    expect((await handler()(fetchParams(url()))).status).toBe(200);
    expect((await handler()(fetchParams(url(), { method: "HEAD" }))).status).toBe(200);
  });

  it("refuses a write during a local-write call too: the risk gate never asked about one", async () => {
    storeSecret(packageConsumer(PACKAGE));
    const error = await refusal(handler(undefined, { effects: ["local-write"] })(write("POST")));
    expect(error.code).toBe(EGRESS_ERROR_CODES.effectNotAllowed);
    expect(seen).toEqual([]);
  });

  it("answers a write while a call decided as external-write or higher is in flight", async () => {
    storeSecret(packageConsumer(PACKAGE));
    for (const effects of [["external-write"], ["destructive"], ["read", "external-write"]] as EffectCategory[][]) {
      expect((await handler(undefined, { effects })(write("POST"))).status).toBe(200);
    }
    expect(seen).toHaveLength(3);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${secret}`);
  });
});

describe("how much a service can ask and the trail it leaves", () => {
  it("writes a bounded trail for ten thousand refused requests, with their count", async () => {
    const answer = handler(null, { rate: { burst: 20_000, refillPerSecond: 1 } });
    const refused: number[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      refused.push((await refusal(answer(fetchParams(`http://127.0.0.1:${String(port)}/search`)))).code);
    }
    expect(new Set(refused)).toEqual(new Set([EGRESS_ERROR_CODES.notInCall]));
    // The first as it happened; the rest are gathered until the window closes.
    expect(audit).toHaveLength(1);
    answer.flush();
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ outcome: "refused", count: 9_999 });
    expect(audit[1]?.reason).toContain("9999 more refused like this");
    // A window that closed is followed by a new one: the next refusal is written as it happens.
    await refusal(answer(fetchParams(`http://127.0.0.1:${String(port)}/search`)));
    expect(audit).toHaveLength(3);
    expect(seen).toEqual([]);
  });

  it("slows a service that sends too many requests to the refill, and lets it go on after", async () => {
    storeSecret(packageConsumer(PACKAGE));
    let now = 1_000;
    const answer = handler(undefined, { rate: { burst: 3, refillPerSecond: 2 }, now: () => now });
    for (let index = 0; index < 3; index += 1) expect((await answer(fetchParams(`http://127.0.0.1:${String(port)}/search`))).status).toBe(200);
    const limited = await refusal(answer(fetchParams(`http://127.0.0.1:${String(port)}/search`)));
    expect(limited.code).toBe(EGRESS_ERROR_CODES.rateLimited);
    expect(seen).toHaveLength(3);
    now += 500;
    expect((await answer(fetchParams(`http://127.0.0.1:${String(port)}/search`))).status).toBe(200);
    expect(seen).toHaveLength(4);
  });
});

describe("what comes back to the service", () => {
  it("removes the key when the provider echoes it JSON-escaped, URL-encoded or inside base64", async () => {
    // A key with the characters each encoding changes, generated here.
    secret = `fake/${randomBytes(12).toString("base64")}+=x`;
    storeSecret(packageConsumer(PACKAGE));
    const result = await handler()(fetchParams(`http://127.0.0.1:${String(port)}/echo-encoded`));
    const body = decode(result.body.data);
    for (const form of secretForms(secret)) expect(body).not.toContain(form);
    for (const form of secretForms(`Bearer ${secret}`)) expect(body).not.toContain(form);
    expect(result.headers["x-echo-url"]).toBe("[redacted]");
    const parsed = JSON.parse(body) as Record<string, string>;
    expect(parsed["escaped"]).toBe("[redacted]");
    expect(parsed["url"]).toBe("[redacted]");
    // The base64 the provider wrapped it in no longer decodes to the key.
    expect(Buffer.from(parsed["inspected"] ?? "", "base64").toString("utf8")).not.toContain(secret);
    expect(Buffer.from(parsed["urlSafe"] ?? "", "base64url").toString("utf8")).not.toContain(secret);
  });

  it("asks the provider for an uncompressed answer whatever the service asked for", async () => {
    const result = await handler()(fetchParams(`http://localhost:${String(port)}/encoding`, { headers: { "accept-encoding": "zstd, br, gzip" } }));
    expect(decode(result.body.data)).toBe("identity");
    expect(seen[0]?.headers["accept-encoding"]).toBe("identity");
  });
});

describe("loopback and private origins", () => {
  it("are refused by default, before anything is sent, even when the package declared them", async () => {
    storeSecret(packageConsumer(PACKAGE));
    const error = await refusal(handler(undefined, { allowPrivateNetwork: false })(fetchParams(`http://127.0.0.1:${String(port)}/search`)));
    expect(error.code).toBe(EGRESS_ERROR_CODES.originNotAllowed);
    expect(error.message).toContain("CC_EGRESS_ALLOW_PRIVATE_NETWORK");
    expect(seen).toEqual([]);
  });

  it("are allowed only by the node setting, never by anything a package says", () => {
    expect(egressAllowsPrivateNetwork({})).toBe(false);
    expect(egressAllowsPrivateNetwork({ CC_EGRESS_ALLOW_PRIVATE_NETWORK: "true" })).toBe(false);
    expect(egressAllowsPrivateNetwork({ CC_EGRESS_ALLOW_PRIVATE_NETWORK: "1" })).toBe(true);
  });

  it("covers localhost, loopback, the private ranges and link-local, in IPv4 and IPv6", () => {
    for (const origin of [
      "http://localhost:8080",
      "http://api.localhost",
      "http://127.0.0.1:11434",
      "http://127.1.2.3",
      "http://0.0.0.0:2375",
      "https://10.1.2.3",
      "https://172.16.0.1",
      "https://172.31.255.255",
      "https://192.168.1.1",
      "http://169.254.169.254",
      "http://[::1]:8080",
      "http://[::]",
      "https://[fd12:3456::1]",
      "https://[fe80::1]",
      "http://[::ffff:127.0.0.1]",
      "http://[::ffff:192.168.0.1]",
    ]) {
      expect(isPrivateNetworkHost(new URL(origin)), origin).toBe(true);
    }
    for (const origin of ["https://api.example.com", "https://8.8.8.8", "https://172.32.0.1", "https://[2001:db8::1]", "https://localhost.example.com"]) {
      expect(isPrivateNetworkHost(new URL(origin)), origin).toBe(false);
    }
  });
});
