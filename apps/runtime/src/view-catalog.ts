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
} from "@clarkcant/contracts";
import {
  type WidgetDeps,
  captureSnapshot,
  createInstance,
} from "@clarkcant/core";
import { OVERVIEW, WIDGETS as CATALOG_WIDGETS } from "@clarkcant/data-canvas";
import { COMPOSITION_TEMPLATES, type ComposeDeps, composeMiniApp } from "./compose-mini-app.ts";
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
export function buildViewCatalog(deps: WidgetDeps, compose?: ComposeDeps): ViewDescriptor[] {
  // The container is excluded: it is not a leaf a model may place, and registering it twice would
  // give the model a view name whose build knows nothing about the composition.
  const simple: ViewDescriptor[] = CATALOG_WIDGETS.filter((definition) => definition.id !== OVERVIEW.id).map(
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

  if (compose === undefined) return simple;

  const overview = OVERVIEW;
  return [
    ...simple,
    {
      id: overview.id,
      label: overview.semanticDescription,
      notes:
        `For the composed overview, pass props.templateId as one of: ${COMPOSITION_TEMPLATES.map((template) => template.templateId).join(", ")}, ` +
        `and props.period as "week" or "month". Naming a template is what skips the selector.`,
      build: async (request) => {
        const templateId = request.props.templateId;
        const period = request.props.period;
        const outcome = await composeMiniApp(compose, {
          conversationId: request.conversationId,
          messageId: request.messageId,
          principalId: request.principal.principalId,
          // The caption is the model's own sentence about what it is showing, and it is the only
          // free text the selector is offered. The user's raw message is not sent.
          intent: request.caption,
          ...(typeof templateId === "string" ? { explicitTemplateId: templateId } : {}),
          ...(period === "week" || period === "month" ? { period } : {}),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
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
