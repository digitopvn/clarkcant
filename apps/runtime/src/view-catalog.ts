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
import { WIDGETS as CATALOG_WIDGETS } from "@clarkcant/data-canvas";
import { definitionDigest } from "@clarkcant/widget-host";

import type { ViewDescriptor } from "./model-turn.ts";

/**
 * Build the catalog, or nothing when this node holds no widget definitions.
 *
 * Returning an empty list is what keeps the tool unregistered. A catalog that is present but
 * useless would have the model spend a turn discovering that every view is unavailable.
 */
export function buildViewCatalog(deps: WidgetDeps): ViewDescriptor[] {
  return CATALOG_WIDGETS.map((definition) => ({
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
  }));
}
