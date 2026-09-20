import { useCallback, useEffect, useState } from "react";

import type { GatewayClient } from "./api.ts";
import { prefersReducedMotion } from "./typewriter.ts";
import { resolveOrbProfile, type ResolvedOrbProfile } from "./orb-profile.ts";

/**
 * The personalized orb, resolved from what the node stored.
 *
 * One hook rather than a fetch in each host, because two hosts resolve it — the first-run screen draws the
 * orb before a conversation exists, and the conversation draws it afterwards — and two copies of the
 * reduced-motion rule is exactly how the two would come to disagree about whether motion is on.
 *
 * Three properties:
 *
 *   - **A failure leaves it undefined rather than guessing.** The orb is the product's own face, so a node
 *     that cannot answer for a preference must not be why it is missing; the caller draws the shipped
 *     profile in that case.
 *   - **`refresh` exists because a preference can change while the app is open.** Writing a profile in
 *     settings has to change the orb that is on screen, not the one that appears after a reload.
 *   - **Reduced motion is read from both places.** The platform's setting and the stored preference are each
 *     enough on their own; a preference that could outrank the platform one would make the accessibility
 *     switch a lie.
 */

export interface OrbProfileHandle {
  profile: ResolvedOrbProfile | undefined;
  refresh: () => void;
}

export function useOrbProfile(client: GatewayClient): OrbProfileHandle {
  const [profile, setProfile] = useState<ResolvedOrbProfile | undefined>(undefined);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void client
      .preferences()
      .then((listed) => {
        if (cancelled) return;
        const stored = (key: string) => listed.preferences.find((entry) => entry.key === key)?.value;
        setProfile(
          resolveOrbProfile({
            profile: stored("orb.profile"),
            custom: stored("orb.custom"),
            reducedMotion: stored("experience.motion") === "reduced" || prefersReducedMotion(),
          }),
        );
      })
      .catch(() => {
        // Deliberately left undefined; see the note above.
      });
    return () => {
      cancelled = true;
    };
  }, [client, generation]);

  const refresh = useCallback(() => setGeneration((current) => current + 1), []);

  return { profile, refresh };
}
