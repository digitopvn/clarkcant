import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";
import { listProjects, migrate, openDatabase, type Database } from "@clarkcant/storage";

import {
  type ProjectFinderDeps,
  createFindProjectTool,
  findProjectCandidates,
  indexDirectoryPath,
  pathFromIntent,
  projectContext,
  refreshProjectIndex,
  resolveProject,
  scanProjects,
  verifyProject,
} from "../src/project-finder.ts";
import type { JevTransport } from "../src/jev-selector.ts";

/**
 * The workspace finder (Phase 11).
 *
 * The scan runs against a real temporary tree, because the properties that matter are filesystem
 * properties: a symlink that escapes the approved root, a depth limit, an ignore list, and a
 * directory mtime that decides whether a refresh has anything to do. A fixture that mocked the
 * filesystem would assert the mock.
 */

const AT = "2026-09-17T05:00:00.000Z" as Instant;

let home: string;
let db: Database;
let deps: ProjectFinderDeps;
let counter = 0;

function buildTree(): void {
  // A repository: a marker, so it is indexed and not descended into.
  mkdirSync(join(home, "agentkit", "packages", "core"), { recursive: true });
  mkdirSync(join(home, "agentkit", ".git"));
  writeFileSync(join(home, "agentkit", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:duy/agentkit.git\n');
  writeFileSync(join(home, "agentkit", "package.json"), "{}");
  writeFileSync(join(home, "agentkit", "packages", "core", "package.json"), "{}");

  // A documentation vault with a similar name.
  mkdirSync(join(home, "agentkit-docs"), { recursive: true });
  writeFileSync(join(home, "agentkit-docs", "README.md"), "# docs");
  mkdirSync(join(home, "agentkit-docs", "docs"), { recursive: true });

  // An Obsidian vault: documents, not code.
  mkdirSync(join(home, "notes", ".obsidian"), { recursive: true });

  // A folder of images: media, with no marker at all.
  mkdirSync(join(home, "photos"), { recursive: true });
  for (const name of ["a.png", "b.png", "c.jpg"]) writeFileSync(join(home, "photos", name), "x");

  // Ignored: a dependency directory with a marker inside it.
  mkdirSync(join(home, "node_modules", "some-package"), { recursive: true });
  writeFileSync(join(home, "node_modules", "some-package", "package.json"), "{}");

  // Ignored: the system library.
  mkdirSync(join(home, "Library", "Caches"), { recursive: true });
  writeFileSync(join(home, "Library", "Caches", "package.json"), "{}");

  // Beyond the depth limit: a marked directory the scan must not reach.
  const deep = join(home, "a", "b", "c", "d", "e", "f");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "package.json"), "{}");

  // A symlink out of the approved root. Following it would index a tree the user never approved.
  mkdirSync(join(home, "outside-marker"), { recursive: true });
  writeFileSync(join(home, "outside-marker", "package.json"), "{}");
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "clarkcant-finder-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  counter = 0;
  deps = {
    db,
    nodeId: "node_local",
    now: () => AT,
    newId: (prefix) => `${prefix}_${(counter += 1)}`,
    roots: () => [home],
    ignore: () => [],
    home: () => home,
  };
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the scan", () => {
  it("indexes marked directories and refuses to descend into one", async () => {
    buildTree();
    const outcome = await refreshProjectIndex(deps, { full: true });
    const paths = listProjects(db, "node_local", 100).map((project) => project.path);

    expect(paths).toContain(join(home, "agentkit"));
    expect(paths).toContain(join(home, "agentkit-docs"));
    expect(paths).toContain(join(home, "notes"));
    expect(paths).toContain(join(home, "photos"));
    // A package inside a repository is not a project: offering it would propose `packages/core`
    // instead of the repository the user named.
    expect(paths).not.toContain(join(home, "agentkit", "packages", "core"));
    expect(outcome.kept).toBeGreaterThanOrEqual(4);
  });

  it("ignores dependency directories, the system library, and anything beyond the depth limit", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const paths = listProjects(db, "node_local", 100).map((project) => project.path);

    expect(paths.some((path) => path.includes("node_modules"))).toBe(false);
    expect(paths.some((path) => path.includes("Library"))).toBe(false);
    expect(paths.some((path) => path.includes(join("a", "b", "c", "d", "e")))).toBe(false);
  });

  it("does not follow a symlink out of the approved root", async () => {
    buildTree();
    const outside = join(home, "..", "outside-tree");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "package.json"), "{}");
    symlinkSync(outside, join(home, "escape"));

    await refreshProjectIndex(deps, { full: true });
    const paths = listProjects(db, "node_local", 100).map((project) => project.path);
    expect(paths.some((path) => path.endsWith("outside-tree"))).toBe(false);
    expect(paths.some((path) => path.endsWith("escape"))).toBe(false);
  });

  it("keeps the kind it can justify, including media with no marker at all", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const byName = new Map(listProjects(db, "node_local", 100).map((project) => [project.name, project]));

    expect(byName.get("agentkit")?.kind).toBe("code");
    expect(byName.get("agentkit")?.gitRemote).toBe("git@github.com:duy/agentkit.git");
    expect(byName.get("agentkit-docs")?.kind).toBe("docs");
    expect(byName.get("notes")?.kind).toBe("docs");
    expect(byName.get("photos")?.kind).toBe("media");
  });

  it("stores no file contents, and only the metadata the schema declares", async () => {
    buildTree();
    writeFileSync(join(home, "agentkit", "secrets.txt"), "sk-live-abcdef1234567890");
    await refreshProjectIndex(deps, { full: true });

    const rows = db.prepare("SELECT * FROM project_index").all() as Record<string, unknown>[];
    const serialised = JSON.stringify(rows);
    // No file was read for content: the marker list and the git remote are the only extracted text.
    expect(serialised).not.toContain("sk-live-abcdef1234567890");
    expect(serialised).not.toContain("placeholder");
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "aliases",
        "git_remote",
        "indexed_at",
        "kind",
        "last_used_at",
        "markers",
        "mtime",
        "name",
        "node_id",
        "path",
        "project_id",
      ]);
    }
  });

  it("skips a directory whose mtime has not moved, and reindexes one that has", async () => {
    buildTree();
    const first = await refreshProjectIndex(deps, { full: true });
    const agentkit = listProjects(db, "node_local", 100).find((project) => project.name === "agentkit");
    expect(agentkit).toBeDefined();

    const incremental = await refreshProjectIndex(deps, { full: false });
    // Everything already indexed is kept without a write, which is what makes a refresh cheap.
    expect(incremental.kept).toBeGreaterThanOrEqual(incremental.scanned - 1);

    // A new marker moves the directory's mtime, which is the signal the incremental pass reads.
    writeFileSync(join(home, "agentkit", "AGENTS.md"), "rules");
    utimesSync(join(home, "agentkit"), new Date(), new Date(Date.now() + 1000));
    const after = await refreshProjectIndex(deps, { full: false });
    expect(after.scanned).toBeGreaterThanOrEqual(first.scanned);
    const refreshed = listProjects(db, "node_local", 100).find((project) => project.name === "agentkit");
    expect(refreshed?.markers).toContain("AGENTS.md");
    // The project id survives a refresh: it is the identity a pin, a session and a preference use.
    expect(refreshed?.projectId).toBe(agentkit?.projectId);
  });

  it("stops early on a signal instead of walking the whole tree", async () => {
    buildTree();
    const controller = new AbortController();
    controller.abort();
    const outcome = await scanProjects({ roots: [home], signal: controller.signal });
    expect(outcome.stoppedEarly).toBe(true);
    expect(outcome.projects).toHaveLength(0);
  });

  it("is bounded by an entry ceiling", async () => {
    buildTree();
    const outcome = await scanProjects({ roots: [home], maxEntries: 3 });
    expect(outcome.truncated).toBe(true);
  });

  it("does not prune the index when a scan was interrupted", async () => {
    buildTree();
    const first = await refreshProjectIndex(deps, { full: true });
    expect(first.removed).toBe(0);
    const before = listProjects(db, "node_local", 100).map((project) => project.projectId).sort();
    expect(before.length).toBeGreaterThan(0);

    const controller = new AbortController();
    controller.abort();
    const interrupted = await refreshProjectIndex(deps, { full: true, signal: controller.signal });

    expect(interrupted.stoppedEarly).toBe(true);
    // An abort before the first walk reports `truncated: false` having examined nothing. Pruning on
    // that wipes the whole per-node index — including the aliases and last-use times that a rescan
    // cannot reconstruct — so the stop has to be part of the guard, not just the truncation.
    expect(interrupted.removed).toBe(0);
    expect(listProjects(db, "node_local", 100).map((project) => project.projectId).sort()).toEqual(before);
  });
});

