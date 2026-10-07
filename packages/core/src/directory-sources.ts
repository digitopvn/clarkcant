import { join } from "node:path";

import type { DirectoryEntry, UnreadEntryFields } from "@clarkcant/contracts";

import {
  directoryIndexPath,
  listingKey,
  readDirectoryIndex,
  type DirectoryIndexState,
  type DirectoryOrigin,
  type DirectorySourceStatus,
} from "./directory-index.ts";
import {
  OFFICIAL_MARKETPLACE_FEED_URL,
  customFeedId,
  feedLabel,
  feedUrlProblem,
  readRemoteSource,
  refreshRemoteSource,
  type FeedRefreshOptions,
} from "./marketplace-directory.ts";

/**
 * The directory as a set of sources.
 *
 * A node's directory is composed from every configured `DirectoryProvider`, in precedence order:
 *
 * 1. `LocalFileDirectory` — the JSON index named by `CC_DIRECTORY_INDEX`, read exactly as before;
 * 2. `CustomMarketplaceDirectory` — each feed URL in `CC_DIRECTORY_MARKETPLACES` (comma or space separated), in order;
 * 3. `OfficialMarketplaceDirectory` — the ClarkCant Marketplace feed, on unless `CC_OFFICIAL_MARKETPLACE=off`.
 *
 * Every source is untrusted discovery data. The composition only decides *which listing* a package id and version
 * names; installing it still goes through the one install path, which re-resolves the source, checks the digest and
 * asks the policy. Nothing here grants anything.
 *
 * Reading is synchronous and never touches the network: a remote source is read from the copy this node fetched last
 * (`marketplace-directory.ts`). Fetching happens only through `refreshDirectory`, which the places a person asks for
 * something call — a search, an install of a listing not in the copy — and the update check, for sources fetched before.
 *
 * **A package id belongs to the first source that lists it.** When a later source lists the same package id, its
 * listings for that id are left out (and counted as `shadowed`), so a marketplace cannot add versions — or an
 * "update" — to a package the person's own index or catalog already names.
 *
 * Precedence only holds while the earlier sources can be read, so a source that cannot be read never hands its package
 * ids to a later one silently:
 *
 * - A broken index file is fatal. The whole directory is `unreadable` (as it was before remote sources existed), and
 *   nothing is listed from a marketplace until the file is fixed, because the file may name any id.
 * - A remote source with no copy to list (`not-fetched`, `unreachable`, `unsupported`, `unreadable`) leaves the later
 *   sources listed, with its failure in `sources`. A listing from a later source is then installable only when the
 *   person chose it from a list that named its source (`sourcesUnreadBefore`, checked by the install path), and an
 *   update is only ever offered from the source a package was installed from.
 */

export interface DirectoryConfig {
  /** Where the sources are configured. */
  env: NodeJS.ProcessEnv;
  /**
   * The node's data folder, where the copies of remote sources are kept. Without one, remote sources are not used:
   * a remote listing this node could not find again after a restart would be a listing nothing can serve.
   */
  dataDir: string | undefined;
}

export interface DirectoryProvider {
  readonly origin: DirectoryOrigin;
  /** What the source lists now: the file as it is, or the remote copy fetched last. No network. */
  read(): { status: DirectorySourceStatus; state: DirectoryIndexState };
  /** Fetch a fresh copy when the source is remote and one is due. Never throws. A file has nothing to refresh. */
  refresh(options?: FeedRefreshOptions): Promise<void>;
}

/** The env value that turns the official Marketplace off. */
function isOff(value: string | undefined): boolean {
  return value !== undefined && ["off", "false", "0", "no"].includes(value.trim().toLowerCase());
}

export const OFFICIAL_MARKETPLACE_LABEL = "ClarkCant Marketplace";

/** The index file named by `CC_DIRECTORY_INDEX`, read exactly as `readDirectoryIndex` always has. */
export function localFileDirectory(path: string): DirectoryProvider {
  const origin: DirectoryOrigin = { id: "local", kind: "local-file", label: path };
  return {
    origin,
    read: () => {
      const state = readDirectoryIndex(path);
      const status: DirectorySourceStatus =
        state.kind === "configured"
          ? { origin, state: "ready", entryCount: state.entries.length }
          : { origin, state: "unreadable", entryCount: 0, reason: state.kind === "unreadable" ? state.reason : "" };
      return { status, state };
    },
    refresh: () => Promise.resolve(),
  };
}

