/**
 * The views a model may ask for.
 *
 * This is the host's half of the `show_view` contract. The model supplies a view name and some
 * values; everything that turns those values into something renderable happens here. Nothing in
 * this file produces a host-owned card, and that is the point: the catalog is what makes a forged
 * approval unrepresentable rather than merely rejected. The model's vocabulary is exactly the
 * list below, and every entry in it is an ordinary surface.
 *
 * Two things are deliberately not here. There is no view that reports task or connection state —
 * the node builds those cards from its own records, and a model has no records to build one from.
 * The status, progress and details cards below are not that: they show what the model states about
 * something, carry no control and no freshness badge, and never stand in for the node's own cards.
 * And there is no way to pass rows inline: the catalog widgets take an opaque dataset reference,
 * so a large result set never enters the conversation transcript.
 */

import {
  type WidgetDefinition,
  CHOICE_KINDS,
  INPUT_KINDS,
  MAX_COMPOSITION_SECTIONS,
  MAX_FORM_FIELDS,
  MAX_GRAPH_KEYS,
  MAX_GRID_COLUMNS,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_NODES,
  MAX_DETAIL_ITEMS,
  MAX_LIST_ITEMS,
  MAX_PROGRESS_STEPS,
  SNAPSHOT_TEXT_LIMIT,
  STATUS_TONES,
  STEP_STATUSES,
  DIFF_LINE_KINDS,
  MAX_CODE_CHARS,
  MAX_CODE_LINES,
  MAX_DIFF_FILES,
  MAX_DIFF_LINES,
  clipWithMarker,
  formInputSchema,
  parseFields,
  artifactViewerLimitProblems,
  artifactViewerText,
  parseListItems,
  readStatusCard,
  statusCardText,
  readArtifactViewer,
  CALENDAR_VIEWS,
  MAX_CALENDAR_EVENTS,
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
  calendarText,
  isKnownTimeZone,
  monthDates,
  readCalendarEvents,
  XY_CHART_KIND,
  XY_CHART_VIEW_OPERATION,
  MAX_TIMELINE_ACTOR,
  MAX_TIMELINE_DESCRIPTION,
  MAX_TIMELINE_ENTRIES,
  MAX_TIMELINE_TITLE,
  TIMELINE_ORDERS,
  TIMELINE_PAGE_SIZES,
  TIMELINE_SELECT_OPERATION,
  TIMELINE_TIMEZONE_PATTERN,
  MAX_TIMELINE_TIMEZONE,
  readTimeline,
  timelineProblems,
  timelineText,
  compileActionBinding,
  readXyChart,
  xyChartData,
  xyChartProblems,
  xyChartText,
} from "@clarkcant/contracts";
import { getDatasetForPrincipal } from "@clarkcant/storage";
import { type WidgetDeps, placeInstance } from "@clarkcant/core";
import {
  ACTION,
  ACTION_ICONS,
  AREA_CHART,
  ARTIFACT_VIEWER_KIND,
  CALENDAR,
  CHOICE,
  CODE,
  CTA,
  DETAILS,
  DIFF,
  FILE,
  FORM,
  INPUT,
  LIST,
  OVERVIEW,
  PROGRESS,
  SCATTER_CHART,
  SEARCH,
  STATUS,
  STATUS_CARD_KIND,
  TIMELINE,
  WIDGETS as CATALOG_WIDGETS,
  primitivePropsProblems,
} from "@clarkcant/data-canvas";
import {
  type ActionBindingDeps,
  type ActionInputSpec,
  type WidgetActionCompile,
  AGENT_ITEM_KEY,
  compileWidgetAction,
} from "./application/action-bindings.ts";
import { calendarViewBinding } from "./calendar-binding.ts";
import { COMPOSITION_TEMPLATES, type ComposeDeps, type ComposeInput, composeMiniApp } from "./compose-mini-app.ts";
import { composeLayout, layoutLeafWidgets } from "./compose-layout.ts";
import { definitionDigest, validateProps } from "@clarkcant/widget-host";

import type { ViewDescriptor } from "./model-turn.ts";

/**
 * Build the catalog, or nothing when this node holds no widget definitions.
 *
 * Returning an empty list is what keeps the tool unregistered. A catalog that is present but
 * useless would have the model spend a turn discovering that every view is unavailable.
 *
 * The composed surface is registered last and is the only entry whose build is asynchronous: it
 * consults the selector and reads local records before it can say what to draw. The ordinary
 * entries are unchanged, which is what keeps the existing `show_view` path working exactly as it
 * did.
 */
