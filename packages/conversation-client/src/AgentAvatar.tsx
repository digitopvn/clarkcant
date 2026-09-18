import { type ReactElement } from "react";

/**
 * The agent's mark beside a reply.
 *
 * Static, for every reply including the newest, and drawn by CSS rather than by a canvas. It was an
 * animated orb on the newest reply only, which had two costs: an orb is a WebGL context, and a
 * conversation that gave each reply its own would run the browser out of them; and the moment a new
 * reply arrived, the previous one changed from a live canvas into the static fallback — the same mark
 * apparently deforming as it changed kind. A mark that never moves has neither problem.
 *
 * The palette is the orb's own, so it still reads as the same object as the header and the dock.
 */
export function AgentAvatar(): ReactElement {
  return <span className="cc-avatar" data-orb="fallback" aria-hidden="true" />;
}
