import { memo, type CSSProperties, type ReactElement } from "react";

import type { GatewayClient, Timeline } from "./api.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { renderBlock, type BlockActions, type SurfaceBlockRef } from "./blocks.tsx";

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
  return (
    <article
      className="cc-row"
      data-role={message.role}
      // Staggered so a reply with several parts arrives as a sequence rather than as one block;
      // capped, because the tenth row should not wait a second to appear.
      style={
        {
          "--cc-enter-delay": `${Math.min(index, 6) * 60}ms`,
          ...(settled ? { contentVisibility: "auto", containIntrinsicSize: "0 auto 120px" } : {}),
        } as CSSProperties
      }
    >
      {message.role === "assistant" ? (
        // Full width, with the agent's mark beside it: a reply is the agent talking, and boxing it
        // like the user's message would make both sides look like utterances.
        <div className="cc-assistant">
          <AgentAvatar />
          <div className="cc-assistant-body">
            {message.blocks.map((block, blockIndex) => renderBlock(block, blockIndex, renderSurface, blockActions, client))}
          </div>
        </div>
      ) : (
        // A bubble, because it is the user's own words coming back to them at a glance.
        <div className="cc-bubble" data-bubble="user">
          {message.blocks.map((block, blockIndex) => renderBlock(block, blockIndex, renderSurface, blockActions, client))}
        </div>
      )}
    </article>
  );
}

export const TimelineMessageRow = memo(TimelineMessageRowComponent);
