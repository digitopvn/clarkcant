import { memo, type ReactElement } from "react";

import type { GatewayClient, Timeline } from "./api.ts";
import { TranscriptRow } from "./transcript-row.tsx";
import { renderBlock, type BlockActions, type SurfaceBlockRef } from "./blocks.tsx";
import { echoesCommandReceipt } from "./command-receipts.ts";
import { useT } from "./i18n/locale-context.tsx";
import { WorkStepsFold } from "./work-steps-fold.tsx";
import { countsAsStep, foldWorkSteps, isWorkBlock } from "./work-steps.ts";

export interface TimelineMessageRowProps {
  message: Timeline["messages"][number];
  index: number;
  renderSurface: (props: SurfaceBlockRef) => ReactElement;
  blockActions: BlockActions;
  client: GatewayClient;
  /**
   * Whether this row is still part of the active turn.
   *
   * A settled row gets `content-visibility: auto`, which lets the browser skip layout and paint
   * for rows the reader has scrolled away from; the live row never does, because a row the browser
   * is allowed to skip painting is a row a screen reader or `aria-live` announcement may skip too,
   * and the row still streaming is the one thing on the page that must never go quiet.
   */
  settled: boolean;
}

/**
 * One row of the transcript: a stored user or assistant message.
 *
 * Wrapped in `React.memo` so that while a turn streams — which re-renders `Conversation` on every
 * delta — a settled row with unchanged props is skipped rather than re-walked and re-rendered.
 * `renderSurface`, `blockActions` and `client` are memoized by the caller specifically so this
 * comparison is meaningful; a fresh function or object on every render would defeat the memo
 * silently, with no error to say so.
 */
function TimelineMessageRowComponent({
  message,
  index,
  renderSurface,
  blockActions,
  client,
  settled,
}: TimelineMessageRowProps): ReactElement {
  const t = useT();
  // A block that only echoes a command receipt is left out before folding, so it neither splits a run nor counts in it.
  const shown = message.blocks
    .map((block, blockIndex) => ({ block, blockIndex }))
    .filter(({ blockIndex }) => !echoesCommandReceipt(message.blocks, blockIndex));
  const draw = ({ block, blockIndex }: (typeof shown)[number]): ReactElement | null =>
    renderBlock(block, blockIndex, renderSurface, blockActions, client, t);
  return (
    <TranscriptRow role={message.role} index={index} settled={settled}>
      {foldWorkSteps(shown, (entry) => isWorkBlock(entry.block), (entry) => countsAsStep(entry.block)).map((run) =>
        run.kind === "item" ? (
          draw(run.item)
        ) : (
          <WorkStepsFold
            key={`steps-${run.entries[0]!.item.blockIndex}`}
            count={run.count}
            failed={run.entries.filter((entry) => entry.item.block.status === "failed").length}
          >
            {run.entries.map((entry) => draw(entry.item))}
          </WorkStepsFold>
        ),
      )}
    </TranscriptRow>
  );
}

export const TimelineMessageRow = memo(TimelineMessageRowComponent);
