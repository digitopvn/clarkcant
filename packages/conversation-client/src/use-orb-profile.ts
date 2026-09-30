import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { ORB_PROFILE_LABELS, type OrbProfileName, type ThemeOrb } from "@clarkcant/contracts";

import type { GatewayClient } from "./api.ts";
import { readThemeOrb, subscribeToThemeOrb } from "./appearance.ts";
import type { MessageKey } from "./i18n/messages.ts";
import { prefersReducedMotion, usePlatformReducedMotion } from "./typewriter.ts";
import { resolveOrbProfile, type ResolvedOrbProfile } from "./orb-profile.ts";

/**
 * The personalized orb, resolved from what the node stored.
 *
 * One hook rather than a fetch in each host, because two hosts resolve it — the first-run screen draws the
 * orb before a conversation exists, and the conversation draws it afterwards — and two copies of the
 * reduced-motion rule is exactly how the two would come to disagree about whether motion is on.
 *
 * Five properties:
 *
 *   - **The person's choice, then the theme's, then Clark's.** A profile never chosen is read as no choice, so the
 *     drawn theme's Orb default applies until the person picks one; reduced motion still wins over both.
 *   - **A failed first read leaves it undefined rather than guessing.** The orb is the product's own face, so a
 *     node that cannot answer for a preference must not be why it is missing; the caller draws the shipped
 *     profile in that case.
 *   - **`refresh` exists because a preference can change while the app is open.** Writing a profile in settings,
 *     or asking Clark for one, has to change the orb that is on screen, not the one that appears after a reload.
 *   - **`refresh` answers with what is now drawn, or fails.** A caller that says "the orb is now Plasma" has to be
 *     able to know that it is; a read that failed keeps the previous profile and rejects, so the caller can say so.
 *   - **Reduced motion is read from both places, live.** The platform's setting and the stored preference are each
 *     enough on their own, and the platform's is followed as it is switched on and off again. The stored one also
 *     marks the page (see `markReducedMotion`), so it stills the theme's durations and the pointer light too, not
 *     only the Orb.
 */

export interface OrbProfileHandle {
  profile: ResolvedOrbProfile | undefined;
  /**
   * Re-read the stored preferences and draw them. Resolves with the profile now on screen; rejects when the node
   * could not answer, in which case the previous profile is still the one drawn.
   */
  refresh: () => Promise<ResolvedOrbProfile>;
}

/**
 * The three stored values the orb is resolved from, kept raw so the platform switch can be re-applied to them.
 * `profile` is `undefined` while the person has never chosen one, which is when the theme's default applies.
 */
interface StoredOrb {
  profile: unknown;
  custom: unknown;
  motion: unknown;
}

function resolveStored(stored: StoredOrb, theme: ThemeOrb | undefined, platformReducedMotion: boolean): ResolvedOrbProfile {
  return resolveOrbProfile({
    profile: stored.profile,
    custom: stored.custom,
    theme,
    reducedMotion: stored.motion === "reduced" || platformReducedMotion,
  });
}

/**
 * Mark the page with the person's own Reduced motion setting, so it stops what the operating system's setting stops.
 *
 * The body rather than the root element: a theme's scheme block sits on `:root[data-cc-theme]`, which outranks a
 * bare attribute rule on the same element, so a mark on the root would leave the theme's durations in force. On the
 * body the token sheet's `[data-cc-reduced-motion="true"]` block declares the reduced durations for everything
 * inside it, whatever the root inherits from the theme, and the page's own reduced-motion rules match the same mark.
 */
export function markReducedMotion(target: HTMLElement, reduced: boolean): void {
  if (reduced) target.dataset.ccReducedMotion = "true";
  else delete target.dataset.ccReducedMotion;
}

export function useOrbProfile(client: GatewayClient): OrbProfileHandle {
  const [stored, setStored] = useState<StoredOrb | undefined>(undefined);
  const platformReducedMotion = usePlatformReducedMotion();
  /** The drawn theme's Orb suggestion, followed as the theme changes; see `readThemeOrb`. */
  const themeOrb = useSyncExternalStore(subscribeToThemeOrb, readThemeOrb, () => undefined);
  /*
   * Which read was asked for last. Two reads can be in flight — the first load and a refresh after a write — and the
   * older one answering second would put back the value the write replaced.
   */
  const latestRead = useRef(0);

  const read = useCallback(async (): Promise<StoredOrb> => {
    latestRead.current += 1;
    const ticket = latestRead.current;
    const listed = await client.preferences();
    const value = (key: string): unknown => listed.preferences.find((entry) => entry.key === key)?.value;
    // A profile nobody chose is reported as its default value; it is read as "no choice", so a theme's Orb can apply.
    const chosen = listed.preferences.find((entry) => entry.key === "orb.profile");
    const next: StoredOrb = {
      profile: chosen === undefined || chosen.isDefault ? undefined : chosen.value,
      custom: value("orb.custom"),
      motion: value("experience.motion"),
    };
    if (ticket === latestRead.current) setStored(next);
    return next;
  }, [client]);

  useEffect(() => {
    read().catch(() => {
      // Deliberately left undefined; see the note above. A later refresh reads again.
    });
  }, [read]);

  const profile = useMemo(
    () => (stored === undefined ? undefined : resolveStored(stored, themeOrb, platformReducedMotion)),
    [stored, themeOrb, platformReducedMotion],
  );

  const settingReduced = stored?.motion === "reduced";
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    markReducedMotion(document.body, settingReduced);
    return () => markReducedMotion(document.body, false);
  }, [settingReduced]);

  const refresh = useCallback(async (): Promise<ResolvedOrbProfile> => {
    const next = await read();
    return resolveStored(next, readThemeOrb(), prefersReducedMotion());
  }, [read]);

  return { profile, refresh };
}

export interface OrbSelection {
  /** Store the style: the same preference write the Settings control makes. */
  write: (profile: OrbProfileName) => Promise<unknown>;
  /** Re-read and draw it, answering with what is now on screen. */
  refresh: () => Promise<ResolvedOrbProfile>;
  t: (key: MessageKey) => string;
}

/**
 * Switch the orb to a style, and answer only with what the screen now shows.
 *
 * The sentence is what the agent tells the person, so "done" waits for the refresh to answer with the style now
 * drawn. A write the node refused rejects with the node's reason. A read-back that failed, or one that shows a
 * different style, also rejects: the style is saved and the sentence says so, but the orb is still the old one,
 * and saying it changed would be untrue on screen.
 */
export async function selectOrbProfileShown(profile: OrbProfileName, selection: OrbSelection): Promise<string> {
  const name = ORB_PROFILE_LABELS[profile];
  await selection.write(profile);
  let shown: ResolvedOrbProfile;
  try {
    shown = await selection.refresh();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(selection.t("shell.intent.orbSavedNotShown").replace("{name}", name).replace("{reason}", reason), {
      cause,
    });
  }
  if (shown.name !== profile) {
    throw new Error(
      selection
        .t("shell.intent.orbShowsOther")
        .replace("{name}", name)
        .replace("{shown}", ORB_PROFILE_LABELS[shown.name]),
    );
  }
  return selection.t("shell.intent.orbChanged").replace("{name}", name);
}