describe("ranking and candidates", () => {
  it("prefers an exact alias, then recent use, and filters by kind", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });

    const docs = listProjects(db, "node_local", 100).find((project) => project.name === "agentkit-docs");
    expect(docs).toBeDefined();
    if (docs === undefined) return;

    // The search finds the repository by its own name.
    const byName = findProjectCandidates(deps, { query: "agentkit" }).candidates;
    expect(byName.map((candidate) => candidate.name)).toContain("agentkit");

    // Both carry the same alias, so both match the same way and recent use is what decides — which
    // is the tie this ranking exists to break. The aliases are written directly rather than taught
    // through a preference, because this test is about the ordering rule.
    db.prepare("UPDATE project_index SET last_used_at = NULL WHERE aliases = '[\"agentkit\"]'").run();
    db.prepare(
      "UPDATE project_index SET aliases = '[\"agentkit\"]' WHERE name IN ('agentkit', 'agentkit-docs')",
    ).run();
    const bothAliases = findProjectCandidates(deps, { query: "agentkit" }).candidates;
    expect(bothAliases.length).toBeGreaterThanOrEqual(2);
    db.prepare("UPDATE project_index SET last_used_at = ? WHERE project_id = ?").run("2026-09-16T00:00:00.000Z", docs.projectId);
    const withRecent = findProjectCandidates(deps, { query: "agentkit" }).candidates;
    expect(withRecent[0]?.name).toBe("agentkit-docs");

    // A structured filter is exact and free.
    expect(findProjectCandidates(deps, { query: "agentkit", kind: "docs" }).candidates.map((c) => c.name)).toEqual(["agentkit-docs"]);
    expect(findProjectCandidates(deps, { query: "agentkit", kind: "media" }).candidates).toHaveLength(0);
  });

  it("returns a relative path and never an absolute one", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const { candidates } = findProjectCandidates(deps, { query: "agentkit" });
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.relPath.startsWith("/")).toBe(false);
      expect(candidate.relPath).not.toContain(home);
    }

    const tool = createFindProjectTool(deps);
    const result = await tool.execute({ query: "agentkit" });
    expect(result.text).toContain("~/agentkit-docs");
    expect(result.text).not.toContain(home);
  });

  it("serves a cache hit quickly", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const startedAt = Date.now();
    const { candidates } = findProjectCandidates(deps, { query: "agentkit" });
    const elapsed = Date.now() - startedAt;
    expect(candidates.length).toBeGreaterThan(0);
    // The plan's target for a cache hit. Generous next to a scan, and it catches the mistake of
    // scanning inside the read path.
    expect(elapsed).toBeLessThan(50);
  });
});

