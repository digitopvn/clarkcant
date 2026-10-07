import { readFileSync } from "node:fs";

import {
  readDirectoryEntry,
  unreadListingFields,
  type DirectoryEntry,
  type DirectorySourceKind,
  type DirectorySourceState,
  type UnreadEntryFields,
  type UnreadListingFields,
} from "@clarkcant/contracts";

/**
 * Searching a directory index.
 *
 * There is no registry behind this and the code does not pretend there is. A directory is a **file** — a JSON array
 * of entries in the shape `directoryEntrySchema` already validates — and the runtime reads it if one is configured.
 * That keeps the whole search honest: results come from something that exists on this machine or at a URL the user
 * named, and a machine with no directory configured says so instead of showing an empty list.
 *
 * The install path is untouched by any of this. A result is a *pointer*; installing it goes through the same
 * resolver, digest check and generation swap as a path typed by hand. Search is how you find a source, never how you
 * authorise one.
 */

/** Where a directory index lives, if one is configured at all. */
export function directoryIndexPath(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env["CC_DIRECTORY_INDEX"];
  return configured === undefined || configured.trim() === "" ? undefined : configured.trim();
}

export type DirectoryIndexState =
  | {
      kind: "configured";
      directory: string;
      entries: DirectoryEntry[];
      /**
       * For each entry that carried fields this node does not read, what it left out (`readDirectoryEntry`), keyed by
       * `listingKey`. Absent or without a key means the node read all of that entry. Read it with `unreadFieldsOf`.
       */
      unreadFields?: ReadonlyMap<string, UnreadEntryFields>;
      /**
       * Which configured source listed each entry, keyed by `listingKey`, when the state was composed from several
       * sources (`readDirectory`). Read it with `originOf`. Absent when the state is a single index file read directly.
       */
      origins?: ReadonlyMap<string, DirectoryOrigin>;
      /** Every configured source with its own named state, in precedence order. Absent for a single file read directly. */
      sources?: readonly DirectorySourceStatus[];
    }
  /** No index is configured. A state, not an empty result list: "nothing configured" is not "nothing found". */
  | { kind: "not-configured"; reason: string }
  /** An index is configured and could not be used. Named, because the fix is the user's. */
  | { kind: "unreadable"; directory: string; reason: string; sources?: readonly DirectorySourceStatus[] };


/** Where a listing came from: which configured source, of which kind, under the name a person recognises. */
export interface DirectoryOrigin {
  /** Stable id of the source on this node (`local`, `official`, `custom-<hash>`). */
  id: string;
  kind: DirectorySourceKind;
  /** The index file's path, or the marketplace's name or address. */
  label: string;
}

/** The state of one source (`directorySourceStateSchema`), with what it contributes and why it is not `ready`. */
export interface DirectorySourceStatus {
  origin: DirectoryOrigin;
  state: DirectorySourceState;
  /** How many listings this source contributes. */
  entryCount: number;
  /** When the listed copy of a remote source was fetched. */
  fetchedAt?: string;
  /** Why the source is not `ready`, in words a person can act on. */
  reason?: string;
  /** Listings left out because a source earlier in precedence lists the same package id. */
  shadowed?: number;
}

/** Which listing a set of unread fields belongs to: the package, the version and the artifact it names. */
export function listingKey(entry: Pick<DirectoryEntry, "packageId" | "version" | "digest">): string {
  return JSON.stringify([entry.packageId, entry.version, entry.digest]);
}

/**
 * What `entry`'s listing carried that this node did not read, as a card, an install question or an update notice says
 * it, or undefined when it read all of it.
 */
export function unreadFieldsOf(
  index: DirectoryIndexState,
  entry: Pick<DirectoryEntry, "packageId" | "version" | "digest">,
): UnreadListingFields | undefined {
  if (index.kind !== "configured" || index.unreadFields === undefined) return undefined;
  const unread = index.unreadFields.get(listingKey(entry));
  return unread === undefined ? undefined : unreadListingFields(unread);
}

