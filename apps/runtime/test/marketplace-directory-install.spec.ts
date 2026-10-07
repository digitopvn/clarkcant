import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { directoryEntrySchema, messageBlockSchema, type DirectoryEntry } from "@clarkcant/contracts";
import { DIRECTORY_FEED_FORMAT } from "@clarkcant/core";
import { startFakeNpmRegistry } from "@clarkcant/core/test-support/fake-npm-registry";

import { runCli } from "../../../packages/widget-cli/src/cli.ts";
import { handleRequest, type GatewayDeps, type GatewayResponse } from "../src/gateway.ts";
import { createSearchDirectoryTool } from "../src/search-directory-tool.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * A package listed by a remote marketplace, installed through the one install route.
 *
 * The author flow (`clark widget init` → `publish`) produces the archive and its directory entry; a fake npm registry
 * serves the archive, and a marketplace feed on this machine's loopback serves the entry — the same shape the official
 * Marketplace's feed is specified to have. Nothing is configured on the node but the feed's address, so what passes here
 * is discovery from a marketplace, fetch from npm and verification by the node, with no hand-written index between them.
 */

const AT = "2026-10-07T05:00:00.000Z";

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
const restoreEnv: Record<string, string | undefined> = {};
const servers: Server[] = [];

function setEnv(name: string, value: string): void {
  if (!(name in restoreEnv)) restoreEnv[name] = process.env[name];
  process.env[name] = value;
}

