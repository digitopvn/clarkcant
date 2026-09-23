import { type ReactElement } from "react";

import {
  PREVIEW_THEMES,
  PREVIEW_VIEWPORTS,
  type PreviewAction,
  type PreviewState,
} from "@clarkcant/widget-catalog";

/**
 * The Lab's preview controls.
 *
 * Every control here changes something real: the fixture selector swaps the props the renderer
 * receives, the viewport selector sets the preview frame's width from `PREVIEW_WIDTHS`, the theme
 * selector sets a scoped theme attribute on the preview subtree, and reduced motion sets a scoped
 * attribute the stylesheet honours. There is no control whose only effect is its own label.
 */

export interface WidgetFixtureControlsProps {
  preview: PreviewState;
  fixtures: readonly string[];
  onChange: (action: PreviewAction) => void;
}

export function WidgetFixtureControls({
  preview,
  fixtures,
  onChange,
}: WidgetFixtureControlsProps): ReactElement {
  return (
    <div className="cc-widget-lab-controls" data-widget-lab-controls="true">
      <label className="cc-widget-lab-control">
        <span>Fixture</span>
        <select
          value={preview.fixture}
          onChange={(event) => onChange({ kind: "fixture", value: event.target.value })}
          data-widget-lab-fixture="true"
        >
          {fixtures.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>

      <label className="cc-widget-lab-control">
        <span>Khung</span>
        <select
          value={preview.viewport}
          onChange={(event) => onChange({ kind: "viewport", value: event.target.value })}
          data-widget-lab-viewport="true"
        >
          {PREVIEW_VIEWPORTS.map((viewport) => (
            <option key={viewport} value={viewport}>
              {viewport}
            </option>
          ))}
        </select>
      </label>

      <label className="cc-widget-lab-control">
        <span>Theme</span>
        <select
          value={preview.theme}
          onChange={(event) => onChange({ kind: "theme", value: event.target.value })}
          data-widget-lab-theme="true"
        >
          {PREVIEW_THEMES.map((theme) => (
            <option key={theme} value={theme}>
              {theme}
            </option>
          ))}
        </select>
      </label>

      <label className="cc-widget-lab-control cc-widget-lab-check">
        <input
          type="checkbox"
          checked={preview.reducedMotion}
          onChange={(event) => onChange({ kind: "reduced-motion", value: event.target.checked })}
          data-widget-lab-reduced-motion="true"
        />
        <span>Giảm chuyển động</span>
      </label>
    </div>
  );
}
