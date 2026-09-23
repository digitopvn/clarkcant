import type { ReplyStreamEvent } from "./api.ts";

/**
 * A reply that is still arriving, in the order the turn produced it.
 *
 * The same shape the node stores, built the same way and for the same reason: the model writes a
 * sentence, calls a tool, writes another sentence, and a view that collected each kind separately would
 * reorder the turn. Text and reasoning coalesce into the segment above them; a tool call is its own
 * widget, updated in place when its result arrives.
 *
 * Pure, so the pairing of a tool start with its end — the part that would fail silently by leaving a
 * spinner spinning — can be asserted without a browser.
 */
export type LiveSegment =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; block: Record<string, unknown> };

export function applyLiveEvent(segments: readonly LiveSegment[], event: ReplyStreamEvent): LiveSegment[] {
  const last = segments.at(-1);

  if (event.type === "text-delta") {
    return last?.kind === "text"
      ? [...segments.slice(0, -1), { kind: "text", text: last.text + event.text }]
      : [...segments, { kind: "text", text: event.text }];
  }

  if (event.type === "reasoning-delta") {
    return last?.kind === "reasoning"
      ? [...segments.slice(0, -1), { kind: "reasoning", text: last.text + event.text }]
      : [...segments, { kind: "reasoning", text: event.text }];
  }

  // Not a transcript fact: an app-control action is delivered to the executor by `useTurnSend`
  // directly (see its own `onEvent`), and it never becomes a segment - replaying it here would
  // repeat the side effect on every re-render of a reply that already finished.
  if (event.type === "host-control") return [...segments];

  if (event.type === "tool-start") {
    return [
      ...segments,
      {
        kind: "tool",
        block: {
          type: "tool-activity",
          toolCallId: event.toolCallId,
          name: event.name,
          label: event.label,
          status: "running",
          args: event.args,
          startedAt: new Date().toISOString(),
        },
      },
    ];
  }

  // The end of a call updates the widget that is already on screen rather than adding a second one.
  // A call whose start never arrived is ignored: the stored message is what says what happened.
  return segments.map((segment) =>
    segment.kind === "tool" && segment.block.toolCallId === event.toolCallId
      ? {
          kind: "tool",
          block: {
            ...segment.block,
            status: event.status,
            result: event.result,
            endedAt: new Date().toISOString(),
          },
        }
      : segment,
  );
}
