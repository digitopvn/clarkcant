import { useCallback, useEffect, useRef, useState } from "react";

import type { AppearanceResponse } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";
import { applyAppearance } from "./appearance.ts";

/**
 * The theme the node says to draw, kept applied to the page.
 *
 * Asked for when the conversation mounts, after this client changes a package, when the person picks a theme, and when
 * the window comes back into view. The last one is there because the node does not push package changes: a package
 * removed from another device, or by Clark from the conversation, reaches this page the next time it is looked at.
 *
 * A node that cannot be reached leaves the page as it is. Redrawing Clark Default because a request failed would
 * change what a person sees for a reason that has nothing to do with their theme.
 */

export interface AppearanceState {
  /** The node's last answer, or `undefined` until it has given one. */
  appearance: AppearanceResponse | undefined;
  /**
   * Why the page is drawing Clark Default although the node sent a theme: the page checks the document again before
   * compiling it, and refuses one the node should not have accepted.
   */
  localProblem: string | undefined;
  /** Counts answers, so a surface listing themes can re-read when the answer may have changed. */
  generation: number;
  refresh: () => Promise<void>;
}

export function useAppearance(client: GatewayClient): AppearanceState {
  const [appearance, setAppearance] = useState<AppearanceResponse | undefined>(undefined);
  const [localProblem, setLocalProblem] = useState<string | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  // Only the latest request is applied: two refreshes racing must not leave the older answer on screen.
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = latest.current + 1;
    latest.current = ticket;
    let next: AppearanceResponse;
    try {
      next = await client.appearance();
    } catch {
      return;
    }
    if (ticket !== latest.current) return;
    const applied = applyAppearance({ theme: next.theme, themeRef: next.appliedRef });
    setAppearance(next);
    setLocalProblem(applied.ok ? undefined : applied.problem);
    setGeneration((count) => count + 1);
  }, [client]);

  useEffect(() => {
    void refresh();
    const stopPackages = client.onPackagesChanged(() => void refresh());
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopPackages();
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, refresh]);

  return { appearance, localProblem, generation, refresh };
}
