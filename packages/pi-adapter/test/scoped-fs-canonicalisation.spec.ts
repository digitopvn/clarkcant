import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalRoots, resolveInsideRoots } from "../src/scoped-fs.ts";

/**
 * The one candidate failure a real filesystem cannot be asked to produce on demand.
 *
 * `walkPath` canonicalises each component before the next one is joined to it, and the direction of that
 * failure is what this file pins: the component is refused, never kept as the un-canonicalised candidate it
 * was. The failure needs `stat` to answer for a component and `realpath` to fail on that same component
 * afterwards, which is a race between two syscalls rather than a state of the filesystem, so a real fixture
 * can only reach it by accident. That is why this file mocks and its sibling does not: `scoped-fs.spec.ts`
 * runs the whole boundary against real `mkdtemp` fixtures, and this file injects exactly one failing call to
 * test the branch those fixtures cannot reach.
 *
 * The mock refuses one path fragment and passes every other call to the real implementation, so the root is
 * still canonicalised, identified and re-checked by the code under test rather than by a stub.
 */
const FAILING_COMPONENT = "cannot-be-canonicalised";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (path: string) => {
      if (path.includes(FAILING_COMPONENT)) {
        const cause = new Error(`EACCES: permission denied, realpath '${path}'`) as NodeJS.ErrnoException;
        cause.code = "EACCES";
        throw cause;
      }
      return actual.realpath(path);
    },
  };
});

let base: string;
let project: string;

beforeEach(async () => {
  // Canonical, because macOS puts the temporary directory behind a `/var` -> `/private/var` symlink.
  base = await realpath(await mkdtemp(join(tmpdir(), "clarkcant-canonical-")));
  project = join(base, "project");
  // The component really is there, so `stat` answers for it and only the canonicalisation of it fails.
  await mkdir(join(project, FAILING_COMPONENT), { recursive: true });
  await writeFile(join(project, "notes.md"), "three records\n", "utf8");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("a component that cannot be canonicalised", () => {
  it("refuses the path rather than admitting the candidate as it stands", async () => {
    const canonical = await canonicalRoots([project]);
    expect(canonical.refused).toEqual([]);

    const verdict = await resolveInsideRoots(canonical.approved, join(project, FAILING_COMPONENT, "child.txt"));

    /*
     * The fallback this replaced answered `ok` here: it kept the lexical candidate, joined the rest of the
     * path to it and compared strings, so a path whose target the platform never confirmed was admitted on
     * the strength of its spelling. A refusal is the only answer this walk may give when it cannot see where
     * a component points.
     */
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/could not be canonicalised/);
    expect(verdict.ok === false && verdict.reason).toContain(FAILING_COMPONENT);
  });

  it("still admits a path whose components all canonicalise", async () => {
    const canonical = await canonicalRoots([project]);

    const verdict = await resolveInsideRoots(canonical.approved, join(project, "notes.md"));

    // The injected failure is one path fragment wide: the boundary is not refusing for the mock's sake.
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.path).toBe(join(project, "notes.md"));
  });
});
