import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GatewayClient, ResolvedDataset, SnapshotPresentationResponse, Timeline } from "./api.ts";
import { composedImageRefs } from "./mini-app-surface.tsx";
import { mergeTimeline, olderPageCursor } from "./timeline-window.ts";
import { useHostObjectUrls } from "./use-image-urls.ts";
import type { ObjectUrls } from "./use-object-urls.ts";

/** Every block in a timeline's messages, flattened. */
function blocksOf(timeline: Timeline | undefined): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const message of timeline?.messages ?? []) {
    for (const block of message.blocks ?? []) blocks.push(block);
  }
  return blocks;
}

export interface ConversationTimelineState {
  conversationId: string | undefined;
  setConversationId: (id: string | undefined) => void;
  timeline: Timeline | undefined;
  setTimeline: (timeline: Timeline | undefined) => void;
  datasets: Record<string, ResolvedDataset>;
  setDatasets: (datasets: Record<string, ResolvedDataset>) => void;
  /** Read a dataset again: the node refused something because its rows changed, so the rows held here are old. */
  refreshDataset: (datasetId: string) => void;
  snapshots: Record<string, SnapshotPresentationResponse>;
  setSnapshots: (snapshots: Record<string, SnapshotPresentationResponse>) => void;
  /** Merge a page the node answered with into the held window (`mergeTimeline`). */
  applyTimeline: (next: Timeline) => void;
  refreshTimeline: () => void;
  /** Whether the node holds messages older than the oldest one held here. */
  hasOlder: boolean;
  /** A read of the page before the held window is under way. */
  olderLoading: boolean;
  /** The last read of an older page failed; the next `loadOlder` asks again. */
  olderFailed: boolean;
  /** Read the page just older than the held window and merge it in front. Resolves once it is merged or has failed. */
  loadOlder: () => Promise<void>;
  instanceById: Map<string, Timeline["instances"][number]>;
  composedSnapshots: { snapshotId: string; instanceId: string | undefined }[];
  imageUrl: (imageRef: string) => string | undefined;
  /** The same set, for a player: its source's state, and a way to ask for its bytes when they are needed. */
  mediaUrls: ObjectUrls;
}

/**
 * The conversation's own record, and everything that reads it.
 *
 * One hook rather than several, because the pieces below share one fact they cannot each
 * discover on their own: which conversation they are the record of. Loading an existing
 * conversation, resolving the datasets a visible widget references, resolving the immutable
 * presentation behind a composed message, and resolving the pictures any of that asks for, are
 * all reads of the same timeline and are kept together so they stay in one place to audit rather
 * than four places that could disagree about what `timeline` means.
 */
