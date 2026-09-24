import type { Instant } from "@clarkcant/contracts";
import {
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
 *     of its own. A directory that is not configured, or entries that name no newer version, produce nothing.
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

/** A minimal view of a directory entry: enough to compare and to label a package update notice. */
export interface UpdateCandidate {
  packageId: string;
  version: string;
  sourceKind: "npm" | "git" | "local";
  lane: "isolated-ui" | "service" | "declarative" | "trusted-native";
}

/**
 * Whether `candidate` names a version that sorts after `current`.
 *
 * Ordinary semver precedence for the common case (`major.minor.patch[-prerelease]`): numeric parts compare
 * numerically, and a release beats any prerelease of the same numeric triple. Neither side needs to be a
 * `x.y.z` string for this to answer *something* useful — a value this module does not recognise as semver falls
 * back to a plain string comparison, so a malformed directory entry never crashes the check, only skips catching a
 * legitimate bump it could not parse.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (a === undefined || b === undefined) return candidate !== current && candidate > current;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return (a.core[index] as number) > (b.core[index] as number);
  }
  if (a.pre === undefined && b.pre === undefined) return false;
  if (a.pre === undefined) return true;
  if (b.pre === undefined) return false;
  return a.pre > b.pre;
}

function parseSemver(version: string): { core: [number, number, number]; pre: string | undefined } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (match === null) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4],
  };
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
}

/**
 * The pure check: given what is installed and what the two upstreams say, write the notices that are new.
 *
 * Every notice goes through `tryRecordNodeNotice`, so a storage failure is reported on stderr and never turns a
 * finished check into a thrown error — and every notice's `dedupKey` names the exact package+version, so calling
 * this again (the periodic job does, every interval) writes nothing new until an actually newer version appears.
 */
export async function checkForUpdates(input: CheckForUpdatesInput): Promise<UpdateCheckReport> {
  let packageUpdates = 0;
  for (const installed of input.installedPackages) {
    const candidate = input.directory.find((entry) => entry.packageId === installed.packageId);
    if (candidate === undefined) continue;
    if (!isNewerVersion(candidate.version, installed.version)) continue;
    tryRecordNodeNotice(
      input.services,
      packageUpdateNotice({
        packageId: installed.packageId,
        currentVersion: installed.version,
        newVersion: candidate.version,
        sourceKind: candidate.sourceKind,
        lane: candidate.lane,
        at: input.now(),
      }),
    );
    packageUpdates += 1;
  }

  const piPackageName = input.piPackageName ?? PI_PACKAGE_NAME;
  const latest = await fetchLatestNpmVersion({
    name: piPackageName,
    registryUrl: input.registryUrl,
    fetchImpl: input.fetchImpl ?? fetch,
    timeoutMs: input.timeoutMs,
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
 * rather than every published version. Any failure — network, timeout, a non-2xx status, a body that does not
 * carry a `version` string — is folded into `{ ok: false }` rather than thrown, so the caller's "offline never
 * errors" rule holds without a try/catch of its own around this call.
 */
async function fetchLatestNpmVersion(input: {
  name: string;
  registryUrl: string | undefined;
  fetchImpl: typeof fetch;
  timeoutMs: number | undefined;
}): Promise<{ ok: true; version: string } | { ok: false }> {
  const registry = (input.registryUrl ?? DEFAULT_REGISTRY_URL).replace(/\/$/, "");
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const response = await input.fetchImpl(`${registry}/${encodeURIComponent(input.name)}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false };
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string" || body.version.trim() === "") return { ok: false };
    return { ok: true, version: body.version };
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
export async function runUpdateCheckOnce(deps: UpdateCheckJobDeps): Promise<UpdateCheckReport> {
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
    now,
  });
}

/**
 * Start the periodic job. An unref'd interval so it never holds the process open on its own, and never more than
 * one pass in flight — a slow or hung registry fetch cannot pile up a second, overlapping check.
 *
 * Runs once shortly after start (so a node does not wait a full interval to say anything), then every
 * `intervalMs`. `stop()` clears the timer; the caller runs it when the node closes, the same as every other
 * unref'd timer this runtime owns (`pi-session-watch.ts`, `server.ts`'s keep-alive).
 */
export function startUpdateCheckTimer(deps: UpdateCheckJobDeps): { stop: () => void } {
  const intervalMs = deps.intervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
  let inFlight = false;
  let stopped = false;

  const runOnce = (): void => {
    if (inFlight || stopped) return;
    inFlight = true;
    void runUpdateCheckOnce(deps)
      .catch((cause: unknown) => {
        process.stderr.write(
          `update check: not completed — ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
      })
      .finally(() => {
        inFlight = false;
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
    },
  };
}
