import { type ReactElement, type RefObject } from "react";

import { Orb } from "./Orb.tsx";

/**
 * The agent's mark beside a reply.
 *
 * Animated for the newest reply only, and that is a constraint rather than a flourish. Every orb is a
 * WebGL context, and a page may hold only a handful before the browser starts taking them away — a
 * conversation where each reply had its own would go blank partway down, which is the failure this
 * avoids. The newest reply is the one being read, so it is the one that moves; earlier ones are drawn
 * from the same palette by CSS.
 *
 * The static one is deliberately not the accent-coloured dot that was here before: the design puts the
 * same object beside every reply, and a message that looks like it came from a different agent
 * depending on its position in the transcript is worse than no avatar at all.
 */
export function AgentAvatar({
  animated,
  pointerTarget,
}: {
  animated: boolean;
  /** The surface the pointer position is read from, so the avatar lights up as the mouse passes. */
  pointerTarget?: RefObject<HTMLElement | null>;
}): ReactElement {
  if (!animated) return <span className="cc-avatar" data-orb="fallback" aria-hidden="true" />;
  return (
    <Orb
      size={28}
      className="cc-avatar"
      label=""
      {...(pointerTarget === undefined ? {} : { pointerTarget })}
    />
  );
}