/** A remote feed, read from this node's copy and refreshed on demand. */
export function marketplaceDirectory(input: {
  origin: DirectoryOrigin;
  feedUrl: string;
  cacheDir: string;
}): DirectoryProvider {
  const { origin, feedUrl, cacheDir } = input;
  const problem = feedUrlProblem(feedUrl);
  if (problem !== undefined) {
    // A misconfigured address is a named state of that source, not a crash and not a silently missing source. Named by
    // its label, never the raw address, whose query may carry a token.
    const reason = `${feedLabel(feedUrl)}: ${problem}`;
    return {
      origin,
      read: () => ({
        status: { origin, state: "unreadable", entryCount: 0, reason },
        state: { kind: "unreadable", directory: origin.label, reason },
      }),
      refresh: () => Promise.resolve(),
    };
  }
  return {
    origin,
    read: () => readRemoteSource(origin, feedUrl, cacheDir),
    refresh: (options) => refreshRemoteSource(origin, feedUrl, cacheDir, options),
  };
}

/** The official ClarkCant Marketplace. */
export function officialMarketplaceDirectory(cacheDir: string): DirectoryProvider {
  return marketplaceDirectory({
    origin: { id: "official", kind: "official-marketplace", label: OFFICIAL_MARKETPLACE_LABEL },
    feedUrl: OFFICIAL_MARKETPLACE_FEED_URL,
    cacheDir,
  });
}

/** A marketplace or catalog feed the person configured. */
export function customMarketplaceDirectory(feedUrl: string, cacheDir: string): DirectoryProvider {
  return marketplaceDirectory({
    origin: { id: customFeedId(feedUrl), kind: "custom-marketplace", label: feedLabel(feedUrl) },
    feedUrl,
    cacheDir,
  });
}

/** The feed URLs in `CC_DIRECTORY_MARKETPLACES`, in order, each once. */
export function customFeedUrls(env: NodeJS.ProcessEnv): string[] {
  const raw = env["CC_DIRECTORY_MARKETPLACES"] ?? "";
  return [...new Set(raw.split(/[\s,]+/u).filter((part) => part !== ""))];
}

/** Where the copies of remote sources are kept under a node's data folder. */
export function directoryCacheDir(dataDir: string): string {
  return join(dataDir, "directory-cache");
}

/** Every configured source, in precedence order. */
export function directoryProviders(config: DirectoryConfig): DirectoryProvider[] {
  const providers: DirectoryProvider[] = [];
  const path = directoryIndexPath(config.env);
  if (path !== undefined) providers.push(localFileDirectory(path));
  if (config.dataDir !== undefined) {
    const cacheDir = directoryCacheDir(config.dataDir);
    for (const url of customFeedUrls(config.env)) providers.push(customMarketplaceDirectory(url, cacheDir));
    if (!isOff(config.env["CC_OFFICIAL_MARKETPLACE"])) providers.push(officialMarketplaceDirectory(cacheDir));
  }
  return providers;
}

/** The states of a source that has nothing to list: it was never fetched, or could not be read and has no earlier copy. */
const FAILED_STATES: ReadonlySet<DirectorySourceStatus["state"]> = new Set([
  "not-fetched",
  "unreachable",
  "unsupported",
  "unreadable",
]);

/** What a person can do when no source lists anything. */
const SETUP_HINT =
  "to list packages, set CC_DIRECTORY_INDEX to a JSON index file or add a marketplace or catalog feed with CC_DIRECTORY_MARKETPLACES";

/**
 * Compose what the sources list into one directory state.
 *
 * - No source configured: `not-configured`, a state rather than an empty list.
 * - Only the index file: exactly what `readDirectoryIndex` answers for it, so a node configured as before behaves as before.
 * - The index file cannot be read: `unreadable` with the file's own reason, whatever the other sources list.
 * - Every source failed: `unreadable`, naming each source and why, and how to set a directory up.
 * - Otherwise: `configured`, with the listings of every usable source (by precedence, see above), which source listed
 *   each (`origins`), and every source's own state (`sources`), so a stale or unreachable source is said, not hidden.
 */