export function buildViewCatalog(
  deps: WidgetDeps,
  compose?: ComposeDeps,
  actions?: () => ActionBindingDeps,
): ViewDescriptor[] {
  // The container is excluded: it is not a leaf a model may place, and registering it twice would
  // give the model a view name whose build knows nothing about the composition. The old call to action is
  // excluded because a model placing one got a button with nothing behind it; `canvas.action@1` replaces it and is
  // registered below, with the build that compiles its action. A form and a list are registered below as well, for the
  // same reason. A choice, an input and a search box do nothing on their own — a value set in one would go nowhere — so
  // a model places them as a form's fields and as a layout's search, never alone.
  //
  // The status cards are registered below too: what they show is all in their props, so their text alternative is
  // written from those props rather than from the definition's generic sentence. So are the code, diff and file
  // viewers: their text alternative is the content itself, written by the node rather than the model. So are the area and
  // scatter charts and the calendar, whose rows are read and checked before an instance exists.
  const placed = new Set([
    OVERVIEW.id,
    CTA.id,
    ACTION.id,
    CHOICE.id,
    INPUT.id,
    SEARCH.id,
    FORM.id,
    LIST.id,
    STATUS.id,
    PROGRESS.id,
    DETAILS.id,
    CODE.id,
    DIFF.id,
    FILE.id,
    AREA_CHART.id,
    SCATTER_CHART.id,
    CALENDAR.id,
    TIMELINE.id,
  ]);
  const simple: ViewDescriptor[] = CATALOG_WIDGETS.filter((definition) => !placed.has(definition.id)).map(
    (definition): ViewDescriptor => ({
    id: definition.id,
    label: definition.semanticDescription,

    /**
     * Create a real instance and capture it.
     *
     * The instance is real rather than a transient render: it is what gives a view an identity to
     * come back to, which is what makes the widget's own state survive reopening the conversation.
     * A snapshot is captured at the same time so the transcript keeps what the user actually saw
     * even after the widget's revision moves on.
     *
     * Invalid props throw, and the tool turns that into a refusal the model reads in the same turn.
     * Storing props no renderer can use is how a timeline becomes unrenderable, so the failure is
     * better raised here than discovered by a user staring at a broken card.
     */
    build: ({ props, caption, principal, messageId }) => {
      // The caption is what a reader sees if the renderer is gone, so it wins over the
      // definition's generic fallback whenever the model supplied one.
      const textAlternative = keptText(definition.id, caption, definition.textFallback);
      const { snapshot } = placeInstance(deps, {
        definition,
        packageDigest: definitionDigest(definition),
        ownerPrincipalId: principal.principalId,
        props,
        messageId,
        textAlternative,
        presentationRef: `catalog:${definition.id}`,
      });

      return {
        type: "surface",
        definitionRef: { id: definition.id, version: definition.version },
        snapshot,
        };
      },
    }),
  );

  if (actions !== undefined) simple.push(actionView(deps, actions), formView(deps, actions));
  simple.push(
    listView(deps, actions),
    ...statusCardViews(deps),
    ...artifactViews(deps),
    ...xyChartViews(deps),
    calendarView(deps),
    timelineView(deps, () => compose?.timezone() ?? nodeTimeZone()),
  );
  if (compose === undefined) return simple;

  const overview = OVERVIEW;
  return [
    ...simple,
    {
      id: overview.id,
      label: overview.semanticDescription,
      notes:
        `For the composed overview, pass props.templateId as one of: ${COMPOSITION_TEMPLATES.map((template) => template.templateId).join(", ")}, ` +
        `and props.period as "week" or "month". Naming a template is what skips the selector. ` +
        `To arrange it yourself, pass props.layout instead of a template: a tree of ` +
        `{"kind":"widget","widget":"<one of ${layoutLeafWidgets(compose.registry).join(", ")}>","props":{...},"label":"..."}, ` +
        `{"kind":"divider"}, and containers {"kind":"stack"|"row"|"grid"|"card"|"tabs"|"split"|"collapsible","label":"...","children":[...]} ` +
        `(grid takes "columns" 1-${String(MAX_GRID_COLUMNS)}; collapsible needs a label and takes "open"; each tab needs a label; a split has two children). ` +
        `At most ${String(MAX_LAYOUT_DEPTH)} levels, ${String(MAX_LAYOUT_NODES)} nodes and ${String(MAX_COMPOSITION_SECTIONS)} widgets; ` +
        `the node fills each widget with its own data. props.title names the surface. ` +
        `To connect widgets, declare props.state as {"<key>":{"type":"string"|"number"|"boolean"|"string-list","initial":...}} ` +
        `(at most ${String(MAX_GRAPH_KEYS)} keys) and give leaves "on" and "feed" lists. "on" entries are {"event":"...","steps":[...]}: ` +
        `canvas.search@1 emits query.change {query}, canvas.choice@1 choice.change {value}, canvas.input@1 input.change {value}, ` +
        `canvas.list@1 selection.change {selected}, canvas.table@1 row.select {rowIds}, canvas.calendar@1 date.select {date}, canvas.timeline@1 timeline.select {selectedId}. ` +
        `Steps: {"op":"select-field","key","field"}, {"op":"set","key","value"}, {"op":"toggle","key","field"?}, {"op":"copy","key","from"}, ` +
        `{"op":"append"|"remove","key","field"}, {"op":"map-field","key","field","map":{...},"fallback"?}, {"op":"take","key","field","count"}, {"op":"count","key","field"}. ` +
        `"feed" entries are {"op":"query","key"} for a table or list, or {"op":"filter-equals","field","key"} for a table column, ` +
        `a list's title/subtitle/meta, or a chart's "series". A choice or input is placed only with an "on" rule; ` +
        `with no props.state, a search box narrows every table by itself.`,
      build: async (request) => {
        const templateId = request.props.templateId;
        const period = request.props.period;
        const common: ComposeInput = {
          conversationId: request.conversationId,
          messageId: request.messageId,
          principalId: request.principal.principalId,
          // The caption is the model's own sentence about what it is showing, and it is the only
          // free text the selector is offered. The user's raw message is not sent.
          intent: request.caption,
          ...(period === "week" || period === "month" ? { period } : {}),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        };
        const outcome =
          request.props.layout === undefined
            ? await composeMiniApp(compose, { ...common, ...(typeof templateId === "string" ? { explicitTemplateId: templateId } : {}) })
            : composeLayout(compose, {
                ...common,
                layout: request.props.layout,
                ...(typeof request.props.title === "string" ? { title: request.props.title } : {}),
                ...(request.props.state === undefined ? {} : { state: request.props.state }),
              });

        if (!outcome.ok) {
          // Thrown rather than returned so the tool handler turns it into a refusal the model reads
          // in the same turn; a failed request must not leave a card behind that looks like success.
          throw new Error(
            outcome.problems === undefined
              ? outcome.message
              : `${outcome.message}: ${outcome.problems.join("; ")}`,
          );
        }
        return outcome.block;
      },
    },
  ];
}

