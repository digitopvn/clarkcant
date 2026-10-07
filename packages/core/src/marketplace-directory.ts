import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  readDirectoryCandidates,
  type DirectoryIndexState,
  type DirectoryOrigin,
  type DirectorySourceStatus,
} from "./directory-index.ts";

/**
 * A directory served over HTTP: the official ClarkCant Marketplace, or a marketplace/catalog the person configured.
 *
 * The feed is the same thing a local index file is — a list of `directoryEntrySchema` entries — served at one URL,
 * optionally in pages:
 *
 *     GET <feed url>                → { "format": "clarkcant-directory@1", "entries": [...], "nextCursor": "…" | null }
 *     GET <feed url>?cursor=<next>  → the next page
 *
 * A bare JSON array (a static file on any HTTPS host) is accepted as a one-page feed, so an organisation can publish
 * a private catalog without running a service. Every entry is read with the same `readDirectoryCandidates` a file is:
 * a feed is never more trusted than a file, and a listing is a pointer the install path re-resolves and digest-checks.
 *
 * What this module promises:
 *
 * - **Bounded.** One refresh has a wall-clock timeout, a byte cap per page, a page cap and an entry cap. A feed past a
 *   cap is refused whole rather than half-loaded, because a directory that half-loads shows a subset as the answer.
 * - **Honest about staleness.** The last good copy is kept on disk with the time it was fetched. A failed refresh
 *   keeps listing that copy as `stale`, with the reason; a source that was never fetched is `not-fetched`, and one
 *   that could not be reached with no earlier copy is `unreachable` — never an empty list that reads as "nothing found".
 * - **Sends nothing.** No credentials, cookies or identifying headers: an address carrying a username or password is
 *   refused, and redirects are not followed, so a feed cannot bounce the request somewhere the person did not name.
 * - **Never local.** A remote listing that names a path on this machine is refused: a feed must not be able to point
 *   the installer at the person's own files. The official Marketplace lists npm packages only, because npm is the
 *   distribution channel it indexes.
 */

/** The official Marketplace's directory feed. */
export const OFFICIAL_MARKETPLACE_FEED_URL = "https://marketplace.clarkcant.cc/api/v1/directory";
/** The feed format this node reads. A feed naming another format is refused rather than guessed at. */
export const DIRECTORY_FEED_FORMAT = "clarkcant-directory@1";

const CACHE_FORMAT = "clarkcant-directory-cache@1";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_ENTRIES = 5_000;
const CURSOR_MAX = 200;

/** The limits one refresh runs within. Tests narrow them; the defaults suit a public marketplace of this size. */
export interface FeedLimits {
  timeoutMs: number;
  maxPageBytes: number;
  maxPages: number;
  maxEntries: number;
}

export const DEFAULT_FEED_LIMITS: FeedLimits = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxPageBytes: DEFAULT_MAX_PAGE_BYTES,
  maxPages: DEFAULT_MAX_PAGES,
  maxEntries: DEFAULT_MAX_ENTRIES,
};

/** Why a refresh did not produce a copy. Each maps onto a named source state. */
export type FeedFailure = "unreachable" | "unsupported" | "unreadable";

export type FeedFetchResult = { ok: true; candidates: unknown[] } | { ok: false; failure: FeedFailure; reason: string };

/** The `fetch` this module calls. The global one in production; a fake in tests. */
export type FeedFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Whether `raw` is an address this node will fetch a feed from: HTTPS, or HTTP to this machine's loopback for a local
 * catalog or a test, and never one carrying credentials (they would be sent with every request) or a fragment.
 */
export function feedUrlProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `${redactedAddress(raw)} is not a URL`;
  }
  if (url.username !== "" || url.password !== "") return "a directory address must not carry a username or password";
  if (url.hash !== "") return "a directory address must not carry a #fragment";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
  return "a directory address must use https (plain http is allowed only to this machine)";
}

/**
 * An address as it may be shown, also when it does not parse as a URL: everything from the first `?` or `#` is cut, and
 * anything up to the last `@` before that (a username, a password) is dropped, so a token in the query or the userinfo
 * is never echoed into a message, a label or a card. An address with nothing left to show is named as such.
 */
