import { join } from "node:path";

import {
  BUILTIN_CLARK_THEME_REF,
  nowInstant,
  parseThemeRef,
  type AppearanceFallbackCode,
  type AppearanceFallbackView,
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
import { themeDrawProblem, type ThemeDrawProblem } from "@clarkcant/design-tokens";
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

/** The node fields the registry reads, as the gateway's services carry them. */
export interface ThemeServices {
  runtime: { db: Database; identity: { nodeId: string; ownerPrincipalId: string }; dataDir: string };
  conductor: { newId: (prefix: string) => string };
}

export function themeRegistryDeps(services: ThemeServices): ThemeRegistryDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    dataDir: services.runtime.dataDir,
    ownerPrincipalId: services.runtime.identity.ownerPrincipalId,
    newId: services.conductor.newId,
  };
}

export interface ThemeRegistry {
  themes: ThemeListingView[];
  problems: ThemeProblemView[];
  unchecked: UncheckedThemePackageView[];
  /** The validated documents, by reference. Only package themes; Clark Default is the compiler's own base. */
  documents: ReadonlyMap<string, ThemeDocument>;
  /**
   * Valid themes an audit refuses, by reference, with why: colours that fail the contrast audit, or an appearance that
   * would hide a protected state. Listed as problems, never drawn.
   */
  refused: ReadonlyMap<string, ThemeDrawProblem>;
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
  const refused = new Map<string, ThemeDrawProblem>();
  const claimed = new Set<string>();

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
      if (claimed.has(theme.themeRef)) {
        problems.push({
          packageId,
          version: listed.version,
          themeRef: theme.themeRef,
          message: `theme ${theme.facetId}: another installed package already provides ${theme.themeRef}`,
        });
        continue;
      }
      claimed.add(theme.themeRef);
      // A theme is held to the contrast Clark Default is held to, and may not blur Stop, approval, focus, status or
      // disabled state. One that fails is named rather than offered: drawing it would make the conversation hard to
      // read, or a protected state hard to see, which is not a look anybody chose.
      const audit = themeDrawProblem(theme.document);
      if (audit !== undefined) {
        const problem: ThemeDrawProblem = { ...audit, message: `theme ${theme.facetId}: ${audit.message}` };
        refused.set(theme.themeRef, problem);
        problems.push({
          packageId,
          version: listed.version,
          themeRef: theme.themeRef,
          message: problem.message,
          ...(problem.code === "THEME_LOW_CONTRAST" ? { contrast: problem.contrast } : { protected: problem.protected }),
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

  return { themes, problems, unchecked, documents, refused };
}

export function resolveAppearance(deps: ThemeRegistryDeps, registry: ThemeRegistry = readThemeRegistry(deps)): AppearanceResponse {
  const stored = readRegisteredPreference(
    { db: deps.db, now: nowInstant },
    { principalId: deps.ownerPrincipalId, key: "experience.themeRef" },
  )?.value;
  const selectedRef = typeof stored === "string" ? stored : BUILTIN_CLARK_THEME_REF;
  const resolved = resolveThemeRef(registry, selectedRef);
  return resolved.ok
    ? { selectedRef, appliedRef: resolved.themeRef, theme: resolved.theme, provider: resolved.provider, fallback: null }
    : {
        selectedRef,
        appliedRef: BUILTIN_CLARK_THEME_REF,
        theme: null,
        provider: { kind: "builtin" },
        fallback: resolved.fallback,
      };
}

export type ThemeResolution =
  | { ok: true; themeRef: string; theme: ThemeDocument | null; provider: ThemeProviderView }
  | { ok: false; fallback: AppearanceFallbackView };

/**
 * What a theme reference draws on this node right now: the theme, or why Clark Default is drawn instead.
 *
 * The one place that answers it, so the appearance a page is told to draw and the check a choice is written through
 * cannot disagree about which references work.
 */
export function resolveThemeRef(registry: ThemeRegistry, themeRef: string): ThemeResolution {
  if (themeRef === BUILTIN_CLARK_THEME_REF) return { ok: true, themeRef, theme: null, provider: { kind: "builtin" } };
  const fallback = (code: AppearanceFallbackCode, message: string): ThemeResolution => ({
    ok: false,
    fallback: { code, message },
  });
  const parts = parseThemeRef(themeRef);
  if (parts === undefined || parts.kind === "builtin") return fallback("THEME_UNKNOWN", `${themeRef} is not a theme this build has`);

  const document = registry.documents.get(themeRef);
  const listing = registry.themes.find((theme) => theme.themeRef === themeRef);
  if (document !== undefined && listing !== undefined) {
    return { ok: true, themeRef, theme: document, provider: listing.provider };
  }
  const refused = registry.refused.get(themeRef);
  if (refused !== undefined) {
    return {
      ok: false,
      fallback:
        refused.code === "THEME_LOW_CONTRAST"
          ? { code: refused.code, message: refused.message, contrast: refused.contrast }
          : { code: refused.code, message: refused.message, protected: refused.protected },
    };
  }
  const problem = registry.problems.find((candidate) => candidate.themeRef === themeRef);
  if (problem !== undefined) return fallback("THEME_INVALID", problem.message);
  const unchecked = registry.unchecked.find((candidate) => candidate.packageId === parts.packageId);
  if (unchecked !== undefined) return fallback("THEME_UNAVAILABLE", unchecked.message);
  return fallback("THEME_NOT_INSTALLED", `no installed package provides ${themeRef}`);
}