describe("resolving what the user meant", () => {
  it("scans on a cold index rather than answering that nothing was found", async () => {
    buildTree();
    // No refresh has run: the index is empty. A cold miss triggers a scan, so the answer is either a
    // directory or one question — never "nothing matches" while a match is sitting on disk.
    const outcome = await resolveProject(deps, { intent: "thêm skill mới cho dự án agentkit đi" });
    expect(["resolved", "clarify"]).toContain(outcome.status);
    // The scan really ran, so the index is no longer empty.
    expect(listProjects(db, "node_local", 100).length).toBeGreaterThanOrEqual(2);
    if (outcome.status === "clarify") {
      // Two similarly named directories is the case the plan names, and it asks instead of guessing.
      expect(outcome.options.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("resolves a single match without asking anything", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const outcome = await resolveProject(deps, { intent: "photos" });
    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") return;
    expect(outcome.project.name).toBe("photos");
    expect(outcome.mode).toBe("alias");
  });

  it("asks exactly one question when two directories could both be meant", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });

    const outcome = await resolveProject(deps, { intent: "dự án agentkit" });
    // Both names match; there is no decider configured, so the answer is a question rather than a
    // guess (T19).
    expect(outcome.status).toBe("clarify");
    if (outcome.status !== "clarify") return;
    expect(outcome.options.length).toBeGreaterThanOrEqual(2);
    // The wording belongs to the shared T19 helper; what matters here is that exactly one question is
    // asked and that its options are the candidates.
    expect(outcome.question).toContain("Which one did you mean");
    expect(outcome.options.some((option) => option.includes("agentkit"))).toBe(true);
  });

  it("orders the question's options by recent use, so the likely answer is first", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const docs = listProjects(db, "node_local", 100).find((project) => project.name === "agentkit-docs");
    expect(docs).toBeDefined();
    if (docs === undefined) return;
    db.prepare("UPDATE project_index SET last_used_at = ? WHERE project_id = ?").run("2026-09-16T00:00:00.000Z", docs.projectId);

    const outcome = await resolveProject(deps, { intent: "dự án agentkit" });
    expect(outcome.status).toBe("clarify");
    if (outcome.status !== "clarify") return;
    // The most recently used match is offered first: the user still has to answer, but the answer
    // they are most likely to give is the one at hand.
    expect(outcome.options[0]).toContain("agentkit-docs");
  });

  it("asks for a path when nothing matches, instead of inventing one", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const outcome = await resolveProject(deps, { intent: "dự án hoàn toàn không tồn tại trên máy" });
    expect(["ask-for-directory", "clarify"]).toContain(outcome.status);
  });

  it("refuses a directory that has gone, and one that left the approved roots", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const agentkit = listProjects(db, "node_local", 100).find((project) => project.name === "agentkit");
    expect(agentkit).toBeDefined();
    if (agentkit === undefined) return;

    // Removed from disk: the index is stale and the verification is what notices.
    rmSync(agentkit.path, { recursive: true, force: true });
    const missing = verifyProject(deps, agentkit.projectId);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(["PATH_MISSING", "PROJECT_UNKNOWN"]).toContain(missing.code);

    // Outside the approved roots: the same row, a root the user no longer approves.
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const scoped = { ...deps, roots: () => [join(home, "photos")] };
    const outside = verifyProject(scoped, (listProjects(db, "node_local", 100).find((project) => project.name === "agentkit")?.projectId ?? ""));
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.code).toBe("OUTSIDE_APPROVED_ROOTS");

    // An unknown id is refused rather than treated as absent-but-fine.
    const unknown = verifyProject(deps, "prj_missing");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("PROJECT_UNKNOWN");
  });

  it("reads what is on disk when a project disappears between scans", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const docs = listProjects(db, "node_local", 100).find((project) => project.name === "agentkit-docs");
    expect(docs).toBeDefined();
    if (docs === undefined) return;
    unlinkSync(join(home, "agentkit-docs", "README.md"));
    rmSync(join(home, "agentkit-docs", "docs"), { recursive: true, force: true });
    // The row is still indexed and its path is still a directory; verification succeeds, which is
    // correct: the directory exists, and what changed inside it is not this layer's business.
    expect(verifyProject(deps, docs.projectId).ok).toBe(true);
  });
});