/** The context-reference grammar, as the model is told it (`application/action-context.ts`). */
const CONTEXT_REFS_NOTE =
  `"widget" or "widget:<instanceId>" for what a widget shows, "selection" or "selection:<instanceId>" for what is ` +
  `selected in it, "state:<key>" or "state:<instanceId>/<key>" for a composed view's state value, "artifact:<artifactId>" ` +
  `for a file the button's widget holds (its name, type, size, and the start of a text file); only widgets and files ` +
  `the same person owns`;

/** The workflow step vocabulary, as the model is told it (`application/workflow-executor.ts`). */
const WORKFLOW_NOTE =
  `each step {"stepId","kind","dependsOn":[...]}: "invoke" with "capabilityRef" and "args", where an arg may be ` +
  `{"$step":"<a step it depends on>"} (optionally with "field") or {"$input":"<a key the widget sends>"}; "transform" ` +
  `with "transform" select-field | map-field | filter-equals | take | count and its args (field, value, count); ` +
  `"condition" with {"field","operator","value"} — a false one skips the steps that depend on it`;

/**
 * The one button a model may place, with the action it performs.
 *
 * `props.action` is taken out before anything is stored: the host compiles it into a binding and keeps it, and the
 * instance holds only what the button shows. A proposal the host refuses is thrown before the instance exists, so the
 * model reads the refusal in the same turn and no button without an action is left in the conversation.
 */
function actionView(deps: WidgetDeps, bindingDeps: () => ActionBindingDeps): ViewDescriptor {
  return {
    id: ACTION.id,
    label: ACTION.semanticDescription,
    notes:
      `props.label is the button text (also the request sent to Clark for an agent action); optional props.description, ` +
      `props.emphasis ("primary" | "secondary") and props.icon (${ACTION_ICONS.join(" | ")}). ` +
      `props.action is required and is exactly one of: {"kind":"agent","intent":"<what Clark should do when pressed>"}, ` +
      `optionally with "contextRefs" the host reads for the request (${CONTEXT_REFS_NOTE}) and "background":true to run it ` +
      `as background work; {"kind":"invoke","capabilityRef":"<a package service capability>","args":{...}}; ` +
      `{"kind":"view","operation":"view.save","args":{}} to pin this button to the conversation; ` +
      `or {"kind":"workflow","steps":[...]} over package service capabilities (${WORKFLOW_NOTE}). ` +
      `An agent, invoke or workflow action may add "limits" to tighten the host's own: ` +
      `invoke and workflow {"deadlineMs","maxCallsPerMinute"}, agent {"maxTokens","maxCallsPerMinute"}.`,
    shownText:
      "Shown: canvas.action@1. The button is bound to that action; nothing has run yet, and it runs only when the person presses it.",
    build: ({ props, caption, principal, messageId }) => {
      const { action, ...shown } = props;
      if (action === undefined) throw new Error("canvas.action@1 needs props.action: the action the button performs");
      const definitionRef = { id: ACTION.id, version: ACTION.version, packageDigest: definitionDigest(ACTION) };
      const compiled = compileWidgetAction(bindingDeps(), {
        definitionRef,
        label: typeof shown.label === "string" ? shown.label : "",
        action,
        ownerPrincipalId: principal.principalId,
      });
      if (!compiled.ok) throw new Error(compiled.message);
      const textAlternative = keptText(ACTION.id, caption, `${String(shown.label)}. ${ACTION.textFallback}`);

      const { snapshot } = placeInstance(deps, {
        definition: ACTION,
        packageDigest: definitionRef.packageDigest,
        ownerPrincipalId: principal.principalId,
        props: shown,
        bind: compiled.bindTo,
        messageId,
        textAlternative,
        presentationRef: `catalog:${ACTION.id}`,
      });
      return { type: "surface", definitionRef: { id: ACTION.id, version: ACTION.version }, snapshot };
    },
  };
}

/** The action kinds a form or a list item may be bound to, as the model is told them. */
const SENDING_ACTIONS =
  `{"kind":"agent","intent":"<what Clark should do with what was sent>"}, or ` +
  `{"kind":"invoke","capabilityRef":"<a package service capability>","args":{...}}`;

type ViewRequest = Parameters<ViewDescriptor["build"]>[0];

