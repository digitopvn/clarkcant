/**
 * Stubs must be honest: a file that is not implemented has to say which phase
 * owns it, so nobody mistakes scaffolding for working behaviour.
 */
import { join } from "node:path";

import { readFileSync } from "./context.mjs";

export default function run(ctx) {
  const { repoRoot, check, walk, statusRegistry, statusById } = ctx;
  const c = check("stub-marks-owning-phase");
  const pattern = /TODO\((P(?:10|[0-9]))\):/;
  const files = [
    ...walk(join(repoRoot, "packages"), (f) => f.endsWith(".ts") && f.includes(`${join("", "src")}`)),
    ...walk(join(repoRoot, "packs"), (f) => f.endsWith(".ts")),
  ];
  let marked = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    /*
     * A status reference is a stub claim when the registry does not call it implemented. That is why
     * this reads the registry instead of a marker: the marker used to be a second copy of the status,
     * so a file could say "stub" while the registry said otherwise and both would look fine.
     *
     * When the registry could not be loaded, every reference resolves to nothing, so this stays
     * quiet: check 10 reports the load failure, and turning it into a stub claim here would bury it
     * under owning-phase failures in files that carry no marker at all.
     */
    const stubRef =
      /@implementation-status\s+stub/.test(source) ||
      (statusRegistry !== null &&
        [...source.matchAll(/@status-ref\s+([A-Za-z0-9.-]+)/g)].some(
          (match) => statusById.get(match[1])?.status !== "implemented",
        ));
    const looksLikeStub = stubRef || /throw new NotImplementedError/.test(source);
    if (!looksLikeStub) continue;
    if (!pattern.test(source)) {
      c.failures.push(
        `${ctx.relative(file)} is a stub but has no TODO(P<n>): marker naming its owning phase`,
      );
    } else {
      marked += 1;
    }
  }
  c.notes.push(`${marked} stub files carry an owning-phase marker`);
}
