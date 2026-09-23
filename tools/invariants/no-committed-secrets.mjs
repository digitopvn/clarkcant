/**
 * No live credentials in tracked files, and no repository metadata that would
 * let a build quietly pick up a secret from the environment.
 */
import { join } from "node:path";

import { existsSync, readFileSync } from "./context.mjs";

export default function run(ctx) {
  const { repoRoot, check, walk, relative } = ctx;
  const c = check("no-committed-secrets");
  const patterns = [
    { re: /gh[pousr]_[A-Za-z0-9]{20,}/, what: "GitHub token" },
    { re: /sk-[A-Za-z0-9]{20,}/, what: "OpenAI-style API key" },
    { re: /AKIA[0-9A-Z]{16}/, what: "AWS access key id" },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: "private key block" },
    { re: /npm_[A-Za-z0-9]{30,}/, what: "npm token" },
  ];
  const files = [];
  for (const group of ["packages", "apps", "packs", "examples", "docs", "tools"]) {
    files.push(...walk(join(repoRoot, group), (f) => /\.(ts|tsx|js|mjs|json|md|ya?ml)$/.test(f)));
  }
  files.push(join(repoRoot, "package.json"));
  for (const file of files) {
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const { re, what } of patterns) {
      if (re.test(source)) {
        c.failures.push(`${relative(file)} appears to contain a ${what}`);
      }
    }
  }
  c.notes.push(`${files.length} files scanned for credential patterns`);
}
