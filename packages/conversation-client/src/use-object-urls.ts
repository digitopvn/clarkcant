import { useCallback, useEffect, useRef, useState } from "react";

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
 * Written once for two callers rather than twice: images and attachments differ only in which route the
 * bytes come from, and the three rules above are the part that must not be got wrong differently in two
 * places.
 */
export interface ObjectUrlSet {
  /** The references wanted now: those that left are released, new ones fetched, the rest kept as they are. */
  want: (references: readonly string[]) => void;
  get: (reference: string) => string | undefined;
  /** Releases every URL; a request still in flight is released when it arrives. */
  release: () => void;
}

/** The bookkeeping behind `useObjectUrls`, without React, so what it fetches and releases can be counted. */
export function createObjectUrlSet(input: {
  fetchUrl: (reference: string) => Promise<string>;
  revoke: (url: string) => void;
  onChange: () => void;
}): ObjectUrlSet {
  const urls = new Map<string, string>();
  const inFlight = new Set<string>();
  let wanted = new Set<string>();
  return {
    want: (references) => {
      wanted = new Set(references.filter((reference) => reference !== ""));
      for (const [reference, url] of urls) {
        if (wanted.has(reference)) continue;
        input.revoke(url);
        urls.delete(reference);
      }
      for (const reference of wanted) {
        if (urls.has(reference) || inFlight.has(reference)) continue;
        inFlight.add(reference);
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
          });
      }
    },
    get: (reference) => urls.get(reference),
    release: () => {
      wanted = new Set();
      for (const url of urls.values()) input.revoke(url);
      urls.clear();
    },
  };
}

export function useObjectUrls(
  fetchUrl: (reference: string) => Promise<string>,
  references: readonly string[],
): (reference: string) => string | undefined {
  // Bumped when a URL lands, purely to re-render the surfaces that ask for one.
  const [version, setVersion] = useState(0);
  const key = references.filter((reference) => reference !== "").join(",");
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

  useEffect(() => set.want(key === "" ? [] : key.split(",")), [key, set]);

  /* Released once, when the component that needed them is gone. */
  useEffect(() => () => set.release(), [set]);

  // The identity changes when a URL arrives, so a memoised renderer that reads through this closure is
  // rebuilt - the same reason `datasets` is a dependency where a table is rendered.
  return useCallback((reference: string) => set.get(reference), [set, version]);
}
