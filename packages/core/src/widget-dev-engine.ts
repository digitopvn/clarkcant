import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, realpathSync, statSync, watch, type BigIntStats, type FSWatcher } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  WIDGET_DEV_DIAGNOSTICS_MAX,
  canonicalReach,
  compareDevReach,
  type DirectoryEntry,
  type PackageManifest,
  type WidgetDevBuild,
  type WidgetDevDiagnostic,
  type WidgetDevGeneration,
  type WidgetDevTrigger,
} from "@clarkcant/contracts";

import { directoryEntryOf } from "./directory-entry-of.ts";
import { digestOfDirectory, snapshotLocalPackage } from "./package-fetch.ts";
import { readPackage } from "./widget-package.ts";

/**
 * The one engine behind live widget authoring: watch a package folder, read it the way the node reads a package, and
 * turn each change into either an immutable generation or a failed build with diagnostics.
 *
 * `clark widget dev` and a conversation's dev session both run on it, so a change the standalone dev host shows is
 * exactly the change the conversation shows, read by the same reader (`readPackage`) and named by the same digest a
 * node's snapshot of the files carries.
 *
 * Nothing here runs package code or decides anything: a generation is a description of files. Activating one is the
 * caller's business. The dev host serves the folder itself; a node installs the generation through its one install path
 * and execution policy.
 *
 * Given a `cacheRoot`, each generation is also copied into the node's content-addressed package cache
 * (`snapshotLocalPackage`) and listed from that copy, so what the node installs, serves and asks about is those exact
 * bytes even while the author keeps editing. A failed build never replaces the last good generation: `latest()` keeps
 * returning it, and the build record says what failed, so a caller can show the last working version labelled as such.
 */

/** The files and bytes a package folder may hold for the engine to digest it; the node bounds its own reads the same way. */
export const DEV_ENGINE_LIMITS = { maxFiles: 5_000, maxBytes: 64 * 1024 * 1024 } as const;
/** How long the watcher waits after the last change before it builds, so a save that writes several files builds once. */
export const DEV_ENGINE_DEBOUNCE_MS = 150;
/** How often a watched folder is checked to still be there, for a platform whose watcher does not say it went away. */
export const DEV_ENGINE_ROOT_CHECK_MS = 1_000;
/**
 * How long a watched folder may keep failing to be looked at, for a reason other than not being there, before watching
 * stops. An antivirus or indexer holds a folder for a moment; one that cannot be looked at for this long is not being
 * watched in any useful sense (and on older Windows builds, a folder deleted while the watcher holds it reads as `EPERM`
 * until the watcher lets go, which it never would).
 */
export const DEV_ENGINE_ROOT_UNREADABLE_MS = 30_000;
/**
 * How long after watching starts the folder is built once more, for a save the platform watcher could not see yet. On
 * macOS, FSEvents starts watching asynchronously and reports only what happens after that, so a save right after the first
 * build would otherwise be lost; inotify and Windows watch from the moment `watch` returns.
 */
export const DEV_ENGINE_WATCH_CATCH_UP_MS = 500;
/**
 * How many looks in a row may find a watched folder under a new file id (`replaced`), with no look between them finding
 * the same folder again, before watching stops. A build that makes its output folder again re-arms once and the next
 * look finds the new folder unchanged, however often that happens; a filesystem that gives the folder a new id on every
 * look would otherwise re-watch and copy the whole folder every second, without end.
 */
export const DEV_ENGINE_REARM_MAX = 30;
/**
 * How long a watched folder may be missing before it counts as gone. A build that deletes its output folder and makes it
 * again (`rm -rf out && build`, `rmdir /s /q out && xcopy src out`) leaves the path empty for a moment, and the old
 * watcher reports the deletion straight away; a folder back at the same real path within this time is watched anew
 * rather than stopping the session. Nothing is built while the folder is missing.
 */
export const DEV_ENGINE_ROOT_MISSING_GRACE_MS = 2_000;
/**
 * Folders at the package root that are not the package: version control, and the author's installed dependencies, which
 * the package does not ship and which may hold thousands of files and links (a pnpm `node_modules` is junctions). Left
 * out of the digest, the snapshot and the watch alike, as `clark widget pack` leaves them out of the archive. `dist` is
 * not left out: a built widget's entry may live there.
 */
export const DEV_ENGINE_EXCLUDED_ROOT_NAMES = [".git", "node_modules"] as const;

const isExcludedRootName = (name: string): boolean =>
  (DEV_ENGINE_EXCLUDED_ROOT_NAMES as readonly string[]).includes(name.toLowerCase());

