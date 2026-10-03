import type { MessageKey } from "./i18n/messages.ts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";

import {
  CALENDAR_ID,
  CALENDAR_VIEW_OPERATION,
  TIMELINE_ID,
  TIMELINE_SELECT_OPERATION,
  TREE_ID,
  TREE_SELECT_OPERATION,
  TREE_TOGGLE_OPERATION,
  DIAGRAM_ID,
  DIAGRAM_SELECT_OPERATION,
  BOARD_ID,
  BOARD_MOVE_OPERATION,
  BOARD_APPROVAL_OPERATION,
  BOARD_RESOLVE_OPERATION,
  BOARD_ACKNOWLEDGE_OPERATION,
  MEDIA_VIEW_OPERATION,
  MAP_ID,
  MAP_SELECT_OPERATION,
  MAP_VIEW_OPERATION,
  XY_CHART_KIND,
  XY_CHART_VIEW_OPERATION,
} from "@clarkcant/contracts";

import {
  GatewayError,
  type GatewayClient,
  type ResolvedDataset,
  type SnapshotPresentationResponse,
  type Timeline,
  type TimelineAction,
} from "./api.ts";
import { actionRefusalMessage, actionResultMessage, bindingUnavailableMessage } from "./action-messages.ts";
import { type SurfaceBlockRef } from "./blocks.tsx";
import { type ArtifactFileHost, type MapTileHost, resolveRenderer, toRendererDataset } from "./renderers.tsx";
import { createStateOnlyWriter, type StateOnlyWriter } from "./state-only-writes.ts";
import { tableExportRequestFrom } from "./table-model.ts";
import { desktopDialogLabels } from "./artifact-messages.ts";
import { downloadBlob, saveForPerson } from "./download.ts";
import { MiniAppSurface, type CompositeSurfaceView } from "./mini-app-surface.tsx";
import type { ObjectUrls } from "./use-object-urls.ts";

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
    // The graph it was captured with, and no stored values: history shows the state the surface started in.
    ...(spec?.graph === undefined ? {} : { graph: spec.graph }),
    // A snapshot is history: it never acts, whatever it recorded when it was taken.
    readOnly: true,
  };
}

/** `unavailable` is a refusal the node would repeat (the dataset or the instance is gone); `failed` may pass on retry. */
type ExportStatus = "pending" | "failed" | "unavailable" | "done";

const TABLE_DEFINITION_ID = "canvas.table@1";
const FORM_DEFINITION_ID = "canvas.form@1";
const LIST_DEFINITION_ID = "canvas.list@1";
/**
 * Widgets that act only through a host binding: without one they are drawn view-only, never as a live control. A form
 * is one of them, since sending is all it does.
 */
const BOUND_DEFINITION_IDS = new Set(["canvas.cta@1", "canvas.action@1", FORM_DEFINITION_ID]);
/** Widgets whose view the page keeps for the session: a table's sort and page, a form's draft, a list's selection. */
const LOCAL_VIEW_DEFINITION_IDS = new Set([TABLE_DEFINITION_ID, FORM_DEFINITION_ID, LIST_DEFINITION_ID, BOARD_ID]);
/** What a widget says when the node refused the view it asked to hold, by the view operation it asked through. */
const VIEW_REFUSED: Record<string, MessageKey> = {
  [XY_CHART_VIEW_OPERATION]: "widgets.xyChart.viewRefused",
  [CALENDAR_VIEW_OPERATION]: "widgets.calendar.viewRefused",
  [TIMELINE_SELECT_OPERATION]: "widgets.timeline.selectRefused",
  [TREE_SELECT_OPERATION]: "widgets.tree.actionRefused",
  [TREE_TOGGLE_OPERATION]: "widgets.tree.actionRefused",
  [DIAGRAM_SELECT_OPERATION]: "widgets.diagram.selectRefused",
  [MEDIA_VIEW_OPERATION]: "widgets.action.refusedGeneric",
  [MAP_SELECT_OPERATION]: "widgets.map.viewRefused",
  [MAP_VIEW_OPERATION]: "widgets.map.viewRefused",
};
/** The argument an agent-bound list item is sent under when the binding names none. */
const DEFAULT_ITEM_KEY = "itemId";

/** What a press of a bound button said, kept per instance for the session. */
interface ActionRun {
  pending: boolean;
  message?: string;
  tone?: "done" | "waiting" | "refused";
  approvalId?: string;
}

