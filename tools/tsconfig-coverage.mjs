/**
 * Which workspace `.tsx` files no tsconfig actually typechecks.
 *
 * This lives outside check-invariants.mjs so the matching can be tested on its own. That is not tidiness: a
 * matcher that quietly fails to match is indistinguishable from a repository with nothing wrong, which is the
 * one outcome this module must never produce.
 */

/** Extglob-style syntax this module does not implement. A pattern it cannot read has to fail loudly. */
const UNSUPPORTED_GLOB = /[?[\]{}()!+@|]/;

/**
 * One TypeScript `include`/`exclude` entry as a RegExp, or `undefined` when the pattern uses glob syntax this
 * module does not implement.
 *
 * Implements the syntax these configs actually use: literal segments, `*` for one path segment, and `**` for any
 * number of segments including none — which is what makes a `**` pattern rooted at `packages/a/src/` match both
 * `packages/a/src/Orb.tsx` and `packages/a/src/settings/Panel.tsx`, as TypeScript does.
 *
 * @param {unknown} pattern
 * @returns {RegExp | undefined}
 */
export function includeRegExp(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) return undefined;
  if (UNSUPPORTED_GLOB.test(pattern.replace(/\*/g, ""))) return undefined;
  const source = pattern
    .replace(/[.+^$\\]/g, "\\$&")
    .replace(/\*\*\/|\*\*|\*/g, (match) =>
      match === "**/" ? "(?:.*/)?" : match === "**" ? ".*" : "[^/]*",
    );
  return new RegExp(`^${source}$`);
}

/**
 * The files no config puts in a program, applying the rule TypeScript itself applies: a file is in the program
 * when some `include` matches it and no `exclude` in that same config removes it again.
 *
 * @param {string[]} files repo-relative paths
 * @param {{name: string, include?: string[], exclude?: string[]}[]} configs
 * @returns {{uncovered: string[], problems: string[]}}
 */
export function uncoveredFiles(files, configs) {
  const problems = [];
  const compiled = [];
  for (const config of configs) {
    const includes = Array.isArray(config.include) ? config.include : [];
    const excludes = Array.isArray(config.exclude) ? config.exclude : [];
    for (const pattern of [...includes, ...excludes]) {
      if (includeRegExp(pattern) === undefined) {
        problems.push(
          `${config.name}: unsupported glob ${JSON.stringify(pattern)}, so this check cannot read that config`,
        );
      }
    }
    if (includes.length === 0) continue;
    compiled.push({
      includes: includes.map(includeRegExp).filter((pattern) => pattern !== undefined),
      excludes: excludes.map(includeRegExp).filter((pattern) => pattern !== undefined),
    });
  }
  const uncovered = files.filter(
    (file) =>
      !compiled.some(
        ({ includes, excludes }) =>
          includes.some((pattern) => pattern.test(file)) &&
          !excludes.some((pattern) => pattern.test(file)),
      ),
  );
  return { uncovered, problems };
}
