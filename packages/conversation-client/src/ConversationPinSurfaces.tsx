import type { ReactElement, RefObject } from "react";

import type { GatewayClient, Timeline } from "./api.ts";
import { PinnedLiveSurface } from "./DesktopSurfaces.tsx";
import { useT } from "./i18n/locale-context.tsx";

export interface ConversationPinSurfacesProps {
  client: GatewayClient;
  conversationId: string | undefined;
  pins: Timeline["pins"];
  instanceById: Map<string, Timeline["instances"][number]>;
  liveRefresh: number;
  applyTimeline: (timeline: Timeline) => void;
  setError: (message: string | undefined) => void;
  liveTrigger: RefObject<HTMLElement | null>;
  scroller: RefObject<HTMLDivElement | null>;
}

/**
 * The pinned widgets: the expanded live view of whichever instance is pinned that way, and the
 * shelf of every other pin.
 *
 * The expanded view is the only place a composed surface can be acted on — the copy in the
 * transcript is history, and mounting a second live instance beside it would be two owners for
 * one logical widget.
 */
export function ConversationPinSurfaces({
  client,
  conversationId,
  pins,
  instanceById,
  liveRefresh,
  applyTimeline,
  setError,
  liveTrigger,
  scroller,
}: ConversationPinSurfacesProps): ReactElement {
  const t = useT();
  const shelf =
    pins.length === 0 ? null : (
      <div className="cc-pins" data-pin-shelf="true">
        {pins.map((pin) => {
          const instance = instanceById.get(pin.instanceId);
          return (
            <span key={pin.pinId} className="cc-pin" data-pin-id={pin.pinId} data-refresh-policy={pin.refreshPolicy}>
              <span>{instance?.definitionId ?? pin.instanceId}</span>
              <button
                aria-label={t("widgets.pins.unpin")}
                data-unpin={pin.pinId}
                onClick={() => {
                  if (conversationId === undefined) return;
                  void client
                    .unpin(conversationId, pin.pinId)
                    .then((result) => applyTimeline(result.timeline))
                    .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
                }}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
    );

  return (
    <>
      {conversationId !== undefined &&
        pins
          .filter((pin) => pin.displayMode === "expanded" && instanceById.get(pin.instanceId) !== undefined)
          .map((pin) => (
          <div key={`live-${pin.pinId}`} className="cc-pin-expanded" data-pin-live={pin.pinId}>
            <PinnedLiveSurface
              client={client}
              conversationId={conversationId}
              instanceId={pin.instanceId}
              displayMode="expanded"
              refreshSignal={liveRefresh}
              title={typeof instanceById.get(pin.instanceId)?.props.title === "string" ? String(instanceById.get(pin.instanceId)?.props.title) : undefined}
              onTimeline={applyTimeline}
              onClose={() => {
                // Collapsing is an unpin: the expanded view exists because the pin says so, and
                // leaving the pin behind would make the next render open it again.
                void client
                  .unpin(conversationId, pin.pinId)
                  .then((result) => applyTimeline(result.timeline))
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
                  .finally(() => {
                    const trigger = liveTrigger.current;
                    liveTrigger.current = null;
                    if (trigger !== null && trigger.isConnected) trigger.focus();
                    else scroller.current?.focus();
                  });
              }}
            />
          </div>
        ))}
      {shelf}
    </>
  );
}
