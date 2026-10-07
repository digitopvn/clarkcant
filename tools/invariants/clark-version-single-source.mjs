/**
 * One Clark version, and release tooling pinned exactly.
 *
 * The root `package.json` version is the Clark version. Every application under `apps/` and the build record the
 * runtime embeds (`apps/runtime/release-notes.json`) must carry it: a desktop shell reporting one version while the
 * runtime it starts reports another is the drift a release must never ship (`tools/release/clark-version.mjs`).
 *
 * The release tooling lives outside the app workspace with its own lockfile, so the workspace's pinning check does not
 * see it; its direct dependencies are held to exact versions here.
 */
import { join } from "node:path";

import { existsSync } from "./context.mjs";
import { clarkVersionDrift, clarkVersionManifests, readClarkVersion } from "../release/clark-version.mjs";

const RELEASE_TOOLING = "tools/release/package.json";
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export default function run(ctx) {
  const { repoRoot, check, readJson } = ctx;
  const c = check("clark-version-single-source");

  let version;
  try {
    version = readClarkVersion(repoRoot);
    c.failures.push(...clarkVersionDrift(repoRoot));
  } catch (error) {
    c.failures.push(error instanceof Error ? error.message : String(error));
    return;
  }

  const toolingPath = join(repoRoot, RELEASE_TOOLING);
  let pinned = 0;
  if (!existsSync(toolingPath)) {
    c.failures.push(`${RELEASE_TOOLING} is missing`);
  } else {
    const tooling = readJson(toolingPath);
    for (const field of ["dependencies", "devDependencies"]) {
      for (const [name, spec] of Object.entries(tooling[field] ?? {})) {
        pinned += 1;
        if (!EXACT.test(spec)) c.failures.push(`${RELEASE_TOOLING} ${field} "${name}" is not pinned to an exact version: ${spec}`);
      }
    }
  }

  c.notes.push(`Clark ${version} carried by ${clarkVersionManifests(repoRoot).length} manifests and the embedded release record`);
  c.notes.push(`${pinned} release-tooling dependencies checked for exact pins`);
}
