import { posix } from "node:path";

import {
  PACKAGE_INSTRUCTION_LIMITS,
  PROJECT_INSTRUCTION_LIMITS,
  projectInstructionSnippetPath,
  readProjectInstructions,
  type PackageSource,
  type ProjectInstructionRule,
  type SkippedFacetsRecord,
} from "@clarkcant/contracts";

import { readPackageFile } from "./package-files.ts";
import { parseManifest } from "./widget-package.ts";

/**
 * The conditional instructions an installed package declares, read and validated by the host.
 *
 * An `instructions` facet's `entry` is a rules file in the same open contract as a project's
 * `.clarkcant/instructions.json`, and each snippet a rule includes is `instructions/<name>.md` beside it. The host only
 * ever reads them as text to state, framed as data; nothing here runs package code. What this reader guards is which
 * file is read and how much of it:
 *
 * - Every file is read through `readPackageFile`, the containment a widget frame's files go through: a path that resolves
 *   outside the package, including through a link, is refused. A snippet is named by a plain name, so a rule cannot
 *   reach the host's files, another package's or a project's.
 * - Only this node's own bytes: a source it has not fetched is `NOT_LOCAL`, never a request to fetch it.
 * - Bounded as a project's file is (rules, bytes, glob work), and a snippet is clipped to the package slice.
 * - One broken facet is named and the package's other facets still load.
 *
 * Reading them grants nothing either: whether they are stated at all is the person's per-project choice.
 */

export interface InstalledInstructionsFacet {
  facetId: string;
  rules: readonly ProjectInstructionRule[];
  /** Snippet text by name, for each name a rule includes that has a readable, non-empty file. */
  snippets: ReadonlyMap<string, string>;
}

export interface InstalledInstructionsProblem {
  facetId: string;
  message: string;
}

export type InstalledInstructionsOutcome =
  | {
      ok: true;
      manifestId: string;
      version: string;
      facets: readonly InstalledInstructionsFacet[];
      problems: readonly InstalledInstructionsProblem[];
    }
  | { ok: false; code: "NOT_LOCAL" | "UNREADABLE"; message: string };

/** What a clipped package snippet ends with, as a project's does. */
const CLIPPED = "\n[…đã cắt bớt]";

export function installedInstructions(input: {
  source: PackageSource;
  /** The facets the generation's install skipped, kept inert (`InstalledReadOptions`). */
  skippedAtInstall?: SkippedFacetsRecord | undefined;
}): InstalledInstructionsOutcome {
  if (input.source.kind !== "local") {
    return {
      ok: false,
      code: "NOT_LOCAL",
      message: `this node has no bytes for a ${input.source.kind} package, so its instructions cannot be read here`,
    };
  }
  const entry = { source: input.source };
  const manifestFile = readPackageFile({ entry, relativePath: "clarkcant.json" });
  if (!manifestFile.ok) return { ok: false, code: "UNREADABLE", message: `clarkcant.json: ${manifestFile.message}` };
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch {
    return { ok: false, code: "UNREADABLE", message: "clarkcant.json: is not valid JSON" };
  }
  const parsed = parseManifest(manifestJson, { skippedAtInstall: input.skippedAtInstall });
  if (!parsed.ok) return { ok: false, code: "UNREADABLE", message: `clarkcant.json: ${parsed.problems.join("; ")}` };
  const manifest = parsed.manifest;

  const facets: InstalledInstructionsFacet[] = [];
  const problems: InstalledInstructionsProblem[] = [];
  for (const facet of manifest.facets) {
    if (facet.kind !== "instructions") continue;
    const problem = (reason: string): void => {
      problems.push({ facetId: facet.id, message: `instructions ${facet.id} (${facet.entry}): ${reason}` });
    };
    const file = readPackageFile({ entry, relativePath: facet.entry });
    if (!file.ok) {
      problem(file.message);
      continue;
    }
    if (file.bytes.length > PROJECT_INSTRUCTION_LIMITS.fileBytes) {
      problem(`the file is ${String(file.bytes.length)} bytes, over the ${String(PROJECT_INSTRUCTION_LIMITS.fileBytes)}-byte limit`);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(file.bytes.toString("utf8"));
    } catch {
      problem("is not valid JSON");
      continue;
    }
    const read = readProjectInstructions(json);
    if (!read.ok) {
      problem(read.reason === "unknown-version" ? `version ${String(read.version)} is not one this build reads` : "is not an instructions file");
      continue;
    }
    const folder = posix.dirname(facet.entry.replace(/\\/g, "/"));
    const snippets = new Map<string, string>();
    for (const name of new Set(read.rules.flatMap((rule) => rule.include))) {
      const snippet = readPackageFile({ entry, relativePath: posix.join(folder, projectInstructionSnippetPath(name)) });
      // Bytes, not characters: generous enough for a full snippet in any script, still bounded.
      if (!snippet.ok || snippet.bytes.length > PACKAGE_INSTRUCTION_LIMITS.snippetChars * 16) continue;
      const text = snippet.bytes.toString("utf8").trim();
      if (text === "") continue;
      snippets.set(
        name,
        text.length <= PACKAGE_INSTRUCTION_LIMITS.snippetChars ? text : `${text.slice(0, PACKAGE_INSTRUCTION_LIMITS.snippetChars)}${CLIPPED}`,
      );
    }
    facets.push({ facetId: facet.id, rules: read.rules, snippets });
  }
  return { ok: true, manifestId: manifest.id, version: manifest.version, facets, problems };
}