export function useConversationTimeline(
  client: GatewayClient,
  initialConversationId: string | undefined,
  onTimelineChange: ((timeline: Timeline) => void) | undefined,
): ConversationTimelineState {
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [timeline, setTimeline] = useState<Timeline | undefined>(undefined);
  const [datasets, setDatasets] = useState<Record<string, ResolvedDataset>>({});
  /**
   * The immutable presentation each message captured, keyed by snapshot.
   *
   * Fetched once and kept: a bundle is written once and never updated, so re-reading it on every
   * render would be a request per keystroke for data that cannot have changed. The live instance
   * is a different read, and it lives in the pinned surface that claims ownership of it.
   */
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotPresentationResponse>>({});

  /**
   * The timeline as last merged, read by the next merge.
   *
   * Two pages can arrive in one render - an action's answer and a refresh - and the second has to merge into what the
   * first left rather than into the state this render was drawn from.
   */
  const held = useRef<Timeline | undefined>(undefined);
  /** The conversation the screen is on, so a page read for one the person has since left is not drawn here. */
  const shownConversation = useRef(conversationId);
  shownConversation.current = conversationId;
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const olderInFlight = useRef(false);

  const replaceTimeline = useCallback((next: Timeline | undefined) => {
    held.current = next;
    setTimeline(next);
    if (next === undefined) setOlderFailed(false);
  }, []);

  /**
   * Take a page the node answered with into the window this conversation holds (`mergeTimeline`).
   *
   * Every answer that carries the conversation comes through here, so none of them sends a person who has scrolled back
   * through history to the start of the conversation or drops the turn they just sent.
   */
  const applyTimeline = useCallback(
    (next: Timeline) => {
      const merged = mergeTimeline(held.current, next);
      held.current = merged;
      setTimeline(merged);
      onTimelineChange?.(merged);
    },
    [onTimelineChange],
  );

  /**
   * Read the conversation again.
   *
   * A voice session answers through the conductor like any other message, but over its own
   * socket, so nothing draws the result here. This is the ask that keeps the two views of one
   * conversation from disagreeing until someone reloads the page. It reads the newest page, which merges into the held
   * window instead of replacing it.
   */
  const refreshTimeline = useCallback((): void => {
    if (conversationId === undefined) return;
    void client
      .timelinePage(conversationId, { kind: "latest" })
      .then((loaded) => {
        if (shownConversation.current === conversationId) applyTimeline(loaded);
      })
      .catch(() => undefined);
  }, [applyTimeline, client, conversationId]);

  /**
   * Read the page just older than the oldest message held, and merge it in front.
   *
   * One read at a time: the cursor is the held window's own first sequence, so a second read started before the first
   * answered would ask for the same page. A page for a conversation the person has since left is dropped. A failure is
   * reported as such, and the next call asks again.
   */
  const loadOlder = useCallback(async (): Promise<void> => {
    const current = held.current;
    const cursor = olderPageCursor(current);
    if (current === undefined || cursor === undefined || olderInFlight.current) return;
    const target = current.conversationId;
    olderInFlight.current = true;
    setOlderLoading(true);
    setOlderFailed(false);
    try {
      const page = await client.timelinePage(target, { kind: "before", beforeSequence: cursor });
      if (held.current?.conversationId === target) applyTimeline(page);
    } catch {
      if (held.current?.conversationId === target) setOlderFailed(true);
    } finally {
      olderInFlight.current = false;
      setOlderLoading(false);
    }
  }, [applyTimeline, client]);

  /* Load any existing conversation once, so a reload is not a new conversation. It opens on its newest page. */
  useEffect(() => {
    if (initialConversationId === undefined) return;
    let cancelled = false;
    client
      .timelinePage(initialConversationId, { kind: "latest" })
      .then((loaded) => {
        if (!cancelled) applyTimeline(loaded);
      })
      .catch(() => {
        // A conversation that no longer exists is not an error the user needs to see; the
        // next send creates a fresh one.
        if (!cancelled) setConversationId(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [applyTimeline, client, initialConversationId]);

  /* Resolve every dataset a visible widget references, and record its freshness. */
  const datasetRefs = useMemo(() => {
    const refs = new Set<string>();
    for (const instance of timeline?.instances ?? []) {
      const ref = instance.props.datasetRef;
      if (typeof ref === "string") refs.add(ref);
    }
    return [...refs].sort().join(",");
  }, [timeline]);

  useEffect(() => {
    if (datasetRefs === "") return;
    let cancelled = false;
    for (const datasetId of datasetRefs.split(",")) {
      if (datasets[datasetId] !== undefined) continue;
      client
        .dataset(datasetId)
        .then((resolved) => {
          if (!cancelled) setDatasets((current) => ({ ...current, [datasetId]: resolved }));
        })
        .catch(() => {
          // A missing dataset is normal: the renderer shows its own unavailable message.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [client, datasetRefs, datasets]);

  const refreshDataset = useCallback(
    (datasetId: string) => {
      client
        .dataset(datasetId)
        .then((resolved) => setDatasets((current) => ({ ...current, [datasetId]: resolved })))
        .catch(() => {
          // Gone now: dropping the old rows is what lets the renderer say so instead of drawing them.
          setDatasets((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== datasetId)));
        });
    },
    [client],
  );

  // Read once per timeline rather than per render: a streamed reply renders the conversation on every delta.
  const hasOlder = useMemo(() => olderPageCursor(timeline) !== undefined, [timeline]);

  const instanceById = useMemo(() => {
    const map = new Map<string, Timeline["instances"][number]>();
    for (const instance of timeline?.instances ?? []) map.set(instance.instanceId, instance);
    return map;
  }, [timeline]);

  /**
   * The snapshot behind every composed message, and only those with a bundle.
   *
   * A snapshot written before bundles existed has nothing to render from, which is why the
   * absence of a bundle is carried forward as the reason to show the message's text alternative
   * rather than the live instance's current props.
   */
  const composedSnapshots = useMemo(() => {
    const entries: { snapshotId: string; instanceId: string | undefined }[] = [];
    for (const block of blocksOf(timeline)) {
      if (block.type !== "surface") continue;
      const snapshot = (block.snapshot ?? {}) as Record<string, unknown>;
      const definitionRef = (block.definitionRef ?? {}) as Record<string, unknown>;
      const instanceId = typeof snapshot.instanceId === "string" ? snapshot.instanceId : undefined;
      const definitionId =
        typeof definitionRef.id === "string"
          ? definitionRef.id
          : instanceId === undefined
            ? ""
            : instanceById.get(instanceId)?.definitionId ?? "";
      if (definitionId !== "canvas.overview@1") continue;
      const snapshotId = typeof snapshot.snapshotId === "string" ? snapshot.snapshotId : "";
      if (snapshotId === "" || typeof snapshot.bundleRef !== "string") continue;
      entries.push({ snapshotId, instanceId });
    }
    return entries;
  }, [instanceById, timeline]);

  useEffect(() => {
    if (conversationId === undefined) return;
    for (const entry of composedSnapshots) {
      if (snapshots[entry.snapshotId] !== undefined) continue;
      void client
        .snapshotPresentation(conversationId, entry.snapshotId)
        .then((loaded) => setSnapshots((current) => ({ ...current, [entry.snapshotId]: loaded })))
        .catch(() => {
          // A snapshot that cannot be read is not an error state for the conversation: the
          // message falls back to its text alternative, which is what history keeps regardless.
        });
    }
  }, [client, composedSnapshots, conversationId, snapshots]);

  /**
   * Every picture and every player source any surface asks for, from the props it asks in.
   *
   * A single reference, a list of them, or the poster beside a video: a renderer cannot fetch, it
   * can only draw a URL it was handed, so whatever shape the request takes has to be recognised
   * here or the widget shows its text alternative while the picture sits on the node unread.
   *
   * Pictures, posters included, are read at once: a poster is a still picture under the same import limit as any
   * other, and it is what stands in for the player until the person chooses to play. A video's or an audio file's
   * bytes are listed but read only on request - when the player comes near the screen or the person presses play -
   * because a recording can be tens of megabytes and most of a conversation's history is never replayed.
   */
  const { inlineImageRefs, playerRefs } = useMemo(() => {
    const pictures = new Set<string>();
    const players = new Set<string>();
    const collect = (into: Set<string>, value: unknown): void => {
      if (typeof value === "string") {
        if (value !== "") into.add(value);
        return;
      }
      if (Array.isArray(value)) for (const entry of value) collect(into, entry);
    };
    for (const instance of timeline?.instances ?? []) {
      const props = (instance as { props?: Record<string, unknown> }).props ?? {};
      collect(pictures, props.imageRef);
      collect(pictures, props.imageRefs);
      collect(pictures, props.posterRef);
      collect(players, props.videoRef);
      collect(players, props.audioRef);
    }
    for (const entry of composedSnapshots) {
      for (const ref of composedImageRefs(snapshots[entry.snapshotId]?.sections ?? [])) pictures.add(ref);
    }
    return { inlineImageRefs: [...pictures].sort(), playerRefs: [...players].sort() };
  }, [composedSnapshots, snapshots, timeline]);

  const hostUrls = useHostObjectUrls(client, inlineImageRefs, playerRefs);
  const imageUrl = hostUrls.get;

  return {
    conversationId,
    setConversationId,
    timeline,
    setTimeline: replaceTimeline,
    datasets,
    setDatasets,
    refreshDataset,
    snapshots,
    setSnapshots,
    applyTimeline,
    refreshTimeline,
    hasOlder,
    olderLoading,
    olderFailed,
    loadOlder,
    instanceById,
    composedSnapshots,
    imageUrl,
    mediaUrls: hostUrls,
  };
}
