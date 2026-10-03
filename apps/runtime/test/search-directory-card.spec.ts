import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { messageBlockSchema } from "@clarkcant/contracts";

import { createSearchDirectoryTool } from "../src/node-tools.ts";

/**
 * The marketplace card `search_directory` builds must satisfy its own contract.
 *
 * The conductor strict-parses every host card a tool hands back and leaves out one that fails, so a key the tool emits
 * and the contract does not declare costs the person the whole card — the results and their Install buttons. These
 * tests parse what the real tool builds, from real listings, with the schema the conductor uses.
 */

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FIXTURE = JSON.parse(readFileSync("apps/web/e2e/fixtures/directory.json", "utf8")) as Record<string, unknown>[];

function lookupListing(): Record<string, unknown> {
  // The listing whose reach names a secret, so the card is checked with the widest reach the fixture declares.
  const listing = FIXTURE.find((entry) => {
    const secrets = (entry["declaredReach"] as Record<string, unknown> | undefined)?.["secrets"];
    return Array.isArray(secrets) && secrets.length > 0;
  });
  if (listing === undefined) throw new Error("the directory fixture has no listing whose reach names a secret");
  return listing;
}

async function search(entries: readonly Record<string, unknown>[], query = "", folders: readonly string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "cc-search-card-"));
  temporary.push(dir);
  const folder = join(dir, ...folders);
  mkdirSync(folder, { recursive: true });
  const indexPath = join(folder, "directory.json");
  writeFileSync(indexPath, JSON.stringify(entries));
  const tool = createSearchDirectoryTool({ indexPath, newId: () => "market_card" });
  return (await tool.execute({ query })) as { text: string; hostCard?: Record<string, unknown> };
}

describe("the marketplace card search_directory builds", () => {
  it("parses with a listing that carries both a declared reach and widget appearance claims", async () => {
    const listing = { ...lookupListing(), widgetAppearance: [{ id: "main", mode: "fixed" }] };
    const answer = await search([listing]);

    const parsed = messageBlockSchema.safeParse(answer.hostCard);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    const [row] = (answer.hostCard?.["results"] ?? []) as Record<string, unknown>[];
    // Both keys reach the card, which is what the row draws before the Install press.
    expect(row?.["widgetAppearance"]).toEqual([{ id: "main", mode: "fixed" }]);
    expect(row?.["declaredReach"]).toMatchObject({ secrets: [{ name: expect.any(String) as unknown }] });
  });

  it("parses for every listing in the directory fixture", async () => {
    // One search per listing, because a browse lists only the first few.
    for (const listing of FIXTURE) {
      const answer = await search([listing]);
      const parsed = messageBlockSchema.safeParse(answer.hostCard);
      expect(parsed.success, `${String(listing["packageId"])}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
      expect((answer.hostCard?.["results"] ?? []) as unknown[]).toHaveLength(1);
    }
  });

  it("parses when a listing repeats facets and platforms beyond the card's bounds", async () => {
    const listing = {
      ...lookupListing(),
      facets: Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? "ui" : "tools")),
      platforms: Array.from({ length: 12 }, () => "web"),
    };
    const answer = await search([listing]);
    expect(messageBlockSchema.safeParse(answer.hostCard).success).toBe(true);
    const [row] = (answer.hostCard?.["results"] ?? []) as Record<string, unknown>[];
    expect(row?.["facets"]).toEqual(["ui", "tools"]);
    expect(row?.["platforms"]).toEqual(["web"]);
  });

  it("parses when the query and the directory's path are longer than the card shows", async () => {
    // Several folders rather than one long name: a single name over 255 characters is refused on Windows.
    const folders = Array.from({ length: 6 }, (_, index) => `${String(index)}${"d".repeat(59)}`);
    const answer = await search([lookupListing()], "q".repeat(500), folders);
    const parsed = messageBlockSchema.safeParse(answer.hostCard);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    // The end of the path names the index, so that is what is kept.
    const directory = String(answer.hostCard?.["directory"]);
    expect(directory.startsWith("…")).toBe(true);
    expect(directory.endsWith(join(folders[5] ?? "", "directory.json"))).toBe(true);
    // A shortened query says so, rather than reading as what was searched.
    const query = String(answer.hostCard?.["query"]);
    expect(query).toHaveLength(200);
    expect(query).toBe(`${"q".repeat(199)}…`);
  });

  it("shortens the query and the path between characters, never inside one", async () => {
    // Each folder ends in one plain letter, so a cut by UTF-16 units would land inside the emoji before it.
    const folders = Array.from({ length: 4 }, () => `${"😀".repeat(49)}x`);
    const answer = await search([lookupListing()], "😀".repeat(150), folders);
    const parsed = messageBlockSchema.safeParse(answer.hostCard);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const query = String(answer.hostCard?.["query"]);
    const directory = String(answer.hostCard?.["directory"]);
    expect(query).toBe(`${"😀".repeat(99)}…`);
    expect(loneSurrogate.test(query)).toBe(false);
    expect(directory.startsWith("…")).toBe(true);
    expect(directory.length).toBeLessThanOrEqual(300);
    expect(loneSurrogate.test(directory)).toBe(false);
  });

  it("carries a listed version of the card's full length unchanged, because Install sends it back", async () => {
    const version = `1.0.0-rc.${"a".repeat(71)}`;
    expect(version).toHaveLength(80);
    const answer = await search([{ ...lookupListing(), version }]);
    expect(messageBlockSchema.safeParse(answer.hostCard).success).toBe(true);
    const [row] = (answer.hostCard?.["results"] ?? []) as Record<string, unknown>[];
    expect(row?.["version"]).toBe(version);
  });

  it("refuses a listing whose version is longer than the card allows, saying why, rather than dropping the card", async () => {
    const answer = await search([{ ...lookupListing(), version: `1.0.0-rc.${"a".repeat(80)}` }]);
    expect(answer.hostCard).toBeUndefined();
    expect(answer.text).toContain("does not match the directory schema: version");
    expect(answer.text).toContain("at most 80 characters");
  });

  it("still refuses a reach the contract does not allow, rather than carrying it to the card", async () => {
    const listing = lookupListing();
    const reach = listing["declaredReach"] as Record<string, unknown>;
    const answer = await search([{ ...listing, declaredReach: { ...reach, secrets: [{ name: "LOOKUP_API_KEY", purpose: "x", value: "sk-live" }] } }]);
    expect(answer.hostCard).toBeUndefined();
    expect(answer.text).toContain("does not match the directory schema");
  });
});