/**
 * The text a widget's snapshot keeps: the model's caption, or the widget's own words when it wrote none.
 *
 * Checked before anything is stored. A snapshot with more text than a reader of the conversation accepts would make the
 * whole conversation fail to open. A caption that long is the model's to shorten, so it is refused in the same turn with
 * nothing left behind; the widget's own words are built by this node from props that already passed their schema, so
 * they are shortened, and say so, rather than refusing a widget the model placed correctly.
 */
function keptText(definitionId: string, caption: string, fallback: string): string {
  if (caption.trim() === "") return clipWithMarker(fallback, SNAPSHOT_TEXT_LIMIT);
  if (caption.length > SNAPSHOT_TEXT_LIMIT) {
    throw new Error(
      `${definitionId} cannot be shown: its caption is ${String(caption.length)} characters and at most ${String(SNAPSHOT_TEXT_LIMIT)} are kept; write one short sentence`,
    );
  }
  return caption;
}

/**
 * Store one widget whose action sends something: compile the action with what it carries, then make the instance, bind
 * it and capture it.
 *
 * Props a model wrote are held to the whole schema and to what the schema cannot say before anything is compiled, so a
 * widget that could never be used is refused in the same turn and nothing is left behind.
 */
function placeSending(
  deps: WidgetDeps,
  bindingDeps: (() => ActionBindingDeps) | undefined,
  definition: WidgetDefinition,
  request: ViewRequest,
  sending: { action: unknown; label: string; carries: ActionInputSpec } | undefined,
  textAlternative: string,
): ReturnType<ViewDescriptor["build"]> {
  const full = validateProps(definition, request.props);
  if (!full.ok) throw new Error(`${definition.id} has props that do not fit its schema: ${full.problems.join(", ")}`);
  const problems = primitivePropsProblems(definition.id, request.props);
  if (problems.length > 0) throw new Error(`${definition.id} cannot be shown: ${problems.join("; ")}`);

  const definitionRef = { id: definition.id, version: definition.version, packageDigest: definitionDigest(definition) };
  let compiled: Extract<WidgetActionCompile, { ok: true }> | undefined;
  if (sending !== undefined) {
    if (bindingDeps === undefined) throw new Error(`this node cannot bind an action to ${definition.id}`);
    const result = compileWidgetAction(bindingDeps(), {
      definitionRef,
      label: sending.label,
      action: sending.action,
      carries: sending.carries,
      ownerPrincipalId: request.principal.principalId,
    });
    if (!result.ok) throw new Error(result.message);
    compiled = result;
  }
  const kept = keptText(definition.id, request.caption, textAlternative);

  const { snapshot } = placeInstance(deps, {
    definition,
    packageDigest: definitionRef.packageDigest,
    ownerPrincipalId: request.principal.principalId,
    props: request.props,
    ...(compiled === undefined ? {} : { bind: compiled.bindTo }),
    messageId: request.messageId,
    textAlternative: kept,
    presentationRef: `catalog:${definition.id}`,
  });
  return { type: "surface", definitionRef: { id: definition.id, version: definition.version }, snapshot };
}

/**
 * A form a person fills in and sends to one bound action.
 *
 * The binding records the form's own fields as the input it accepts, so the node checks every submission against them
 * before anything runs. An `invoke` action takes each field as the capability argument of the same name.
 */
function formView(deps: WidgetDeps, bindingDeps: () => ActionBindingDeps): ViewDescriptor {
  return {
    id: FORM.id,
    label: FORM.semanticDescription,
    notes:
      `props.submitLabel is the send button's text; optional props.title and props.description. ` +
      `props.fields is 1-${String(MAX_FORM_FIELDS)} of {"name":"<identifier>","label":"...","kind":"<kind>","required"?:true,"help"?,"placeholder"?}, ` +
      `kind one of ${[...CHOICE_KINDS, ...INPUT_KINDS].join(", ")}; a choice takes "options":[{"value","label"}], ` +
      `number and slider take min/max/step (a slider needs min and max), text takes minLength/maxLength/multiline. ` +
      `Never ask for a password, token, key or other secret in a field: such a form is refused. ` +
      `props.action is required and is exactly one of: ${SENDING_ACTIONS}; an invoke gets each field as the argument of the same name.`,
    shownText:
      "Shown: canvas.form@1. Nothing has been sent; the node checks what the person enters and sends it to the action only when they submit.",
    build: (request) => {
      const { action, ...shown } = request.props;
      if (action === undefined) throw new Error("canvas.form@1 needs props.action: what sending the form does");
      const fields = parseFields(shown.fields) ?? [];
      const carries: ActionInputSpec = {
        source: "user-input",
        noun: "form",
        keys: fields.map((field) => field.name),
        schema: () => formInputSchema(fields),
      };
      const submitLabel = typeof shown.submitLabel === "string" ? shown.submitLabel : "";
      const title = typeof shown.title === "string" && shown.title !== "" ? shown.title : submitLabel;
      const text = `${title}: ${fields.map((field) => `${field.label}${field.required === true ? " *" : ""}`).join(", ")}. ${FORM.textFallback}`;
      return placeSending(deps, bindingDeps, FORM, { ...request, props: shown }, { action, label: submitLabel, carries }, text);
    },
  };
}

/**
 * A list of items with stable ids, and optionally one action a person runs on an item.
 *
 * With an action, the binding records the list's own ids as the only values it accepts, so an item that is not in the
 * list is refused by the node whatever the page sends.
 */