/** The listing publisher for a package that names none: a development listing on this node, said as such. */
const LOCAL_PUBLISHER = { id: "local-development", sourceUrl: "local", license: "UNLICENSED" } as const;

/** A generation with what the node needs to activate it. */
export interface DevGenerationRecord {
  generation: WidgetDevGeneration;
  manifest: PackageManifest;
  /** The directory entry that lists this generation's files by their digest, as `clark widget publish` would. */
  listing: DirectoryEntry;
}

export type DevEngineEvent =
  | { kind: "generation"; record: DevGenerationRecord; build: WidgetDevBuild }
  | { kind: "unchanged"; build: WidgetDevBuild }
  | { kind: "failed"; build: WidgetDevBuild };

type DeltaManifest = Pick<PackageManifest, "facets" | "requestedCapabilities" | "permissions" | "resources">;

export interface DevEngineOptions {
  root: string;
  /**
   * The node's package cache. When given, each generation is a snapshot there and its listing names the snapshot; when
   * not, the listing names the folder itself (the standalone dev host, which serves the folder).
   */
  cacheRoot?: string;
  limits?: { maxFiles: number; maxBytes: number };
  /** Watch the folder and build on change. Off for a caller that drives `rebuild` itself. */
  watch?: boolean;
  debounceMs?: number;
  now?: () => string;
  /**
   * The manifest of what runs now, which a new generation's delta is compared with. Defaults to the newest generation:
   * the dev host serves every generation, while a node may still run an older one that is waiting on a decision.
   */
  baseline?: () => DeltaManifest | undefined;
  /**
   * How many generations this folder already had, so a session resumed after a restart keeps counting rather than
   * naming a second generation 1.
   */
  generationsBefore?: number;
  /** Told about every build the watcher or `rebuild` ran, including ones that produced nothing new. */
  onBuild?: (event: DevEngineEvent) => void;
  /**
   * Told when the watcher itself fails (the folder was removed, the platform cannot watch it), or when the folder could
   * not be looked at for `rootUnreadableMs`; watching has stopped.
   */
  onWatchError?: (error: Error) => void;
  /**
   * Told once when the watched folder is no longer there (deleted or renamed and not back within `rootMissingGraceMs`, no
   * longer a folder, or reached through a link); watching has stopped.
   */
  onRootGone?: () => void;
  /** How often a watched folder is checked to still be there (`DEV_ENGINE_ROOT_CHECK_MS`). */
  rootCheckMs?: number;
  /** How long a folder may keep failing to be looked at before watching stops (`DEV_ENGINE_ROOT_UNREADABLE_MS`). */
  rootUnreadableMs?: number;
  /** How long a watched folder may be missing before it counts as gone (`DEV_ENGINE_ROOT_MISSING_GRACE_MS`). */
  rootMissingGraceMs?: number;
  /**
   * The facet lanes a build may declare. A package with a facet in any other lane is a failed build
   * (`FACET_LANE_UNSUPPORTED`), not a generation. Absent, every lane builds: the standalone dev host runs none of them.
   */
  allowedIsolations?: readonly string[];
}

export interface DevEngine {
  /** The folder's real path: `options.root` resolved once, through any link or junction it was given through. */
  readonly root: string;
  /** The first build, which runs before anything is watched. */
  readonly ready: Promise<DevEngineEvent>;
  /** The newest successful generation. */
  latest(): DevGenerationRecord | undefined;
  lastBuild(): WidgetDevBuild | undefined;
  /** Build now, after any build already running. */
  rebuild(trigger?: WidgetDevTrigger): Promise<DevEngineEvent>;
  /** Whether the folder is being watched: false after `close`, after a watch failure, or when watching was not asked for. */
  watching(): boolean;
  /**
   * Whether the folder is gone (`devRootState`): deleted, no longer a folder, or another folder reached through a link or
   * junction. False when another folder is at the path itself (the watcher moves to it), when it could not be looked at
   * for another reason, or, while watching, when it has been missing for less than `rootMissingGraceMs` (a build that
   * deletes and makes it again is not done yet).
   */
  rootGone(): boolean;
  close(): void;
}

/** What a scope reads from the manifest, beyond the listing. */
type ScopeManifest = Pick<PackageManifest, "requestedCapabilities" | "facets">;

/** Manifests of snapshots already read, by snapshot path. A snapshot is content-addressed, so its manifest never changes. */
const scopeManifests = new Map<string, ScopeManifest>();
const SCOPE_MANIFESTS_MAX = 256;

