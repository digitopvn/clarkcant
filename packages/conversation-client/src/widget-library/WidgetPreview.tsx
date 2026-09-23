import { type ReactElement } from "react";

import type { WidgetCatalogEntry } from "@clarkcant/widget-catalog";
import { FIXTURE_PICTURES } from "@clarkcant/widget-catalog";
import type { WidgetFixture } from "@clarkcant/contracts";

import { resolveRenderer, type RendererDataset } from "../renderers.tsx";

/**
 * A live preview, drawn by the production renderer.
 *
 * The whole point of the library is that it shows what the conversation would actually show, so this
 * calls the same `resolveRenderer` the timeline calls and passes it the same props shape. There is no
 * screenshot and no second implementation of any widget: if a catalog entry loses its renderer, the
 * preview says so instead of quietly drawing something that looks similar.
 *
 * Fixtures are data. `onAction` is deliberately never wired here, so a preview cannot invoke a real
 * effect by being displayed; a fixture that would be actionable in conversation is shown read-only.
 */

export interface WidgetPreviewProps {
  entry: WidgetCatalogEntry;
  fixture: WidgetFixture;
  /** Bumped by the Lab's viewport control; the width is applied by the caller. */
  definitionId?: string;
}

/** The fixture's rows, in the shape a renderer reads them. */
export function rendererDataset(fixture: WidgetFixture): RendererDataset | undefined {
  if (fixture.dataset === undefined) return undefined;
  return {
    rows: fixture.dataset.rows,
    freshness: fixture.dataset.source,
    updatedAt: "",
  };
}

/** Pictures a preview may show, from the fixture's own inline references. */
export function fixtureImageUrl(imageRef: string): string | undefined {
  return FIXTURE_PICTURES[imageRef];
}

export function WidgetPreview({ entry, fixture }: WidgetPreviewProps): ReactElement {
  const renderer = resolveRenderer(entry.definition.id);

  if (renderer === undefined) {
    return (
      <p className="cc-widget-preview-missing" data-widget-preview-missing={entry.definition.id}>
        {`Catalog entry ${entry.definition.id} has no renderer in this build, so it cannot be previewed. `}
        {"The conversation would fall back to the text alternative."}
      </p>
    );
  }

  return (
    <div className="cc-widget-preview" data-widget-preview={entry.cardId}>
      {renderer({
        definitionId: entry.definition.id,
        props: fixture.props,
        dataset: rendererDataset(fixture),
        ...(fixture.state === undefined ? {} : { state: fixture.state }),
        imageUrl: fixtureImageUrl,
      })}
    </div>
  );
}