/** A marketplace feed on loopback, serving `entries` until it is closed. */
async function startFeed(entries: unknown[]): Promise<{ url: string; requests: () => number }> {
  let count = 0;
  const server = createServer((request, response) => {
    count += 1;
    if (request.url?.startsWith("/api/v1/directory") !== true) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ format: DIRECTORY_FEED_FORMAT, entries, nextCursor: null }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the feed did not bind");
  return { url: `http://127.0.0.1:${String(address.port)}/api/v1/directory`, requests: () => count };
}

async function authorPackage(): Promise<{ entry: DirectoryEntry; tarball: Buffer; authorDigest: string }> {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const root = join(dir, "author", "quick-notes");
  expect(await runCli(["widget", "init", root])).toBe(0);
  expect(await runCli(["widget", "publish", root])).toBe(0);
  vi.restoreAllMocks();
  const entry = directoryEntrySchema.parse(JSON.parse(readFileSync(join(root, "dist", "directory-entry.json"), "utf8")));
  const artifact = JSON.parse(readFileSync(join(root, "dist", "artifact.json"), "utf8")) as {
    authorDigest: string;
    npm: { tarball: string };
  };
  return { entry, tarball: readFileSync(join(root, "dist", artifact.npm.tarball)), authorDigest: artifact.authorDigest };
}

async function install(entry: Pick<DirectoryEntry, "packageId" | "version">): Promise<GatewayResponse> {
  return handleRequest(deps, {
    method: "POST",
    path: "/packages/install",
    query: {},
    headers: { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: JSON.stringify({ packageId: entry.packageId, version: entry.version }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-marketplace-install-"));
  services = bootNodeServices({ dataDir: join(dir, "node"), label: "marketplace install test node" });
  deps = { services, now: () => AT as never };
  // Only the feed under test: no index file, and never the live Marketplace.
  setEnv("CC_OFFICIAL_MARKETPLACE", "off");
  setEnv("CC_DIRECTORY_INDEX", "");
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(restoreEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete restoreEnv[name];
  }
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("installing a package a marketplace lists", () => {
  it("fetches the listing on demand and installs the exact npm version through the canonical route", async () => {
    const { entry, tarball } = await authorPackage();
    const registry = await startFakeNpmRegistry({ name: "quick-notes", version: entry.version, tarball });
    try {
      const feed = await startFeed([entry]);
      setEnv("CC_DIRECTORY_MARKETPLACES", feed.url);
      setEnv("CC_NPM_REGISTRY_URL", registry.url);

      const response = await install(entry);

      expect(response.status).toBe(200);
      const body = response.body as Record<string, unknown>;
      expect((body["installed"] as Record<string, unknown>)["packageId"]).toBe(entry.packageId);
      expect(body["state"]).toBe("active");
      // The listing was fetched because the install asked for it; nothing was fetched before.
      expect(feed.requests()).toBe(1);
    } finally {
      await registry.close();
    }
  });

  it("refuses a listing whose digest is not the archive's, whatever the marketplace says", async () => {
    const { entry, tarball, authorDigest } = await authorPackage();
    const registry = await startFakeNpmRegistry({ name: "quick-notes", version: entry.version, tarball });
    try {
      const tampered = { ...entry, digest: authorDigest };
      const feed = await startFeed([tampered]);
      setEnv("CC_DIRECTORY_MARKETPLACES", feed.url);
      setEnv("CC_NPM_REGISTRY_URL", registry.url);

      const response = await install(tampered);

      expect(response.status).toBe(409);
      expect((response.body as Record<string, unknown>)["code"]).toBe("DIGEST_MISMATCH");
      expect(JSON.stringify(response.body)).not.toContain("generationId");
    } finally {
      await registry.close();
    }
  });

  it("says the marketplace could not be reached rather than that the package does not exist", async () => {
    const feed = await startFeed([]);
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
    setEnv("CC_DIRECTORY_MARKETPLACES", feed.url);

    const response = await install({ packageId: "com.example.quick-notes", version: "1.0.0" });

    expect(response.status).toBe(409);
    const body = response.body as Record<string, unknown>;
    expect(body["code"]).toBe("DIRECTORY_UNREADABLE");
    expect(String(body["message"])).toContain("could not reach 127.0.0.1");
  });
});

describe("searching every configured source", () => {
  it("lists rows from the index file and the marketplace with their origins, and leaves out what cannot run here", async () => {
    const { entry } = await authorPackage();
    const elsewhere = { ...entry, packageId: "com.example.windows-only", displayName: "Windows only", platforms: ["win32-x64"] };
    const indexPath = join(dir, "index.json");
    const mine = { ...entry, packageId: "com.example.mine", displayName: "Mine", source: { kind: "local", path: join(dir, "mine") } };
    writeFileSync(indexPath, JSON.stringify([mine]));
    const feed = await startFeed([entry, elsewhere]);
    const tool = createSearchDirectoryTool({
      directory: {
        env: { CC_DIRECTORY_INDEX: indexPath, CC_DIRECTORY_MARKETPLACES: feed.url, CC_OFFICIAL_MARKETPLACE: "off" },
        dataDir: join(dir, "node"),
      },
      newId: () => "market_sources",
      host: { platform: "linux-x64", hostApi: 1 },
    });

    const answer = (await tool.execute({ query: "" })) as { text: string; hostCard?: Record<string, unknown> };

    expect(messageBlockSchema.safeParse(answer.hostCard).success).toBe(true);
    const rows = (answer.hostCard?.["results"] ?? []) as Record<string, unknown>[];
    expect(rows.map((row) => [row["packageId"], (row["origin"] as Record<string, unknown> | undefined)?.["kind"]])).toEqual([
      ["com.example.mine", "local-file"],
      [entry.packageId, "custom-marketplace"],
    ]);
    expect(answer.text).toContain("1 gói bị ẩn");

    // Details for one package: every claim of the listing, said as a claim.
    const details = (await tool.execute({ query: "", packageId: entry.packageId })) as { text: string };
    expect(details.text).toContain(`npm quick-notes@${entry.version}`);
    expect(details.text).toContain(entry.digest);
    expect(details.text).toContain("liệt kê bởi: 127.0.0.1");
    expect(details.text).not.toContain("bị ẩn");
  });

  it("names a marketplace that could not be consulted on the card instead of showing it as empty", async () => {
    const indexPath = join(dir, "index.json");
    writeFileSync(indexPath, JSON.stringify([]));
    const tool = createSearchDirectoryTool({
      directory: {
        env: { CC_DIRECTORY_INDEX: indexPath, CC_DIRECTORY_MARKETPLACES: "http://127.0.0.1:9/api/v1/directory", CC_OFFICIAL_MARKETPLACE: "off" },
        dataDir: join(dir, "node"),
      },
      newId: () => "market_down",
      refresh: { limits: { timeoutMs: 2_000 } },
    });

    const answer = (await tool.execute({ query: "notes" })) as { text: string; hostCard?: Record<string, unknown> };

    expect(messageBlockSchema.safeParse(answer.hostCard).success).toBe(true);
    expect(answer.hostCard?.["sources"]).toEqual([
      expect.objectContaining({ kind: "custom-marketplace", state: "unreachable", label: "127.0.0.1:9/api/v1/directory" }),
    ]);
    expect(answer.text).toContain("không kết nối được");
  });
});
