import { useCallback, useEffect, useRef, useState } from "react";

import type { AppearanceResponse, ThemeContrastFailureView, ThemeProtectedFailureView } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";
import { applyAppearance } from "./appearance.ts";
import { useWidgetAppearance } from "./use-widget-appearance.ts";

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

/** Why the page refused what the node sent: the English reason, and the failing pairs when an audit refused it. */
export interface LocalAppearanceProblem {
  message: string;
  contrast?: ThemeContrastFailureView[];
  protected?: ThemeProtectedFailureView[];
}

export interface AppearanceState {
  /** The node's last answer, or `undefined` until it has given one. */
  appearance: AppearanceResponse | undefined;
  /**
   * Why the page is drawing Clark Default although the node sent a theme: the page checks the document again before
   * compiling it, and refuses one the node should not have accepted.
   */
  localProblem: LocalAppearanceProblem | undefined;
  /** Counts answers, so a surface listing themes can re-read when the answer may have changed. */
  generation: number;
  /**
   * Ask the node again and draw its answer. Resolves with what is now drawn, or `undefined` when the node could not
   * answer or a newer read overtook this one - the page is then left as it was.
   */
  refresh: () => Promise<AppearanceRead | undefined>;
}

/** One answer from the node and what the page made of it. */
export interface AppearanceRead {
  appearance: AppearanceResponse;
  localProblem: LocalAppearanceProblem | undefined;
}

interface DesktopAppearanceBridge {
  clarkcant?: { updateAppearance?: (snapshot: unknown) => Promise<unknown> };
}

export function useAppearance(client: GatewayClient): AppearanceState {
  const drawn = useWidgetAppearance();
  useEffect(() => {
    const bridge = (window as unknown as DesktopAppearanceBridge).clarkcant;
    if (drawn === undefined || typeof bridge?.updateAppearance !== "function") return;
    void bridge.updateAppearance(drawn).catch((error: unknown) => {
      console.error("detached appearance could not be relayed", error);
    });
  }, [drawn]);
  const [appearance, setAppearance] = useState<AppearanceResponse | undefined>(undefined);
  const [localProblem, setLocalProblem] = useState<LocalAppearanceProblem | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  // Only the latest request is applied: two refreshes racing must not leave the older answer on screen.
  const latest = useRef(0);

  const refresh = useCallback(async (): Promise<AppearanceRead | undefined> => {
    const ticket = latest.current + 1;
    latest.current = ticket;
    let next: AppearanceResponse;
    try {
      next = await client.appearance();
    } catch {
      return undefined;
    }
    if (ticket !== latest.current) return undefined;
    const applied = applyAppearance({ theme: next.theme, themeRef: next.appliedRef });
    const problem: LocalAppearanceProblem | undefined = applied.ok
      ? undefined
      : {
          message: applied.problem,
          ...(applied.contrast === undefined ? {} : { contrast: applied.contrast }),
          ...(applied.protected === undefined ? {} : { protected: applied.protected }),
        };
    setAppearance(next);
    setLocalProblem(problem);
    setGeneration((count) => count + 1);
    return { appearance: next, localProblem: problem };
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
