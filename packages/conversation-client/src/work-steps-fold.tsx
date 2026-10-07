import type { ReactElement, ReactNode } from "react";

import { useT } from "./i18n/locale-context.tsx";
import { useSurfaceViewState } from "./surface-view-state.tsx";

/**
 * A run of working steps, drawn as one line that opens onto all of them.
 *
 * A `details` element, like each step inside it, so it is keyboard operable and announced as a disclosure without
 * anything extra. A step that failed is named on the line itself, in the danger colour, rather than opening the fold:
 * a turn routinely tries something, fails, and recovers, and opening twenty steps for a stumble the reply already got
 * past would undo the fold. Inside, the failed step is open on its reason.
 */
export function WorkStepsFold({
  count,
  failed,
  children,
}: {
  count: number;
  failed: number;
  children: ReactNode;
}): ReactElement {
  const t = useT();
  const [open, setOpen] = useSurfaceViewState("steps.open", false);
  const summary = t("blocks.workSteps.done").replace("{count}", String(count));
  return (
    <details
      className="cc-work-steps"
      data-work-steps={count}
      data-work-steps-failed={failed > 0 ? failed : undefined}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cc-tool-head">
        {/* Quiet when a step stumbled: the words say so in red, and a red cross on the whole run would read as the
            run failing when the reply went on past it. */}
        <span className="cc-tool-mark" data-status={failed > 0 ? "noted" : "done"} aria-hidden="true">
          {failed > 0 ? "!" : "✓"}
        </span>
        <span className="cc-tool-label">
          {summary}
          {failed > 0 && <span className="cc-work-steps-failed">{` · ${t("blocks.workSteps.failed").replace("{count}", String(failed))}`}</span>}
        </span>
      </summary>
      <div className="cc-work-steps-body">{children}</div>
    </details>
  );
}
