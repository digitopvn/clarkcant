import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSearchDirectoryTool } from "../src/node-tools.ts";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("carries checked appearance claims into marketplace results without granting authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-directory-appearance-"));
  temporary.push(dir);
  const indexPath = join(dir, "directory.json");
  const entries = JSON.parse(readFileSync("apps/web/e2e/fixtures/directory.json", "utf8")) as Record<string, unknown>[];
  const entry: Record<string, unknown> = { ...entries[0], widgetAppearance: [{ id: "main", mode: "fixed" }] };
  writeFileSync(indexPath, JSON.stringify([entry]));
  const tool = createSearchDirectoryTool({ directory: { env: { CC_DIRECTORY_INDEX: indexPath }, dataDir: undefined }, newId: () => "market_appearance" });
  const answer = await tool.execute({ query: "" }) as { hostCard?: { results: Record<string, unknown>[] }; text: string };
  expect(answer.hostCard?.results[0]?.widgetAppearance).toEqual(entry.widgetAppearance);
  expect(answer.hostCard?.results[0]?.digest).toBe(entry.digest);
  expect(answer.hostCard?.results[0]).not.toHaveProperty("permissions");
  writeFileSync(indexPath, JSON.stringify([{ ...entry, widgetAppearance: [{ id: "main", mode: "privileged" }] }]));
  const refused = await tool.execute({ query: "" }) as { hostCard?: unknown; text: string };
  expect(refused.hostCard).toBeUndefined();
  expect(refused.text).toContain("does not match the directory schema");
});
