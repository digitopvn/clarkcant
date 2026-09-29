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
  type WidgetInstance,
  type WidgetSnapshot,
  MAX_COMPOSITION_SECTIONS,
  MAX_GRID_COLUMNS,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_NODES,
} from "@clarkcant/contracts";
import {
  type WidgetDeps,
  captureSnapshot,
  createInstance,
  saveActionBinding,
} from "@clarkcant/core";
import { ACTION, ACTION_ICONS, CTA, OVERVIEW, WIDGETS as CATALOG_WIDGETS } from "@clarkcant/data-canvas";
import { type ActionBindingDeps, compileWidgetAction } from "./application/action-bindings.ts";
import { COMPOSITION_TEMPLATES, type ComposeDeps, type ComposeInput, composeMiniApp } from "./compose-mini-app.ts";
import { composeLayout, layoutLeafWidgets } from "./compose-layout.ts";
import { definitionDigest } from "@clarkcant/widget-host";

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
  // registered below, with the build that compiles its action.
  const placed = new Set([OVERVIEW.id, CTA.id, ACTION.id]);
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

  if (actions !== undefined) simple.push(actionView(deps, actions));
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
        `the node fills each widget with its own data. props.title names the surface.`,
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
