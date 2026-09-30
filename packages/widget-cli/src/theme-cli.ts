import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { APPEARANCE_API_VERSION, PACKAGE_MANIFEST_SCHEMA_VERSION } from "@clarkcant/contracts";

import type { ConformanceReport } from "./conformance.ts";
import { runThemeConformance } from "./theme-conformance.ts";
import { startThemeDevHost } from "./theme-dev-host.ts";

export const THEME_COMMANDS = [
  { name: "init", usage: "clark theme init <dir>                              scaffold a data-only theme package" },
  { name: "dev", usage: "clark theme dev [dir] [--port N]                     preview production components with live reload" },
  { name: "test", usage: "clark theme test [dir]                              audit documents, assets and both schemes" },
  { name: "pack", usage: "clark theme pack [dir]                              pack through the shared immutable artifact path" },
] as const;

export function initTheme(root: string): void {
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error("Theme init requires an empty directory; existing files are preserved");
  const slug = basename(resolve(root)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "") || "theme";
  const id = `com.example.${slug}`;
  const facetId = `${id}.main`;
  mkdirSync(join(root, "themes"), { recursive: true });
  const manifest = {
    schemaVersion: PACKAGE_MANIFEST_SCHEMA_VERSION, id, version: "0.1.0", displayName: "My Theme",
    description: "A data-only appearance theme.", hostApi: { min: 1, max: 1 },
    facets: [{ kind: "themes", id: facetId, entry: "themes/main.json", isolation: "declarative" }], requestedCapabilities: [],
    permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
    platforms: ["darwin-arm64", "linux-x64", "win32-x64"],
    publisher: { id: "example", sourceUrl: "https://github.com/example/my-theme", license: "MIT" }, dependencies: [],
  };
  const theme = { appearanceApi: { min: APPEARANCE_API_VERSION, max: APPEARANCE_API_VERSION }, id: facetId, displayName: "My Theme", recipes: { button: "outlined", card: "outlined", composer: "framed" } };
  writeFileSync(join(root, "clarkcant.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(root, "themes/main.json"), `${JSON.stringify(theme, null, 2)}\n`);
  writeFileSync(join(root, "README.md"), "# My Theme\n\nEdit themes/main.json, then run `clark theme dev .`, `clark theme test .` and `clark theme pack .`.\nThe preview uses production components; example interactions never operate your runtime.\n\n# Chủ đề của tôi\n\nSửa themes/main.json, rồi chạy `clark theme dev .`, `clark theme test .` và `clark theme pack .`.\nBản xem trước dùng component sản phẩm; thao tác ví dụ không vận hành runtime của bạn.\n");
}

export async function runThemeCli(args: readonly string[], delivery: {
  pack: (root: string, report: ConformanceReport) => number;
  report: (report: ConformanceReport) => string;
}): Promise<number> {
  const [command, ...rest] = args;
  if (!THEME_COMMANDS.some((entry) => entry.name === command)) {
    process.stdout.write(`${THEME_COMMANDS.map((entry) => entry.usage).join("\n")}\n`);
    return 2;
  }
  const portIndex = rest.indexOf("--port");
  const positions = rest.filter((value, index) => value !== "--port" && (portIndex < 0 || index !== portIndex + 1));
  const root = resolve(positions[0] ?? process.cwd());
  try {
    if (positions.length > 1 || positions.some((value) => value.startsWith("-"))) throw new Error("Expected one package directory; unknown options are refused");
    if (portIndex >= 0 && (command !== "dev" || rest.filter((value) => value === "--port").length !== 1 || rest[portIndex + 1] === undefined)) {
      throw new Error("--port is accepted only once, with a value, by clark theme dev");
    }
    if (command === "init") {
      if (positions.length === 0) throw new Error("clark theme init requires a directory");
      initTheme(root);
      process.stdout.write(`Created ${root}\nNext: clark theme dev ${root}\n`);
      return 0;
    }
    if (command === "dev") {
      const port = Number(portIndex < 0 ? "4319" : rest[portIndex + 1]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
      const host = await startThemeDevHost({ root, port });
      process.stdout.write(`Theme dev host: ${host.url}\nCtrl-C to stop\n`);
      await new Promise<void>((done, failed) => {
        const stop = (): void => {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
          void host.close().then(done, failed);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    const result = runThemeConformance(root);
    if (command === "pack") return delivery.pack(root, result);
    process.stdout.write(`${delivery.report(result)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
