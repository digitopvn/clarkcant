import type { MessageKey } from "./i18n/messages.ts";
import { useCallback, useRef, useState, type ReactElement, type RefObject } from "react";

import {
  GatewayError,
  type GatewayClient,
  type ResolvedDataset,
  type SnapshotPresentationResponse,
  type Timeline,
  type TimelineAction,
} from "./api.ts";
import { type SurfaceBlockRef } from "./blocks.tsx";
import { resolveRenderer, toRendererDataset } from "./renderers.tsx";
import { tableExportRequestFrom } from "./table-model.ts";
import { MiniAppSurface, type CompositeSurfaceView } from "./mini-app-surface.tsx";

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
    ...(spec?.layout === undefined ? {} : { layout: spec.layout }),
    // A snapshot is history: it never acts, whatever it recorded when it was taken.
    readOnly: true,
  };
}

/** `unavailable` is a refusal the node would repeat (the dataset or the instance is gone); `failed` may pass on retry. */
type ExportStatus = "pending" | "failed" | "unavailable" | "done";

const TABLE_DEFINITION_ID = "canvas.table@1";
/** Buttons that act only through a host binding: without one they are drawn view-only, never as a live control. */
const BOUND_BUTTON_DEFINITION_IDS = new Set(["canvas.cta@1", "canvas.action@1"]);

/** What a press of a bound button said, kept per instance for the session. */
interface ActionRun {
  pending: boolean;
  message?: string;
  tone?: "done" | "waiting" | "refused";
}

const UNAVAILABLE_KEYS: Record<string, MessageKey> = {
  WORKFLOW_UNSUPPORTED: "widgets.action.unavailable.WORKFLOW_UNSUPPORTED",
  NOT_A_SERVICE_CAPABILITY: "widgets.action.unavailable.NOT_A_SERVICE_CAPABILITY",
  BINDING_STALE: "widgets.action.unavailable.BINDING_STALE",
  CAPABILITY_NOT_READY: "widgets.action.unavailable.CAPABILITY_NOT_READY",
  CAPABILITY_NOT_AUTHENTICATED: "widgets.action.unavailable.CAPABILITY_NOT_AUTHENTICATED",
  CAPABILITY_MISSING: "widgets.action.unavailable.CAPABILITY_MISSING",
};

/**
 * The sentence for a binding the node says cannot run, or for a press it refused.
 *
 * A known code is said in the person's language; an unknown one falls back to the node's own reason, which is still
 * the real answer rather than a generic "something went wrong".
 */
function reasonFor(t: (key: MessageKey) => string, code: string | undefined, reason: string | undefined): string {
  const key = code === undefined ? undefined : UNAVAILABLE_KEYS[code];
  if (key !== undefined) return t(key);
  return reason ?? t("widgets.action.refusedGeneric");
}

