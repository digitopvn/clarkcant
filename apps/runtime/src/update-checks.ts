import { entryFitsHost, platformForHost, semverSchema, type Instant, type Platform } from "@clarkcant/contracts";
import {
  HOST_API_VERSION,
  directoryIndexPath,
  readDirectoryIndex,
  listInstalledPackages,
  type InstallDeps,
  type InstalledPackageView,
} from "@clarkcant/core";
import { sdkVersion } from "@clarkcant/pi-adapter";

import { packageUpdateNotice, piUpdateNotice, tryRecordNodeNotice, type NoticeServices } from "./notices.ts";

/**
 * Checking whether an installed package, widget or the Pi SDK has a newer version published.
 *
 * Two upstreams, both read-only and both already owned elsewhere:
 *
 *   - **Packages and widgets** are compared against the directory index this node already reads for search and
 *     install (`packages/core`'s `readDirectoryIndex`/`directoryIndexPath`) — no second resolver, no network call
 *     of its own. A directory that is not configured, or entries that name no newer version, produce nothing. A
 *     directory commonly lists several versions of the same package; every entry for that `packageId` is
 *     considered, filtered to the ones the installer would actually accept (`entryFitsHost`, the same host/platform
 *     preflight `installPackage` runs, plus a non-empty digest), and the highest surviving version wins. A host
 *     this vocabulary cannot name skips the package half entirely rather than guessing.
 *   - **The Pi SDK** is compared against what `@earendil-works/pi-coding-agent` publishes on npm. This is the one
 *     real network call in this module, and it is the one place "offline" has to be handled without becoming an
 *     error notice: a person working on a plane should never get told something went wrong because nothing could
 *     be reached.
 *
 * `checkForUpdates` is the testable core — every IO it needs (installed packages, directory entries, the SDK's own
 * pinned version, `fetch`, the clock) arrives as an argument, so a test drives it without a real filesystem,
 * registry or process. `startUpdateCheckTimer` is the thin periodic wrapper the runtime actually boots: an unref'd
 * interval, one run in flight at a time, stopped by the caller when the node closes.
 *
 * There is no npm range for a `git`-sourced package's revision — the directory lists an exact commit, and the only
 * way to learn whether a newer commit exists is to clone and look. That upstream is not implemented here: a
 * `git`-sourced entry is compared on its own declared `version` field exactly like an `npm` one (both are ordinary
 * semver on the directory entry), so a publisher that bumps `version` on a new commit is still caught; a publisher
 * that pushes a new commit without bumping `version` is not, and this module does not pretend otherwise.
 */

export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 5_000;
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

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
 * directory entry or a junk registry response must never be reported as an update just because it happened to sort
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
  piUpdate: boolean;
  /** True when the Pi SDK half could not reach the registry. Never an error — offline is an expected state. */
  piOffline: boolean;
}

