import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { repoRelativePath, walk } from "../invariants/context.mjs";
import runCheck, {
  blankCommentsAndStrings,
  checkedFiles,
  isTestPath,
  retryingRmSyncLines,
} from "../invariants/test-cleanup-retries-asynchronously.mjs";
import { removeTestDirectory } from "../test-cleanup.ts";

// The sources below are strings, which the check blanks before it reads a file, so this file does not read as the calls
// it describes.
describe("the check on retrying synchronous removal in test code", () => {
  it("finds a call that asks for retries, wrapped across lines or not", () => {
    const source = [
      'import { rmSync } from "node:fs";',
      "afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));",
      "afterAll(() => {",
      "  rmSync(",
      '    join(dir, "x"),',
      "    { recursive: true, maxRetries: 3, retryDelay: 50 },",
      "  );",
      "});",
      "fs.rmSync(dir, { maxRetries: 2 });",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([2, 4, 9]);
  });

  it("leaves a call without retries, and the promise form with them, alone", () => {
    const source = [
      "rmSync(root, { recursive: true, force: true });",
      "await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });",
      "await removeTestDirectory(dir);",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([]);
  });

  it("does not read a call named in a comment as a call", () => {
    const source = [
      "// rmSync(dir, { maxRetries: 3 }) never retries on Windows",
      "/* rmSync(dir, {",
      "     maxRetries: 3 }) */",
      "rmSync(dir, { recursive: true }); // no maxRetries here",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([]);
  });

  it("does not let a parenthesis in a string unbalance the call, nor read a call inside a string", () => {
    const source = [
      'rmSync(join(dir, "a("), { recursive: true });',
      "const later = { maxRetries: 3 };",
      "const text = 'rmSync(dir, { maxRetries: 3 })';",
      "const fixture = `rmSync(dir, { maxRetries: 3 })`;",
      "const options = { maxRetries: 3 };",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([]);
  });

  it("reads the code inside a template literal's expression", () => {
    const source = ["const result = `${String(rmSync(dir, { maxRetries: 3 }))} and ${'('}`;", "rmSync(other, { maxRetries: 1 });"].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([1, 2]);
  });

  it("finds rmSync under a name the file gives it", () => {
    const source = [
      'import { rmSync as wipe } from "node:fs";',
      'const { rmSync: erase } = await import("node:fs");',
      "const remove = fs.rmSync;",
      "wipe(dir, { maxRetries: 3 });",
      "erase(dir, { maxRetries: 3 });",
      "remove(dir, { maxRetries: 3 });",
      "wipe(dir, { recursive: true });",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([4, 5, 6]);
  });

  it("leaves a call marked as showing the failing form on purpose", () => {
    const source = [
      "// invariant-allow: sync-rm-retries",
      "rmSync(dir, { maxRetries: 3 });",
      "rmSync(dir, { maxRetries: 3 }); // invariant-allow: sync-rm-retries",
      "",
      "rmSync(dir, { maxRetries: 3 });",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([5]);
  });

  it("finds rmSync taken from require under another name", () => {
    const source = [
      'const wipe = require("node:fs").rmSync;',
      "const erase = require('fs').rmSync",
      "wipe(dir, { maxRetries: 3 });",
      "erase(dir, { maxRetries: 3 });",
      '(await import("node:fs")).rmSync(dir, { maxRetries: 3 });',
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([3, 4, 5]);
  });

  it("finds an optional call", () => {
    const source = ["fs.rmSync?.(dir, { maxRetries: 3 });", "rmSync ?. (dir, { maxRetries: 3 });", "fs.rmSync?.(dir, { recursive: true });"].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([1, 2]);
  });

  it("finds a call by bracket access, and an alias taken that way", () => {
    const source = [
      'fs["rmSync"](dir, { maxRetries: 3 });',
      "fs[ 'rmSync' ](dir, {",
      "  maxRetries: 3 });",
      'const wipe = fs["rmSync"];',
      "wipe(dir, { maxRetries: 3 });",
      'fs["rmSync"](dir, { recursive: true });',
      'const text = \'fs["rmSync"](dir, { maxRetries: 3 })\';',
      '// fs["rmSync"](dir, { maxRetries: 3 })',
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([1, 2, 5]);
  });

  it("counts the marker only in a comment, not in a string", () => {
    const source = [
      'const note = "invariant-allow: sync-rm-retries";',
      "rmSync(dir, { maxRetries: 3 });",
      "rmSync(dir, { maxRetries: 3, label: 'invariant-allow: sync-rm-retries' });",
      "/* invariant-allow: sync-rm-retries */ rmSync(dir, { maxRetries: 3 });",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([2, 3]);
  });

  it("does not let an apostrophe in JSX text hide a call later on its line", () => {
    const source = [
      "const view = <p>Don't</p>; rmSync(dir, { maxRetries: 3 });",
      'const size = <p>6" wide</p>; rmSync(dir, { maxRetries: 3 });',
      "const name = 'it\\'s'; rmSync(dir, { recursive: true });",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([1, 2]);
  });

  it("keeps reading code after a regular expression that holds a quote or a backtick", () => {
    const source = [
      "const said = /say: `Đã /u;",
      "const quoted = /it's \"(/g;",
      "rmSync(dir, { maxRetries: 3 });",
      "const text = `/not a regex: '`; rmSync(dir, { maxRetries: 3 });",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([3, 4]);
    const blanked = ["say: `Đã ", "it's \"(", "/not a regex: '"].reduce((text, body) => text.replace(body, " ".repeat(body.length)), source);
    expect(blankCommentsAndStrings(source)).toBe(blanked);
  });

  it("reads a string right after a keyword as a string", () => {
    const source = [
      "function open() { return'(' } rmSync(dir, { maxRetries: 3 });",
      "switch (key) { case'(': break; } rmSync(dir, { maxRetries: 3 });",
      "if (typeof'(' === kind) {} rmSync(dir, { maxRetries: 3 });",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([1, 2, 3]);
  });

  it("finds bracket access whose key sits on the next line", () => {
    const source = ["fs[", '  "rmSync"](dir, { maxRetries: 3 });', "fs?.[", "  `rmSync`", "](dir, { maxRetries: 3 });"].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([2, 4]);
  });

  it("does not take the marker written as JSX text for a comment", () => {
    const source = [
      "const view = <p>// invariant-allow: sync-rm-retries</p>;",
      "rmSync(dir, { maxRetries: 3 });",
      "const note = <p>{/* invariant-allow: sync-rm-retries */}</p>;",
      "rmSync(dir, { maxRetries: 3 });",
    ].join("\n");
    expect(retryingRmSyncLines(source)).toEqual([2]);
  });

  it("reads a file in the language its extension names", () => {
    const source = "const size = <number>value; rmSync(dir, { maxRetries: 3 });";
    expect(retryingRmSyncLines(source, "apps/web/test/helper.ts")).toEqual([1]);
    expect(blankCommentsAndStrings("const s = <p>it's</p>;", "apps/web/test/view.jsx")).toBe("const s = <p>    </p>;");
  });

  it("reads every file it counts as test code, a .jsx spec included", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarkcant-cleanup-check-"));
    try {
      const call = "rmSync(dir, { maxRetries: 3 });\n";
      for (const path of ["apps/web/src/view.spec.jsx", "apps/web/test/helper.jsx", "apps/web/src/view.jsx", "apps/web/test/notes.md"]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), call);
      }
      const result = { failures: [] as string[], notes: [] as string[] };
      runCheck({ repoRoot: root, walk, relative: (target: string) => repoRelativePath(root, target), check: () => result });
      expect(result.failures.map((failure) => failure.split(":")[0]).sort()).toEqual(["apps/web/src/view.spec.jsx", "apps/web/test/helper.jsx"]);
    } finally {
      await removeTestDirectory(root);
    }
  });

  it("covers specs, the helpers in test and e2e folders and CI's widget tooling smoke, not product code", () => {
    expect(isTestPath("apps/runtime/test/live-nodes.ts")).toBe(true);
    expect(isTestPath("apps/web/e2e/fixtures/server.mjs")).toBe(true);
    expect(isTestPath("packages/core/src/thing.spec.ts")).toBe(true);
    expect(isTestPath("tools/smoke-widget-tooling.mjs")).toBe(true);
    expect(isTestPath("apps/runtime/src/worker-process.ts")).toBe(false);
    expect(isTestPath("tools/test-cleanup.ts")).toBe(false);
  });
});

describe("the check over this repository's test code", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const ctx = { repoRoot, walk, relative: (target: string) => repoRelativePath(repoRoot, target) };

  /**
   * What the parser says is not code in `source`, as one flag per character: comments, found from every node's and
   * node list's edges, and the text of literals, delimiters left out. Read through the AST independently of the check's
   * own walk over tokens.
   */
  function parserNonCode(source: string, path: string): boolean[] {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const flags: boolean[] = Array.from({ length: source.length }, () => false);
    const mark = (from: number, to: number, value: boolean) => {
      for (let index = from; index < to; index += 1) flags[index] = value;
    };
    const comments: ts.CommentRange[] = [];
    const jsxText: [number, number][] = [];
    const edges = (...points: number[]) => {
      for (const point of points) {
        comments.push(...(ts.getLeadingCommentRanges(source, point) ?? []), ...(ts.getTrailingCommentRanges(source, point) ?? []));
      }
    };
    const visit = (node: ts.Node) => {
      const start = node.getStart(file);
      if (ts.isJsxText(node)) jsxText.push([node.pos, node.end]);
      else edges(node.pos, node.end);
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateTail(node)) mark(start + 1, node.end - 1, true);
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) mark(start + 1, node.end - 2, true);
      else if (ts.isRegularExpressionLiteral(node)) mark(start + 1, source.lastIndexOf("/", node.end - 1), true);
      ts.forEachChild(node, visit, (nodes) => {
        edges(nodes.pos, nodes.end);
        nodes.forEach(visit);
      });
    };
    visit(file);
    // A shebang is not code either; the comment ranges start after it.
    if (source.startsWith("#!")) comments.push({ pos: 0, end: source.search(/\r?\n|$/), kind: ts.SyntaxKind.SingleLineCommentTrivia });
    for (const range of comments) mark(range.pos, range.end, true);
    // What reads like a comment inside JSX text is text, and all of JSX text is literal text.
    for (const [from, to] of jsxText) mark(from, to, true);
    return flags;
  }

  it("agrees with the TypeScript parser on what is code, in every file it reads", () => {
    const disagreements: string[] = [];
    const files = checkedFiles(ctx);
    for (const path of files) {
      const source = readFileSync(join(repoRoot, path), "utf8");
      const code = blankCommentsAndStrings(source, path);
      const nonCode = parserNonCode(source, path);
      expect(code.length).toBe(source.length);
      for (let index = 0; index < source.length; index += 1) {
        const character = source.charAt(index);
        if (character === " " || character === "\n" || character === "\r" || character === "\t" || (character > "~" && /\s/.test(character))) continue;
        if ((code[index] === " ") !== nonCode[index]) {
          const line = source.slice(0, index).split("\n").length;
          const text = source.split("\n")[line - 1] ?? "";
          disagreements.push(`${path}:${String(line)} ${nonCode[index] ? "reads as code" : "blanks code"}: ${text.trim()}`);
          break;
        }
      }
    }
    expect(files.length).toBeGreaterThan(500);
    expect(disagreements).toEqual([]);
    // Parsing every test file twice takes seconds, more on a slow runner.
  }, 60_000);

  // CI runs the invariants before it installs the parser, so this is where CI holds the repository to the check.
  it("finds no retrying synchronous removal in the repository's test code", () => {
    const result = { failures: [] as string[], notes: [] as string[] };
    runCheck({ ...ctx, check: () => result });
    expect(result.failures).toEqual([]);
    expect(result.notes.join("\n")).toMatch(/test file\(s\) checked/);
  });
});

/**
 * A process whose working directory is `dir` until `release` is called, which on Windows keeps `dir` from being removed.
 * Resolves once the process says it runs, so the directory is held by then.
 */
async function holdAsWorkingDirectory(dir: string): Promise<{ release: () => Promise<void> }> {
  const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'], {
    cwd: dir,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  await new Promise<void>((done, fail) => {
    child.stdout.once("data", () => done());
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`the holding process exited (${String(code)}) before it said it runs`)));
  });
  return {
    release: async () => {
      child.stdin.end();
      await exited;
    },
  };
}

/**
 * The reason for the check, measured: a directory held for a moment, as by a child process that is still exiting (or an
 * antivirus, or an indexer). Only Windows refuses to remove a directory another process holds, so only there does this
 * say anything.
 */
describe.runIf(process.platform === "win32")("removing a directory Windows still holds", () => {
  // Node 22 and Node 24 before 24.21 fail at once without retrying; from 24.21 the retries run but sleep the main thread.
  // Either way the release the test schedules cannot happen during the call, so the outcome is the same on every version.
  it("fails in the synchronous form though it asks for retries, because the release it waits for cannot run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarkcant-cleanup-retry-"));
    writeFileSync(join(dir, "file.txt"), "held");
    const held = await holdAsWorkingDirectory(dir);
    // Let go 100 ms in, well within the retry budget below (100 + 200 + 300 + 400 ms), as removeTestDirectory's test does.
    const released = new Promise<void>((done) => setTimeout(() => void held.release().then(done), 100));
    try {
      // The failing form, on purpose: the check this file tests would otherwise flag it as test cleanup.
      // invariant-allow: sync-rm-retries
      expect(() => rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })).toThrow(/EPERM|EBUSY/);
      expect(existsSync(dir)).toBe(true);
    } finally {
      await released;
      await removeTestDirectory(dir);
    }
  });

  it("retries in removeTestDirectory until the directory is let go, and removes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarkcant-cleanup-retry-"));
    writeFileSync(join(dir, "file.txt"), "held");
    const held = await holdAsWorkingDirectory(dir);
    const holdMs = 700;
    const started = Date.now();
    let releasedAt: number | undefined;
    const released = new Promise<void>((done) =>
      setTimeout(() => {
        void held.release().then(() => {
          releasedAt = Date.now();
          done();
        });
      }, holdMs),
    );
    try {
      await removeTestDirectory(dir);
      expect(existsSync(dir)).toBe(false);
      // Removed only after the holder was let go, so the first attempts failed and a later one, made after waiting,
      // succeeded.
      expect(Date.now() - started).toBeGreaterThanOrEqual(holdMs);
    } finally {
      await released;
    }
    expect(releasedAt).toBeDefined();
  });
});
