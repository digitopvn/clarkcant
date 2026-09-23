import { useCallback, type ReactElement, type RefObject } from "react";

import type { GatewayClient, ResolvedDataset, SnapshotPresentationResponse, Timeline } from "./api.ts";
import { type SurfaceBlockRef } from "./blocks.tsx";
import { resolveRenderer, toRendererDataset } from "./renderers.tsx";
import { MiniAppSurface, type CompositeSurfaceView } from "./mini-app-surface.tsx";
import { useT } from "./i18n/locale-context.tsx";

/**
 * Turn a captured bundle into what the surface renders.
 *
 * Nothing here reaches the live rows. A region with no materialised rows is reported as `missing`
 * rather than filled from the current dataset, which is the difference between history and a view
 * that quietly rewrites itself. `actions` is deliberately empty: a snapshot declares the bindings
 * that existed when it was taken, and the read-only route that produced this data does not carry
 * them, so a historical surface cannot mutate anything even if a client tried.
 */
function toSurfaceViewFromSnapshot(captured: SnapshotPresentationResponse, revision: number): CompositeSurfaceView {
  const materialised = new Map(captured.sections.map((section) => [section.sectionId, section]));
  const availability: Record<string, "live" | "missing"> = {};
  const sections = captured.sections.map((section) => {
    const rows = materialised.get(section.sectionId)?.rows;
    // A region that declares no data reference needs none — a period selector and a save button
    // are complete on their own. Marking those "missing" because they carry no rows drew an empty
    // card where a working control belongs.
    availability[section.sectionId] = section.dataRefs.length === 0 || rows !== undefined ? "live" : "missing";
    return {
      sectionId: section.sectionId,
      slot: section.slot as CompositeSurfaceView["sections"][number]["slot"],
      definitionRef: section.definitionRef,
      props: section.props,
      dataRefs: section.dataRefs,
      ...(rows === undefined ? {} : { rows }),
      textAlternative: section.textAlternative,
    };
  });

  const spec = captured.spec;
  return {
    compositionId: spec?.compositionId ?? "",
    instanceId: spec?.instanceId ?? captured.snapshot.instanceId ?? "",
    catalogDigest: captured.catalogDigest ?? "",
    // The period a snapshot was captured at is the period it shows. A later filter change belongs
    // to the live instance, not to this message.
    initialState: spec?.initialState ?? { period: "week", timezone: "UTC" },
    actions: [],
    sections,
    revision,
    ...(typeof captured.snapshot.capturedAt === "string" ? { capturedAt: captured.snapshot.capturedAt } : {}),
    stale: captured.snapshot.stale === true,
    tombstone: captured.tombstone,
    availability,
    // A snapshot is history: it never acts, whatever it recorded when it was taken.
    readOnly: true,
  };
}

export interface SurfaceRendererDeps {
  client: GatewayClient;
  conversationId: string | undefined;
  timeline: Timeline | undefined;
  instanceById: Map<string, Timeline["instances"][number]>;
  snapshots: Record<string, SnapshotPresentationResponse>;
  datasets: Record<string, ResolvedDataset>;
  imageUrl: (imageRef: string) => string | undefined;
  applyTimeline: (next: Timeline) => void;
  setError: (message: string | undefined) => void;
  liveTrigger: RefObject<HTMLElement | null>;
}

/**
 * Draws a widget from either a composed snapshot or the live catalogue.
 *
 * `canvas.overview@1` is checked before the leaf renderer lookup, because it is not a leaf:
 * `resolveRenderer` has no entry for it, and asking for one first would send every composed
 * surface down the fallback path. Every other definition goes through the catalog renderer, or
 * falls back to its text alternative when the client has none for it — which is not an early
 * return, because a widget the client cannot draw inline can still be opened as a live view.
 */
