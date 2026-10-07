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
    if (!["README.md", "README.vi.md", "DESIGN.md", "DESIGN.vi.md", "AGENTS.md", "docs/manifest.json"].includes(path)
      && !/^(docs|plans)\/.+\.md$/u.test(path)) {
      return { full: true, reason: "changes outside prose allowlist" };
    }
  }
  return { full: false, reason: "documentation only; invariants required" };
}

/**
 * What a change must touch to change the published widget author tooling, or how it is built, smoke-tested or released:
 * the workspace packages its bundles inline (`tools/test/build-widget-tooling.spec.ts` checks this list against the
 * build's own record of them), the reference apps its templates copy, the root manifests and lockfile, the TypeScript
 * config its declarations are emitted with, and its scripts and workflows. A directory ends in `/`.
 */
export const WIDGET_TOOLING_PATHS = [
  "packages/contracts/",
  "packages/conversation-client/",
  "packages/core/",
  "packages/design-tokens/",
  "packages/integration-sdk/",
  "packages/storage/",
  "packages/widget-catalog/",
  "packages/widget-cli/",
  "packages/widget-host/",
  "packages/widget-sdk/",
  "packs/data-canvas/",
  "examples/reference-apps/",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "LICENSE",
  "tools/ci-test-scope.mjs",
  ".github/workflows/ci.yml",
  ".github/workflows/release-widget-tooling.yml",
];

/** Whether CI should run the widget tooling smoke: a changed path it depends on, or a diff it cannot read. */
export function touchesWidgetTooling(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return true;
  return paths.some((path) => typeof path !== "string"
    || /^tools\/(?:[^/]+\/)*[^/]*widget-tooling[^/]*$/u.test(path)
    || WIDGET_TOOLING_PATHS.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry)));
}

function main() {
  let result = { full: true, reason: "diff unavailable" };
  // A diff that cannot be read runs the smoke too.
  let widgetTooling = true;
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
    const paths = diff === "" ? [] : diff.slice(0, -1).split("\0");
    result = classifyPaths(paths);
    widgetTooling = touchesWidgetTooling(paths);
  } catch {
    // A missing base, failed Git command, or malformed result must never skip tests.
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${result.full}\nwidget_tooling=${widgetTooling}\n`);
  console.log(`Test scope: ${result.full ? "full" : "docs-only"} (${result.reason}); widget tooling smoke: ${widgetTooling ? "run" : "skipped"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
