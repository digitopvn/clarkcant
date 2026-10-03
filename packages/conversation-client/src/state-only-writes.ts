import type { ViewStateWriteResult, Timeline, TimelineAction } from "./api.ts";
import type { MessageKey } from "./i18n/messages.ts";

/** One state-only write of a player's playback state: where it goes, the revision it is checked at, what it says. */
export interface StateOnlyWrite {
  conversation: string;
  instanceId: string;
  revision: number;
  action: TimelineAction;
  view: Record<string, unknown>;
  refused: MessageKey;
}

/** A write as it is sent: stamped with the player's write sequence when the player made it, not when it left. */
export interface SequencedStateOnlyWrite extends StateOnlyWrite {
  sequence: number;
}

export interface StateOnlyWriterDeps {
  send: (
    write: SequencedStateOnlyWrite,
    invocationId: string,
    options: { keepalive: boolean },
  ) => Promise<ViewStateWriteResult>;
  newInvocationId: () => string;
  /** A write is going out for this player, so an earlier refusal beside it no longer stands. */
  onSending: (instanceId: string) => void;
  /** A node from before the variant took the write as an ordinary action and answered with the conversation. */
  onTimeline: (timeline: Timeline) => void;
  onRefused: (write: SequencedStateOnlyWrite, cause: unknown) => void;
  now?: () => number;
}

export interface StateOnlyWriter {
  /** Send a player's write: at once when nothing is in flight or the page is leaving, otherwise as the waiting one. */
  send: (write: StateOnlyWrite, leaving: boolean) => void;
  /** The state a player draws from: what the node answered this page, when it is newer than what the timeline says. */
  nodeState: (
    instanceId: string,
    stateRevision: number | undefined,
    state: Record<string, unknown> | undefined,
  ) => Record<string, unknown> | undefined;
}

/**
 * The page's side of a player's state-only writes.
 *
 * - **One in flight per player.** A write made meanwhile waits, and only the latest waiting one is sent, at the revision
 *   the node answered with.
 * - **The leaving write goes at once** with `keepalive`, and it drops the waiting write: nothing older than it is sent
 *   after it.
 * - **Every write carries the player's sequence**, `max(now in milliseconds, previous + 1)`, stamped when the player
 *   made it. It grows across page loads because the clock does, and the node writes nothing for a sequence that is not
 *   newer than the last it accepted, so the in-flight write arriving after the leaving one cannot roll it back either.
 * - **What the node answered is held**, so a player drawn again later starts from it rather than from an older
 *   timeline; a timeline with a newer state wins.
 */
export function createStateOnlyWriter(deps: StateOnlyWriterDeps): StateOnlyWriter {
  const now = deps.now ?? Date.now;
  const queues = new Map<string, { inFlight: boolean; waiting?: SequencedStateOnlyWrite }>();
  const held = new Map<string, { stateRevision: number; state: Record<string, unknown> }>();
  const sequences = new Map<string, number>();

  const nextSequence = (instanceId: string): number => {
    const next = Math.max(Math.floor(now()), (sequences.get(instanceId) ?? 0) + 1);
    sequences.set(instanceId, next);
    return next;
  };

  const dispatch = (write: SequencedStateOnlyWrite, leaving: boolean): void => {
    const { instanceId } = write;
    const queue = queues.get(instanceId);
    if (leaving) {
      // Nothing that waited is sent after the leaving write: it is older than what the player says as it goes.
      queues.set(instanceId, { inFlight: queue?.inFlight ?? false });
    } else if (queue?.inFlight === true) {
      queues.set(instanceId, { inFlight: true, waiting: write });
      return;
    } else {
      queues.set(instanceId, { inFlight: true });
      deps.onSending(instanceId);
    }
    void deps
      .send(write, deps.newInvocationId(), { keepalive: leaving })
      .then((result) => {
        if (result.timeline !== undefined) deps.onTimeline(result.timeline);
        const kept = held.get(instanceId);
        if (kept === undefined || kept.stateRevision < result.stateRevision) {
          held.set(instanceId, { stateRevision: result.stateRevision, state: result.state });
        }
        if (leaving) return;
        const next = queues.get(instanceId)?.waiting;
        queues.set(instanceId, { inFlight: false });
        if (next !== undefined) dispatch({ ...next, revision: result.revision }, false);
      })
      .catch((cause: unknown) => {
        // Best-effort on a page that is unloading; the node stops believing an old "playing" on its own.
        if (leaving) return;
        queues.set(instanceId, { inFlight: false });
        deps.onRefused(write, cause);
      });
  };

  return {
    send: (write, leaving) => dispatch({ ...write, sequence: nextSequence(write.instanceId) }, leaving),
    nodeState: (instanceId, stateRevision, state) => {
      const kept = held.get(instanceId);
      return kept !== undefined && kept.stateRevision > (stateRevision ?? 0) ? kept.state : state;
    },
  };
}