function listView(deps: WidgetDeps, bindingDeps: (() => ActionBindingDeps) | undefined): ViewDescriptor {
  return {
    id: LIST.id,
    label: LIST.semanticDescription,
    notes:
      `props.items is up to ${String(MAX_LIST_ITEMS)} of {"id":"<stable id>","title":"...","subtitle"?,"meta"?}; ` +
      `optional props.title, props.selection ("none" | "single" | "multi"), props.pageSize and props.emptyText. ` +
      `To let a person act on one item, pass props.itemActionLabel (the button text) with props.action, one of: ${SENDING_ACTIONS}; ` +
      `an invoke names the argument that takes the item's id: "bindings":[{"target":"<argument>","source":"selected-row"}].`,
    shownText: "Shown: canvas.list@1. An item's action runs only when the person presses it on that item.",
    build: (request) => {
      const { action, ...shown } = request.props;
      const label = shown.itemActionLabel;
      if ((action === undefined) !== (label === undefined)) {
        throw new Error("canvas.list@1 takes props.itemActionLabel and props.action together: the button and what it does");
      }
      const items = parseListItems(shown.items) ?? [];
      const ids = items.map((item) => item.id);
      const carries: ActionInputSpec = {
        source: "selected-row",
        noun: "list",
        schema: (keys) => {
          const key = keys[0] ?? AGENT_ITEM_KEY;
          return { type: "object", additionalProperties: false, properties: { [key]: { type: "string", enum: ids } }, required: [key] };
        },
      };
      const title = typeof shown.title === "string" && shown.title !== "" ? `${shown.title}: ` : "";
      const shownItems = items.slice(0, 20).map((item) => item.title).join("; ");
      const more = items.length > 20 ? ` (+${String(items.length - 20)})` : "";
      const text = items.length === 0 ? `${title}${typeof shown.emptyText === "string" ? shown.emptyText : LIST.textFallback}` : `${title}${shownItems}${more}`;
      return placeSending(
        deps,
        bindingDeps,
        LIST,
        { ...request, props: shown },
        action === undefined ? undefined : { action, label: String(label), carries },
        text,
      );
    },
  };
}

/** What the model is told about each status card's props. */
const STATUS_CARD_NOTES: Readonly<Record<string, string>> = {
  [STATUS.id]:
    `props.label is the status in a few words and props.tone one of ${STATUS_TONES.join(", ")}; optional props.title, ` +
    `props.detail and props.asOf (a day like 2026-09-30, or an instant with its offset like 2026-09-30T09:00:00+07:00). ` +
    `Not for this node's own tasks, runs or connections: those already have live cards, and this card only repeats what you wrote.`,
  [PROGRESS.id]:
    `Either props.value and props.max (value 0 to max; optional props.unit), or props.steps: 1-${String(MAX_PROGRESS_STEPS)} of ` +
    `{"label":"...","status":"${STEP_STATUSES.join('" | "')}","detail"?} with at most one current step. ` +
    `Optional props.title, props.label (what is progressing) and props.asOf. Only a value you actually know: never a guess. ` +
    `Not for this node's own tasks and runs: those already have a live task card, and this card only repeats what you wrote.`,
  [DETAILS.id]:
    `props.items is 1-${String(MAX_DETAIL_ITEMS)} of {"label":"...","value":"..."}, each label once; optional props.title and props.asOf.`,
};

/**
 * The status, progress and details cards.
 *
 * Nothing on them acts and nothing on them is read from the node, so the model is told exactly that: the card shows what
 * it wrote, and says "as of" only when the model gave a time.
 */
function statusCardViews(deps: WidgetDeps): ViewDescriptor[] {
  return [STATUS, PROGRESS, DETAILS].map((definition) => ({
    id: definition.id,
    label: definition.semanticDescription,
    notes: STATUS_CARD_NOTES[definition.id] ?? "",
    shownText: `Shown: ${definition.id}. It shows what you wrote, not a live reading, and nothing on it acts.`,
    build: (request) => {
      const kind = STATUS_CARD_KIND[definition.id];
      if (kind === undefined) throw new Error(`${definition.id} is not a status card`);
      const content = readStatusCard(kind, request.props);
      const text = content === undefined ? definition.textFallback : statusCardText(content);
      // The card's own words are its text alternative: a caption would only repeat what the card says, less exactly.
      return placeSending(deps, undefined, definition, { ...request, caption: "" }, undefined, text);
    },
  }));
}

/** What the model is told about each artifact viewer's props. */
const ARTIFACT_VIEWER_NOTES: Readonly<Record<string, string>> = {
  [CODE.id]:
    `props.code is the code itself (at most ${String(MAX_CODE_LINES)} lines and ${String(MAX_CODE_CHARS)} characters); ` +
    `optional props.path (shown as text), props.language (a name like "ts" or "python"; the path's extension otherwise), ` +
    `props.startLine for an excerpt, props.title, and props.truncated:true when you cut the code to fit. A control, bidi or ` +
    `invisible character in the code is shown as a marker such as ⟨U+202E⟩, and the card warns about it.`,
  [DIFF.id]:
    `props.files is 1-${String(MAX_DIFF_FILES)} of {"path":"...","oldPath"?,"hunks":[{"oldStart":n,"newStart":n,"section"?,` +
    `"lines":[{"kind":"${DIFF_LINE_KINDS.join('" | "')}","text":"<one line, without its +/- sign>"}]}]}, hunks in file order; ` +
    `oldStart 0 for a new file, newStart 0 for a deleted one. Each hunk's numbers must follow from the hunks above it in the ` +
    `same file. At most ${String(MAX_DIFF_LINES)} lines in all: set props.truncated:true when you left part of the change out. ` +
    `The card counts additions and removals itself.`,
  [FILE.id]:
    `props.name is the file's own name; optional props.mediaType (type/subtype), props.sizeBytes, props.source (where it came from, in words), ` +
    `props.path (shown as text, never a URL), props.summary and props.title. Without props.artifactRef the card has no link and cannot ` +
    `open or download the file. With props.artifactRef — the {"v":1,"artifactId":"art_…",…} reference a widget or tool gave you, ` +
    `copied whole — the person can open the file or save it; the node checks each time that it is theirs.`,
};

