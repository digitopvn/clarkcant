import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import { initTheme } from "../src/theme-cli.ts";
import { startThemeDevHost, readThemeDevView } from "../src/theme-dev-host.ts";

describe("the production theme author dev host", () => {
  it("serves checked theme data and the production module entry, refusing other origins and package file browsing", async () => {
    const root = mkdtempSync(join(tmpdir(), "clark-theme-host-"));
    initTheme(root);
    const host = await startThemeDevHost({ root, port: 0, watchFiles: false });
    try {
      expect((await fetch(host.url)).status).toBe(200);
      const html = await (await fetch(host.url)).text();
      expect(html).toContain("theme-dev-runtime.tsx");
      const view = await (await fetch(`${host.url}/dev/theme`)).json();
      expect(view.themes).toHaveLength(1);
      expect(view.report.ok).toBe(true);
      expect(view.report.summary["requires-dev-host"]).toBe(1);
      expect((await fetch(`${host.url}/clarkcant.json`)).status).toBe(404);
      expect((await fetch(`${host.url}/dev/theme`, { headers: { origin: "https://outside.test" } })).status).toBe(403);
      expect((await fetch(`${host.url}/dev/theme`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${host.url}/src/theme-dev-runtime.tsx`)).status).toBe(200);
    } finally {
      await host.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
    await expect(fetch(host.url)).rejects.toThrow();
  });
  it("reports a changed or invalid document and closes its recursive watcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "clark-theme-watch-"));
    initTheme(root);
    const host = await startThemeDevHost({ root, port: 0 });
    try {
      const path = join(root, "themes/main.json");
      const theme = JSON.parse(readFileSync(path, "utf8"));
      theme.displayName = "Live edit";
      writeFileSync(path, JSON.stringify(theme));
      await viWait(() => host.reloads() > 0);
      expect(readThemeDevView(root).themes[0]?.document.displayName).toBe("Live edit");
      writeFileSync(path, "{ incomplete JSON");
      const invalid = readThemeDevView(root);
      expect(invalid.themes).toHaveLength(0);
      expect(invalid.report.ok).toBe(false);
      expect(invalid.problem).toMatch(/JSON/);
    } finally {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function viWait(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!predicate() && Date.now() < end) await new Promise((done) => setTimeout(done, 25));
  expect(predicate()).toBe(true);
}
