import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { platformSkippedTestTitles } from "../platform-skipped-tests.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The nesting this module exists for, written out rather than read from a real spec file: a matcher that quietly
 * stops nesting would pass a suite that only used the real files, and then report every skipped test as running.
 */
function spec(body: string): string {
  return `import { describe, it } from "vitest";\nconst POSIX = process.platform !== "win32";\n${body}\n`;
}

describe("platformSkippedTestTitles", () => {
  it("reports a test inside a describe skipped on a platform condition, and the suite's own title", () => {
    const source = spec(`
describe.skipIf(!POSIX)("POSIX only", () => {
  it("runs only there", () => {});
});
`);
    expect([...platformSkippedTestTitles(source)]).toEqual([
      ["POSIX only", "!POSIX"],
      ["runs only there", "!POSIX"],
    ]);
  });

  it("reports a test skipped on the platform condition itself, with no name bound to it", () => {
    const source = spec(`
describe.skipIf(process.platform === "win32")("POSIX only", () => {
  it("runs only there", () => {});
});
`);
    expect(platformSkippedTestTitles(source).get("runs only there")).toBe('process.platform === "win32"');
  });

  it("reports a single test skipped in place", () => {
    const source = spec(`
describe("everything else", () => {
  it.skipIf(!POSIX)("skipped in place", () => {});
});
`);
    expect(platformSkippedTestTitles(source).has("skipped in place")).toBe(true);
  });

  it("reports a suite run only on a platform condition", () => {
    const source = spec(`
describe.runIf(POSIX)("POSIX only", () => {
  it("runs only there", () => {});
});
`);
    expect(platformSkippedTestTitles(source).has("runs only there")).toBe(true);
  });

  it("does not report the tests of an unskipped suite in the same file", () => {
    const source = spec(`
describe("everything else", () => {
  it("always runs", () => {});
});
describe.skipIf(!POSIX)("POSIX only", () => {
  it("runs only there", () => {});
});
`);
    const skipped = platformSkippedTestTitles(source);
    expect(skipped.has("always runs")).toBe(false);
    expect(skipped.has("everything else")).toBe(false);
    expect(skipped.has("runs only there")).toBe(true);
  });

  it("does not report a skip whose condition is not the platform", () => {
    const source = `import { describe, it } from "vitest";
const LIVE = process.env.CLARKCANT_JEV_LIVE === "1";
describe.skipIf(!LIVE)("live provider (opt-in)", () => {
  it("calls the provider", () => {});
});
`;
    expect(platformSkippedTestTitles(source).size).toBe(0);
  });

  it("does not report a title that also has a declaration outside the skip", () => {
    const source = spec(`
describe.skipIf(!POSIX)("POSIX only", () => {
  it("same title", () => {});
});
describe("everything else", () => {
  it("same title", () => {});
});
`);
    expect(platformSkippedTestTitles(source).has("same title")).toBe(false);
  });

  it("reports a suite's own title as skipped, because a citation of it would name nothing that runs", () => {
    const source = spec(`
describe.skipIf(!POSIX)("POSIX only", () => {
  it("runs only there", () => {});
});
`);
    expect(platformSkippedTestTitles(source).has("POSIX only")).toBe(true);
  });

  it("reads the repository's real socket suite as skipped and its other tests as running", () => {
    const source = readFileSync(join(repoRoot, "apps/runtime/test/portable-runtime.spec.ts"), "utf8");
    const skipped = platformSkippedTestTitles(source);
    expect(skipped.get("serves a real request and keeps the file owner-only")).toBe("!POSIX");
    expect(skipped.get("clears the file a node left behind when it did not shut down")).toBe("!POSIX");
    expect(skipped.get("refuses a path another node is listening on rather than taking it away")).toBe("!POSIX");
    expect(skipped.has("names the engine and its version when one answers")).toBe(false);
  });
});