/**
 * The code, diff and file viewers.
 *
 * Nothing on them is read from the node and nothing links anywhere, so the model is told exactly that. The copy button on
 * a code card copies the text already on the page and reaches nothing on the node. Props over a limit are refused first,
 * in words that say by how much and what to do, before the schema's generic "too long" could say it less usefully.
 */
function artifactViews(deps: WidgetDeps): ViewDescriptor[] {
  return [CODE, DIFF, FILE].map((definition) => ({
    id: definition.id,
    label: definition.semanticDescription,
    notes: ARTIFACT_VIEWER_NOTES[definition.id] ?? "",
    shownText: `Shown: ${definition.id}. It shows what you wrote, as text; it opens and fetches nothing.`,
    build: (request) => {
      const kind = ARTIFACT_VIEWER_KIND[definition.id];
      if (kind === undefined) throw new Error(`${definition.id} is not a code, diff or file viewer`);
      const limits = artifactViewerLimitProblems(kind, request.props);
      if (limits.length > 0) throw new Error(`${definition.id} cannot be shown: ${limits.join("; ")}`);
      const content = readArtifactViewer(kind, request.props);
      const text = content === undefined ? definition.textFallback : artifactViewerText(content);
      // The card's own content is its text alternative: a caption would say less than the code or diff it stands for.
      return placeSending(deps, undefined, definition, { ...request, caption: "" }, undefined, text);
    },
  }));
}

/** What the model is told about each chart's props. */
const XY_CHART_NOTES: Readonly<Record<string, string>> = {
  [AREA_CHART.id]:
    `props.datasetRef names a dataset on this node; props.x is the field on the x axis (text categories in row order, or ` +
    `numbers that rise row by row) and props.y is 1-${String(MAX_CHART_SERIES)} numeric fields, each drawn as a series. ` +
    `Name every field exactly as the rows spell it: nothing is guessed. Optional props.labels ({"<field>":"<what to call it>"}), ` +
    `props.unit, props.title, and props.stacked:true to stack the series (no negative values then). ` +
    `A chart draws the first ${String(MAX_CHART_POINTS)} rows and says how many it left out.`,
  [SCATTER_CHART.id]:
    `props.datasetRef names a dataset on this node; props.x is a numeric field and props.y is 1-${String(MAX_CHART_SERIES)} numeric ` +
    `fields, each drawn as its own series of points against x. Name every field exactly as the rows spell it: nothing is guessed. ` +
    `Optional props.pointLabel (a field other than x and y that names each point), props.labels ({"<field>":"<what to call it>"}), props.unit (y), ` +
    `props.xUnit and props.title. A chart draws the first ${String(MAX_CHART_POINTS)} rows and says how many it left out.`,
};

/**
 * The area and scatter charts.
 *
 * The rows are read here, before an instance exists, so a field the model named that the rows do not have, or a value
 * that is not a number, is refused in the same turn with the host's reason rather than drawn as an empty or zeroed
 * chart. Each chart is placed with the one view binding its legend and points write through; the binding is a view
 * operation, so it reads and re-renders and never acts outside the node's own state.
 */
