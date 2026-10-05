import { entryFitsHost, platformForHost, type Instant, type Platform } from "@clarkcant/contracts";
import {
  HOST_API_VERSION,
  directoryIndexPath,
  readDirectoryIndex,
  listInstalledPackages,
  type InstallDeps,
  type InstalledPackageView,
} from "@clarkcant/core";
import { skippedVersionsOf, type SkippedVersionKind } from "@clarkcant/storage";

import {
  packageUpdateKeyPrefixes,
  packageUpdateNotice,
  tryRecordUpdateNotice,
  tryRetirePiUpdateNotices,
  type NoticeServices,
} from "./notices.ts";

/**
 * Checking whether an installed package or widget has a newer version published.
 *
 * The upstream is the directory index this node already reads for search and install (`packages/core`'s
 * `readDirectoryIndex`/`directoryIndexPath`) — no second resolver, no network call of its own. A directory that is not
 * configured, or entries that name no newer version, produce nothing. A directory commonly lists several versions of
 * the same package; every entry for that `packageId` is considered, filtered to the ones the installer would actually
 * accept (`entryFitsHost`, the same host/platform preflight `installPackage` runs, plus a non-empty digest), and the
 * highest surviving version wins. A host this vocabulary cannot name skips the check entirely rather than guessing.
 *
 * The Pi SDK is not checked. It is pinned exactly in `packages/pi-adapter` and ships with ClarkCant itself, so there
 * is nothing the person could do about a newer one from the inbox: a notice for it would be a pointer with no action
 * behind it. A node that still holds Pi update notices from before has them retired on the next pass.
 *
 * `checkForUpdates` is the testable core — every IO it needs (installed packages, directory entries, the clock) arrives
 * as an argument, so a test drives it without a real filesystem or directory. `startUpdateCheckTimer` is the thin
 * periodic wrapper the runtime actually boots: an unref'd interval, stopped by the caller when the node closes.
 *
 * There is no npm range for a `git`-sourced package's revision — the directory lists an exact commit, and the only
 * way to learn whether a newer commit exists is to clone and look. That upstream is not implemented here: a
 * `git`-sourced entry is compared on its own declared `version` field exactly like an `npm` one (both are ordinary
 * semver on the directory entry), so a publisher that bumps `version` on a new commit is still caught; a publisher
 * that pushes a new commit without bumping `version` is not, and this module does not pretend otherwise.
 */

export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * A minimal view of a directory entry: enough to compare, to check installability, and to label a package update
 * notice.
 */
export interface UpdateCandidate {
  packageId: string;
  version: string;
  sourceKind: "npm" | "git" | "local";
  lane: "isolated-ui" | "service" | "declarative" | "trusted-native";
  /** The digest the directory entry publishes. An update is never reported for an entry with none — see `installPackage`. */
  digest: string;
  /** The host API range the entry declares it was built against, checked with the same `entryFitsHost` the installer runs. */
  hostApi: { min: number; max: number };
  /** The platforms the entry declares it runs on. */
  platforms: readonly Platform[];
}

/**
 * Whether `candidate` names a version that sorts after `current`.
 *
 * Ordinary semver precedence for the common case (`major.minor.patch[-prerelease]`): numeric parts compare
 * numerically, a release beats any prerelease of the same numeric triple, and two prereleases of the same triple
 * compare identifier by identifier — each pair numeric compares numerically, and a numeric identifier always sorts
 * before an alphanumeric one at the same position, per semver precedence.
 *
 * Either side not parsing as semver answers `false` rather than falling back to a string compare: a malformed
 * directory entry must never be reported as an update just because it happened to sort
 * higher lexically.
 *
 * A candidate that is itself a prerelease is only ever reported when `current` is a prerelease too — a stable
 * install is never offered a prerelease build, even one that names a higher core version.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (a === undefined || b === undefined) return false;
  if (a.pre !== undefined && b.pre === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return (a.core[index] as number) > (b.core[index] as number);
  }
  if (a.pre === undefined && b.pre === undefined) return false;
  if (a.pre === undefined) return true;
  if (b.pre === undefined) return false;
  return comparePrereleaseIdentifiers(a.pre, b.pre) > 0;
}

function parseSemver(version: string): { core: [number, number, number]; pre: string | undefined } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (match === null) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4],
  };
}

/**
 * Semver prerelease precedence between two dot-separated identifier strings (the part after the `-`).
 *
 * Compared identifier by identifier: a pair that are both all-digits compares numerically, a numeric identifier
 * always sorts below an alphanumeric one at the same position, and two alphanumeric identifiers compare as plain
 * strings. A prerelease with fewer identifiers sorts below one that shares its leading identifiers and has more.
 * Positive means `a` is newer than `b`; negative means older; zero means equal.
 */
