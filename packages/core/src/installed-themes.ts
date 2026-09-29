import { checkThemeDocument, formatThemeRef, parseThemeRef, type PackageSource, type ThemeDocument } from "@clarkcant/contracts";

import { readPackageFile } from "./package-files.ts";
import { parseManifest } from "./widget-package.ts";

/**
 * The themes an installed package declares, read and validated by the host.
 *
 * A theme is a `themes` facet on the package's one manifest, whose `entry` is a JSON document inside the package. The
 * document is data, and the only thing the host ever does with it is hand it to the appearance compiler, which emits
 * nothing but token values under the host's own selectors. So what this reader guards is the edge before that: which
 * file is read, how much of it, and whether it is a document the contract accepts.
 *
 * - The entry is read through `readPackageFile`, the same containment the widget frame's files go through: a path
 *   that resolves outside the package, including through a symlink, is refused rather than followed.
 * - Only this node's own bytes. A source it has not fetched is `NOT_LOCAL`, never a request to go and get it, so a
 *   theme can never make the node reach the network.
 * - Every problem is named and the other themes of the package still load, because one broken facet is a fact about
 *   that facet rather than a reason to hide the package's working ones.
 */

/** A theme document larger than this is refused unread. The contract's largest valid document is a few KiB. */
export const THEME_DOCUMENT_MAX_BYTES = 64 * 1024;

export interface InstalledTheme {
  /** How the theme is selected: `package:<manifest id>#<facet id>`. */
  themeRef: string;
  facetId: string;
  document: ThemeDocument;
}

/** A theme facet that did not load, and why. */
export interface InstalledThemeProblem {
  facetId: string;
  /** The reference the theme would have had; absent when the package id cannot form one. */
  themeRef: string | undefined;
  message: string;
}

export type InstalledThemesOutcome =
  | {
      ok: true;
      /** The id the package gives itself, which is what its theme references are named under. */
      manifestId: string;
      themes: readonly InstalledTheme[];
      problems: readonly InstalledThemeProblem[];
    }
  | { ok: false; code: "NOT_LOCAL" | "UNREADABLE"; message: string };

export function installedThemes(input: { source: PackageSource }): InstalledThemesOutcome {
  if (input.source.kind !== "local") {
    return {
      ok: false,
      code: "NOT_LOCAL",
      message: `this node has no bytes for a ${input.source.kind} package, so its themes cannot be read here`,
    };
  }
  const entry = { source: input.source };

  const manifestFile = readPackageFile({ entry, relativePath: "clarkcant.json" });
  if (!manifestFile.ok) return { ok: false, code: "UNREADABLE", message: `clarkcant.json: ${manifestFile.message}` };
  const manifestJson = parseJson(manifestFile.bytes);
  if (!manifestJson.ok) return { ok: false, code: "UNREADABLE", message: `clarkcant.json: ${manifestJson.message}` };
  const parsed = parseManifest(manifestJson.value);
  if (!parsed.ok) return { ok: false, code: "UNREADABLE", message: `clarkcant.json: ${parsed.problems.join("; ")}` };
  const manifest = parsed.manifest;

  const themes: InstalledTheme[] = [];
  const problems: InstalledThemeProblem[] = [];
  for (const facet of manifest.facets) {
    if (facet.kind !== "themes") continue;
    const formatted = formatThemeRef({ kind: "package", packageId: manifest.id, facetId: facet.id });
    // A package id a reference cannot carry — one with a `#` or whitespace — would make a theme nobody can select.
    const themeRef = parseThemeRef(formatted) === undefined ? undefined : formatted;
    const problem = (reason: string): void => {
      problems.push({ facetId: facet.id, themeRef, message: `theme ${facet.id} (${facet.entry}): ${reason}` });
    };
    if (themeRef === undefined) {
      problem(`the package id ${JSON.stringify(manifest.id)} cannot name a theme`);
      continue;
    }

    const file = readPackageFile({ entry, relativePath: facet.entry });
    if (!file.ok) {
      problem(file.message);
      continue;
    }
    if (file.bytes.length > THEME_DOCUMENT_MAX_BYTES) {
      problem(`the document is ${String(file.bytes.length)} bytes, over the ${String(THEME_DOCUMENT_MAX_BYTES)}-byte limit`);
      continue;
    }
    const json = parseJson(file.bytes);
    if (!json.ok) {
      problem(json.message);
      continue;
    }
    const checked = checkThemeDocument(json.value);
    if (!checked.ok) {
      problem(checked.problems.join("; "));
      continue;
    }
    // The manifest and the document both name the theme, and a package where they disagree has a theme whose
    // reference points at a different id than the one it says it is.
    if (checked.document.id !== facet.id) {
      problem(`id "${checked.document.id}" does not match the manifest facet id "${facet.id}"`);
      continue;
    }
    themes.push({ themeRef, facetId: facet.id, document: checked.document });
  }

  return { ok: true, manifestId: manifest.id, themes, problems };
}

function parseJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    return { ok: false, message: "is not valid JSON" };
  }
}