function xyChartViews(deps: WidgetDeps): ViewDescriptor[] {
  return [AREA_CHART, SCATTER_CHART].map((definition) => ({
    id: definition.id,
    label: definition.semanticDescription,
    notes: XY_CHART_NOTES[definition.id] ?? "",
    shownText:
      `Shown: ${definition.id}, drawn from the dataset as it is now. A person can hide series and select a point; ` +
      `what they chose is in the chart's widget state.`,
    build: (request) => {
      const kind = XY_CHART_KIND[definition.id];
      if (kind === undefined) throw new Error(`${definition.id} is not an area or scatter chart`);
      const full = validateProps(definition, request.props);
      if (!full.ok) throw new Error(`${definition.id} has props that do not fit its schema: ${full.problems.join(", ")}`);
      const own = xyChartProblems(kind, request.props);
      if (own.length > 0) throw new Error(`${definition.id} cannot be shown: ${own.join("; ")}`);
      const chart = readXyChart(kind, request.props);
      if (chart === undefined) throw new Error(`${definition.id} cannot be shown: its props do not describe a chart`);

      const dataset = getDatasetForPrincipal(deps.db, chart.datasetRef, request.principal.principalId);
      if (dataset === undefined) {
        throw new Error(`${definition.id} cannot be shown: dataset "${chart.datasetRef}" is not on this node, or is not yours to read`);
      }
      const document = typeof dataset.document === "object" && dataset.document !== null ? (dataset.document as Record<string, unknown>) : {};
      const rows = Array.isArray(document.rows) ? (document.rows as unknown[]) : [];
      const columns = Array.isArray(document.columns) ? (document.columns as unknown[]) : undefined;
      const problems = xyChartProblems(kind, request.props, rows, columns);
      if (problems.length > 0) throw new Error(`${definition.id} cannot be shown: ${problems.join("; ")}`);

      const packageDigest = definitionDigest(definition);
      // The chart's own words are its text alternative: series, ranges and how many rows it drew, from the rows it read.
      const textAlternative = keptText(definition.id, "", xyChartText(chart, xyChartData(chart, rows)));
      const { snapshot } = placeInstance(deps, {
        definition,
        packageDigest,
        ownerPrincipalId: request.principal.principalId,
        props: request.props,
        bind: (instanceId) => {
          const compiled = compileActionBinding({
            bindingId: deps.newId("act"),
            instance: {
              instanceId,
              ownerNodeId: deps.nodeId,
              definitionRef: { id: definition.id, version: definition.version, packageDigest },
              actionBindingRevision: 1,
            },
            packageGeneration: packageDigest,
            label: "Chart view",
            proposal: { kind: "view", operation: XY_CHART_VIEW_OPERATION, args: {} },
            inputSchema: { type: "object" },
            allowedDataRefs: [chart.datasetRef],
            fixedConstraints: {},
            // A view operation reads and re-renders; it writes nothing outside the node's own state.
            effectCategory: "read",
            requiresApproval: false,
            limits: {},
            bindingDigest: `sha256:${XY_CHART_VIEW_OPERATION}:${instanceId}`,
            at: deps.now(),
            knownCapabilities: new Set(),
          });
          if (!compiled.ok) throw new Error(compiled.message);
          return compiled.binding;
        },
        messageId: request.messageId,
        textAlternative,
        presentationRef: `catalog:${definition.id}`,
      });
      return { type: "surface", definitionRef: { id: definition.id, version: definition.version }, snapshot };
    },
  }));
}

/**
 * The calendar.
 *
 * The month, the timezone and the dataset are checked here, before an instance exists, so a calendar that would open on
 * no month, in a timezone this node cannot place instants in, or over rows that are not the person's is refused in the
 * same turn with the reason. It is placed with the one view binding its view switcher, days and events write through;
 * the binding is a view operation, so it reads and re-renders and never changes an event. Adding, moving or removing an
 * event stays the capability of whatever owns the events.
 */
function calendarView(deps: WidgetDeps): ViewDescriptor {
  const definition = CALENDAR;
  return {
    id: definition.id,
    label: definition.semanticDescription,
    notes:
      `props.datasetRef names a dataset on this node whose rows are events: {title, startsAt, endsAt} with ISO instants, or ` +
      `{title, allDay:true, startDate, endDate} with endDate the day after the last day, or {title, date}; eventId and ` +
      `timezone are optional. props.month is YYYY-MM; props.timezone (an IANA name, default UTC) is the one the events are ` +
      `shown in; optional props.view (${CALENDAR_VIEWS.join(", ")}) is the view it opens in, and props.title. ` +
      `The calendar reads the first ${String(MAX_CALENDAR_EVENTS)} rows. It shows events; it does not add or change them.`,
    shownText:
      `Shown: ${definition.id}, drawn from the dataset as it is now. A person can switch between month, week and agenda ` +
      `and select a day or an event; what they chose is in the calendar's widget state.`,
    build: (request) => {
      const full = validateProps(definition, request.props);
      if (!full.ok) throw new Error(`${definition.id} has props that do not fit its schema: ${full.problems.join(", ")}`);
      const month = typeof request.props.month === "string" ? request.props.month : "";
      if (!/^\d{4}-\d{2}$/.test(month) || monthDates(month).length === 0) {
        throw new Error(`${definition.id} cannot be shown: props.month "${month}" is not a month in YYYY-MM form`);
      }
      const timeZone = request.props.timezone ?? "UTC";
      if (!isKnownTimeZone(timeZone)) {
        throw new Error(`${definition.id} cannot be shown: props.timezone "${String(timeZone)}" is not a timezone this node knows`);
      }
      const datasetRef = String(request.props.datasetRef);
      const dataset = getDatasetForPrincipal(deps.db, datasetRef, request.principal.principalId);
      if (dataset === undefined) {
        throw new Error(`${definition.id} cannot be shown: dataset "${datasetRef}" is not on this node, or is not yours to read`);
      }
      const document = typeof dataset.document === "object" && dataset.document !== null ? (dataset.document as Record<string, unknown>) : {};
      const rows = Array.isArray(document.rows) ? (document.rows as unknown[]) : [];
      const read = readCalendarEvents(rows, timeZone);
      const title = typeof request.props.title === "string" && request.props.title.trim() !== "" ? request.props.title : undefined;

      const packageDigest = definitionDigest(definition);
      // The calendar's own words are its text alternative: each event of the month and when it is, from the rows it read.
      const textAlternative = keptText(definition.id, "", calendarText({ month, timeZone, ...(title === undefined ? {} : { title }) }, read));
      const { snapshot } = placeInstance(deps, {
        definition,
        packageDigest,
        ownerPrincipalId: request.principal.principalId,
        props: request.props,
        bind: (instanceId) =>
          calendarViewBinding(deps, {
            instanceId,
            definitionRef: { id: definition.id, version: definition.version, packageDigest },
            datasetRef,
          }),
        messageId: request.messageId,
        textAlternative,
        presentationRef: `catalog:${definition.id}`,
      });
      return { type: "surface", definitionRef: { id: definition.id, version: definition.version }, snapshot };
    },
  };
}
/** The node's own display timezone, or UTC when the platform names none. */
function nodeTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * The timezone a timeline without one is placed in: the node's own, when it is a name the timeline's schema accepts
 * and this node can place instants in, and UTC otherwise.
 *
 * Written into the stored props rather than left for each reader to guess, so the node's semantic document, its text
 * alternative and the page all group entries into the same days.
 */
