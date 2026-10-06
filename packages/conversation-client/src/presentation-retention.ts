import type { Timeline } from "./api.ts";

/**
 * What the transcript keeps resident for history it is not drawing.
 *
 * Pictures, datasets and composed presentations are read for the rows that are mounted, and kept for a while after a
 * row leaves the screen so scrolling back a little does not read them again. "A while" is a count, not a timeout: the
 * most recently drawn references beyond the ones on screen, up to a budget, and the oldest of those goes first. A
 * reference that leaves the kept list is released by its owner (`createObjectUrlSet` revokes its object URL), so a
 * long session holds a bounded number of them however far it is scrolled.
 */
export const PRESENTATION_RETENTION = {
  /** Pictures and players' listed sources, beyond those drawn now. */
  pictures: 48,
  /** Resolved datasets, beyond those drawn now. */
  datasets: 16,
  /** Composed presentations, beyond those drawn now. */
  snapshots: 16,
} as const;

/** Before the transcript says which rows it mounted, the newest this many count as drawn. */
export const PRESENT_BEFORE_REPORT = 20;

/**
 * The references to keep, most recently drawn first: every one drawn now, then those drawn before, up to `budget` of
 * them. Calling it again with the same `present` and its own answer gives the same answer.
 */
export function retainRecent(previous: readonly string[], present: readonly string[], budget: number): string[] {
  const now = new Set(present);
  const kept = [...now];
  let spare = Math.max(0, budget);
  for (const reference of previous) {
    if (spare === 0) break;
    if (now.has(reference)) continue;
    kept.push(reference);
    spare -= 1;
  }
  return kept;
}

/** The instances a message draws: a widget it names, or the instance a captured surface was taken of. */
export function instanceIdsOf(message: Timeline["messages"][number]): string[] {
  const ids: string[] = [];
  for (const block of message.blocks ?? []) {
    if (block.type === "widget-ref" && typeof block.instanceId === "string") ids.push(block.instanceId);
    if (block.type === "surface") {
      const snapshot = block.snapshot;
      if (typeof snapshot === "object" && snapshot !== null && typeof (snapshot as { instanceId?: unknown }).instanceId === "string") {
        ids.push((snapshot as { instanceId: string }).instanceId);
      }
    }
  }
  return ids;
}

/**
 * The messages whose presentation is wanted: those the transcript mounted, or the newest few before it said.
 *
 * Unknown ids are ignored, so a report about a window the conversation has since replaced asks for nothing it no
 * longer holds.
 */
export function presentMessages(
  timeline: Timeline | undefined,
  presentIds: readonly string[] | undefined,
): Timeline["messages"] {
  const messages = timeline?.messages ?? [];
  if (presentIds === undefined) return messages.slice(-PRESENT_BEFORE_REPORT);
  const wanted = new Set(presentIds);
  return messages.filter((message) => wanted.has(message.messageId));
}
