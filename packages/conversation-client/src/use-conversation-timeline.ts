import { useCallback, useEffect, useMemo, useState } from "react";

import type { GatewayClient, ResolvedDataset, SnapshotPresentationResponse, Timeline } from "./api.ts";
import { useImageUrls } from "./use-image-urls.ts";

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
  snapshots: Record<string, SnapshotPresentationResponse>;
  setSnapshots: (snapshots: Record<string, SnapshotPresentationResponse>) => void;
  applyTimeline: (next: Timeline) => void;
  refreshTimeline: () => void;
  instanceById: Map<string, Timeline["instances"][number]>;
  composedSnapshots: { snapshotId: string; instanceId: string | undefined }[];
  imageUrl: (imageRef: string) => string | undefined;
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

  const applyTimeline = useCallback(
    (next: Timeline) => {
      setTimeline(next);
      onTimelineChange?.(next);
    },
    [onTimelineChange],
  );

  /**
   * Read the conversation again.
   *
   * A voice session answers through the conductor like any other message, but over its own
   * socket, so nothing draws the result here. This is the ask that keeps the two views of one
   * conversation from disagreeing until someone reloads the page.
   */
  const refreshTimeline = useCallback((): void => {
    if (conversationId === undefined) return;
    void client
      .timeline(conversationId)
      .then((loaded) => applyTimeline(loaded))
      .catch(() => undefined);
  }, [applyTimeline, client, conversationId]);

  /* Load any existing conversation once, so a reload is not a new conversation. */
  useEffect(() => {
    if (initialConversationId === undefined) return;
    let cancelled = false;
    client
      .timeline(initialConversationId)
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
   * Every picture any surface asks for, from the props it asks in.
   *
   * A single reference, a list of them, or the poster beside a video: a renderer cannot fetch, it
   * can only draw a URL it was handed, so whatever shape the request takes has to be recognised
   * here or the widget shows its text alternative while the picture sits on the node unread.
   */
  const inlineImageRefs = useMemo(() => {
    const refs = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === "string") {
        if (value !== "") refs.add(value);
        return;
      }
      if (Array.isArray(value)) for (const entry of value) collect(entry);
    };
    for (const instance of timeline?.instances ?? []) {
      const props = (instance as { props?: Record<string, unknown> }).props ?? {};
      collect(props.imageRef);
      collect(props.imageRefs);
      collect(props.videoRef);
      collect(props.posterRef);
    }
    for (const entry of composedSnapshots) {
      for (const section of snapshots[entry.snapshotId]?.sections ?? []) {
        const ref = section.props.imageRef;
        if (typeof ref === "string" && ref !== "") refs.add(ref);
      }
    }
    return [...refs].sort();
  }, [composedSnapshots, snapshots, timeline]);

  const imageUrl = useImageUrls(client, inlineImageRefs);

  return {
    conversationId,
    setConversationId,
    timeline,
    setTimeline,
    datasets,
    setDatasets,
    snapshots,
    setSnapshots,
    applyTimeline,
    refreshTimeline,
    instanceById,
    composedSnapshots,
    imageUrl,
  };
}