function scopeManifestOf(listing: DirectoryEntry): ScopeManifest | null {
  if (listing.source.kind !== "local") return null;
  const path = listing.source.path;
  const known = scopeManifests.get(path);
  if (known !== undefined) return known;
  let read: ScopeManifest | null;
  try {
    const pkg = readPackage(path);
    read = pkg.problems.length === 0 ? pkg.manifest : null;
  } catch {
    read = null;
  }
  // Only a manifest that was read is kept: a snapshot that could not be read now may be readable later.
  if (read === null) return null;
  if (scopeManifests.size >= SCOPE_MANIFESTS_MAX) scopeManifests.delete(scopeManifests.keys().next().value ?? "");
  scopeManifests.set(path, read);
  return read;
}

/**
 * The consent a dev session's installs are decided under: the package, and everything it binds about what it may
 * reach — declared reach, resource request, device, filesystem and network permissions, the capabilities it requests,
 * and each facet by kind, id and lane.
 *
 * Two generations with the same scope differ only in code that runs inside what the person already allowed, so one
 * decision covers both; any change to the scope, wider or narrower, is a different question. The capabilities and facets
 * are read from the manifest of the snapshot the listing names (or the one given), which is immutable, so the install,
 * the inbox and the decide route all compute the same scope for the same listing. A listing whose manifest cannot be read
 * has a scope of its own, so nothing granted for a readable one covers it.
 */
