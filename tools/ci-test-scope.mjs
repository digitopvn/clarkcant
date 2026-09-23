import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Only known prose surfaces may omit runtime tests; invariants still run. */
export function classifyPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { full: true, reason: "empty or unavailable diff" };
  }
  for (const path of paths) {
    if (typeof path !== "string" || /[\\:]/u.test(path)
      || [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      return { full: true, reason: "unrecognized path" };
    }
    if (!["README.md", "DESIGN.md", "AGENTS.md", "docs/manifest.json"].includes(path)
      && !/^(docs|plans)\/.+\.md$/u.test(path)) {
      return { full: true, reason: "changes outside prose allowlist" };
    }
  }
  return { full: false, reason: "documentation only; invariants required" };
}

function main() {
  let result = { full: true, reason: "diff unavailable" };
  try {
    const base = process.env.CI_DIFF_BASE ?? "";
    const head = process.env.CI_DIFF_HEAD ?? "HEAD";
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(base) || /^0+$/u.test(base)
      || (head !== "HEAD" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(head))) {
      throw new Error("invalid revision");
    }
    const diff = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base, head, "--"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    if (diff !== "" && !diff.endsWith("\0")) throw new Error("incomplete diff");
    result = classifyPaths(diff === "" ? [] : diff.slice(0, -1).split("\0"));
  } catch {
    // A missing base, failed Git command, or malformed result must never skip tests.
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${result.full}\n`);
  console.log(`Test scope: ${result.full ? "full" : "docs-only"} (${result.reason})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
