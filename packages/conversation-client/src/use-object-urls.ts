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
 * - **A URL is released only when its owner goes away.** Revoking on every dependency change releases URLs
 *   that are still on screen, which is indistinguishable from a corrupt image.
 * - **A late arrival is released, never stored.** A fetch that finishes after its caller stopped caring must
 *   not put a URL into the map, or nothing would ever revoke it.
 *
 * Written once for two callers rather than twice: images and attachments differ only in which route the
 * bytes come from, and the three rules above are the part that must not be got wrong differently in two
 * places.
 */
export function useObjectUrls(
  fetchUrl: (reference: string) => Promise<string>,
  references: readonly string[],
): (reference: string) => string | undefined {
  const urls = useRef(new Map<string, string>());
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

  useEffect(() => {
    if (key === "") return;
    let cancelled = false;
    for (const reference of key.split(",")) {
      if (urls.current.has(reference)) continue;
      void fetchRef
        .current(reference)
        .then((url) => {
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          urls.current.set(reference, url);
          setVersion((current) => current + 1);
        })
        .catch(() => {
          // The renderer shows its own message with the name it has, which is what a reader gets either way
          // — bytes that cannot be fetched are a description, not a blank.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [key]);

  /* Released once, when the component that needed them is gone. */
  useEffect(() => {
    const map = urls.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  // The identity changes when a URL arrives, so a memoised renderer that reads through this closure is
  // rebuilt — the same reason `datasets` is a dependency where a table is rendered.
  return useCallback((reference: string) => urls.current.get(reference), [version]);
}
