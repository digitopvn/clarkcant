import { memo, type ReactElement } from "react";

import type { GatewayClient, Timeline, TimelineMessage } from "./api.ts";
import { TranscriptRow } from "./transcript-row.tsx";
import { renderBlock, type BlockActions, type SurfaceBlockRef } from "./blocks.tsx";
import type { MessageKey } from "./i18n/messages.ts";
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
 * What the transcript says for a message the host wrote, in the reader's language.
 *
 * The stored text is the sentence the model read, and it is never shown: it is not anyone's words, and it is written in
 * whatever language the node used. A kind this build does not know still reads as the host carrying on, never as the
 * person speaking.
 */
export function hostWrittenLineKey(hostWritten: NonNullable<TimelineMessage["hostWritten"]>): MessageKey {
  return hostWritten.kind === "host-continuation" ? "timeline.hostWritten.continuation" : "timeline.hostWritten.other";
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
  if (message.hostWritten !== undefined && message.hostWritten !== null) {
    // A quiet, centred line rather than a bubble: nobody typed it, so it must not sit where the person's words do.
    return (
      <div className="cc-row cc-host-line" data-host-written={message.hostWritten.kind}>
        <p className="cc-host-line-text">{t(hostWrittenLineKey(message.hostWritten))}</p>
      </div>
    );
  }
  return (
    <TranscriptRow role={message.role} index={index} settled={settled}>
      {message.blocks.map((block, blockIndex) => renderBlock(block, blockIndex, renderSurface, blockActions, client, t))}
    </TranscriptRow>
  );
}

export const TimelineMessageRow = memo(TimelineMessageRowComponent);