describe("the selector's view", () => {
  function responder(choice: string, probabilities: Record<string, number>): { transport: JevTransport; seen: string[] } {
    const seen: string[] = [];
    return {
      seen,
      transport: async (request) => {
        seen.push(JSON.stringify(request.body));
        return {
          status: 200,
          body: { model: "jev-1.13.0", answers: { project: { type: "choice", choice, probabilities } } },
        };
      },
    };
  }

  it("offers names and relative paths, never an absolute home path", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const recorded = responder("none", {});
    const withDecider: ProjectFinderDeps = {
      ...deps,
      decider: {
        jev: {
          config: {
            enabled: true,
            localOnly: false,
            apiKey: "sk-test-not-a-real-key",
            endpoint: "https://api.typesafe.ai/v1/systemone",
            endpointRefusal: undefined,
            model: "jev-1.13.0",
            timeoutMs: 4000,
            maxCallsPerTurn: 2,
            policyVersion: "test",
            confidenceFloor: 0.85,
            marginFloor: 0.2,
            noulOnFloor: 0.85,
            noulOffFloor: 0.15,
          },
          transport: recorded.transport,
        },
        budget: () => ({ deadlineAt: Date.now() + 4000 }),
      },
    };

    const outcome = await resolveProject(withDecider, { intent: "dự án agentkit" });
    expect(recorded.seen.length).toBeGreaterThan(0);
    const payload = recorded.seen.join(" ");
    expect(payload).not.toContain(home);
    expect(payload).toContain("agentkit");
    // Declining every candidate becomes a clarifying question rather than a guess.
    expect(["clarify", "resolved"]).toContain(outcome.status);
  });

  it("uses a decisive choice, and records the use so the next question is easier", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const agentkit = listProjects(db, "node_local", 100).find((project) => project.name === "agentkit");
    const docs = listProjects(db, "node_local", 100).find((project) => project.name === "agentkit-docs");
    expect(agentkit).toBeDefined();
    expect(docs).toBeDefined();
    if (agentkit === undefined || docs === undefined) return;

    const recorded = responder(agentkit.projectId, {
      [agentkit.projectId]: 0.94,
      [docs.projectId]: 0.04,
      none: 0.02,
    });
    const withDecider: ProjectFinderDeps = {
      ...deps,
      decider: {
        jev: {
          config: {
            enabled: true,
            localOnly: false,
            apiKey: "sk-test-not-a-real-key",
            endpoint: "https://api.typesafe.ai/v1/systemone",
            endpointRefusal: undefined,
            model: "jev-1.13.0",
            timeoutMs: 4000,
            maxCallsPerTurn: 2,
            policyVersion: "test",
            confidenceFloor: 0.85,
            marginFloor: 0.2,
            noulOnFloor: 0.85,
            noulOffFloor: 0.15,
          },
          transport: recorded.transport,
        },
        budget: () => ({ deadlineAt: Date.now() + 4000 }),
      },
    };

    const outcome = await resolveProject(withDecider, { intent: "dự án agentkit" });
    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") return;
    expect(outcome.mode).toBe("jev");
    expect(outcome.project.projectId).toBe(agentkit.projectId);

    const context = projectContext(outcome.project);
    expect(context).toContain("agentkit");
    expect(context).toContain("không phải");
  });
});

