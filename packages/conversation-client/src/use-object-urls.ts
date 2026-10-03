import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Object URLs for a set of node-owned bytes, owned in one place.
 *
 * An `<img src="/images/x">` and an `<img src="/attachments/x/content">` both cannot carry the bearer
 * token, so the bytes are fetched through the authenticated client and handed to the DOM as a blob URL.
 * Three rules make that safe, and each of them is a bug this hook exists to prevent:
 *
 * - **One fetch per reference, one owner per URL.** Two components fetching the same bytes each get their
 *   own blob URL, and a component that revokes "its" URL on cleanup can revoke the one another component is
 *   still displaying. That is exactly what happened when the transcript and the pinned view each managed
 *   this themselves: the picture rendered as a figure with a revoked `src`.
 * - **A URL is released only when it is no longer wanted.** When the set changes, the references still in it
 *   keep their URL and their request in flight; only a reference that left the set is released, and only a
 *   new one is fetched. Revoking everything on each change released URLs still on screen, and cancelling
 *   every request in flight fetched the same bytes again for each change - up to a whole gallery's worth
 *   each time a composed surface arrived. Everything left is released when the owner goes away.
 * - **A late arrival is released, never stored.** A fetch that finishes after its reference stopped being
 *   wanted must not put a URL into the map, or nothing would ever revoke it.
 *
 * Written once for every caller rather than once each: pictures, players and attachments differ only in which
 * route the bytes come from and when they are wanted, and the three rules above are the part that must not be got
 * wrong differently in several places.
 *
 * **Read now, or read on request.** A picture is read as soon as it is listed: it is what the reader sees. A player's
 * bytes are listed *on request*: the reference is known, but nothing is fetched until something asks for it with
 * `request` - the player coming near the screen, or the person pressing play. A conversation with several long
 * recordings therefore reads none of them until one is about to be seen. An attached file's bytes are listed the same
 * way and asked for only when the person downloads it. A reference read on request is wanted, for
 * the three rules above, from the moment it is requested until it leaves the list; leaving the list forgets the
 * request, so a reference that comes back is read only when it is asked for again.
 */
export interface ObjectUrlSet {
  /**
   * The references wanted now: those that left are released, new ones fetched, the rest kept as they are.
   *
   * `onRequest` lists the references that may be read but are not read until `request` names them. A reference in
   * both lists is read now.
   */
  want: (references: readonly string[], onRequest?: readonly string[]) => void;
  get: (reference: string) => string | undefined;
  /** Where one reference is: see `ObjectUrlStatus`. */
  status: (reference: string) => ObjectUrlStatus;
  /**
   * Ask for a reference listed on request. Asking again, or for one already read, changes nothing. A request for a
   * reference not listed yet is kept, and read when the list names it.
   */
  request: (reference: string) => void;
  /**
   * Read again a reference listed on request whose read failed, because the person asked to try again. Nothing else
   * reads a refused reference again (see `failed` in `ObjectUrlStatus`), so this is the one way back without the
   * reference leaving the list. A reference that did not fail, or is not listed on request, is left as it is.
   */
  retry: (reference: string) => void;
  /** Releases every URL and forgets every request; a request still in flight is released when it arrives. */
  release: () => void;
}

/**
 * Where one reference is.
 *
 * - `ready`: its URL can be drawn.
 * - `loading`: its bytes are being read.
 * - `idle`: listed on request and not asked for yet.
 * - `failed`: its bytes could not be read. A reference read on request is not read again until it leaves the list
 *   and comes back, or the person asks again through `retry`; one read now is tried again the next time the list
 *   changes, as it always was.
 * - `unlisted`: nobody listed it, so nothing will be read.
 */
export type ObjectUrlStatus = "ready" | "loading" | "idle" | "failed" | "unlisted";

