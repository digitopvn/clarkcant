import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { digestOfDirectory } from "@clarkcant/core";

/**
 * The browser suite's package directory lists the theme packages by the digest of their files, as a published directory
 * would. The theme picker shows that digest, so a placeholder there would show a value no real package can have, and a
 * fixture edited without its digest would show one that is not the fixture's.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const THEME_PACKAGES = ["apps/web/e2e/fixtures/theme-dusk", "apps/web/e2e/fixtures/theme-dusk-dim"];

interface FixtureEntry {
  packageId: string;
  version: string;
  source: { kind: string; path?: string };
  digest: string;
}

describe("the browser suite's theme packages", () => {
  const entries = JSON.parse(readFileSync(join(ROOT, "apps/web/e2e/fixtures/directory.json"), "utf8")) as FixtureEntry[];

  it.each(THEME_PACKAGES)("lists %s under the digest of its bytes", (path) => {
    const entry = entries.find((candidate) => candidate.source.kind === "local" && candidate.source.path === path);
    expect(entry?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestOfDirectory(join(ROOT, path))).toEqual({ ok: true, digest: entry?.digest });
  });
});