export function redactedAddress(raw: string): string {
  const end = raw.search(/[?#]/u);
  const withoutQuery = end === -1 ? raw : raw.slice(0, end);
  const at = withoutQuery.lastIndexOf("@");
  const shown = at === -1 ? withoutQuery : withoutQuery.slice(at + 1);
  return shown === "" ? "an address with no host" : shown;
}

/**
 * The name a person recognises for a custom feed: its host and path, without a query or userinfo that may carry anything.
 * An address with no host (it does not parse, or `user:token@host/feed` parsed as a `user:` scheme) is redacted as text.
 */
export function feedLabel(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.host !== "") return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    // Named as text below.
  }
  return redactedAddress(raw);
}

/** A stable id for a custom feed, so its cached copy is found again and never confused with another feed's. */
export function customFeedId(url: string): string {
  return `custom-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) {
    // undici reports a refused/unresolved address as "fetch failed" with the useful part in `cause`.
    const inner = (cause as Error & { cause?: unknown }).cause;
    return inner instanceof Error && inner.message !== "" ? `${cause.message}: ${inner.message}` : cause.message;
  }
  return String(cause);
}

/** Read at most `maxBytes` of a body, refusing rather than truncating a longer one. */
async function readBounded(response: Response, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false };
  if (response.body === null) return { ok: true, text: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * Fetch every page of a feed, within `limits`. Never throws: every failure is a named result.
 */
export async function fetchDirectoryFeed(
  feedUrl: string,
  options: { fetch: FeedFetch; limits?: Partial<FeedLimits> },
): Promise<FeedFetchResult> {
  const limits = { ...DEFAULT_FEED_LIMITS, ...options.limits };
  const problem = feedUrlProblem(feedUrl);
  if (problem !== undefined) return { ok: false, failure: "unreadable", reason: problem };
  const label = feedLabel(feedUrl);
  const signal = AbortSignal.timeout(limits.timeoutMs);
  const candidates: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= limits.maxPages) {
      return { ok: false, failure: "unreadable", reason: `${label} has more than ${String(limits.maxPages)} pages of listings` };
    }
    const url = new URL(feedUrl);
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    let response: Response;
    try {
      response = await options.fetch(url.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal,
      });
    } catch (cause) {
      const reason = signal.aborted
        ? `${label} did not answer within ${String(Math.round(limits.timeoutMs / 1000))} s`
        : `could not reach ${label}: ${errorText(cause)}`;
      return { ok: false, failure: "unreachable", reason };
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        failure: "unsupported",
        reason: `${label} answered HTTP ${String(response.status)}: it does not serve a ClarkCant directory feed`,
      };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, failure: "unreachable", reason: `${label} answered HTTP ${String(response.status)}` };
    }
    let body: { ok: true; text: string } | { ok: false };
    try {
      body = await readBounded(response, limits.maxPageBytes);
    } catch (cause) {
      const reason = signal.aborted
        ? `${label} did not finish answering within ${String(Math.round(limits.timeoutMs / 1000))} s`
        : `the answer from ${label} broke off: ${errorText(cause)}`;
      return { ok: false, failure: "unreachable", reason };
    }
    if (!body.ok) {
      return { ok: false, failure: "unreadable", reason: `a page from ${label} is larger than ${String(limits.maxPageBytes)} bytes` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return { ok: false, failure: "unreadable", reason: `${label} did not answer with JSON` };
    }
    const read = readFeedPage(parsed);
    if (!read.ok) return { ok: false, failure: "unreadable", reason: `${label}: ${read.reason}` };
    candidates.push(...read.entries);
    if (candidates.length > limits.maxEntries) {
      return { ok: false, failure: "unreadable", reason: `${label} lists more than ${String(limits.maxEntries)} entries` };
    }
    if (read.nextCursor === undefined) return { ok: true, candidates };
    cursor = read.nextCursor;
  }
}

/** One page of a feed: a bare array, or the paged object. */
function readFeedPage(
  parsed: unknown,
): { ok: true; entries: unknown[]; nextCursor: string | undefined } | { ok: false; reason: string } {
  if (Array.isArray(parsed)) return { ok: true, entries: parsed, nextCursor: undefined };
  if (typeof parsed !== "object" || parsed === null) return { ok: false, reason: "the feed is not a directory" };
  const page = parsed as { format?: unknown; entries?: unknown; nextCursor?: unknown };
  if (page.format !== undefined && page.format !== DIRECTORY_FEED_FORMAT) {
    return { ok: false, reason: `the feed is in a format this Clark does not read (${String(page.format).slice(0, 60)})` };
  }
  if (!Array.isArray(page.entries)) return { ok: false, reason: "the feed has no entries list" };
  if (page.nextCursor === undefined || page.nextCursor === null) return { ok: true, entries: page.entries, nextCursor: undefined };
  if (typeof page.nextCursor !== "string" || page.nextCursor === "" || page.nextCursor.length > CURSOR_MAX) {
    return { ok: false, reason: "the feed's next-page cursor is malformed" };
  }
  return { ok: true, entries: page.entries, nextCursor: page.nextCursor };
}

/** What a remote source may list: never a path on this machine, and for the official Marketplace npm packages only. */
function sourceRuleProblem(state: DirectoryIndexState, origin: DirectoryOrigin): string | undefined {
  if (state.kind !== "configured") return undefined;
  for (const entry of state.entries) {
    if (entry.source.kind === "local") {
      return `${entry.packageId}@${entry.version} is listed by a path on this machine, which a remote directory cannot list`;
    }
    if (origin.kind === "official-marketplace" && entry.source.kind !== "npm") {
      return `${entry.packageId}@${entry.version} is not an npm package, and the Marketplace lists npm packages only`;
    }
  }
  return undefined;
}

/** Read fetched candidates as a directory, with the remote source rules on top of the file rules. */
export function readFeedCandidates(origin: DirectoryOrigin, candidates: unknown): DirectoryIndexState {
  const state = readDirectoryCandidates(origin.label, candidates);
  const problem = sourceRuleProblem(state, origin);
  return problem === undefined ? state : { kind: "unreadable", directory: origin.label, reason: problem };
}

/* ------------------------------------------------------------------ *
 * The copy kept on disk
 * ------------------------------------------------------------------ */

interface FeedCache {
  format: typeof CACHE_FORMAT;
  feedUrl: string;
  /** When `entries` was fetched; null when no fetch has succeeded yet. */
  fetchedAt: string | null;
  /** The candidates as the feed served them, re-read on every load so the cache is never more trusted than the feed. */
  entries: unknown[] | null;
  lastAttempt: { at: string; outcome: "ok" | FeedFailure; reason?: string };
}

export function feedCachePath(cacheDir: string, origin: DirectoryOrigin): string {
  return join(cacheDir, `${origin.id}.json`);
}

function loadCache(path: string, feedUrl: string): FeedCache | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const cache = parsed as Partial<FeedCache>;
  if (cache.format !== CACHE_FORMAT || cache.feedUrl !== feedUrl) return undefined;
  if (typeof cache.lastAttempt !== "object" || cache.lastAttempt === null || typeof cache.lastAttempt.at !== "string") return undefined;
  if (!(cache.entries === null || Array.isArray(cache.entries))) return undefined;
  if (!(cache.fetchedAt === null || typeof cache.fetchedAt === "string")) return undefined;
  return cache as FeedCache;
}

function saveCache(path: string, cache: FeedCache): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.${String(process.pid)}.${Date.now().toString(36)}.tmp`;
  writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
  renameSync(temp, path);
}