/** The bookkeeping behind `useObjectUrls`, without React, so what it fetches and releases can be counted. */
export function createObjectUrlSet(input: {
  fetchUrl: (reference: string) => Promise<string>;
  revoke: (url: string) => void;
  onChange: () => void;
}): ObjectUrlSet {
  const urls = new Map<string, string>();
  const inFlight = new Set<string>();
  const failed = new Set<string>();
  const requested = new Set<string>();
  let now = new Set<string>();
  let onRequest = new Set<string>();
  let wanted = new Set<string>();

  const fetchOne = (reference: string): void => {
    if (urls.has(reference) || inFlight.has(reference)) return;
    inFlight.add(reference);
    failed.delete(reference);
    void input
      .fetchUrl(reference)
      .then((url) => {
        inFlight.delete(reference);
        if (!wanted.has(reference)) {
          input.revoke(url);
          return;
        }
        urls.set(reference, url);
        input.onChange();
      })
      .catch(() => {
        // The renderer shows its own message with the name it has, which is what a reader gets either way
        // - bytes that cannot be fetched are a description, not a blank.
        inFlight.delete(reference);
        if (!wanted.has(reference)) return;
        failed.add(reference);
        input.onChange();
      });
  };

  /** Re-derive what is wanted, release what is not, and fetch what is wanted and missing. */
  const settle = (): void => {
    wanted = new Set(now);
    for (const reference of onRequest) if (requested.has(reference)) wanted.add(reference);
    for (const [reference, url] of urls) {
      if (wanted.has(reference)) continue;
      input.revoke(url);
      urls.delete(reference);
    }
    for (const reference of failed) if (!now.has(reference) && !onRequest.has(reference)) failed.delete(reference);
    for (const reference of wanted) {
      // A reference read on request that failed stays failed: asking the node again on every render would be a
      // request loop for bytes it already refused.
      if (failed.has(reference) && !now.has(reference)) continue;
      fetchOne(reference);
    }
  };

  return {
    want: (references, lazy = []) => {
      now = new Set(references.filter((reference) => reference !== ""));
      onRequest = new Set(lazy.filter((reference) => reference !== "" && !now.has(reference)));
      // A request outlives a change of list only while the reference is still listed on request.
      for (const reference of requested) if (!onRequest.has(reference) && !now.has(reference)) requested.delete(reference);
      settle();
    },
    get: (reference) => urls.get(reference),
    status: (reference) => {
      if (urls.has(reference)) return "ready";
      if (inFlight.has(reference) && wanted.has(reference)) return "loading";
      if (failed.has(reference)) return "failed";
      if (onRequest.has(reference)) return "idle";
      return now.has(reference) ? "loading" : "unlisted";
    },
    request: (reference) => {
      if (reference === "" || requested.has(reference)) return;
      requested.add(reference);
      if (!onRequest.has(reference)) return;
      // Only the reference asked for: a picture that failed is tried again when the list changes, not because a player
      // came near the screen.
      wanted.add(reference);
      fetchOne(reference);
      input.onChange();
    },
    retry: (reference) => {
      if (!failed.has(reference) || !onRequest.has(reference)) return;
      requested.add(reference);
      wanted.add(reference);
      fetchOne(reference);
      input.onChange();
    },
    release: () => {
      now = new Set();
      onRequest = new Set();
      wanted = new Set();
      requested.clear();
      failed.clear();
      for (const url of urls.values()) input.revoke(url);
      urls.clear();
    },
  };
}

/** What a set of object URLs answers for the surfaces that draw them. */
export interface ObjectUrls {
  get: (reference: string) => string | undefined;
  status: (reference: string) => ObjectUrlStatus;
  request: (reference: string) => void;
  retry: (reference: string) => void;
}

export function useObjectUrls(
  fetchUrl: (reference: string) => Promise<string>,
  references: readonly string[],
): (reference: string) => string | undefined {
  return useObjectUrlSet(fetchUrl, references, []).get;
}

/**
 * Object URLs for references read now and references read on request (see `ObjectUrlSet`).
 *
 * The answer's identity changes whenever a URL lands or a reference changes state, so a memoised renderer that reads
 * through it is rebuilt.
 */
export function useObjectUrlSet(
  fetchUrl: (reference: string) => Promise<string>,
  references: readonly string[],
  onRequest: readonly string[],
): ObjectUrls {
  // Bumped when a URL lands, purely to re-render the surfaces that ask for one.
  const [version, setVersion] = useState(0);
  const key = references.filter((reference) => reference !== "").join(",");
  const lazyKey = onRequest.filter((reference) => reference !== "").join(",");
  /**
   * The fetcher, read at call time.
   *
   * Held in a ref because it is a fresh closure on every render: depending on it directly would re-fetch
   * every reference on every render, and the caller passing a stable function is not something this hook can
   * require without making every call site memorise one.
   */
  const fetchRef = useRef(fetchUrl);
  fetchRef.current = fetchUrl;
  const [set] = useState(() =>
    createObjectUrlSet({
      fetchUrl: (reference) => fetchRef.current(reference),
      revoke: (url) => URL.revokeObjectURL(url),
      onChange: () => setVersion((current) => current + 1),
    }),
  );

  useEffect(() => set.want(key === "" ? [] : key.split(","), lazyKey === "" ? [] : lazyKey.split(",")), [key, lazyKey, set]);

  /* Released once, when the component that needed them is gone. */
  useEffect(() => () => set.release(), [set]);

  // The identity changes when a URL arrives, so a memoised renderer that reads through this closure is
  // rebuilt - the same reason `datasets` is a dependency where a table is rendered.
  const get = useCallback((reference: string) => set.get(reference), [set, version]);
  const status = useCallback(
    (reference: string): ObjectUrlStatus => {
      const known = set.status(reference);
      if (known !== "unlisted") return known;
      // Listed in this render but not yet handed to the set, which happens in an effect after it: say what the
      // reference is about to be rather than "unlisted", so a player does not flash its unavailable message first.
      if (key !== "" && key.split(",").includes(reference)) return "loading";
      if (lazyKey !== "" && lazyKey.split(",").includes(reference)) return "idle";
      return "unlisted";
    },
    [key, lazyKey, set, version],
  );
  const request = useCallback((reference: string) => set.request(reference), [set]);
  const retry = useCallback((reference: string) => set.retry(reference), [set]);
  return useMemo(() => ({ get, status, request, retry }), [get, status, request, retry]);
}
