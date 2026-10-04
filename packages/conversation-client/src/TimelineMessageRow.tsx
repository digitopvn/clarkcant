import { memo, type ReactElement } from "react";

import type { GatewayClient, Timeline } from "./api.ts";
import { TranscriptRow } from "./transcript-row.tsx";
import { renderBlock, type BlockActions, type SurfaceBlockRef } from "./blocks.tsx";
import { echoesCommandReceipt } from "./command-receipts.ts";
import { useT } from "./i18n/locale-context.tsx";

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
  return (
    <TranscriptRow role={message.role} index={index} settled={settled}>
      {message.blocks.map((block, blockIndex) =>
        echoesCommandReceipt(message.blocks, blockIndex)
          ? null
          : renderBlock(block, blockIndex, renderSurface, blockActions, client, t),
      )}
    </TranscriptRow>
  );
}

export const TimelineMessageRow = memo(TimelineMessageRowComponent);