/**
 * Read the configured index.
 *
 * Each entry is read with `readDirectoryEntry`: a field this node does not know is dropped and remembered in
 * `unreadFields`, so an index a newer directory wrote still serves every package, and what was left out is said where
 * the listing is shown. A field it does know with a value that does not validate is still a refusal of the whole file
 * rather than a silently dropped row: a directory that half-loads would show a subset of what it holds and call it the
 * answer.
 */
export function readDirectoryIndex(path: string | undefined): DirectoryIndexState {
  if (path === undefined) {
    return {
      kind: "not-configured",
      reason: "no directory is configured; set CC_DIRECTORY_INDEX to a JSON index file to search one",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      kind: "unreadable",
      directory: path,
      reason: `could not read the directory index: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
  return readDirectoryCandidates(path, parsed);
}

/**
 * Read a parsed index — a JSON array of entries — the way `readDirectoryIndex` reads a file. Shared with the remote
 * sources (`marketplace-directory.ts`), so a feed is held to exactly the rules a file is: unknown fields dropped and
 * named, a known field with a bad value refusing the whole index.
 */
export function readDirectoryCandidates(directory: string, parsed: unknown): DirectoryIndexState {
  const path = directory;
  if (!Array.isArray(parsed)) {
    return { kind: "unreadable", directory: path, reason: "the directory index is not a JSON array of entries" };
  }
  const entries: DirectoryEntry[] = [];
  const unreadFields = new Map<string, UnreadEntryFields>();
  for (const candidate of parsed) {
    const result = readDirectoryEntry(candidate);
    if (!result.success) {
      const first = result.error.issues[0];
      return {
        kind: "unreadable",
        directory: path,
        reason: `an entry does not match the directory schema: ${first?.path.join(".") ?? ""} ${
          first?.message ?? "invalid"
        }`,
      };
    }
    entries.push(result.data);
    if (result.unreadFields.names.length + result.unreadFields.unnamed > 0) {
      const key = listingKey(result.data);
      // The same listing twice keeps every field either copy carried, so neither is said to be read in full.
      const before = unreadFields.get(key) ?? { names: [], unnamed: 0 };
      unreadFields.set(key, {
        names: [...new Set([...before.names, ...result.unreadFields.names])],
        unnamed: Math.max(before.unnamed, result.unreadFields.unnamed),
      });
    }
  }
  return { kind: "configured", directory: path, entries, ...(unreadFields.size === 0 ? {} : { unreadFields }) };
}

/** How well an entry answers a query. Higher is better; 0 means it does not answer it. */
function score(entry: DirectoryEntry, query: string): number {
  const id = entry.packageId.toLowerCase();
  const name = entry.displayName.toLowerCase();
  const description = entry.description.toLowerCase();
  if (id === query) return 100;
  if (id.startsWith(query)) return 80;
  if (id.includes(query)) return 70;
  if (name.includes(query)) return 60;
  if (description.includes(query)) return 40;
  if (entry.facets.some((facet) => facet.includes(query))) return 20;
  return 0;
}

/**
 * Rank the entries that answer a query.
 *
 * An entry with no digest is dropped before ranking. It is not installable — the resolver would refuse it — so
 * showing it would offer an install that cannot happen, which is the same defect as a button whose action does not
 * exist, one step further away.
 *
 * An empty query browses rather than searching: everything with a digest, ordered by name. A search box that went
 * blank when you cleared it would make the directory unreadable exactly when you wanted to look around.
 */
export function searchDirectory(input: {
  entries: readonly DirectoryEntry[];
  query: string;
  limit?: number;
}): DirectoryEntry[] {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const installable = input.entries.filter((entry) => entry.digest.trim() !== "");
  const query = input.query.trim().toLowerCase();
  if (query === "") {
    return [...installable].sort((a, b) => a.displayName.localeCompare(b.displayName)).slice(0, limit);
  }
  return installable
    .map((entry) => ({ entry, rank: score(entry, query) }))
    .filter((scored) => scored.rank > 0)
    // Ties break on the name so the same query twice gives the same order; a listing that reshuffles looks live
    // when nothing changed.
    .sort((a, b) => b.rank - a.rank || a.entry.displayName.localeCompare(b.entry.displayName))
    .slice(0, limit)
    .map((scored) => scored.entry);
}
