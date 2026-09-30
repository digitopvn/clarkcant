import { createHash } from "node:crypto";

import {
  type Instant,
  type SemanticAction,
  type SemanticProposal,
  type SemanticView,
  type WidgetSemanticDoc,
  artifactViewerSemantic,
  canonicalSemanticDoc,
  describeSemanticDoc,
  graphSemanticState,
  normalizeSemanticDoc,
  readArtifactViewer,
  readStatusCard,
  statusCardSemantic,
  XY_CHART_KIND,
  calendarSemantic,
  isKnownTimeZone,
  readCalendarEvents,
  readCalendarState,
  readXyChart,
  readXyChartView,
  xyChartData,
  xyChartSemantic,
} from "@clarkcant/contracts";
import { ARTIFACT_VIEWER_KIND, CALENDAR, STATUS_CARD_KIND } from "@clarkcant/data-canvas";
import { type WidgetDeps, getActionBinding, getInstance, liveStateOf, semanticViewOf } from "@clarkcant/core";
import {
  findCompositionByInstance,
  getDatasetForPrincipal,
  getWidgetSemantic,
  listTouchedWidgets,
  recordWidgetSemantic,
} from "@clarkcant/storage";

/**
 * What a widget a person changed means now, built from what this node holds (#195).
 *
 * One builder for every reader: the note a model turn ends with, `inspect_ui`, and voice's view of what is on screen.
 * Each reads the same document, so a typed question and a spoken one about the same chart are answered from the same
 * facts.
 */

/** How many touched widgets a turn looks at. The note names fewer; `inspect_ui` can read these. */
export const UI_CONTEXT_WIDGETS_READ = 8;

export type SemanticDeps = WidgetDeps;

/**
 * The actions a person can take on the widget, from the instance's bindings and nowhere else.
 *
 * A view binding is left out: it is how the widget's own controls write their state, which the values already say,
 * not something the agent would offer to do.
 */
function actionsOf(deps: SemanticDeps, bindingIds: readonly string[]): SemanticAction[] {
  return bindingIds.flatMap((bindingId) => {
    const binding = getActionBinding(deps, bindingId);
    if (binding === undefined || binding.proposal.kind === "view") return [];
    return [{ actionBindingId: binding.actionBindingId, label: binding.label, requiresApproval: binding.requiresApproval }];
  });
}

/**
 * The document for one instance, or undefined when this node no longer holds it.
 *
 * A composition says its period, its selected day and its graph values, read from the state row the node stores. A
 * status, progress or details card says what its props say. A widget in its own frame says what it proposed about
 * itself, cleaned and bounded, marked as its own words. Anything else says what it is.
 */