describe("the index surface", () => {
  it("lists what is indexed without reading any directory", async () => {
    buildTree();
    await refreshProjectIndex(deps, { full: true });
    const listed = listProjects(db, "node_local", 100);
    expect(listed.length).toBeGreaterThanOrEqual(4);
    // Listing is a database read, so it does not depend on the filesystem being readable.
    rmSync(home, { recursive: true, force: true });
    expect(listProjects(db, "node_local", 100).length).toBeGreaterThanOrEqual(4);
  });
});

describe("a directory the user typed", () => {
  it("recognises a path in what the user said, quoted or bare", () => {
    expect(pathFromIntent("mở /Users/duy/proj đi")).toBe("/Users/duy/proj");
    expect(pathFromIntent('dùng "~/my vault" nhé')).toBe("~/my vault");
    // A path at the end of a sentence carries the sentence's punctuation.
    expect(pathFromIntent("dùng /Users/duy/proj.")).toBe("/Users/duy/proj");
    // Words are not paths, and neither is a relative path: nothing here is a directory to open.
    expect(pathFromIntent("kế hoạch tuần này")).toBeUndefined();
    expect(pathFromIntent("proj/sub")).toBeUndefined();
  });

  it("indexes a named directory even when nothing marks it", async () => {
    mkdirSync(join(home, "plain-folder"), { recursive: true });
    const outcome = indexDirectoryPath(deps, join(home, "plain-folder"));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const projects = listProjects(db, "node_local", 10);
    const indexed = projects.find((project) => project.projectId === outcome.projectId);
    // The scanner would have skipped this directory — no marker, no media. The user naming it is the
    // signal that makes it a project, which is what "nhập path" has to mean.
    expect(indexed?.path).toBe(join(home, "plain-folder"));
    expect(indexed?.name).toBe("plain-folder");
    expect(indexed?.kind).toBe("generic");
  });

  it("accepts a home-relative path and refuses one outside the approved roots", () => {
    mkdirSync(join(home, "vault"), { recursive: true });
    expect(indexDirectoryPath(deps, "~/vault").ok).toBe(true);

    const outside = indexDirectoryPath(deps, "/tmp");
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.code).toBe("OUTSIDE_APPROVED_ROOTS");
  });

  it("reports a path that is missing or is not a directory", () => {
    const missing = indexDirectoryPath(deps, join(home, "not-here"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("PATH_MISSING");

    writeFileSync(join(home, "a-file.md"), "# not a directory");
    const file = indexDirectoryPath(deps, join(home, "a-file.md"));
    expect(file.ok).toBe(false);
    if (!file.ok) expect(file.code).toBe("NOT_A_DIRECTORY");
  });

  it("does not index the same directory twice", () => {
    mkdirSync(join(home, "twice"), { recursive: true });
    const first = indexDirectoryPath(deps, join(home, "twice"));
    const second = indexDirectoryPath(deps, join(home, "twice"));
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.projectId).toBe(first.projectId);
    expect(listProjects(db, "node_local", 100).filter((project) => project.name === "twice")).toHaveLength(1);
  });

  it("resolves a typed path without searching, so the directory question is answered once", async () => {
    mkdirSync(join(home, "typed-target"), { recursive: true });
    let selectorCalls = 0;
    const resolution = await resolveProject(
      {
        ...deps,
        decider: {
          jev: {
            config: {
              enabled: true,
              localOnly: false,
              apiKey: "sk-test-not-a-real-key",
              endpoint: "https://api.typesafe.ai/v1/systemone",
              endpointRefusal: undefined,
              model: "jev-1.13.0",
              timeoutMs: 2000,
              maxCallsPerTurn: 2,
              policyVersion: "2026-09-17",
              confidenceFloor: 0.85,
              marginFloor: 0.2,
              noulOnFloor: 0.85,
              noulOffFloor: 0.15,
            },
            transport: async () => {
              selectorCalls += 1;
              return { status: 200, body: {} };
            },
          },
          budget: () => ({ deadlineAt: Date.now() + 2000, timeoutMs: 2000 }),
        },
      },
      { intent: `mở giúp tui ${join(home, "typed-target")}` },
    );

    expect(resolution.status).toBe("resolved");
    if (resolution.status !== "resolved") return;
    // `path` rather than `rank`: the answer records that the user named it, which is what a later
    // reader needs to tell a typed directory from a searched one.
    expect(resolution.mode).toBe("path");
    expect(resolution.relPath).toBe("typed-target");
    expect(resolution.project.path).toBe(join(home, "typed-target"));
    // A path is not a query: nothing was searched and the selector was never asked.
    expect(selectorCalls).toBe(0);
  });

  it("rejects a typed path it cannot use instead of asking for a path again", async () => {
    const outside = await resolveProject(deps, { intent: `dùng /tmp đi` });
    expect(outside.status).toBe("rejected");
    if (outside.status === "rejected") expect(outside.code).toBe("OUTSIDE_APPROVED_ROOTS");

    const missing = await resolveProject(deps, { intent: `dùng ${join(home, "gone")} đi` });
    expect(missing.status).toBe("rejected");
    if (missing.status === "rejected") expect(missing.code).toBe("PATH_MISSING");
  });
});
