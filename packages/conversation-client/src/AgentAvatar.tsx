import { createContext, type ReactElement, type ReactNode, useContext, useMemo, useSyncExternalStore } from "react";

import { readCanvasColor } from "./Orb.tsx";
import { orbPaletteGradient, type ResolvedOrbProfile } from "./orb-profile.ts";
import { orbOptionsFromProfile, orbSnapshot } from "./orb-snapshot.ts";
import { readDocumentAppearance, subscribeToDocumentTheme } from "./theme.ts";

/** The avatar's size in CSS pixels; the picture is taken at twice that so it stays sharp on a dense display. */
const AVATAR_SIZE = 28;

interface AgentAvatarPicture {
  /** A still frame of the person's own orb, or undefined where WebGL could not draw one. */
  src: string | undefined;
  /** The profile's colours as a gradient, for a machine without WebGL. */
  background: string;
}

const AgentAvatarContext = createContext<AgentAvatarPicture | undefined>(undefined);

/**
 * Takes the avatar's picture once for the conversation, from the orb the person chose.
 *
 * Retaken when the profile or the theme changes — the orb is drawn against the page's own colour — and never per reply:
 * every avatar in the transcript shows the same picture, so a long conversation costs one frame, not one per row.
 */
export function AgentAvatarProvider({
  profile,
  children,
}: {
  profile: ResolvedOrbProfile | undefined;
  children: ReactNode;
}): ReactElement {
  const theme = useSyncExternalStore(subscribeToDocumentTheme, readDocumentAppearance, () => "dark");
  const picture = useMemo<AgentAvatarPicture>(() => {
    const options = orbOptionsFromProfile(profile);
    const canvasColor = typeof document === "undefined" ? undefined : readCanvasColor(document.documentElement);
    const src = orbSnapshot(
      canvasColor === undefined ? options : { ...options, palette: { ...options.palette, canvas: canvasColor } },
      `${profile?.key ?? "default"}|${theme}|${canvasColor?.join(",") ?? ""}`,
      AVATAR_SIZE * 2,
    );
    return { src, background: orbPaletteGradient(profile?.palette ?? {}) };
    // The key is the profile's identity as a value; the object itself is rebuilt on every resolve.
  }, [profile?.key, theme]);
  return <AgentAvatarContext.Provider value={picture}>{children}</AgentAvatarContext.Provider>;
}

/**
 * The agent's mark beside a reply.
 *
 * A still picture of the person's own orb — the same profile as the header and the dock — taken once and shown at a
 * fixed square size. It was a CSS gradient that only approximated the orb and ignored the chosen profile, and before
 * that an animated orb on the newest reply only, which spent a WebGL context per reply and visibly changed kind when
 * the next reply arrived. A picture that never moves has neither problem and still reads as the same object.
 *
 * Without a provider, or where WebGL cannot draw, the mark is the profile's colours as a round gradient.
 */
export function AgentAvatar(): ReactElement {
  const picture = useContext(AgentAvatarContext);
  if (picture?.src !== undefined) {
    return (
      <img
        className="cc-avatar"
        data-orb="snapshot"
        src={picture.src}
        width={AVATAR_SIZE}
        height={AVATAR_SIZE}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    );
  }
  return (
    <span
      className="cc-avatar"
      data-orb="fallback"
      aria-hidden="true"
      style={{ background: picture?.background ?? orbPaletteGradient({}) }}
    />
  );
}