export function composeDirectory(providers: readonly DirectoryProvider[]): DirectoryIndexState {
  if (providers.length === 0) {
    return {
      kind: "not-configured",
      reason:
        "no directory is configured; set CC_DIRECTORY_INDEX to a JSON index file, add a marketplace with " +
        "CC_DIRECTORY_MARKETPLACES, or turn the ClarkCant Marketplace back on (CC_OFFICIAL_MARKETPLACE)",
    };
  }
  const reads = providers.map((provider) => provider.read());
  const only = reads[0];
  if (reads.length === 1 && only !== undefined && only.status.origin.kind === "local-file") {
    const origins = only.state.kind === "configured" ? originsFor(only.state.entries, only.status.origin) : undefined;
    return only.state.kind === "configured"
      ? { ...only.state, ...(origins === undefined ? {} : { origins }), sources: [only.status] }
      : only.state.kind === "unreadable"
        ? { ...only.state, sources: [only.status] }
        : only.state;
  }

  const directory = providers.map((provider) => provider.origin.label).join(" · ");
  const statuses = reads.map((read) => read.status);
  const brokenIndex = reads.find((read) => read.status.origin.kind === "local-file" && read.state.kind !== "configured");
  if (brokenIndex !== undefined) {
    // The person's own index may name any package id; filling in from a marketplace while it is broken would let another
    // party's listing stand in for the person's own.
    const reason = brokenIndex.state.kind === "unreadable" ? brokenIndex.state.reason : (brokenIndex.status.reason ?? "");
    return { kind: "unreadable", directory, reason, sources: statuses };
  }

  const entries: DirectoryEntry[] = [];
  const unreadFields = new Map<string, UnreadEntryFields>();
  const origins = new Map<string, DirectoryOrigin>();
  const owner = new Map<string, string>();
  const sources: DirectorySourceStatus[] = [];
  for (const read of reads) {
    if (read.state.kind !== "configured") {
      sources.push(read.status);
      continue;
    }
    let contributed = 0;
    let shadowed = 0;
    for (const entry of read.state.entries) {
      const claimedBy = owner.get(entry.packageId);
      if (claimedBy !== undefined && claimedBy !== read.status.origin.id) {
        shadowed += 1;
        continue;
      }
      owner.set(entry.packageId, read.status.origin.id);
      const key = listingKey(entry);
      entries.push(entry);
      contributed += 1;
      if (!origins.has(key)) origins.set(key, read.status.origin);
      const unread = read.state.unreadFields?.get(key);
      if (unread !== undefined) unreadFields.set(key, unread);
    }
    sources.push({ ...read.status, entryCount: contributed, ...(shadowed === 0 ? {} : { shadowed }) });
  }

  if (sources.every((status) => FAILED_STATES.has(status.state))) {
    const problems = directoryProblems(sources) ?? "no source could be read";
    return { kind: "unreadable", directory, reason: `${problems}; ${SETUP_HINT}`, sources };
  }
  return {
    kind: "configured",
    directory,
    entries,
    ...(unreadFields.size === 0 ? {} : { unreadFields }),
    origins,
    sources,
  };
}

function originsFor(entries: readonly DirectoryEntry[], origin: DirectoryOrigin): Map<string, DirectoryOrigin> {
  return new Map(entries.map((entry) => [listingKey(entry), origin]));
}

/** The directory every configured source composes, read now without touching the network. */
export function readDirectory(config: DirectoryConfig): DirectoryIndexState {
  return composeDirectory(directoryProviders(config));
}

/**
 * Fetch fresh copies of the remote sources that are due, in parallel. Never throws; each outcome becomes that source's
 * state on the next `readDirectory`.
 */
export async function refreshDirectory(config: DirectoryConfig, options: FeedRefreshOptions = {}): Promise<void> {
  await Promise.all(directoryProviders(config).map((provider) => provider.refresh(options)));
}

/** Which source listed `entry`, when the state knows. */
export function originOf(
  state: DirectoryIndexState,
  entry: Pick<DirectoryEntry, "packageId" | "version" | "digest">,
): DirectoryOrigin | undefined {
  return state.kind === "configured" ? state.origins?.get(listingKey(entry)) : undefined;
}

/**
 * The sources earlier in precedence than `origin` that have nothing to list right now (never fetched, or failed with no
 * earlier copy). Any of them may list the same package id, and would own it if it could be read, so a listing from
 * `origin` is not what precedence would pick: the install path installs it only when the person chose it from a list
 * that named its source. Empty when `origin` is first, or every earlier source answered.
 */
export function sourcesUnreadBefore(state: DirectoryIndexState, origin: DirectoryOrigin): DirectorySourceStatus[] {
  if (state.kind !== "configured" || state.sources === undefined) return [];
  const at = state.sources.findIndex((status) => status.origin.id === origin.id);
  return at <= 0 ? [] : state.sources.slice(0, at).filter((status) => FAILED_STATES.has(status.state));
}

/**
 * The sources that are not fully answering, as one sentence: "<source>: <why>; …". Undefined when every source is ready.
 * Said next to a "not in the directory" refusal, so a package missing because its marketplace is down is not reported as
 * a package that does not exist.
 */
export function directoryProblems(sources: readonly DirectorySourceStatus[] | undefined): string | undefined {
  const problems = (sources ?? [])
    .filter((status) => status.state !== "ready")
    .map((status) => `${status.origin.label}: ${status.reason ?? status.state}`);
  return problems.length === 0 ? undefined : problems.join("; ");
}
