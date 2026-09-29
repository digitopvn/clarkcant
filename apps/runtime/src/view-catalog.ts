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
 * And there is no way to pass rows inline: the catalog widgets take an opaque dataset reference,
 * so a large result set never enters the conversation transcript.
 */

import {
  type WidgetDefinition,
  type WidgetInstance,
  type WidgetSnapshot,
  CHOICE_KINDS,
  INPUT_KINDS,
  MAX_COMPOSITION_SECTIONS,
  MAX_FORM_FIELDS,
  MAX_GRAPH_KEYS,
  MAX_GRID_COLUMNS,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_NODES,
  MAX_LIST_ITEMS,
  formInputSchema,
  parseFields,
  parseListItems,
} from "@clarkcant/contracts";
import {
  type WidgetDeps,
  captureSnapshot,
  createInstance,
  saveActionBinding,
} from "@clarkcant/core";
import {
  ACTION,
  ACTION_ICONS,
  CHOICE,
  CTA,
  FORM,
  INPUT,
  LIST,
  OVERVIEW,
  SEARCH,
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
  const placed = new Set([OVERVIEW.id, CTA.id, ACTION.id, CHOICE.id, INPUT.id, SEARCH.id, FORM.id, LIST.id]);
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
      const instance: WidgetInstance = createInstance(deps, {
        definition,
        packageDigest: definitionDigest(definition),
        ownerPrincipalId: principal.principalId,
        props,
      });

      const snapshot: WidgetSnapshot = captureSnapshot(deps, {
        messageId,
        instance,
        // The caption is what a reader sees if the renderer is gone, so it wins over the
        // definition's generic fallback whenever the model supplied one.
        textAlternative: caption.trim() === "" ? definition.textFallback : caption,
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
  simple.push(listView(deps, actions));
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
        `canvas.list@1 selection.change {selected}, canvas.table@1 row.select {rowIds}, canvas.calendar@1 date.select {date}. ` +
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
      `props.action is required and is exactly one of: {"kind":"agent","intent":"<what Clark should do when pressed>"}; ` +
      `{"kind":"invoke","capabilityRef":"<a package service capability>","args":{...}}; ` +
      `{"kind":"view","operation":"view.save","args":{}} to pin this button to the conversation; ` +
      `or {"kind":"workflow","steps":[...]}, which this node shows but cannot run yet.`,
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
      });
      if (!compiled.ok) throw new Error(compiled.message);

      const instance: WidgetInstance = createInstance(deps, {
        definition: ACTION,
        packageDigest: definitionRef.packageDigest,
        ownerPrincipalId: principal.principalId,
        props: shown,
      });
      saveActionBinding(deps, compiled.bindTo(instance.instanceId));
      const snapshot: WidgetSnapshot = captureSnapshot(deps, {
        messageId,
        instance,
        textAlternative: caption.trim() === "" ? `${String(shown.label)}. ${ACTION.textFallback}` : caption,
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
    const result = compileWidgetAction(bindingDeps(), { definitionRef, label: sending.label, action: sending.action, carries: sending.carries });
    if (!result.ok) throw new Error(result.message);
    compiled = result;
  }

  const instance: WidgetInstance = createInstance(deps, {
    definition,
    packageDigest: definitionRef.packageDigest,
    ownerPrincipalId: request.principal.principalId,
    props: request.props,
  });
  if (compiled !== undefined) saveActionBinding(deps, compiled.bindTo(instance.instanceId));
  const snapshot: WidgetSnapshot = captureSnapshot(deps, {
    messageId: request.messageId,
    instance,
    textAlternative: request.caption.trim() === "" ? textAlternative : request.caption,
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
