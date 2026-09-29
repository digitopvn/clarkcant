import { join } from "node:path";

import {
  BUILTIN_CLARK_THEME_REF,
  nowInstant,
  parseThemeRef,
  type AppearanceResponse,
  type DirectoryEntry,
  type ThemeDocument,
  type ThemeListingView,
  type ThemeProblemView,
  type ThemeProviderView,
  type UncheckedThemePackageView,
} from "@clarkcant/contracts";
import {
  directoryIndexPath,
  installedThemes,
  listInstalledPackages,
  readDirectoryIndex,
  readRegisteredPreference,
  resolveLocalSource,
  type InstalledPackageView,
} from "@clarkcant/core";
import { type Database } from "@clarkcant/storage";

/**
 * The theme registry: which themes this node can draw, and which one the person's choice resolves to.
 *
 * Host-owned and read on demand. The themes are the `themes` facets of the packages whose generation is active, so an
 * install, an update, an uninstall, a restore and a rollback all reach this list through the one package lifecycle,
 * with no theme-specific install state to fall out of step with it. A theme is data: nothing here runs package code,
 * and nothing a package wrote reaches the page except the token values the appearance compiler accepts.
 */

export interface ThemeRegistryDeps {
  db: Database;
  nodeId: string;
  dataDir: string;
  ownerPrincipalId: string;
  newId: (prefix: string) => string;
}

export interface ThemeRegistry {
  themes: ThemeListingView[];
  problems: ThemeProblemView[];
  unchecked: UncheckedThemePackageView[];
  /** The validated documents, by reference. Only package themes; Clark Default is the compiler's own base. */
  documents: ReadonlyMap<string, ThemeDocument>;
}

const CLARK_LISTING: ThemeListingView = {
  themeRef: BUILTIN_CLARK_THEME_REF,
  displayName: "Clark Default",
  provider: { kind: "builtin" },
};

/**
 * The directory entry that holds the bytes of an installed generation.
 *
 * The same narrow fallback the widget listing uses for a package installed from disk, whose recorded id is its path.
 * The digest has to match too: an entry that now lists different bytes under the same version is not what was
 * installed, and drawing it would show a theme nobody consented to.
 */
function entryFor(entries: readonly DirectoryEntry[], installed: InstalledPackageView): DirectoryEntry | undefined {
  return entries.find(
    (candidate) =>
      candidate.digest === installed.digest &&
      ((candidate.packageId === installed.packageId && candidate.version === installed.version) ||
        (candidate.source.kind === "local" && candidate.source.path === installed.packageId)),
  );
}

export function readThemeRegistry(deps: ThemeRegistryDeps): ThemeRegistry {
  const installed = listInstalledPackages({ db: deps.db, nodeId: deps.nodeId, now: nowInstant, newId: deps.newId });
  const index = readDirectoryIndex(directoryIndexPath(process.env));
  const cacheRoot = join(deps.dataDir, "package-cache");

  const themes: ThemeListingView[] = [CLARK_LISTING];
  const problems: ThemeProblemView[] = [];
  const unchecked: UncheckedThemePackageView[] = [];
  const documents = new Map<string, ThemeDocument>();

  for (const pkg of installed) {
    if (index.kind !== "configured") {
      unchecked.push({ packageId: pkg.packageId, version: pkg.version, code: "NO_DIRECTORY", message: index.reason });
      continue;
    }
    const listed = entryFor(index.entries, pkg);
    if (listed === undefined) {
      unchecked.push({
        packageId: pkg.packageId,
        version: pkg.version,
        code: "NOT_IN_DIRECTORY",
        message: `${pkg.packageId}@${pkg.version} with digest ${pkg.digest} is not in the directory, so this node cannot locate its files`,
      });
      continue;
    }
    // The declared identity, as the widget listing reports it: a local install records its path as the id.
    const packageId = listed.packageId;
    const read = installedThemes({ source: resolveLocalSource(listed, cacheRoot) });
    if (!read.ok) {
      unchecked.push({ packageId, version: listed.version, code: read.code, message: read.message });
      continue;
    }
    const provider: ThemeProviderView = {
      kind: "package",
      packageId,
      version: listed.version,
      digest: pkg.digest,
      lane: pkg.lane,
      sourceTier: pkg.source.sourceTier,
    };
    for (const theme of read.themes) {
      // Two installed packages declaring the same id would claim one reference; the first keeps it and the other is
      // named, rather than one silently replacing the other depending on listing order.
      if (documents.has(theme.themeRef)) {
        problems.push({
          packageId,
          version: listed.version,
          themeRef: theme.themeRef,
          message: `theme ${theme.facetId}: another installed package already provides ${theme.themeRef}`,
        });
        continue;
      }
      documents.set(theme.themeRef, theme.document);
      themes.push({
        themeRef: theme.themeRef,
        displayName: theme.document.displayName,
        ...(theme.document.description === undefined ? {} : { description: theme.document.description }),
        provider,
      });
    }
    for (const problem of read.problems) {
      problems.push({ packageId, version: listed.version, themeRef: problem.themeRef, message: problem.message });
    }
  }

  return { themes, problems, unchecked, documents };
}

export function resolveAppearance(deps: ThemeRegistryDeps, registry: ThemeRegistry = readThemeRegistry(deps)): AppearanceResponse {
  const stored = readRegisteredPreference(
    { db: deps.db, now: nowInstant },
    { principalId: deps.ownerPrincipalId, key: "experience.themeRef" },
  )?.value;
  const selectedRef = typeof stored === "string" ? stored : BUILTIN_CLARK_THEME_REF;
  const clark = (fallback: AppearanceResponse["fallback"]): AppearanceResponse => ({
    selectedRef,
    appliedRef: BUILTIN_CLARK_THEME_REF,
    theme: null,
    provider: { kind: "builtin" },
    fallback,
  });

  if (selectedRef === BUILTIN_CLARK_THEME_REF) return clark(null);
  const parts = parseThemeRef(selectedRef);
  if (parts === undefined || parts.kind === "builtin") {
    return clark({ code: "THEME_UNKNOWN", message: `${selectedRef} is not a theme this build has` });
  }

  const document = registry.documents.get(selectedRef);
  const listing = registry.themes.find((theme) => theme.themeRef === selectedRef);
  if (document !== undefined && listing !== undefined) {
    return { selectedRef, appliedRef: selectedRef, theme: document, provider: listing.provider, fallback: null };
  }
  const problem = registry.problems.find((candidate) => candidate.themeRef === selectedRef);
  if (problem !== undefined) return clark({ code: "THEME_INVALID", message: problem.message });
  const unreadable = registry.unchecked.find((candidate) => candidate.packageId === parts.packageId);
  if (unreadable !== undefined) return clark({ code: "THEME_UNAVAILABLE", message: unreadable.message });
  return clark({
    code: "THEME_NOT_INSTALLED",
    message: `no installed package provides ${selectedRef}`,
  });
}