export function buildWidgetSemantic(
  deps: SemanticDeps,
  instanceId: string,
  proposal?: SemanticProposal,
): WidgetSemanticDoc | undefined {
  const instance = getInstance(deps, instanceId);
  if (instance === undefined) return undefined;
  const definitionId = instance.definitionRef.id;
  const availableActions = actionsOf(deps, instance.actionBindingIds);

  const composition = findCompositionByInstance(deps.db, instanceId, instance.ownerPrincipalId);
  if (composition !== undefined) {
    const body = liveStateOf(deps, instanceId)?.body ?? {};
    const graph = graphSemanticState(composition.graph, body.graph);
    const period = typeof body.period === "string" ? body.period : composition.initialState.period;
    const selectedDate = typeof body.selectedDate === "string" ? body.selectedDate : composition.initialState.selectedDate;
    return normalizeSemanticDoc({
      instanceId,
      definitionId,
      // What it is, not what it holds: the values say that, and repeating them here would make every change to one of
      // them a change to the summary too, which a continuing session would be told twice.
      summary: `${composition.templateId} view of ${String(composition.sections.length)} part(s)`,
      // The graph's own keys win over the view's: they are what the model declared for this surface.
      values: { period, ...(selectedDate === undefined ? {} : { selectedDate }), ...(graph?.values ?? {}) },
      availableActions,
    });
  }

  // A status, progress or details card means what its props say. Its freshness is unknown rather than live: the props
  // are what the model stated when it placed the card, and nothing on this node keeps them current.
  const cardKind = STATUS_CARD_KIND[definitionId];
  const card = cardKind === undefined ? undefined : readStatusCard(cardKind, instance.props);
  if (card !== undefined) {
    const meaning = statusCardSemantic(card);
    return normalizeSemanticDoc({ instanceId, definitionId, ...meaning, availableActions, freshness: "unknown" });
  }

  if (proposal !== undefined) {
    return normalizeSemanticDoc({
      instanceId,
      definitionId,
      summary: proposal.summary,
      ...(proposal.values === undefined ? {} : { values: proposal.values }),
      ...(proposal.selectedIds === undefined ? {} : { selectedIds: proposal.selectedIds }),
      availableActions,
      source: "frame",
    });
  }

  // A code, diff or file card says what its props say: a name, a language, line counts, never the body. Its freshness is
  // unknown rather than live: the props are what the model stated when it placed the card, and nothing here re-reads them.
  const viewerKind = ARTIFACT_VIEWER_KIND[definitionId];
  const viewer = viewerKind === undefined ? undefined : readArtifactViewer(viewerKind, instance.props);
  if (viewer !== undefined) {
    return normalizeSemanticDoc({ instanceId, definitionId, ...artifactViewerSemantic(viewer), availableActions, freshness: "unknown" });
  }

  // An area or scatter chart says which series are shown, their ranges and the point selected, from the state row and
  // the rows this node holds now. Its freshness is the dataset's own: the chart is drawn from it, not from the props.
  const chartKind = XY_CHART_KIND[definitionId];
  const chart = chartKind === undefined ? undefined : readXyChart(chartKind, instance.props);
  if (chart !== undefined) {
    const dataset = getDatasetForPrincipal(deps.db, chart.datasetRef, instance.ownerPrincipalId);
    const document = dataset?.document;
    const rows =
      typeof document === "object" && document !== null && Array.isArray((document as { rows?: unknown }).rows)
        ? (document as { rows: unknown[] }).rows
        : [];
    const data = dataset === undefined ? undefined : xyChartData(chart, rows);
    const view = readXyChartView(chart, liveStateOf(deps, instanceId)?.body);
    return normalizeSemanticDoc({
      instanceId,
      definitionId,
      ...xyChartSemantic(chart, data, view),
      availableActions,
      freshness: dataset?.freshness ?? "unknown",
    });
  }

  // A calendar says its view, the day and event selected and what is on that day, from the state row — read in its
  // current shape, so a calendar saved before it had views reads as a month view — and the events this node holds now.
  if (definitionId === CALENDAR.id && typeof instance.props.month === "string" && typeof instance.props.datasetRef === "string") {
    const timeZone = isKnownTimeZone(instance.props.timezone) ? instance.props.timezone : "UTC";
    const dataset = getDatasetForPrincipal(deps.db, instance.props.datasetRef, instance.ownerPrincipalId);
    const document = dataset?.document;
    const rows =
      typeof document === "object" && document !== null && Array.isArray((document as { rows?: unknown }).rows)
        ? (document as { rows: unknown[] }).rows
        : [];
    const read = dataset === undefined ? undefined : readCalendarEvents(rows, timeZone);
    const month = instance.props.month;
    const view = readCalendarState(liveStateOf(deps, instanceId, CALENDAR)?.body, month, instance.props.view, read?.events);
    const title = typeof instance.props.title === "string" && instance.props.title.trim() !== "" ? instance.props.title : undefined;
    return normalizeSemanticDoc({
      instanceId,
      definitionId,
      ...calendarSemantic({ month, timeZone, ...(title === undefined ? {} : { title }) }, read, view),
      availableActions,
      freshness: dataset?.freshness ?? "unknown",
    });
  }
  return normalizeSemanticDoc({ instanceId, definitionId, summary: `${definitionId} (${instance.lifecycle})`, availableActions });
}

export function semanticDigest(doc: WidgetSemanticDoc): string {
  return createHash("sha256").update(canonicalSemanticDoc(doc)).digest("hex");
}

/**
 * Rebuild one touched widget's document and store it, returning it with its revision.
 *
 * This is where the edits since the last read become one change or none: the revision moves only when the rebuilt
 * document differs from the stored one.
 */
export function refreshWidgetSemantic(
  deps: SemanticDeps,
  instanceId: string,
): { doc: WidgetSemanticDoc; revision: number } | undefined {
  const row = getWidgetSemantic(deps.db, instanceId);
  const doc = buildWidgetSemantic(deps, instanceId, row?.proposal);
  if (doc === undefined) return undefined;
  if (row === undefined) return { doc, revision: 0 };
  const revision = recordWidgetSemantic(deps.db, {
    instanceId,
    document: doc,
    digest: semanticDigest(doc),
    at: deps.now() as Instant,
  });
  return { doc, revision };
}

/**
 * A voice view of an instance, told what the widget shows now from the same document a model turn reads.
 *
 * The actions stay the view's own, every binding the instance holds: a spoken "pick next week" is a view action, and
 * voice has to be able to name it. What changes is the account of the widget's state, which was only its name.
 */
export function withSemanticState(deps: SemanticDeps, view: SemanticView): SemanticView {
  const doc = buildWidgetSemantic(deps, view.instanceId, getWidgetSemantic(deps.db, view.instanceId)?.proposal);
  if (doc === undefined || doc.summary === "") return view;
  return {
    ...view,
    summary: doc.summary,
    selectedIds: doc.selectedIds,
    textRepresentation: describeSemanticDoc(doc).join("\n").slice(0, 4000),
  };
}

/** The live view voice decides a sentence against, for the focused instance. */
export function focusedSemanticView(deps: SemanticDeps, instanceId: string): SemanticView | undefined {
  const view = semanticViewOf(deps, instanceId, { source: "live" });
  return view === undefined ? undefined : withSemanticState(deps, view);
}

/** The widgets a person changed in a conversation, newest first, each as it means now. */
export function conversationUiContext(
  deps: SemanticDeps,
  conversationId: string,
  limit = UI_CONTEXT_WIDGETS_READ,
): { doc: WidgetSemanticDoc; revision: number }[] {
  return listTouchedWidgets(deps.db, conversationId, limit).flatMap((row) => {
    const current = refreshWidgetSemantic(deps, row.instanceId);
    return current === undefined ? [] : [current];
  });
}