/**
 * One widget's view writes: whether one is in flight, at which revision it was sent, and the latest change waiting for
 * each of its view bindings. A widget with two bindings (a tree's selection and expansion, a map's selection and view)
 * keeps one waiting change per binding, each sent through its own binding, so a selection made while a pan is in flight
 * is neither dropped nor sent to the binding that does not take it.
 */
export interface ViewQueue {
  inFlight: boolean;
  revision?: number;
  queued?: { action?: TimelineAction; view: Record<string, unknown>; onSettled?: (timeline: Timeline) => void }[];
}

/**
 * Whether a view change is sent now, and at which revision.
 *
 * An ordinary change waits behind a write in flight. A change sent as the page goes away cannot wait, because the answer
 * that would release it never arrives: it is sent at once, with `keepalive`, at the revision the write in flight
 * produces if the node accepts it (a view write moves the revision by one). If that write is refused, so is this one,
 * and the node's own freshness window keeps what it reports honest.
 */
export function planViewWrite(
  queue: ViewQueue | undefined,
  revision: number,
  leaving: boolean,
): { send: false } | { send: true; expectedRevision: number; keepalive: boolean } {
  if (queue?.inFlight !== true) return { send: true, expectedRevision: revision, keepalive: leaving };
  if (!leaving) return { send: false };
  return { send: true, expectedRevision: (queue.revision ?? revision) + 1, keepalive: true };
}