function timelineTimeZone(zone: string): string {
  return zone.length <= MAX_TIMELINE_TIMEZONE && new RegExp(TIMELINE_TIMEZONE_PATTERN).test(zone) && isKnownTimeZone(zone) ? zone : "UTC";
}

/**
 * The activity timeline.
 *
 * Everything it shows is in its props, so the props are held to the timeline's whole rule set here, before an instance
 * exists: a time that is not a real ISO 8601 instant with an offset or a date, an id used twice, an unknown tone, too many
 * entries or too much text, or a hidden character is refused in the same turn with the reason, and nothing is left
 * behind. It is placed with the one view binding a selection writes through; the binding is a view operation, so it
 * re-renders and never changes an entry.
 */
function timelineView(deps: WidgetDeps, timezone: () => string): ViewDescriptor {
  const definition = TIMELINE;
  return {
    id: definition.id,
    label: definition.semanticDescription,
    notes:
      `props.entries is a list of at most ${String(MAX_TIMELINE_ENTRIES)} entries {"id","at","title","description"?,"actor"?,"tone"?}: ` +
      `each id is unique; "at" is an ISO 8601 instant with an offset (2026-09-30T09:15:00+07:00 or ...Z) or a date (2026-09-30) ` +
      `for an all-day entry; title is one line of at most ${String(MAX_TIMELINE_TITLE)} characters; description is plain text of at ` +
      `most ${String(MAX_TIMELINE_DESCRIPTION)}; actor names who did it in at most ${String(MAX_TIMELINE_ACTOR)}; tone is one of ` +
      `${STATUS_TONES.join(", ")} (default neutral). Optional props.order (${TIMELINE_ORDERS.join(", ")}, default newest), ` +
      `props.pageSize (${String(TIMELINE_PAGE_SIZES.min)}-${String(TIMELINE_PAGE_SIZES.max)}, default ${String(TIMELINE_PAGE_SIZES.default)}), ` +
      `props.timezone (an IANA name the entries are grouped into days in; default this node's), props.title, and ` +
      `props.truncated: true when you left entries out. Text is plain: no HTML, links or hidden characters.`,
    shownText:
      `Shown: ${definition.id}, from the entries you gave. A person can page through it and select an entry; ` +
      `what they selected is in the timeline's widget state.`,
    build: (request) => {
      const full = validateProps(definition, request.props);
      if (!full.ok) throw new Error(`${definition.id} has props that do not fit its schema: ${full.problems.join(", ")}`);
      const problems = timelineProblems(request.props);
      if (problems.length > 0) throw new Error(`${definition.id} cannot be shown: ${problems.join("; ")}`);
      const props = request.props.timezone === undefined ? { ...request.props, timezone: timelineTimeZone(timezone()) } : request.props;
      const timeline = readTimeline(props);
      if (timeline === undefined) throw new Error(`${definition.id} cannot be shown: its props do not describe a timeline`);

      const packageDigest = definitionDigest(definition);
      // The timeline's own words are its text alternative: every day and entry it shows, written by the node.
      const textAlternative = keptText(definition.id, "", timelineText(timeline, SNAPSHOT_TEXT_LIMIT));
      const { snapshot } = placeInstance(deps, {
        definition,
        packageDigest,
        ownerPrincipalId: request.principal.principalId,
        props,
        bind: (instanceId) => {
          const compiled = compileActionBinding({
            bindingId: deps.newId("act"),
            instance: {
              instanceId,
              ownerNodeId: deps.nodeId,
              definitionRef: { id: definition.id, version: definition.version, packageDigest },
              actionBindingRevision: 1,
            },
            packageGeneration: packageDigest,
            label: "Timeline selection",
            proposal: { kind: "view", operation: TIMELINE_SELECT_OPERATION, args: {} },
            inputSchema: { type: "object" },
            // Everything the timeline shows is in its props; a selection reads no dataset.
            allowedDataRefs: [],
            fixedConstraints: {},
            effectCategory: "read",
            requiresApproval: false,
            limits: {},
            bindingDigest: `sha256:${TIMELINE_SELECT_OPERATION}:${instanceId}`,
            at: deps.now(),
            knownCapabilities: new Set(),
          });
          if (!compiled.ok) throw new Error(compiled.message);
          return compiled.binding;
        },
        messageId: request.messageId,
        textAlternative,
        presentationRef: `catalog:${definition.id}`,
      });
      return { type: "surface", definitionRef: { id: definition.id, version: definition.version }, snapshot };
    },
  };
}