export interface CheckForUpdatesInput {
  services: NoticeServices;
  installedPackages: readonly InstalledPackageView[];
  /** The directory index, already read. A node with no directory configured passes an empty array. */
  directory: readonly UpdateCandidate[];
  /** The Pi SDK version this node runs, e.g. from `sdkVersion()`. */
  piInstalledVersion: string;
  piPackageName?: string;
  registryUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now: () => Instant;
  /** Aborts the Pi SDK registry fetch, combined with the 5s timeout. Set by `startUpdateCheckTimer` on `stop()`. */
  signal?: AbortSignal;
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
 * The pure check: given what is installed and what the two upstreams say, write the notices that are new.
 *
 * Every notice goes through `tryRecordNodeNotice`, so a storage failure is reported on stderr and never turns a
 * finished check into a thrown error — and every notice's `dedupKey` names the exact package+version, so calling
 * this again (the periodic job does, every interval) writes nothing new until an actually newer version appears.
 *
 * A directory commonly lists several versions of the same package. Every entry for a given `packageId` is
 * filtered to the ones `isInstallableCandidate` accepts and then to the ones actually newer than what is
 * installed, and the highest of those wins — never the first entry the directory happens to list. When this host's
 * platform is not one the vocabulary names at all, the package half is skipped entirely rather than guessing.
 */
export async function checkForUpdates(input: CheckForUpdatesInput): Promise<UpdateCheckReport> {
  let packageUpdates = 0;
  const platform = platformForHost(process.platform, process.arch);
  if (platform !== undefined) {
    for (const installed of input.installedPackages) {
      const newest = input.directory
        .filter(
          (entry) =>
            entry.packageId === installed.packageId &&
            isInstallableCandidate(entry, platform) &&
            isNewerVersion(entry.version, installed.version),
        )
        .reduce<UpdateCandidate | undefined>(
          (best, entry) => (best === undefined || isNewerVersion(entry.version, best.version) ? entry : best),
          undefined,
        );
      if (newest === undefined) continue;
      tryRecordNodeNotice(
        input.services,
        packageUpdateNotice({
          packageId: installed.packageId,
          currentVersion: installed.version,
          newVersion: newest.version,
          sourceKind: newest.sourceKind,
          lane: newest.lane,
          at: input.now(),
        }),
      );
      packageUpdates += 1;
    }
  }

  const piPackageName = input.piPackageName ?? PI_PACKAGE_NAME;
  const latest = await fetchLatestNpmVersion({
    name: piPackageName,
    registryUrl: input.registryUrl,
    fetchImpl: input.fetchImpl ?? fetch,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (!latest.ok) {
    // Unreachable registry, a timeout, or a malformed response: offline is an expected state for a local-first
    // node, not a failure worth telling the person about every few hours it happens to be true.
    return { packageUpdates, piUpdate: false, piOffline: true };
  }
  if (!isNewerVersion(latest.version, input.piInstalledVersion)) {
    return { packageUpdates, piUpdate: false, piOffline: false };
  }
  tryRecordNodeNotice(
    input.services,
    piUpdateNotice({
      packageName: piPackageName,
      currentVersion: input.piInstalledVersion,
      newVersion: latest.version,
      at: input.now(),
    }),
  );
  return { packageUpdates, piUpdate: true, piOffline: false };
}

/**
 * The npm registry's own `GET /<package>/latest` shorthand: the packument for exactly the `latest` dist-tag,
 * rather than every published version. Any failure — network, timeout, an abort, a non-2xx status, a body that
 * does not carry a valid-semver `version` string — is folded into `{ ok: false }` rather than thrown, so the
 * caller's "offline never errors" rule holds without a try/catch of its own around this call.
 *
 * The request signal combines the 5s timeout with the caller's own `signal` (`AbortSignal.any`), when one is
 * given, so a check `stop()` interrupts mid-fetch ends the same way a timeout does: quietly, as `{ ok: false }`,
 * never as a notice written after the caller asked this to stop.
 */
async function fetchLatestNpmVersion(input: {
  name: string;
  registryUrl: string | undefined;
  fetchImpl: typeof fetch;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
}): Promise<{ ok: true; version: string } | { ok: false }> {
  const registry = (input.registryUrl ?? DEFAULT_REGISTRY_URL).replace(/\/$/, "");
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = input.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, input.signal]);
  try {
    const response = await input.fetchImpl(`${registry}/${encodeURIComponent(input.name)}/latest`, { signal });
    if (!response.ok) return { ok: false };
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string") return { ok: false };
    const parsed = semverSchema.safeParse(body.version.trim());
    if (!parsed.success) return { ok: false };
    return { ok: true, version: parsed.data };
  } catch {
    return { ok: false };
  }
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
  fetchImpl?: typeof fetch;
  registryUrl?: string;
  timeoutMs?: number;
  now?: () => Instant;
  /** Reads the Pi SDK version this node actually runs. Defaults to `sdkVersion` from `@clarkcant/pi-adapter`. */
  piInstalledVersion?: () => Promise<string>;
  intervalMs?: number;
}

/** One pass: read what is installed, what the directory says, what the SDK reports, and check. */
export async function runUpdateCheckOnce(
  deps: UpdateCheckJobDeps,
  options: { signal?: AbortSignal } = {},
): Promise<UpdateCheckReport> {
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
  const piInstalledVersion = await (deps.piInstalledVersion ?? sdkVersion)();

  return checkForUpdates({
    services: deps.services,
    installedPackages: installed,
    directory,
    piInstalledVersion,
    ...(deps.registryUrl === undefined ? {} : { registryUrl: deps.registryUrl }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    now,
  });
}

/**
 * Start the periodic job. An unref'd interval so it never holds the process open on its own, and never more than
 * one pass in flight — a slow or hung registry fetch cannot pile up a second, overlapping check.
 *
 * Runs once shortly after start (so a node does not wait a full interval to say anything), then every
 * `intervalMs`. `stop()` clears the timer and, if a pass is in flight, aborts its registry fetch (the same
 * `AbortSignal` `checkForUpdates` combines with its 5s timeout) — so a pass `stop()` catches mid-flight ends
 * quietly as `{ ok: false }`, the same as an offline registry, rather than finishing on its own time and writing a
 * notice after the caller already asked this to stop. The caller runs `stop()` when the node closes, the same as
 * every other unref'd timer this runtime owns (`pi-session-watch.ts`, `server.ts`'s keep-alive).
 */
export function startUpdateCheckTimer(deps: UpdateCheckJobDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
  let inFlight = false;
  let stopped = false;
  let controller: AbortController | undefined;

  const runOnce = (): void => {
    if (inFlight || stopped) return;
    inFlight = true;
    controller = new AbortController();
    void runUpdateCheckOnce(deps, { signal: controller.signal })
      .catch((cause: unknown) => {
        process.stderr.write(
          `update check: not completed — ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
      })
      .finally(() => {
        inFlight = false;
        controller = undefined;
      });
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
      controller?.abort();
    },
  };
}
