import { type ReactElement } from "react";

import { useT } from "../i18n/locale-context.tsx";
import type { InspectorPanel } from "./widget-lab.ts";

/**
 * The inspector.
 *
 * It renders what `inspectorPanels` computes and adds nothing: the interesting decisions (which
 * panels exist, what each row says, whether an action may be driven from a preview) are pure
 * functions, so they are asserted in Node rather than through a rendered tree. What is left here is
 * disclosure - collapsed sections a developer opens when they need them.
 */

export interface WidgetInspectorProps {
  panels: readonly InspectorPanel[];
}

export function WidgetInspector({ panels }: WidgetInspectorProps): ReactElement {
  const t = useT();
  return (
    <div className="cc-widget-inspector" data-widget-inspector="true">
      {panels.map((panel) => (
        <details key={panel.id} className="cc-widget-inspector-panel" data-inspector-panel={panel.id} open>
          <summary>{panel.label}</summary>
          <dl className="cc-widget-inspector-rows">
            {panel.rows.length === 0 ? (
              <div className="cc-widget-inspector-row">
                <dt>—</dt>
                <dd>{t("widgets.inspector.nothingDeclared")}</dd>
              </div>
            ) : (
              panel.rows.map((row, index) => (
                <div className="cc-widget-inspector-row" key={`${panel.id}-${index}`}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))
            )}
          </dl>
        </details>
      ))}
    </div>
  );
}