function comparePrereleaseIdentifiers(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const left = aParts[index];
    const right = bParts[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftIsNumeric = /^\d+$/.test(left);
    const rightIsNumeric = /^\d+$/.test(right);
    if (leftIsNumeric && rightIsNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff;
      continue;
    }
    if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** What `checkForUpdates` learned, for a caller (or a test) that wants to assert on counts rather than notices. */
export interface UpdateCheckReport {
  packageUpdates: number;
}

export interface CheckForUpdatesInput {
  services: NoticeServices;
  installedPackages: readonly InstalledPackageView[];
  /** The directory index, already read. A node with no directory configured passes an empty array. */
  directory: readonly UpdateCandidate[];
  now: () => Instant;
  /** The platform the installer checks entries against. Defaults to this process's host; a test pins it. */
  platform?: Platform | undefined;
}

/**
 * Whether the installer would actually accept `candidate` on this host: the same host/platform preflight
 * `installPackage` runs (`entryFitsHost`), plus a non-empty digest. Reusing the shared check rather than
 * re-deriving compatibility here means this module can never offer an update the install path would refuse.
 */
function isInstallableCandidate(candidate: UpdateCandidate, platform: Platform): boolean {
  if (candidate.digest.trim() === "") return false;
  return entryFitsHost({
    entry: { hostApi: candidate.hostApi, platforms: [...candidate.platforms] },
    hostApi: HOST_API_VERSION,
    platform,
  }).ok;
}

/**
 * The pure check: given what is installed and what the directory lists, write the notices that are new.
 *
 * Every notice goes through `tryRecordUpdateNotice`, so a storage failure is reported on stderr and never turns a
 * finished check into a thrown error — and every notice's `dedupKey` names the exact package+version, so calling
 * this again (the periodic job does, every interval) writes nothing new until an actually newer version appears.
 * When one does, its notice retires the earlier update notices for the same package, so the inbox offers only the
 * newest. Pi SDK update notices left from before the SDK stopped being checked are retired on every pass.
 *
 * A directory commonly lists several versions of the same package. Every entry for a given `packageId` is
 * filtered to the ones `isInstallableCandidate` accepts and then to the ones actually newer than what is
 * installed, and the highest of those wins — never the first entry the directory happens to list. When this host's
 * platform is not one the vocabulary names at all, the check is skipped entirely rather than guessing.
 *
 * A version the owner skipped from an earlier notice, or anything older than it, is not reported again
 * (`skipped_versions`); a newer one still is.
 */
export function checkForUpdates(input: CheckForUpdatesInput): UpdateCheckReport {
  let packageUpdates = 0;
  const platform = "platform" in input ? input.platform : platformForHost(process.platform, process.arch);
  if (platform !== undefined) {
    for (const installed of input.installedPackages) {
      const skipped = skippedFor(input.services, "package", installed.packageId);
      const newest = input.directory
        .filter(
          (entry) =>
            entry.packageId === installed.packageId &&
            isInstallableCandidate(entry, platform) &&
            isNewerVersion(entry.version, installed.version) &&
            !skipped(entry.version),
        )
        .reduce<UpdateCandidate | undefined>(
          (best, entry) => (best === undefined || isNewerVersion(entry.version, best.version) ? entry : best),
          undefined,
        );
      if (newest === undefined) continue;
      tryRecordUpdateNotice(
        input.services,
        packageUpdateNotice({
          packageId: installed.packageId,
          currentVersion: installed.version,
          newVersion: newest.version,
          sourceKind: newest.sourceKind,
          lane: newest.lane,
          at: input.now(),
        }),
        packageUpdateKeyPrefixes(installed.packageId),
      );
      packageUpdates += 1;
    }
  }

  tryRetirePiUpdateNotices(input.services, input.now());
  return { packageUpdates };
}

/**
 * Whether a version is one the owner asked not to hear about: at or below a version they skipped from an update
 * notice. Read per check rather than cached, so a skip made a minute ago holds on the next pass.
 */
function skippedFor(services: NoticeServices, kind: SkippedVersionKind, name: string): (version: string) => boolean {
  const skipped = skippedVersionsOf(services.runtime.db, services.runtime.identity.ownerPrincipalId, kind, name);
  return (version) => skipped.some((mark) => !isNewerVersion(version, mark));
}

/** A directory entry's git/npm/local source, narrowed to the label an update notice shows. */
function sourceKindOf(source: { kind: "local" | "git" | "npm" }): "npm" | "git" | "local" {
  return source.kind;
}

export interface UpdateCheckJobDeps {
  services: NoticeServices;
  installDeps: InstallDeps;
  /** Where the directory index lives, when one is configured. Defaults to reading `CC_DIRECTORY_INDEX`. */
  env?: NodeJS.ProcessEnv;
  now?: () => Instant;
  intervalMs?: number;
  /** The platform directory entries are checked against. Defaults to this process's host; a test pins it. */
  platform?: Platform | undefined;
}

/** One pass: read what is installed and what the directory says, and check. */
export function runUpdateCheckOnce(deps: UpdateCheckJobDeps): UpdateCheckReport {
  const now = deps.now ?? (() => new Date().toISOString() as Instant);
  const installed = listInstalledPackages(deps.installDeps);
  const index = readDirectoryIndex(directoryIndexPath(deps.env ?? process.env));
  const directory: UpdateCandidate[] =
    index.kind === "configured"
      ? index.entries.map((entry) => ({
          packageId: entry.packageId,
          version: entry.version,
          sourceKind: sourceKindOf(entry.source),
          lane: entry.riskTier,
          digest: entry.digest,
          hostApi: entry.hostApi,
          platforms: entry.platforms,
        }))
      : [];

  return checkForUpdates({
    services: deps.services,
    installedPackages: installed,
    directory,
    ...("platform" in deps ? { platform: deps.platform } : {}),
    now,
  });
}

/**
 * Start the periodic job: an unref'd interval, so it never holds the process open on its own.
 *
 * Runs once shortly after start (so a node does not wait a full interval to say anything), then every `intervalMs`. A
 * pass reads only local state and finishes before the next tick can start, so passes never overlap. A pass that throws
 * is reported on stderr and the next tick runs as usual. The caller runs `stop()` when the node closes, the same as
 * every other unref'd timer this runtime owns (`pi-session-watch.ts`, `server.ts`'s keep-alive).
 */
export function startUpdateCheckTimer(deps: UpdateCheckJobDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
  let stopped = false;

  const runOnce = (): void => {
    if (stopped) return;
    try {
      runUpdateCheckOnce(deps);
    } catch (cause: unknown) {
      process.stderr.write(`update check: not completed — ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  };

  const startTimer = setTimeout(runOnce, 0);
  startTimer.unref();
  const interval = setInterval(runOnce, intervalMs);
  interval.unref();

  return {
    stop: () => {
      stopped = true;
      clearTimeout(startTimer);
      clearInterval(interval);
    },
  };
}
