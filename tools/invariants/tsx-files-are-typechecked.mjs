/**
 * Every `.tsx` in the workspace is covered by a typecheck include.
 *
 * `tsconfig.json` matches `.ts` and never `.tsx`, and `tsconfig.web.json` names only the web roots it covers. A
 * `.tsx` outside those roots is therefore in neither program: `pnpm typecheck` passes, `pnpm verify` passes, and
 * nothing has read the file. The widget CLI's browser entry was written into exactly that hole and escaped only
 * because its path was added to `tsconfig.web.json` by hand.
 *
 * The config list is read out of the `typecheck` script rather than naming the two files here, so a third config
 * is covered the moment it is wired in — and the check fails when it resolves no config or finds no `.tsx`, so it
 * cannot pass by having lost its own subject. The matching lives in tsconfig-coverage.mjs so it can be tested.
 */
import { join } from "node:path";

import { existsSync } from "./context.mjs";
import { uncoveredFiles } from "../tsconfig-coverage.mjs";

export default function run(ctx) {
  const { repoRoot, check, walk, relative, readJson } = ctx;
  const c = check("tsx-files-are-typechecked");
  const roots = ["packages", "apps", "packs", "examples", "tools"];
  const files = roots
    .flatMap((root) => walk(join(repoRoot, root), (path) => path.endsWith(".tsx")))
    .map((path) => relative(path));

  const typecheck = readJson(join(repoRoot, "package.json")).scripts?.typecheck ?? "";
  const names = [...typecheck.matchAll(/-p\s+(\S+)/g)].map((match) => match[1]);
  const configs = [];
  for (const name of names) {
    const configPath = join(repoRoot, name);
    if (!existsSync(configPath)) {
      c.failures.push(`the typecheck script names ${name}, which does not exist`);
      continue;
    }
    configs.push({ name, ...readJson(configPath) });
  }

  if (configs.length === 0) {
    c.failures.push("no typecheck config could be read, so this check has no subject");
  }
  if (files.length === 0) {
    c.failures.push("no .tsx file was found, so this check has no subject");
  }

  const { uncovered, problems } = uncoveredFiles(files, configs);
  for (const problem of problems) c.failures.push(problem);
  for (const file of uncovered.slice(0, 6)) {
    c.failures.push(
      `${file} is in no typecheck include (${names.join(", ")}), so nothing typechecks it: add its path to one of them`,
    );
  }
  if (uncovered.length > 6) {
    c.failures.push(`and ${uncovered.length - 6} more .tsx file(s) in no typecheck include`);
  }
  c.notes.push(
    `${files.length} .tsx file(s) checked against ${configs.length} typecheck config(s) — ${names.join(", ")}`,
  );
}