export function useSurfaceRenderer({
  client,
  conversationId,
  timeline,
  instanceById,
  snapshots,
  datasets,
  imageUrl,
  applyTimeline,
  setError,
  liveTrigger,
}: SurfaceRendererDeps): (input: SurfaceBlockRef) => ReactElement {
  const t = useT();
  return useCallback(
    (input: SurfaceBlockRef): ReactElement => {
      const instance = input.instanceId === undefined ? undefined : instanceById.get(input.instanceId);
      const definitionId = instance?.definitionId ?? input.definitionId;

      if (definitionId === "canvas.overview@1") {
        const captured = input.snapshotId === "" ? undefined : snapshots[input.snapshotId];
        // Staleness is the one field that changes after a snapshot is written, and it is recorded
        // on the snapshot row rather than in the message — the message is history and stays as it
        // was.
        const snapshotRow = timeline?.snapshots.find((entry) => entry.snapshotId === input.snapshotId);
        const stale = snapshotRow?.stale ?? input.stale;
        if (instance === undefined) {
          return (
            <div className="cc-card cc-freshness" data-widget-fallback="true" style={{ padding: "var(--cc-space-md)" }}>
              {input.textAlternative}
            </div>
          );
        }
        return (
          <div
            data-widget-instance={instance.instanceId}
            data-widget-definition={definitionId}
            data-snapshot={input.snapshotId}
            data-snapshot-stale={stale ? "true" : "false"}
          >
            {captured === undefined ? (
              // History without a stored bundle shows what the message itself carries.
              // Substituting the live instance here is the failure mode this whole split exists to
              // prevent.
              <div className="cc-card cc-freshness" data-widget-fallback="true" style={{ padding: "var(--cc-space-md)" }}>
                {input.textAlternative}
              </div>
            ) : (
              <MiniAppSurface
                view={toSurfaceViewFromSnapshot(captured, instance.revision)}
                title={typeof instance.props.title === "string" ? instance.props.title : undefined}
                imageUrl={imageUrl}
              />
            )}
            {conversationId !== undefined && (
              <button
                className="cc-icon-btn"
                style={{ width: "auto", padding: "0 var(--cc-space-sm)", marginTop: "var(--cc-space-xs)" }}
                data-open-live={instance.instanceId}
                onClick={(event) => {
                  liveTrigger.current = event.currentTarget;
                  // "Open the current view" is an expanded pin: the pinned surface is where the
                  // live instance is mounted, and it is the one that claims ownership of it.
                  void client
                    .pin(conversationId, instance.instanceId, "expanded")
                    .then((result) => applyTimeline(result.timeline))
                    .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
                }}
              >
                {t("widgets.surface.openCurrent")}
              </button>
            )}
          </div>
        );
      }

      const Renderer = resolveRenderer(definitionId);
      if (instance === undefined) {
        // Without the instance there is nothing to open, and the snapshot's text alternative is
        // what history keeps.
        return (
          <div className="cc-card cc-freshness" data-widget-fallback="true" style={{ padding: "var(--cc-space-md)" }}>
            {input.textAlternative}
          </div>
        );
      }
      const datasetRef = instance.props.datasetRef;
      const resolved = typeof datasetRef === "string" ? datasets[datasetRef] : undefined;
      const dataset = resolved === undefined ? undefined : toRendererDataset(resolved);

      return (
        <div data-widget-instance={instance.instanceId} data-widget-definition={definitionId}>
          {Renderer === undefined ? (
            /*
             * No catalog renderer for this definition — which is exactly the case for a widget
             * that runs in its own frame. The text alternative stands in for the inline view, and
             * the live view is still offered below.
             */
            <div className="cc-card cc-freshness" data-widget-fallback="true" style={{ padding: "var(--cc-space-md)" }}>
              {input.textAlternative}
            </div>
          ) : (
            <Renderer
              definitionId={definitionId}
              props={instance.props}
              dataset={dataset}
              // The picture resolver, which used to reach only the composed surface. A widget that
              // draws a picture cannot fetch one: it can only draw a URL it was handed, so leaving
              // this out made every picture widget show its text alternative while the bytes sat
              // unread on the node.
              imageUrl={imageUrl}
              onAction={(action) => {
                // View actions only for now: an action that would cause an effect goes through
                // the approval route, and there is no code path here that bypasses it.
                void action;
              }}
            />
          )}
          {conversationId !== undefined && (
            <button
              className="cc-icon-btn"
              style={{ width: "auto", padding: "0 var(--cc-space-sm)", marginTop: "var(--cc-space-xs)" }}
              {...(Renderer === undefined
                ? { "data-open-live": instance.instanceId }
                : { "data-pin-instance": instance.instanceId })}
              onClick={() => {
                /*
                 * A widget the client has no renderer for opens its live view; one it can draw is
                 * pinned compact. The distinction matters because the live view is the only place
                 * such a widget can be seen at all: "pin it again" would put it on the shelf with
                 * nothing on it.
                 */
                const request =
                  Renderer === undefined
                    ? client.pin(conversationId, instance.instanceId, "expanded")
                    : client.pin(conversationId, instance.instanceId);
                void request
                  .then((result) => applyTimeline(result.timeline))
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
              }}
            >
              {Renderer === undefined ? t("widgets.surface.openCurrent") : t("widgets.surface.pinAgain")}
            </button>
          )}
        </div>
      );
    },
    [applyTimeline, client, conversationId, datasets, imageUrl, instanceById, liveTrigger, setError, snapshots, t, timeline],
  );
}