function newInvocationId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID();
  return `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
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
  refreshDataset: (datasetId: string) => void;
  imageUrl: (imageRef: string) => string | undefined;
  /** A player's source, read only when the player is near the screen or the person presses play. */
  mediaUrls: ObjectUrls;
  applyTimeline: (next: Timeline) => void;
  setError: (message: string | undefined) => void;
  liveTrigger: RefObject<HTMLElement | null>;
  /** Told whenever a press starts or stops waiting on the node, so the conversation can offer Stop meanwhile. */
  onActionsRunningChange?: (running: boolean) => void;
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
  refreshDataset,
  imageUrl,
  mediaUrls,
  applyTimeline,
  setError,
  liveTrigger,
  t,
  onActionsRunningChange,
}: SurfaceRendererDeps): (input: SurfaceBlockRef) => ReactElement {
  /*
   * A standalone widget's view (a table's sort, search, page and selection; a form's draft; a list's page and
   * selection) is held here for the session: the node keeps no view state for a catalog widget, so this is what brings
   * a remounted widget back the way it was left. It is not persisted, and it is never sent anywhere except as the view
   * an export writes or the values a person submits.
   */
  const localViews = useRef(new Map<string, Record<string, unknown>>());
  /*
   * Open and Save As for a file card that points at an artifact. Both go through the person's own routes, which check
   * that the artifact is this principal's on every call; a card whose artifact is gone or someone else's says so.
   */
  const artifactFiles = useMemo<ArtifactFileHost>(
    () => ({
      open: (ref) => client.artifactContent(ref.artifactId),
      saveAs: async (ref, name) => {
        const exported = await client.exportArtifact(ref.artifactId, name);
        // Named by the type the node sent the bytes as, not the one the card's ref claims.
        const mimeType = exported.mimeType === "" ? ref.mimeType : exported.mimeType;
        return saveForPerson(exported.blob, exported.filename, { mimeType, labels: desktopDialogLabels(t) });
      },
    }),
    [client, t],
  );
  /*
   * A map's tiles, when the node's tile policy names a provider: the policy view says whose they are, and each tile is
   * read through the node's own tile route with the person's token, then drawn from a blob URL. A map never names a host,
   * so nothing it holds can send the page elsewhere; a node with no policy answers `provider: null` and maps draw the
   * offline basemap only.
   */
  const mapTiles = useMemo<MapTileHost>(
    () => ({
      policy: () => client.mapTilePolicy(),
      tile: (z, x, y, signal) => client.mapTile(z, x, y, signal),
    }),
    [client],
  );
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
   * one effect without making a later, deliberate press a duplicate. `input` is what a form or a list item sends: the
   * node checks it against what the binding accepts before anything runs.
   */
  /*
   * A chart's view (the series hidden, the point selected) and a calendar's (month, week or agenda, the day and event
   * selected) are drawn by the widget at once and kept by the node through the widget's own view binding. One request per
   * widget is in flight; a change made meanwhile waits and is sent with the revision the first one returned, and only the
   * latest waiting change is sent, so a burst of clicks is one write per round trip and ends at what the person last
   * chose. A refusal drops the waiting change and says why beside the widget, which then draws the view the node holds.
   */
  const viewQueues = useRef(new Map<string, ViewQueue>());
  /** A refusal said beside a widget, and how many there have been: each one sets the widget back to the node's view. */
  const [viewRefusals, setViewRefusals] = useState<Record<string, { message: string; count: number }>>({});
  const clearViewRefusal = useCallback((instanceId: string): void => {
    setViewRefusals((current) => {
      const refusal = current[instanceId];
      return refusal === undefined || refusal.message === "" ? current : { ...current, [instanceId]: { message: "", count: refusal.count } };
    });
  }, []);
  /*
   * A refused view write is said beside the widget in the person's language — the node's own sentence is English,
   * written for the model and the logs — and the widget draws the node's view again. A change that went through while a
   * later one waited was not applied yet, so the timeline is read back rather than trusted; and the node checked the view
   * against the rows it holds now, which may not be the rows this page was given, so those are read again too.
   */
  const refuseView = useCallback(
    (conversation: string, instanceId: string, datasetRef: string | undefined, cause: unknown, refused: MessageKey): void => {
      const code = cause instanceof GatewayError ? cause.code : undefined;
      const message =
        code === "REVISION_MISMATCH"
          ? t("widgets.action.revisionMismatch")
          : (bindingUnavailableMessage(t, code) ?? t(refused));
      setViewRefusals((current) => ({ ...current, [instanceId]: { message, count: (current[instanceId]?.count ?? 0) + 1 } }));
      if (datasetRef !== undefined) refreshDataset(datasetRef);
      void client
        .timeline(conversation)
        .then(applyTimeline)
        .catch(() => undefined);
    },
    [applyTimeline, client, refreshDataset, t],
  );
  const sendView = useCallback(
    (conversation: string, instanceId: string, datasetRef: string | undefined, action: TimelineAction, revision: number, view: Record<string, unknown>, refused: MessageKey, onSettled?: (timeline: Timeline) => void, leaving = false): void => {
      const queue = viewQueues.current.get(instanceId);
      const plan = planViewWrite(queue, revision, leaving);
      if (!plan.send) {
        const waiting = (queue?.queued ?? []).filter((entry) => (entry.action ?? action).actionBindingId !== action.actionBindingId);
        viewQueues.current.set(instanceId, {
          ...(queue ?? { inFlight: true }),
          queued: [...waiting, { action, view, ...(onSettled === undefined ? {} : { onSettled }) }],
        });
        return;
      }
      if (queue?.inFlight === true) {
        // The widget is going away: a change waiting for this binding is older than this write and is replaced by it, but
        // one waiting for another binding (a map's selection behind its view) is not covered by it, so it goes first, in
        // order, each at the revision the one before it produces.
        const others = (queue.queued ?? []).filter((entry) => (entry.action ?? action).actionBindingId !== action.actionBindingId);
        const writes = [...others.map((entry) => ({ action: entry.action ?? action, view: entry.view })), { action, view }];
        viewQueues.current.set(instanceId, { inFlight: true, revision: plan.expectedRevision + writes.length - 1 });
        const send = (index: number): Promise<void> => {
          const write = writes[index];
          if (write === undefined) return Promise.resolve();
          return client
            .invokeAction(
              conversation,
              instanceId,
              {
                actionBindingId: write.action.actionBindingId,
                expectedRevision: plan.expectedRevision + index,
                expectedBindingDigest: write.action.bindingDigest,
                input: write.view,
                invocationId: newInvocationId(),
              },
              { keepalive: true },
            )
            .then((result) => {
              applyTimeline(result.timeline);
              return send(index + 1);
            });
        };
        // Best-effort on a page that is unloading; the node stops believing an old "playing" on its own.
        send(0).catch(() => undefined);
        return;
      }
      viewQueues.current.set(instanceId, { inFlight: true, revision: plan.expectedRevision, ...(queue?.queued === undefined ? {} : { queued: queue.queued }) });
      clearViewRefusal(instanceId);
      void client
        .invokeAction(
          conversation,
          instanceId,
          {
            actionBindingId: action.actionBindingId,
            expectedRevision: plan.expectedRevision,
            expectedBindingDigest: action.bindingDigest,
            input: view,
            invocationId: newInvocationId(),
          },
          plan.keepalive ? { keepalive: true } : {},
        )
        .then((result) => {
          const [next, ...rest] = viewQueues.current.get(instanceId)?.queued ?? [];
          viewQueues.current.set(instanceId, { inFlight: false, ...(rest.length === 0 ? {} : { queued: rest }) });
          if (next !== undefined) sendView(conversation, instanceId, datasetRef, next.action ?? action, result.revision, next.view, refused, next.onSettled);
          else { applyTimeline(result.timeline); onSettled?.(result.timeline); }
        })
        .catch((cause: unknown) => {
          viewQueues.current.set(instanceId, { inFlight: false });
          refuseView(conversation, instanceId, datasetRef, cause, refused);
        });
    },
    [applyTimeline, clearViewRefusal, client, refuseView],
  );

  /*
   * A player's playback state goes as the state-only write (`createStateOnlyWriter`): the node stores it and answers
   * with the state alone, so nothing in the conversation is rebuilt or re-rendered for it. The writer is made once for
   * the page, so its queues and its players' write sequences outlive a render; what it calls is read at the call.
   */
  const writerDeps = useRef({ applyTimeline, clearViewRefusal, client, refuseView });
  writerDeps.current = { applyTimeline, clearViewRefusal, client, refuseView };
  const [stateWriter] = useState<StateOnlyWriter>(() =>
    createStateOnlyWriter({
      send: (write, invocationId, { keepalive }) =>
        writerDeps.current.client.writeViewState(
          write.conversation,
          write.instanceId,
          {
            actionBindingId: write.action.actionBindingId,
            expectedRevision: write.revision,
            expectedBindingDigest: write.action.bindingDigest,
            input: write.view,
            invocationId,
            sequence: write.sequence,
          },
          keepalive ? { keepalive: true } : {},
        ),
      newInvocationId,
      onSending: (instanceId) => writerDeps.current.clearViewRefusal(instanceId),
      // A node from before the variant took it as an ordinary action and moved the revision: its timeline says so.
      onTimeline: (timeline) => writerDeps.current.applyTimeline(timeline),
      onRefused: (write, cause) => writerDeps.current.refuseView(write.conversation, write.instanceId, undefined, cause, write.refused),
    }),
  );

  const [actionRuns, setActionRuns] = useState<Record<string, ActionRun>>({});
  // Whether a press is still waiting on the node, told to the conversation so its Stop is offered while one is: a
  // button's call is stopped by the same Stop as a reply.
  const anyActionRunning = Object.values(actionRuns).some((run) => run.pending);
  useEffect(() => {
    onActionsRunningChange?.(anyActionRunning);
  }, [anyActionRunning, onActionsRunningChange]);
  const runAction = useCallback(
    (conversation: string, instance: Timeline["instances"][number], action: TimelineAction, input: Record<string, unknown>, onResult?: (result: Awaited<ReturnType<GatewayClient["invokeAction"]>> | undefined, cause?: unknown) => void): void => {
      const id = instance.instanceId;
      setActionRuns((current) => ({ ...current, [id]: { pending: true } }));
      void client
        .invokeAction(conversation, id, {
          actionBindingId: action.actionBindingId,
          expectedRevision: instance.revision,
          expectedBindingDigest: action.bindingDigest,
          input,
          invocationId: newInvocationId(),
        })
        .then((result) => {
          applyTimeline(result.timeline);
          // Started or waiting on an approval card is not done; the words for each are said in the person's language.
          const tone = result.outcome === "background" || result.approvalRequired !== undefined ? "waiting" : "done";
          const run: ActionRun = { pending: false, tone, message: actionResultMessage(t, result), ...(result.approvalRequired === undefined ? {} : { approvalId: result.approvalRequired.approvalId }) };
          setActionRuns((current) => ({ ...current, [id]: run }));
          onResult?.(result);
        })
        .catch((cause: unknown) => {
          // Said from the node's code and details, never its English sentence or a raw code: what failed, what was
          // kept, and what happens next — the inbox only when the node recorded the question there.
          const message =
            cause instanceof GatewayError
              ? actionRefusalMessage(t, { code: cause.code, reason: cause.reason, details: cause.details })
              : t("widgets.action.refusedGeneric");
          setActionRuns((current) => ({ ...current, [id]: { pending: false, tone: "refused", message } }));
          onResult?.(undefined, cause);
        });
    },
    [applyTimeline, client, refreshDataset, t],
  );

  const settledApprovals = useRef(new Set<string>());
  useEffect(() => {
    if (conversationId === undefined || timeline === undefined) return;
    const receipts = new Map<string, "done" | "refused">();
    for (const message of timeline.messages) for (const block of message.blocks) {
      if (block.type !== "tool-activity") continue;
      const args = (block.args ?? {}) as Record<string, unknown>;
      if (typeof args.approvalId !== "string") continue;
      if (args.decision === "denied" || args.outcome === "refused") receipts.set(args.approvalId, "refused");
      else if (args.outcome === "done") receipts.set(args.approvalId, "done");
    }
    for (const [instanceId, run] of Object.entries(actionRuns)) {
      const approvalId = run.approvalId;
      const outcome = approvalId === undefined ? undefined : receipts.get(approvalId);
      if (approvalId === undefined || outcome === undefined || settledApprovals.current.has(approvalId)) continue;
      const instance = instanceById.get(instanceId);
      const action = instance?.actions?.find((candidate) => candidate.viewOperation === BOARD_RESOLVE_OPERATION);
      if (instance === undefined || action === undefined || !action.available) continue;
      settledApprovals.current.add(approvalId);
      sendView(conversationId, instanceId, undefined, action, instance.revision, { approvalId, outcome }, "widgets.action.refusedGeneric");
      setActionRuns((current) => {
        const { approvalId: _approvalId, ...settled } = current[instanceId] ?? { pending: false };
        return { ...current, [instanceId]: settled };
      });
    }
  }, [actionRuns, conversationId, instanceById, sendView, timeline]);

  return useCallback(
    (input: SurfaceBlockRef): ReactElement => {
      const instance = input.instanceId === undefined ? undefined : instanceById.get(input.instanceId);
      const definitionId = instance?.definitionId ?? input.definitionId;

      // The node could not read this block's stored snapshot back. It says so here, in place of the block, rather than
      // drawing the widget from a record it could not check; the rest of the conversation is unaffected.
      if (input.snapshotId !== "" && timeline?.snapshots.some((entry) => entry.snapshotId === input.snapshotId && entry.unreadable === true)) {
        return (
          <div className="cc-card cc-freshness" role="note" data-widget-unreadable="true" style={{ padding: "var(--cc-space-md)" }}>
            {t("widgets.snapshot.unreadable")}
          </div>
        );
      }

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
      const isForm = definitionId === FORM_DEFINITION_ID;
      const isList = definitionId === LIST_DEFINITION_ID;
      const exportStatus = exports[instance.instanceId];
      // One widget, one binding: a button, a form and a list are each made with at most one, and neither the renderer
      // nor this hook learns what it does.
      const boundAction = definitionId === BOARD_ID
        ? instance.actions?.find((candidate) => candidate.viewOperation === undefined)
        : instance.actions?.[0];
      const needsBinding = BOUND_DEFINITION_IDS.has(definitionId);
      const sends = needsBinding || (isList && boundAction !== undefined);
      const actionRun = actionRuns[instance.instanceId];
      // A widget with no binding, or no conversation to run it in, is drawn view-only instead of as a live control.
      const actionReady = boundAction !== undefined && conversationId !== undefined;
      const keepsView = LOCAL_VIEW_DEFINITION_IDS.has(definitionId);
      // The one view operation a chart, a calendar or a timeline keeps its view on the node through.
      const viewOperation =
        XY_CHART_KIND[definitionId] !== undefined
          ? XY_CHART_VIEW_OPERATION
          : definitionId === CALENDAR_ID
            ? CALENDAR_VIEW_OPERATION
              : definitionId === TIMELINE_ID
                ? TIMELINE_SELECT_OPERATION
                : definitionId === DIAGRAM_ID
                  ? DIAGRAM_SELECT_OPERATION
                  : undefined;
      const viewOperations = definitionId === TREE_ID
        ? [TREE_SELECT_OPERATION, TREE_TOGGLE_OPERATION]
        : definitionId === MAP_ID
          ? [MAP_SELECT_OPERATION, MAP_VIEW_OPERATION]
        : definitionId === BOARD_ID
          ? [BOARD_MOVE_OPERATION, BOARD_APPROVAL_OPERATION, BOARD_RESOLVE_OPERATION, BOARD_ACKNOWLEDGE_OPERATION]
          : definitionId === "canvas.carousel@1" || definitionId === "canvas.gallery@1" || definitionId === "canvas.video@1" ||
              definitionId === "canvas.audio@1" || definitionId === "canvas.document@1"
            ? [MEDIA_VIEW_OPERATION]
            : viewOperation === undefined ? [] : [viewOperation];
      const viewRefusal = viewRefusals[instance.instanceId];
      // A player's own state-only writes are answered without a timeline, so the newest of the two is the node's view.
      const nodeState = stateWriter.nodeState(instance.instanceId, instance.stateRevision, instance.state);
      const widgetState: Record<string, unknown> | undefined =
        viewOperations.length > 0
        ? {
            // The view the node holds; the widget draws a change at once and adopts this when it moves.
            ...(nodeState ?? {}),
            ...(definitionId === BOARD_ID && boundAction !== undefined ? { externalBound: true } : {}),
            ...(definitionId === BOARD_ID && actionRun?.message !== undefined ? { actionMessage: actionRun.message, actionTone: actionRun.tone } : {}),
            ...(viewRefusal === undefined ? {} : { message: viewRefusal.message, viewReset: viewRefusal.count }),
          }
        : !keepsView && !sends
          ? undefined
          : {
              ...(keepsView ? localViews.current.get(instance.instanceId) : {}),
              ...(isTable && exportStatus !== undefined ? { exportStatus } : {}),
              ...(sends && actionRun?.pending === true ? { pending: true } : {}),
              ...(sends && actionRun?.message !== undefined ? { message: actionRun.message, tone: actionRun.tone } : {}),
              ...(sends && boundAction !== undefined && !boundAction.available
                ? { unavailableReason: actionRefusalMessage(t, { code: boundAction.unavailableCode, reason: boundAction.unavailableReason, details: {} }) }
                : {}),
              ...(isList && actionReady ? { itemActionReady: true } : {}),
            };

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
              statedAt={input.capturedAt}
              // The picture resolver, which used to reach only the composed surface. A widget that
              // draws a picture cannot fetch one: it can only draw a URL it was handed, so leaving
              // this out made every picture widget show its text alternative while the bytes sat
              // unread on the node.
              imageUrl={imageUrl}
              mediaUrls={mediaUrls}
              {...(widgetState === undefined ? {} : { state: widgetState })}
              {...(keepsView
                ? {
                    onStateChange: (patch: Record<string, unknown>) => {
                      const id = instance.instanceId;
                      localViews.current.set(id, { ...localViews.current.get(id), ...patch });
                      // "Downloaded" described the view that was exported; once the view changes it no longer does.
                      if (isTable && exportStatus === "done") {
                        setExports((current) => {
                          if (current[id] !== "done") return current;
                          const { [id]: _done, ...rest } = current;
                          return rest;
                        });
                      }
                    },
                  }
                : {})}
              {...(isTable ? { canExport: conversationId !== undefined } : {})}
              {...(conversationId === undefined ? {} : { artifactFiles })}
              {...(conversationId === undefined || definitionId !== MAP_ID ? {} : { mapTiles })}
              {...(needsBinding && !actionReady
                ? {}
                : {
                    onAction: (action: string, payload: Record<string, unknown>, options?: { leaving?: boolean; stateOnly?: boolean }) => {
                      // A table's export is a read the node answers with a file, through its own person-only route.
                      if (isTable && action === "export.requested" && conversationId !== undefined) {
                        if (exportStatus !== "pending") exportTable(conversationId, instance.instanceId, payload);
                        return;
                      }
                      // A chart's, a calendar's or a timeline's view goes through its own binding, without a "done" line: the widget itself
                      // shows it.
                      const viewAction = action === "media.select" ? MEDIA_VIEW_OPERATION : action;
                      if (viewOperations.includes(viewAction)) {
                        const matchingAction = instance.actions?.find((candidate) => candidate.viewOperation === viewAction) ?? boundAction;
                        if (matchingAction !== undefined && matchingAction.available && conversationId !== undefined) {
                          const datasetRef = instance.props.datasetRef;
                          const viewInput = definitionId === BOARD_ID && action === BOARD_MOVE_OPERATION
                            ? { ...payload, external: boundAction !== undefined }
                            : payload;
                          if (options?.stateOnly === true && viewAction === MEDIA_VIEW_OPERATION) {
                            stateWriter.send(
                              {
                                conversation: conversationId,
                                instanceId: instance.instanceId,
                                revision: instance.revision,
                                action: matchingAction,
                                view: viewInput,
                                refused: VIEW_REFUSED[viewAction] ?? "widgets.action.refusedGeneric",
                              },
                              options.leaving === true,
                            );
                            return;
                          }
                          if (options?.leaving === true) {
                            sendView(conversationId, instance.instanceId, typeof datasetRef === "string" ? datasetRef : undefined, matchingAction, instance.revision, viewInput, VIEW_REFUSED[viewAction] ?? "widgets.xyChart.viewRefused", undefined, true);
                            return;
                          }
                          sendView(conversationId, instance.instanceId, typeof datasetRef === "string" ? datasetRef : undefined, matchingAction, instance.revision, viewInput, VIEW_REFUSED[viewAction] ?? "widgets.xyChart.viewRefused", (nextTimeline) => {
                            if (definitionId !== BOARD_ID || action !== BOARD_MOVE_OPERATION || boundAction === undefined) return;
                            const current = nextTimeline.instances.find((entry) => entry.instanceId === instance.instanceId);
                            const invoke = current?.actions?.find((candidate) => candidate.viewOperation === undefined);
                            if (current === undefined || invoke === undefined) return;
                            if (!invoke.available) {
                              const resolve = current.actions?.find((candidate) => candidate.viewOperation === BOARD_RESOLVE_OPERATION);
                              if (resolve !== undefined) sendView(conversationId, current.instanceId, undefined, resolve, current.revision, { outcome: "refused" }, "widgets.action.refusedGeneric");
                              return;
                            }
                            runAction(conversationId, current, invoke, payload, (result, cause) => {
                              const latest = result?.timeline ?? nextTimeline;
                              const settledInstance = latest.instances.find((entry) => entry.instanceId === instance.instanceId);
                              if (settledInstance === undefined) return;
                              const operation = result?.approvalRequired !== undefined ? BOARD_APPROVAL_OPERATION : BOARD_RESOLVE_OPERATION;
                              const viewAction = settledInstance.actions?.find((candidate) => candidate.viewOperation === operation);
                              if (viewAction === undefined || !viewAction.available) return;
                              const input = result?.approvalRequired !== undefined
                                ? { approvalId: result.approvalRequired.approvalId }
                                : { outcome: result === undefined
                                  ? cause instanceof GatewayError && cause.details.outcome === "uncertain" ? "uncertain" : "refused"
                                  : result.outcome === "done" ? "done" : "uncertain",
                                  ...(settledInstance.state?.pendingMove && typeof settledInstance.state.pendingMove === "object" && typeof (settledInstance.state.pendingMove as { approvalId?: unknown }).approvalId === "string"
                                    ? { approvalId: (settledInstance.state.pendingMove as { approvalId: string }).approvalId }
                                    : {}) };
                              sendView(conversationId, settledInstance.instanceId, undefined, viewAction, settledInstance.revision, input, "widgets.action.refusedGeneric");
                            });
                          });
                        }
                        return;
                      }
                      if (boundAction === undefined || conversationId === undefined || actionRun?.pending === true) return;
                      if (needsBinding && !isForm && action === "activate") {
                        runAction(conversationId, instance, boundAction, {});
                        return;
                      }
                      // What a form sends is its values, which the node checks against the fields before the action runs.
                      if (isForm && action === "submit") {
                        const values = payload.values;
                        if (typeof values === "object" && values !== null && !Array.isArray(values)) {
                          runAction(conversationId, instance, boundAction, values as Record<string, unknown>);
                        }
                        return;
                      }
                      // A list item is sent by its id alone, under the one argument the binding takes it as.
                      if (isList && action === "item.activate" && typeof payload.itemId === "string") {
                        const key = boundAction.inputKeys?.[0] ?? DEFAULT_ITEM_KEY;
                        runAction(conversationId, instance, boundAction, { [key]: payload.itemId });
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
      mediaUrls,
      runAction,
      sendView,
      setError,
      snapshots,
      stateWriter,
      t,
      timeline,
      viewRefusals,
    ],
  );
}