export function devConsentScopeOf(listing: DirectoryEntry, manifest?: ScopeManifest): string {
  const read = manifest ?? scopeManifestOf(listing);
  const body = {
    packageId: listing.packageId,
    reach: listing.declaredReach === undefined ? null : canonicalReach(listing.declaredReach),
    resources: listing.resources ?? null,
    isolations: listing.isolations.map((entry) => `${entry.facetKind}:${entry.isolation}`).sort(),
    permissions: [...listing.permissionsSummary].sort(),
    requestedCapabilities: read === null ? null : [...new Set(read.requestedCapabilities)].sort(),
    facets: read === null ? null : read.facets.map((facet) => `${facet.kind}:${facet.id}:${facet.isolation}`).sort(),
  };
  return `widget-dev-scope:sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

/** Whether an operation digest is a dev session's consent scope rather than an artifact digest. */
export function isDevConsentScope(operationDigest: string): boolean {
  return operationDigest.startsWith("widget-dev-scope:");
}

function capped(diagnostics: WidgetDevDiagnostic[]): Pick<WidgetDevBuild, "diagnostics" | "diagnosticsMore"> {
  const more = diagnostics.length - WIDGET_DEV_DIAGNOSTICS_MAX;
  return { diagnostics: diagnostics.slice(0, WIDGET_DEV_DIAGNOSTICS_MAX), ...(more > 0 ? { diagnosticsMore: more } : {}) };
}

/** A reader problem as a diagnostic, with the file it names made relative to the package when it names one. */
export function devDiagnosticOf(root: string, problem: string, severity: WidgetDevDiagnostic["severity"] = "error"): WidgetDevDiagnostic {
  const message = problem.trim().slice(0, 1000) || "the package could not be read";
  const named = /^(.+?\.(?:json|html|js|mjs|css|ts|tsx)):\s/.exec(message)?.[1];
  if (named === undefined) return { severity, message };
  const inside = relative(root, resolve(root, named));
  const path = inside.startsWith("..") ? named : inside.split(sep).join("/");
  return { severity, path: path.slice(0, 400), message };
}

/** The bytes a package's files hold, the excluded root folders left out as the digest leaves them out. */
function sizeOf(root: string): number {
  let total = 0;
  const visit = (directory: string, depth: number): void => {
    for (const name of readdirSync(directory)) {
      if (depth === 0 && isExcludedRootName(name)) continue;
      const path = join(directory, name);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat === undefined) continue;
      if (stat.isDirectory()) visit(path, depth + 1);
      else if (stat.isFile()) total += stat.size;
    }
  };
  visit(root, 0);
  return total;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Holds `root` open where that keeps its file id from being given to a folder made again there; undefined elsewhere. */
function pinRoot(root: string): number | undefined {
  if (process.platform === "win32") return undefined;
  try {
    return openSync(root, "r");
  } catch {
    return undefined;
  }
}

/** Which folder a path named when it was first watched: its device and file id, which a folder made again does not keep. */
export interface DevRootIdentity {
  dev: bigint;
  ino: bigint;
}

/** The identity of the folder at `root` now, or undefined when it cannot be read as a folder. */
function devRootIdentityOf(root: string): DevRootIdentity | undefined {
  try {
    const stat = statSync(root, { bigint: true });
    return stat.isDirectory() ? { dev: stat.dev, ino: stat.ino } : undefined;
  } catch {
    return undefined;
  }
}

/** The errors that say a path is not there: anything else (a busy or locked folder on Windows) may pass on the next look. */
const GONE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

type DevRootLook =
  | { state: "present" }
  | { state: "replaced"; identity: DevRootIdentity }
  /** `missing`: nothing is at the path (`ENOENT`, `ENOTDIR`), which a build that makes the folder again also leaves for a moment. */
  | { state: "gone"; missing?: true }
  | { state: "unknown"; code: string };

/** Whether a folder on `path`, or `path` itself, is a link or junction. */
function linkOnPath(path: string): boolean {
  for (let at = path; ; at = dirname(at)) {
    if (lstatSync(at).isSymbolicLink()) return true;
    if (dirname(at) === at) return false;
  }
}

/**
 * Whether `real` (where `root` resolves now) is `canonical`, the real path `root` was at the start. Where the filesystem
 * usually ignores case (Windows, macOS), a real path that differs only in case is the same place when nothing on the
 * path is a link: a folder made again as `Out` for `out` is the folder chosen, but a folder above it swapped for a link
 * to a sibling named in another case (on a case-sensitive volume) is not.
 */
const samePlace = (root: string, real: string, canonical: string): boolean =>
  real === canonical ||
  ((process.platform === "win32" || process.platform === "darwin") && real.toLowerCase() === canonical.toLowerCase() && !linkOnPath(root));

/**
 * Whether `root` still leads to `canonical`: it is not itself a link or junction, and it resolves there. When it could
 * not be looked at, the look that says why.
 */
function leadsTo(root: string, canonical: string | undefined): boolean | DevRootLook {
  if (canonical === undefined) return false;
  try {
    return !lstatSync(root).isSymbolicLink() && samePlace(root, realpathSync.native(root), canonical);
  } catch (cause) {
    return lookFailed(cause);
  }
}

/** The canonical path of `root`, or undefined when it cannot be resolved. */
function canonicalPathOf(root: string): string | undefined {
  try {
    return realpathSync.native(root);
  } catch {
    return undefined;
  }
}

const lookFailed = (cause: unknown): DevRootLook => {
  const code = (cause as NodeJS.ErrnoException).code;
  return code !== undefined && GONE_CODES.has(code) ? { state: "gone", missing: true } : { state: "unknown", code: code ?? messageOf(cause) };
};

function lookAtDevRoot(root: string, identity?: DevRootIdentity, canonical?: string): DevRootLook {
  let stat: BigIntStats;
  try {
    stat = statSync(root, { bigint: true });
  } catch (cause) {
    return lookFailed(cause);
  }
  if (!stat.isDirectory()) return { state: "gone" };
  if (identity !== undefined && (stat.dev !== identity.dev || stat.ino !== identity.ino)) {
    // Another folder at the path is the folder being developed only when the path still leads where it led when watching
    // started: the path itself, or a folder above it, swapped for a link or junction leads into a tree nobody chose.
    const leads = leadsTo(root, canonical);
    if (leads !== true) return leads === false ? { state: "gone" } : leads;
    return { state: "replaced", identity: { dev: stat.dev, ino: stat.ino } };
  }
  return { state: "present" };
}

/**
 * Whether a dev folder is still the folder being developed.
 *
 * - `gone`: nothing is at the path, or something other than a folder is.
 * - `replaced`: given the `identity` it was watched with, a different folder is at the path. A folder deleted and made
 *   again (`rm -rf out && build`) keeps its path but not its identity, and a watcher on the old one hears nothing from the
 *   new one (a watching engine waits `DEV_ENGINE_ROOT_MISSING_GRACE_MS` for a missing folder to come back); some
 *   filesystems (FUSE mounts without stable inode numbers, some network drives) also give a folder that is still there a
 *   new id. Either way there is a folder to watch, so the watcher moves to it. A different folder
 *   reached through a link or junction (at the path or at a folder above it), so that the path no longer resolves to
 *   the canonical path watching started from, is `gone` instead: it is not the folder that was chosen.
 * - `unknown`: the folder could not be looked at for another reason (`EPERM`, `EBUSY` while an antivirus or indexer holds
 *   it). That is not a folder that went away; the caller looks again next time.
 * - `present`: the same folder is there.
 */
export function devRootState(root: string, identity?: DevRootIdentity): "present" | "replaced" | "gone" | "unknown" {
  return lookAtDevRoot(root, identity).state;
}

/** Whether two failed builds failed the same way: the same diagnostics, so a second one tells nobody anything new. */
const sameFailure = (before: WidgetDevBuild | undefined, after: WidgetDevBuild): boolean =>
  before !== undefined &&
  !before.ok &&
  !after.ok &&
  before.diagnosticsMore === after.diagnosticsMore &&
  JSON.stringify(before.diagnostics) === JSON.stringify(after.diagnostics);

/**
 * Why the folder's files could not be taken for a build. A folder over the size limit, or a link that points
 * outside it, stays refused until the person changes the folder; anything else may pass on the next save.
 */
const devFilesCodeOf = (code: string): "FILES_TOO_LARGE" | "FILES_LINK_REFUSED" | "FILES_UNREADABLE" =>
  code === "ARTIFACT_TOO_LARGE" ? "FILES_TOO_LARGE" : code === "ARTIFACT_SYMLINK_ESCAPE" ? "FILES_LINK_REFUSED" : "FILES_UNREADABLE";

export function startDevEngine(options: DevEngineOptions): DevEngine {
  const given = resolve(options.root);
  /**
   * Where the folder's path resolved when the engine started: a folder at the path that resolves elsewhere is not it. A
   * folder given through a link or junction (a symlinked projects folder, a junctioned workspace) is watched and built at
   * this real path, so the link it was given through is not taken for a swap.
   */
  const canonical = canonicalPathOf(given);
  const root = canonical ?? given;
  const limits = options.limits ?? DEV_ENGINE_LIMITS;
  const now = options.now ?? (() => new Date().toISOString());
  // Only the newest generation is kept: older ones are named in their build records and the caller's own state.
  let newest: DevGenerationRecord | undefined;
  let last: WidgetDevBuild | undefined;
  let closed = false;

  const fail = (trigger: WidgetDevTrigger, diagnostics: WidgetDevDiagnostic[]): DevEngineEvent => {
    last = { ok: false, at: now(), trigger, ...capped(diagnostics) };
    return { kind: "failed", build: last };
  };

  /** Read a folder as a package: its manifest and widget ids, or what is wrong with it. */
  const read = (folder: string): { ok: true; manifest: PackageManifest; widgetIds: string[] } | { ok: false; diagnostics: WidgetDevDiagnostic[] } => {
    let pkg: ReturnType<typeof readPackage>;
    try {
      pkg = readPackage(folder);
    } catch (cause) {
      return { ok: false, diagnostics: [devDiagnosticOf(folder, messageOf(cause))] };
    }
    if (pkg.problems.length > 0) {
      return { ok: false, diagnostics: pkg.problems.map((problem) => devDiagnosticOf(folder, problem)) };
    }
    const allowed = options.allowedIsolations;
    if (allowed !== undefined) {
      const outside = pkg.manifest.facets.filter((facet) => !allowed.includes(facet.isolation));
      if (outside.length > 0) {
        return {
          ok: false,
          diagnostics: outside.map((facet) => ({
            severity: "error" as const,
            path: "clarkcant.json",
            code: "FACET_LANE_UNSUPPORTED",
            message: `facet ${facet.kind}:${facet.id} runs as ${facet.isolation}, outside the widget frame; a widget dev session runs only ${allowed.join(" and ")} facets, so install this package the ordinary way`,
          })),
        };
      }
    }
    const widgetIds = pkg.facets.map((facet) => facet.definition.id);
    if (widgetIds.length === 0) {
      return {
        ok: false,
        diagnostics: [{ severity: "error", path: "clarkcant.json", message: "the package declares no widget facet, so there is nothing to show" }],
      };
    }
    return { ok: true, manifest: pkg.manifest, widgetIds };
  };

  /**
   * Whether the path now leads somewhere other than where it led at the start, through a link or junction swapped in at
   * the folder or above it. Checked before and after the files are taken, so the window in which a swap could have a
   * foreign tree built is the copy itself; closing it fully would need reads relative to a held folder handle.
   */
  const ledElsewhere = (): boolean => canonical !== undefined && leadsTo(root, canonical) === false;
  const elsewhere = (trigger: WidgetDevTrigger): DevEngineEvent =>
    fail(trigger, [
      {
        severity: "error",
        code: "FILES_LINK_REFUSED",
        message: "the folder's path now leads to another folder through a link or junction, so it was not built",
      },
    ]);

  const build = async (trigger: WidgetDevTrigger): Promise<DevEngineEvent> => {
    if (ledElsewhere()) return elsewhere(trigger);
    const source = read(root);
    if (!source.ok) return fail(trigger, source.diagnostics);

    let folder = root;
    let digest: string;
    try {
      if (options.cacheRoot === undefined) {
        const digested = digestOfDirectory(root, { exclude: DEV_ENGINE_EXCLUDED_ROOT_NAMES, excludeAnyCase: true, limits });
        if (!digested.ok) {
          return fail(trigger, [{ severity: "error", code: devFilesCodeOf(digested.code), message: `the files could not be digested: ${digested.message}` }]);
        }
        digest = digested.digest;
      } else {
        const snapshot = await snapshotLocalPackage({
          path: root,
          cacheRoot: options.cacheRoot,
          limits,
          excludeRootNames: DEV_ENGINE_EXCLUDED_ROOT_NAMES,
        });
        if (!snapshot.ok) {
          // Files that changed while they were copied are not a broken package: the next change event builds them again.
          // A folder that is too large, or a link that leaves it, stays refused until the person changes the folder.
          return fail(trigger, [
            {
              severity: "error",
              code: devFilesCodeOf(snapshot.code),
              message: `the files could not be copied for this build (${snapshot.code}): ${snapshot.message}`,
            },
          ]);
        }
        folder = snapshot.artifact.path;
        digest = snapshot.artifact.digest;
      }
    } catch (cause) {
      return fail(trigger, [{ severity: "error", code: "FILES_UNREADABLE", message: `the files could not be read: ${messageOf(cause)}` }]);
    }
    if (ledElsewhere()) return elsewhere(trigger);

    const previous = newest;
    if (previous !== undefined && previous.generation.digest === digest) {
      last = { ok: true, at: now(), trigger, generation: previous.generation.generation, diagnostics: [] };
      return { kind: "unchanged", build: last };
    }
    // What the generation is, read from the bytes it names: the copy, when there is one, since the folder may have moved on.
    const copy = folder === root ? source : read(folder);
    if (!copy.ok) return fail(trigger, copy.diagnostics);

    const manifest = copy.manifest;
    const publisher = manifest.publisher;
    const generation: WidgetDevGeneration = Object.freeze({
      generation: (previous?.generation.generation ?? options.generationsBefore ?? 0) + 1,
      packageId: manifest.id,
      version: manifest.version,
      digest,
      builtAt: now(),
      trigger,
      widgetIds: copy.widgetIds,
      delta: compareDevReach(options.baseline === undefined ? previous?.manifest : options.baseline(), manifest),
      warnings: [],
    });
    let sizeBytes = 0;
    try {
      sizeBytes = sizeOf(folder);
    } catch {
      // Descriptive only; a listing whose size could not be summed still names its bytes by digest.
    }
    const record: DevGenerationRecord = Object.freeze({
      generation,
      manifest,
      listing: directoryEntryOf(manifest, {
        source: { kind: "local", path: folder },
        publisher: publisher === undefined ? { ...LOCAL_PUBLISHER } : { id: publisher.id, sourceUrl: publisher.sourceUrl, license: publisher.license },
        sizeBytes,
        digest,
      }),
    });
    newest = record;
    last = { ok: true, at: generation.builtAt, trigger, generation: generation.generation, diagnostics: [] };
    return { kind: "generation", record, build: last };
  };

  // Builds run one at a time, in order: a change that lands during a build is built after it.
  let queue: Promise<DevEngineEvent> = build("start");
  const ready = queue;
  const enqueue = (job: () => Promise<DevEngineEvent>): Promise<DevEngineEvent> => {
    queue = queue.then(job, job);
    return queue;
  };

  /**
   * The folder watched, by identity: a folder deleted and made again at the same path before the next look is a folder
   * the watcher does not hear (Windows keeps watching the deleted one), so the watcher moves to it. Only taken when
   * watching.
   */
  let identity: DevRootIdentity | undefined;
  /** When the folder first failed to be looked at, in the run of failures going on now (`DEV_ENGINE_ROOT_UNREADABLE_MS`). */
  let unreadableSince: number | undefined;
  /** When the folder was first found missing, in the absence going on now (`DEV_ENGINE_ROOT_MISSING_GRACE_MS`). */
  let missingSince: number | undefined;
  /** How many looks in a row found the folder under a new id, with none finding it unchanged between (`DEV_ENGINE_REARM_MAX`). */
  let rearmsInARow = 0;
  const unreadableMs = options.rootUnreadableMs ?? DEV_ENGINE_ROOT_UNREADABLE_MS;
  const missingGraceMs = options.rootMissingGraceMs ?? DEV_ENGINE_ROOT_MISSING_GRACE_MS;
  /**
   * The watched folder held open, on Linux and macOS, while it is watched. A folder deleted there frees its file id, and
   * one made again at the same path straight after is commonly given the same id back, so it would read as the same
   * folder; held open, the deleted folder keeps its id and the new one is given another. Windows gives a new folder a new
   * id already, and a folder held open there could not be deleted, so nothing is held there.
   */
  let pin: number | undefined;
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rootCheck: ReturnType<typeof setInterval> | undefined;
  let catchUp: ReturnType<typeof setTimeout> | undefined;
  const debounceMs = options.debounceMs ?? DEV_ENGINE_DEBOUNCE_MS;
  /** Let go of the watched folder: its watcher and, where it is held open, its handle. */
  const release = (): void => {
    watcher?.close();
    watcher = undefined;
    if (pin !== undefined) {
      try {
        closeSync(pin);
      } catch {
        // Already closed; nothing else holds it.
      }
      pin = undefined;
    }
  };
  const stopWatching = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (catchUp !== undefined) clearTimeout(catchUp);
    catchUp = undefined;
    if (rootCheck !== undefined) clearInterval(rootCheck);
    rootCheck = undefined;
    release();
  };
  const watchFailed = (cause: unknown): void => options.onWatchError?.(cause instanceof Error ? cause : new Error(String(cause)));
  /** Build after the last change of a burst, and report what it built. */
  const scheduleBuild = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      // A folder watched anew by this look has its own build scheduled; building here as well would build it twice.
      if (closed || !rootStillThere() || timer !== undefined) return;
      void enqueue(() => build("change")).then((event) => {
        if (!closed) options.onBuild?.(event);
      }, watchFailed);
    }, debounceMs);
    timer.unref();
  };
  /** Watch the folder at `root` now, held open where that keeps its id (`pinRoot`). */
  const arm = (): void => {
    pin = pinRoot(root);
    const next = watch(root, { recursive: true }, (_event, filename) => {
      const name = typeof filename === "string" ? filename : "";
      if (!rootStillThere()) return;
      if (isExcludedRootName(name.split(/[\\/]/)[0] ?? "")) return;
      scheduleBuild();
    });
    watcher = next;
    // The watcher never keeps a process alive by itself: the dev host's server or the node does that.
    next.unref();
    next.on("error", (error) => {
      // An error from a watcher already let go of (the folder was replaced and is watched anew) says nothing now.
      if (watcher !== next) return;
      // A folder that went away is said as that, not as a watcher failure.
      if (!rootStillThere()) return;
      stopWatching();
      options.onWatchError?.(error);
    });
  };
  /**
   * Whether the folder is still there, and if not, stop watching and say so. A folder deleted, renamed or replaced while
   * watched is not reported by every platform's watcher (Windows reports neither an event nor an error), so this is
   * checked on every change and on a timer rather than left to the watcher.
   *
   * - Another folder at the path (`replaced`) is watched in place of the old one and built: it is where the person's
   *   files are now, whether a build made it again or the filesystem gave the same folder a new id. One reached through a
   *   link or junction is `gone`. More than `DEV_ENGINE_REARM_MAX` of these in a row, with no look between them finding
   *   the folder unchanged, stops watching as a watch failure.
   * - A folder missing from the path (`gone`, not found) counts as gone only once it has been missing for
   *   `rootMissingGraceMs`: until then no build starts (`rootGone` says not gone either, so a build already running that
   *   fails on the missing files leaves the caller's session live) and the path is looked at again, and a folder back at
   *   the same real path is watched anew (`replaced`) and built. Anything else that is `gone` (not a folder, or reached through a link) is
   *   gone at once.
   * - A folder that could not be looked at this time (`unknown`) is looked at again on the next tick rather than taken as
   *   gone, until it has failed for `rootUnreadableMs` in a row: then watching stops as a watch failure that says why.
   */
  /**
   * Whether `look` found the watched folder missing for less than `rootMissingGraceMs` so far: it may be on its way back,
   * so it is not gone yet. The absence is timed from the first look that found it, whichever asked.
   */
  const stillAwaited = (look: DevRootLook): boolean => {
    if (look.state !== "gone" || look.missing !== true || closed || watcher === undefined) return false;
    const at = performance.now();
    missingSince ??= at;
    return at - missingSince < missingGraceMs;
  };
  const rootStillThere = (): boolean => {
    if (closed || watcher === undefined) return !closed;
    const look = lookAtDevRoot(root, identity, canonical);
    if (look.state === "unknown") {
      // A monotonic clock: a clock set back, or a machine asleep, neither stretches nor cuts short the bound.
      const at = performance.now();
      unreadableSince ??= at;
      if (at - unreadableSince < unreadableMs) return true;
      stopWatching();
      const failingMs = Math.round(at - unreadableSince);
      const failing = failingMs < 1000 ? `${String(failingMs)} ms` : `${String(Math.round(failingMs / 1000))} s`;
      options.onWatchError?.(new Error(`the folder could not be looked at for ${failing} (${look.code}), so it is no longer watched`));
      return false;
    }
    unreadableSince = undefined;
    if (stillAwaited(look)) return false;
    missingSince = undefined;
    if (look.state === "present") {
      rearmsInARow = 0;
      return true;
    }
    if (look.state === "replaced") {
      rearmsInARow += 1;
      const idOf = (id: DevRootIdentity | undefined): string => (id === undefined ? "none" : `${String(id.dev)}:${String(id.ino)}`);
      if (rearmsInARow > DEV_ENGINE_REARM_MAX) {
        stopWatching();
        options.onWatchError?.(
          new Error(
            `the folder was found under a new file id on more than ${String(DEV_ENGINE_REARM_MAX)} looks in a row (last ${idOf(identity)} to ${idOf(look.identity)}), so it is no longer watched; its filesystem may not keep file ids stable`,
          ),
        );
        return false;
      }
      process.stderr.write(`widget dev: watching ${root} anew: its file id changed from ${idOf(identity)} to ${idOf(look.identity)}\n`);
      release();
      try {
        identity = look.identity;
        arm();
      } catch (cause) {
        stopWatching();
        watchFailed(cause);
        return false;
      }
      scheduleBuild();
      // As at the start: a save the new watcher could not see yet (FSEvents starts asynchronously) is built then.
      scheduleCatchUp();
      return true;
    }
    stopWatching();
    options.onRootGone?.();
    return false;
  };
  /**
   * Build once more `DEV_ENGINE_WATCH_CATCH_UP_MS` after a watcher starts, for a save made before the platform watcher was
   * live. Only news is reported: files that did not change build nothing new, and a folder that was already failing fails
   * the same way, so where the watcher saw everything this is silent. A build with no news leaves the last build as it
   * was, rather than relabelled as a change made now.
   */
  const scheduleCatchUp = (): void => {
    if (catchUp !== undefined) clearTimeout(catchUp);
    catchUp = setTimeout(() => {
      catchUp = undefined;
      // A change already waiting to build reads the folder anyway; so does the build of a folder this look watched anew.
      if (closed || timer !== undefined || !rootStillThere() || timer !== undefined) return;
      let news = false;
      void enqueue(async () => {
        // Read once every build before it has settled, the first one included: a first build slower than the catch-up
        // delay has not set the last build when the timer fires, and its failure would otherwise be news twice.
        const before = last;
        const event = await build("change");
        news =
          event.kind === "generation" ||
          (event.kind === "failed" && !sameFailure(before, event.build)) ||
          // Files back to the newest generation after a failed build: the failure is over, which is news.
          (event.kind === "unchanged" && before?.ok === false);
        if (!news && before !== undefined) last = before;
        return event;
      }).then(
        (event) => {
          if (!closed && news) options.onBuild?.(event);
        },
        watchFailed,
      );
    }, DEV_ENGINE_WATCH_CATCH_UP_MS);
    catchUp.unref();
  };
  if (options.watch !== false) {
    try {
      identity = devRootIdentityOf(root);
      arm();
      rootCheck = setInterval(() => void rootStillThere(), options.rootCheckMs ?? DEV_ENGINE_ROOT_CHECK_MS);
      rootCheck.unref();
      scheduleCatchUp();
    } catch (cause) {
      stopWatching();
      watchFailed(cause);
    }
  }

  return {
    root,
    ready,
    latest: () => newest,
    lastBuild: () => last,
    rebuild: async (trigger = "rebuild") => {
      const event = await enqueue(() => build(trigger));
      if (!closed) options.onBuild?.(event);
      return event;
    },
    watching: () => watcher !== undefined && !closed,
    rootGone: () => {
      // A build that overlaps a folder being made again fails on its missing files; the folder is not gone for that.
      const look = lookAtDevRoot(root, identity, canonical);
      return look.state === "gone" && !stillAwaited(look);
    },
    close: () => {
      closed = true;
      stopWatching();
    },
  };
}
