import { useCallback, useEffect, useRef, useState } from "react";

import type { GatewayClient } from "./api.ts";

/**
 * Object URLs for a set of imported images, owned in one place.
 *
 * An `<img src="/images/x">` cannot carry the bearer token, so image bytes are fetched through the
 * authenticated client and handed to the DOM as a blob URL. Three rules make that safe, and each of
 * them is a bug this hook exists to prevent:
 *
 * - **One fetch per image, one owner per URL.** Two components fetching the same image each get their
 *   own blob URL, and a component that revokes "its" URL on cleanup can revoke the one another
 *   component is still displaying. That is exactly what happened when the transcript and the pinned
 *   view each managed this themselves: the picture rendered as a figure with a revoked `src`.
 * - **A URL is released only when its owner goes away.** Revoking on every dependency change releases
 *   URLs that are still on screen, which is indistinguishable from a corrupt image.
 * - **A late arrival is released, never stored.** A fetch that finishes after its caller stopped
 *   caring must not put a URL into the map, or nothing would ever revoke it.
 */
export function useImageUrls(
  client: GatewayClient,
  refs: readonly string[],
): (imageRef: string) => string | undefined {
  const urls = useRef(new Map<string, string>());
  // Bumped when a URL lands, purely to re-render the surfaces that ask for one.
  const [version, setVersion] = useState(0);
  const key = refs.filter((ref) => ref !== "").join(",");

  useEffect(() => {
    if (key === "") return;
    let cancelled = false;
    for (const imageRef of key.split(",")) {
      if (urls.current.has(imageRef)) continue;
      void client
        .imageObjectUrl(imageRef)
        .then((url) => {
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          urls.current.set(imageRef, url);
          setVersion((current) => current + 1);
        })
        .catch(() => {
          // The renderer shows its own message with the alt text, which is what a reader gets either
          // way — an image that cannot be fetched is a description, not a blank.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [client, key]);

  /* Released once, when the component that needed them is gone. */
  useEffect(() => {
    const map = urls.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  // The identity changes when a URL arrives, so a memoised renderer that reads through this closure
  // is rebuilt — the same reason `datasets` is a dependency where a table is rendered.
  return useCallback((imageRef: string) => urls.current.get(imageRef), [version]);
}