/** The last read of each cache file, reused while the file is unchanged: readers call this on every request. */
const readMemo = new Map<string, { mtimeMs: number; size: number; read: RemoteSourceRead }>();

export interface RemoteSourceRead {
  status: DirectorySourceStatus;
  state: DirectoryIndexState;
}

function failedRead(origin: DirectoryOrigin, state: DirectorySourceStatus["state"], reason: string): RemoteSourceRead {
  return {
    status: { origin, state, entryCount: 0, reason },
    state: { kind: "unreadable", directory: origin.label, reason },
  };
}

/** What a remote source lists now, from its copy on disk. No network. */
export function readRemoteSource(origin: DirectoryOrigin, feedUrl: string, cacheDir: string): RemoteSourceRead {
  const path = feedCachePath(cacheDir, origin);
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(path);
  } catch {
    return notFetched(origin);
  }
  const memo = readMemo.get(path);
  if (memo !== undefined && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) return memo.read;
  const read = readCacheFile(origin, feedUrl, path);
  readMemo.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, read });
  return read;
}

function notFetched(origin: DirectoryOrigin): RemoteSourceRead {
  const reason = `${origin.label} has not been fetched on this node yet`;
  return { status: { origin, state: "not-fetched", entryCount: 0, reason }, state: { kind: "unreadable", directory: origin.label, reason } };
}

