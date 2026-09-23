import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FakePiAdapter,
  SCOPED_FS_TOOL_NAMES,
  canonicalRoots,
  type WorkerBrief,
  type WorkerSessionHandle,
} from "@clarkcant/pi-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProjectSessionStarter } from "../src/project-session.ts";

/**
 * Confinement through the runtime's own seam.
 *
 * The unit tests in `pi-adapter` prove that a path outside an approved root is refused. This file proves
 * the part only the runtime can: that the session the node starts for a chosen project carries the
 * boundary — every approved root, canonicalised — and that the filesystem tools it runs with are the
 * scoped ones bound to those roots. It is the difference between a boundary that exists and a boundary
 * that is installed.
 *
 * The fixture is a project with a sibling beside it:
 *
 *   base/
 *     project/          <- chosen
 *       notes.md
 *     second/           <- also approved
 *       other.md
 *     sibling/
 *       secret.txt      <- not approved, and must stay unreadable
 */

let base: string;
let project: string;
let second: string;
let sibling: string;

const INSIDE_TEXT = "three records\n";
const SIBLING_TEXT = "SECRET-SIBLING\n";

beforeEach(async () => {
  // Canonical, because macOS puts the temporary directory behind a `/var` -> `/private/var` symlink.
  base = await realpath(await mkdtemp(join(tmpdir(), "clarkcant-project-session-")));
  project = join(base, "project");
  second = join(base, "second");
  sibling = join(base, "sibling");
  await mkdir(project, { recursive: true });
  await mkdir(second, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(join(project, "notes.md"), INSIDE_TEXT, "utf8");
  await writeFile(join(second, "other.md"), "the second approved root\n", "utf8");
  await writeFile(join(sibling, "secret.txt"), SIBLING_TEXT, "utf8");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Records the brief each session was created with: the boundary travels on it. */
class RecordingAdapter extends FakePiAdapter {
  readonly briefs: WorkerBrief[] = [];

  override async createWorkerSession(brief: WorkerBrief): Promise<WorkerSessionHandle> {
    this.briefs.push(brief);
    return super.createWorkerSession(brief);
  }
}

describe("a project session is confined to the approved project roots", () => {
  it("reads a file inside the selected project and refuses a file beside it", async () => {
    const adapter = new RecordingAdapter();
    const starter = createProjectSessionStarter({
      sessionDir: join(base, "sessions"),
      createAdapter: () => adapter,
    });

    const handle = await starter.start({ goal: "read the notes", projectRoots: [project] });
    expect(handle.sessionId).not.toBe("");

    const brief = adapter.briefs[0];
    expect(brief).toBeDefined();
    const read = (brief?.customTools ?? []).find((tool) => tool.name === "clarkcant_read");
    expect(read).toBeDefined();

    const inside = await read!.execute({ path: join(project, "notes.md") });
    const outside = await read!.execute({ path: join(sibling, "secret.txt") });

    expect(inside.text).toContain(INSIDE_TEXT.trim());
    // The refusal names what it refused and where the boundary is, and the file's contents never appear.
    expect(outside.text).toMatch(/^refused: /);
    expect(outside.text).toContain(project);
    expect(outside.text).not.toContain(SIBLING_TEXT.trim());
  });

  it("hands the session every approved root, canonicalised, not just the first", async () => {
    const adapter = new RecordingAdapter();
    const cwds: string[] = [];
    const starter = createProjectSessionStarter({
      sessionDir: join(base, "sessions"),
      createAdapter: (cwd) => {
        cwds.push(cwd);
        return adapter;
      },
    });

    // The first root arrives through a symlink, so the brief carrying the canonical path is an assertion
    // rather than an accident of the temporary directory.
    const alias = join(base, "alias-to-project");
    await symlink(project, alias, "dir");
    await starter.start({ goal: "work in both", projectRoots: [alias, second] });

    const brief = adapter.briefs[0];
    const canonical = await canonicalRoots([project, second]);
    expect(canonical.refused).toEqual([]);
    expect(brief?.projectRoots).toEqual([...canonical.roots]);
    // The working directory is a convenience the SDK needs; the boundary is `projectRoots`.
    expect(cwds).toEqual([project]);

    const read = (brief?.customTools ?? []).find((tool) => tool.name === "clarkcant_read");
    const inSecond = await read!.execute({ path: join(second, "other.md") });
    const inNeither = await read!.execute({ path: join(sibling, "secret.txt") });
    expect(inSecond.text).toContain("the second approved root");
    expect(inNeither.text).toMatch(/^refused: /);
  });

  it("declares the boundary and runs with the scoped tools instead of the SDK's own", async () => {
    const adapter = new RecordingAdapter();
    const starter = createProjectSessionStarter({
      sessionDir: join(base, "sessions"),
      createAdapter: () => adapter,
    });

    await starter.start({ goal: "work in the project", projectRoots: [project] });

    const brief = adapter.briefs[0];
    expect(brief?.confineToProjectRoots).toBe(true);
    expect((brief?.customTools ?? []).map((tool) => tool.name)).toEqual([...SCOPED_FS_TOOL_NAMES]);
  });

  it("refuses to start when an approved root cannot be used, naming it", async () => {
    const adapter = new RecordingAdapter();
    const starter = createProjectSessionStarter({
      sessionDir: join(base, "sessions"),
      createAdapter: () => adapter,
    });

    const missing = join(base, "not-there");
    await expect(starter.start({ goal: "work in the project", projectRoots: [missing] })).rejects.toThrow(
      /a project session cannot start/,
    );
    await expect(starter.start({ goal: "work in the project", projectRoots: [missing] })).rejects.toThrow(missing);
    // A session that cannot be confined is not started at all: dropping the root would confine the worker
    // to something other than what was approved.
    expect(adapter.briefs).toHaveLength(0);
  });
});
