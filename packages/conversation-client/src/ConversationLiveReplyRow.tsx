import type { CSSProperties, ReactElement } from "react";

import { AgentAvatar } from "./AgentAvatar.tsx";
import { ReasoningBlock, ToolActivityBlock } from "./blocks.tsx";
import { useT } from "./i18n/locale-context.tsx";
import { Markdown } from "./markdown.tsx";
import type { LiveSegment } from "./live-reply.ts";
import { WorkStepsFold } from "./work-steps-fold.tsx";
import { foldWorkSteps } from "./work-steps.ts";

export interface ConversationLiveReplyRowProps {
  live: readonly LiveSegment[];
}

/**
 * The reply while it is being written: a blinking marker until the first token arrives, then the
 * segments themselves, in the order the turn produced them.
 *
 * Never memoized and never given `content-visibility`: this is the one row on the page that must
 * never go quiet, since it changes on every delta of the active turn. An indicator that stayed
 * after the text started would be claiming the model has not begun, which is the opposite of
 * what is on screen.
 */
export function ConversationLiveReplyRow({ live }: ConversationLiveReplyRowProps): ReactElement {
  const t = useT();
  const newest = live.length - 1;
  return (
    <article className="cc-row" data-role="assistant" data-live="true" style={{ "--cc-enter-delay": "0ms" } as CSSProperties}>
      <div className="cc-assistant">
        <AgentAvatar />
        <div className="cc-assistant-body">
          {live.length === 0 ? (
            <div className="cc-thinking" data-thinking="true" role="status" aria-label={t("shell.reply.thinkingAria")}>
              <span className="cc-thinking-dot" aria-hidden="true" />
              <span className="cc-thinking-dot" aria-hidden="true" />
              <span className="cc-thinking-dot" aria-hidden="true" />
            </div>
          ) : (
            // Drawn in the order the turn produced it, so a tool call the model makes halfway
            // through a sentence appears where it happened rather than under the whole reply —
            // which is also where the stored message will put it. Earlier steps fold into one line
            // once there are enough of them; the newest segment never does, because it is the one
            // the person is watching.
            foldWorkSteps(live, (segment, index) => segment.kind !== "text" && index !== newest).map((run) =>
              run.kind === "item" ? (
                drawSegment(run.item, run.index, run.index === newest)
              ) : (
                <WorkStepsFold
                  key={`live-steps-${run.entries[0]!.index}`}
                  count={run.count}
                  failed={run.entries.filter((entry) => entry.item.kind === "tool" && entry.item.block.status === "failed").length}
                >
                  {run.entries.map((entry) => drawSegment(entry.item, entry.index, false))}
                </WorkStepsFold>
              ),
            )
          )}
        </div>
      </div>
    </article>
  );
}

/** One segment of the live reply; `last` is whether it is the one still arriving. */
function drawSegment(segment: LiveSegment, index: number, last: boolean): ReactElement {
  if (segment.kind === "tool") {
    return <ToolActivityBlock key={`live-tool-${String(segment.block.toolCallId ?? index)}`} block={segment.block} />;
  }
  if (segment.kind === "reasoning") {
    // `last` is the whole signal: the live view is drawn in the order the turn
    // produced it, so the most recent segment is the one still arriving. Reasoning
    // stops being that segment the moment text or a tool call follows it, which is
    // exactly when reasoning stopped.
    return (
      <ReasoningBlock
        key={`live-reasoning-${index}`}
        block={{ type: "reasoning", content: segment.text }}
        writing={last}
      />
    );
  }
  return (
    <div key={`live-text-${index}`} className="cc-text" data-streaming={last ? "true" : undefined}>
      <Markdown text={segment.text} />
      {last && <span className="cc-caret" aria-hidden="true" />}
    </div>
  );
}