function readCacheFile(origin: DirectoryOrigin, feedUrl: string, path: string): RemoteSourceRead {
  const cache = loadCache(path, feedUrl);
  if (cache === undefined) return notFetched(origin);
  const attempt = cache.lastAttempt;
  if (cache.entries === null) {
    const reason = attempt.reason ?? `${origin.label} could not be read`;
    return failedRead(origin, attempt.outcome === "ok" ? "unreadable" : attempt.outcome, reason);
  }
  const state = readFeedCandidates(origin, cache.entries);
  if (state.kind !== "configured") return failedRead(origin, "unreadable", state.kind === "unreadable" ? state.reason : "");
  const fetchedAt = cache.fetchedAt ?? attempt.at;
  const status: DirectorySourceStatus =
    attempt.outcome === "ok"
      ? { origin, state: "ready", entryCount: state.entries.length, fetchedAt }
      : {
          origin,
          state: "stale",
          entryCount: state.entries.length,
          fetchedAt,
          reason: `${attempt.reason ?? `${origin.label} could not be refreshed`}; listing the copy fetched at ${fetchedAt}`,
        };
  return { status, state };
}

export interface FeedRefreshOptions {
  fetch?: FeedFetch;
  now?: () => Date;
  /** A successful copy younger than this is not fetched again. Default 15 minutes. */
  maxAgeMs?: number;
  /** A failed attempt younger than this is not retried, so a down marketplace is not hammered. Default 30 seconds. */
  retryAfterMs?: number;
  /** Only refresh a source this node fetched before (a background check never makes the first contact). */
  onlyIfCached?: boolean;
  limits?: Partial<FeedLimits>;
}

export const DEFAULT_FEED_MAX_AGE_MS = 15 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 30_000;

/** One refresh per cache file at a time: concurrent callers share it rather than fetching twice. */
const inFlight = new Map<string, Promise<void>>();

/**
 * Fetch a fresh copy of a remote source when it is due, and record the outcome. Never throws: a failure is recorded
 * as the source's state, and the previous copy (if any) is kept and listed as stale.
 */
export function refreshRemoteSource(
  origin: DirectoryOrigin,
  feedUrl: string,
  cacheDir: string,
  options: FeedRefreshOptions = {},
): Promise<void> {
  const path = feedCachePath(cacheDir, origin);
  const running = inFlight.get(path);
  if (running !== undefined) return running;
  const work = runRefresh(origin, feedUrl, path, options).finally(() => inFlight.delete(path));
  inFlight.set(path, work);
  return work;
}

async function runRefresh(origin: DirectoryOrigin, feedUrl: string, path: string, options: FeedRefreshOptions): Promise<void> {
  const now = options.now ?? (() => new Date());
  const cache = loadCache(path, feedUrl);
  if (cache === undefined && options.onlyIfCached === true) return;
  if (cache !== undefined) {
    const age = now().getTime() - Date.parse(cache.lastAttempt.at);
    const due =
      cache.lastAttempt.outcome === "ok"
        ? (options.maxAgeMs ?? DEFAULT_FEED_MAX_AGE_MS)
        : (options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
    if (Number.isFinite(age) && age >= 0 && age < due) return;
  }
  const fetcher = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const fetched = await fetchDirectoryFeed(feedUrl, { fetch: fetcher, ...(options.limits === undefined ? {} : { limits: options.limits }) });
  const at = now().toISOString();
  let next: FeedCache;
  if (fetched.ok) {
    const state = readFeedCandidates(origin, fetched.candidates);
    next =
      state.kind === "configured"
        ? { format: CACHE_FORMAT, feedUrl, fetchedAt: at, entries: fetched.candidates, lastAttempt: { at, outcome: "ok" } }
        : {
            format: CACHE_FORMAT,
            feedUrl,
            fetchedAt: cache?.fetchedAt ?? null,
            entries: cache?.entries ?? null,
            lastAttempt: { at, outcome: "unreadable", reason: state.kind === "unreadable" ? state.reason : "" },
          };
  } else {
    next = {
      format: CACHE_FORMAT,
      feedUrl,
      fetchedAt: cache?.fetchedAt ?? null,
      entries: cache?.entries ?? null,
      lastAttempt: { at, outcome: fetched.failure, reason: fetched.reason },
    };
  }
  try {
    saveCache(path, next);
  } catch (cause) {
    // The node's own data folder could not be written: the source keeps its previous state, and the reason is logged.
    process.stderr.write(`directory: could not keep the copy of ${origin.label}: ${errorText(cause)}\n`);
  }
}