function newInvocationId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID();
  return `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** Hand a file to the browser's download flow, then release the object URL. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // The click starts the download synchronously; the URL is released once the browser has read it.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export interface SurfaceRendererDeps {
  /** Passed, not read via `useT()`: this hook runs in `Conversation`'s body, before its provider mounts. */
  t: (key: MessageKey) => string;
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
  t,
}: SurfaceRendererDeps): (input: SurfaceBlockRef) => ReactElement {
  /*
   * A standalone table's view (sort, search, page, selection) is held here for the session: the node keeps no view
   * state for a catalog widget, so this is what brings a remounted table back the way it was left. It is not
   * persisted, and it is never sent anywhere except as the view an export writes.
   */
  const tableViews = useRef(new Map<string, Record<string, unknown>>());
  const [exports, setExports] = useState<Record<string, ExportStatus>>({});
  const exportTable = useCallback(
    (conversation: string, instanceId: string, payload: Record<string, unknown>): void => {
      setExports((current) => ({ ...current, [instanceId]: "pending" }));
      // The node reads the instance's own dataset and writes the file; the page only says which view it wants.
      void client
        .exportTable(conversation, instanceId, tableExportRequestFrom(payload))
        .then(({ blob, filename }) => {
          downloadBlob(blob, filename);
          setExports((current) => ({ ...current, [instanceId]: "done" }));
        })
        .catch((cause: unknown) => {
          // Shown in the table itself, next to the button: what was kept, and whether trying again can help.
          const lasting = cause instanceof GatewayError && (cause.status === 404 || cause.status === 409);
          setExports((current) => ({ ...current, [instanceId]: lasting ? "unavailable" : "failed" }));
        });
    },
    [client],
  );

  /*
   * A bound button's press goes to the same action route every surface uses, with the binding digest and instance
   * revision the timeline carried: the node checks both again, so a button drawn from an out-of-date timeline is
   * refused rather than running something the person did not see. A fresh id per press is what lets a double click be
   * one effect without making a later, deliberate press a duplicate.
   */
  const [actionRuns, setActionRuns] = useState<Record<string, ActionRun>>({});
  const runAction = useCallback(
    (conversation: string, instance: Timeline["instances"][number], action: TimelineAction): void => {
      const id = instance.instanceId;
      setActionRuns((current) => ({ ...current, [id]: { pending: true } }));
      void client
        .invokeAction(conversation, id, {
          actionBindingId: action.actionBindingId,
          expectedRevision: instance.revision,
          expectedBindingDigest: action.bindingDigest,
          input: {},
          invocationId: newInvocationId(),
        })
        .then((result) => {
          applyTimeline(result.timeline);
          const run: ActionRun =
            result.approvalRequired !== undefined
              ? // Nothing ran yet; the card the host placed in the conversation is where it is decided.
                { pending: false, tone: "waiting", message: t("widgets.action.awaitingApproval") }
              : result.duplicate
                ? { pending: false, tone: "done", message: t("widgets.action.duplicate") }
                : typeof result.output === "string" && result.output !== ""
                  ? { pending: false, tone: "done", message: result.output }
                  : result.pinId !== null
                    ? { pending: false, tone: "done", message: t("widgets.action.pinned") }
                    : { pending: false, tone: "done", message: t("widgets.action.done") };
          setActionRuns((current) => ({ ...current, [id]: run }));
        })
        .catch((cause: unknown) => {
          const code = cause instanceof GatewayError ? cause.code : undefined;
          const message =
            code === "TURN_IN_PROGRESS"
              ? t("widgets.action.turnInProgress")
              : code === "REVISION_MISMATCH"
                ? t("widgets.action.revisionMismatch")
                : reasonFor(t, code, cause instanceof GatewayError ? cause.reason : undefined);
          setActionRuns((current) => ({ ...current, [id]: { pending: false, tone: "refused", message } }));
        });
    },
    [applyTimeline, client, t],
  );

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
      const isTable = definitionId === TABLE_DEFINITION_ID;
      const exportStatus = exports[instance.instanceId];
      // One button, one binding: `canvas.action@1` is made with exactly one, and the renderer never learns its kind.
      const boundAction = instance.actions?.[0];
      const isBoundButton = BOUND_BUTTON_DEFINITION_IDS.has(definitionId);
      const actionRun = actionRuns[instance.instanceId];
      const buttonState: Record<string, unknown> | undefined = !isBoundButton
        ? undefined
        : {
            ...(actionRun?.pending === true ? { pending: true } : {}),
            ...(actionRun?.message === undefined ? {} : { message: actionRun.message, tone: actionRun.tone }),
            ...(boundAction !== undefined && !boundAction.available
              ? { unavailableReason: reasonFor(t, boundAction.unavailableCode, boundAction.unavailableReason) }
              : {}),
          };
      // A button with no binding, or no conversation to run it in, is drawn view-only instead of as a live control.
      const buttonActionable = boundAction !== undefined && conversationId !== undefined;

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
              {...(isTable
                ? {
                    state: {
                      ...tableViews.current.get(instance.instanceId),
                      ...(exportStatus === undefined ? {} : { exportStatus }),
                    },
                    onStateChange: (patch: Record<string, unknown>) => {
                      const id = instance.instanceId;
                      tableViews.current.set(id, { ...tableViews.current.get(id), ...patch });
                      // "Downloaded" described the view that was exported; once the view changes it no longer does.
                      if (exportStatus === "done") {
                        setExports((current) => {
                          if (current[id] !== "done") return current;
                          const { [id]: _done, ...rest } = current;
                          return rest;
                        });
                      }
                    },
                    canExport: conversationId !== undefined,
                  }
                : {})}
              {...(buttonState === undefined ? {} : { state: buttonState })}
              {...(isBoundButton && !buttonActionable
                ? {}
                : {
                    onAction: (action: string, payload: Record<string, unknown>) => {
                      // A table's export is a read the node answers with a file, through its own person-only route.
                      if (isTable && action === "export.requested" && conversationId !== undefined) {
                        if (exportStatus !== "pending") exportTable(conversationId, instance.instanceId, payload);
                        return;
                      }
                      if (isBoundButton && action === "activate" && boundAction !== undefined && conversationId !== undefined) {
                        if (actionRun?.pending !== true) runAction(conversationId, instance, boundAction);
                        return;
                      }
                      // Everything else is a view action: selection and paging stay in the view, and an action that
                      // would cause an effect goes through the approval route, which no code path here bypasses.
                    },
                  })}
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
    [
      actionRuns,
      applyTimeline,
      client,
      conversationId,
      datasets,
      exportTable,
      exports,
      imageUrl,
      instanceById,
      liveTrigger,
      runAction,
      setError,
      snapshots,
      t,
      timeline,
    ],
  );
}
