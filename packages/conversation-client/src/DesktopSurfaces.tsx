/**
 * Menu bar pieces for the desktop shell.
 *
 * A menu bar popover and a notification. Both are small, and both have one job that is easy to get
 * wrong: not overstating the state of the node behind them. The popover shows the same connection
 * state the app window does, and the notification trigger reports whether the host actually
 * supports notifications rather than assuming a desktop shell does.
 */

import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GatewayClient, LiveWidgetResponse, Timeline } from "./api.ts";
import { MiniAppSurface, type CompositeSurfaceView } from "./mini-app-surface.tsx";

export interface MenuBarPopoverProps {
  nodeLabel: string;
  connection: "connecting" | "ready" | "offline";
  /** Tasks still running, so the popover is worth opening. */
  activeTaskCount: number;
  onOpenApp: () => void;
}

export function MenuBarPopover({
  nodeLabel,
  connection,
  activeTaskCount,
  onOpenApp,
}: MenuBarPopoverProps): ReactElement {
  const stateText = connection === "ready" ? "Ready" : connection === "connecting" ? "Đang kết nối" : "Mất kết nối";
  return (
    <div className="cc-menubar" role="dialog" aria-label={`Trạng thái ${nodeLabel}`} data-connection={connection}>
      <div className="cc-menubar-head">
        {/* The same wording the app window uses. Two surfaces describing one node differently is
            how a user learns not to trust either of them. */}
        <span className="cc-dot" data-state={connection} aria-hidden="true" />
        <span>{stateText}</span>
      </div>
      <p className="cc-freshness" style={{ margin: 0 }} data-menu-task-count={activeTaskCount}>
        {activeTaskCount === 0 ? "Không có việc nào đang chạy." : `${activeTaskCount} việc đang chạy.`}
      </p>
      <button type="button" className="cc-badge" onClick={onOpenApp} style={{ cursor: "pointer", font: "inherit" }}>
        Mở cửa sổ
      </button>
    </div>
  );
}

export interface DesktopNotificationProps {
  title: string;
  body: string;
}

/**
 * Ask the host to raise a notification.
 *
 * `Notification` is absent in Electron's sandboxed renderer unless the host exposes it, so the
 * component reports that it could not rather than silently doing nothing. A notification that
 * never appears and never says why is indistinguishable from a bug in whatever was being
 * notified about.
 */
export function DesktopNotification({ title, body }: DesktopNotificationProps): ReactElement {
  const [outcome, setOutcome] = useState<"idle" | "sent" | "unsupported" | "denied">("idle");

  const send = useCallback(() => {
    const api = globalThis as { Notification?: typeof Notification };
    if (api.Notification === undefined) {
      setOutcome("unsupported");
      return;
    }
    if (api.Notification.permission === "denied") {
      setOutcome("denied");
      return;
    }
    void api.Notification.requestPermission().then((permission) => {
      if (permission !== "granted") {
        setOutcome("denied");
        return;
      }
      new api.Notification!(title, { body });
      setOutcome("sent");
    });
  }, [title, body]);

  return (
    <div className="cc-notification-trigger" data-notification-outcome={outcome}>
      <button type="button" className="cc-badge" onClick={send} style={{ cursor: "pointer", font: "inherit" }}>
        Báo cho tôi khi xong
      </button>
      {outcome === "unsupported" && (
        <span className="cc-freshness" data-notification-unsupported="true">
          Cửa sổ này không có quyền gửi thông báo.
        </span>
      )}
      {outcome === "denied" && (
        <span className="cc-freshness" data-notification-denied="true">
          Bạn đã từ chối quyền thông báo.
        </span>
      )}
      {outcome === "sent" && <span className="cc-freshness">Đã gửi.</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Pinned live surface
 * ------------------------------------------------------------------ */

export interface PinnedLiveSurfaceProps {
  client: GatewayClient;
  conversationId: string;
  instanceId: string;
  displayMode: "compact" | "expanded";
  title?: string | undefined;
  /** Called after any successful action, so the host can refresh its page. */
  onTimeline: (timeline: Timeline) => void;
}

/** How long a claim is held before it is refreshed. Shorter than the server's lease on purpose. */
const CLAIM_REFRESH_MS = 30_000;

/**
 * The live view of a pinned instance.
 *
 * This is the only place a user can act on a composed surface, and it holds the single owner token
 * while it is on screen. That is what the ownership model is for: the inline copy in the transcript
 * is history and stays read-only, so the same data is never editable from two places at once —
 * which is how a filter change in one tab silently rewrites what another tab is looking at.
 *
 * The claim is refreshed on a timer because a claim with no expiry is an orphan waiting to happen,
 * and released on unmount so the next surface does not have to wait for the lease to lapse.
 */
export function PinnedLiveSurface({
  client,
  conversationId,
  instanceId,
  displayMode,
  title,
  onTimeline,
}: PinnedLiveSurfaceProps): ReactElement {
  const [live, setLive] = useState<LiveWidgetResponse | undefined>(undefined);
  const [ownership, setOwnership] = useState<"claiming" | "owner" | "elsewhere" | "error">("claiming");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const ownerToken = useRef<string>(newOwnerToken());

  const load = useCallback(async (): Promise<void> => {
    try {
      const resolved = await client.liveWidget(conversationId, instanceId);
      setLive(resolved);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
      setOwnership("error");
    }
  }, [client, conversationId, instanceId]);

  useEffect(() => {
    let cancelled = false;
    const claim = async (): Promise<void> => {
      try {
        await client.claimLiveOwner(conversationId, instanceId, {
          ownerToken: ownerToken.current,
          surface: "pin",
          leaseMs: CLAIM_REFRESH_MS * 3,
        });
        if (!cancelled) setOwnership("owner");
      } catch (cause) {
        if (cancelled) return;
        // Refused means another surface holds it. This one still renders, read-only, and says so.
        setOwnership("elsewhere");
        setNotice(
          cause instanceof Error && cause.message.includes("ALREADY_OWNED")
            ? "Bản hiện tại đang được mở ở một vị trí khác. Ở đây chỉ xem."
            : cause instanceof Error
              ? cause.message
              : String(cause),
        );
      }
      await load();
    };

    void claim();
    const timer = setInterval(() => {
      void client
        .claimLiveOwner(conversationId, instanceId, {
          ownerToken: ownerToken.current,
          surface: "pin",
          leaseMs: CLAIM_REFRESH_MS * 3,
        })
        .catch(() => undefined);
    }, CLAIM_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      // Best effort: the lease is what makes a failed release recoverable.
      void client.releaseLiveOwner(conversationId, instanceId, ownerToken.current).catch(() => undefined);
    };
  }, [client, conversationId, instanceId, load]);

  /* Imported images are fetched through the authenticated client, not linked to directly. */
  const imageRefs = useMemo(() => {
    const refs = new Set<string>();
    for (const section of live?.sections ?? []) {
      const ref = section.props.imageRef;
      if (typeof ref === "string" && ref !== "") refs.add(ref);
    }
    return [...refs];
  }, [live]);

  useEffect(() => {
    let cancelled = false;
    for (const imageId of imageRefs) {
      if (imageUrls[imageId] !== undefined) continue;
      void client
        .imageObjectUrl(imageId)
        .then((url) => {
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          setImageUrls((current) => ({ ...current, [imageId]: url }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [client, imageRefs, imageUrls]);

  const readOnly = ownership !== "owner";

  if (live === undefined) {
    return (
      <div className="cc-live-surface" data-live-instance={instanceId} data-ownership={ownership}>
        <p className="cc-freshness" style={{ margin: 0 }}>
          {notice ?? "Đang mở bản hiện tại…"}
        </p>
      </div>
    );
  }

  const view = toSurfaceViewFromLive(live, imageUrls, readOnly);

  return (
    <div className="cc-live-surface" data-live-instance={instanceId} data-ownership={ownership} data-display-mode={displayMode}>
      {notice !== undefined && (
        <p className="cc-freshness" data-live-notice="true" style={{ margin: "0 0 var(--cc-space-xs)" }}>
          {notice}
        </p>
      )}
      <MiniAppSurface
        view={view}
        title={title}
        busy={busy}
        imageUrl={(ref) => imageUrls[ref]}
        onIntent={
          readOnly
            ? undefined
            : (intent) => {
                const action = live.spec.actions.find((entry) => entry.sectionId === intent.sectionId);
                if (action === undefined) return;
                setBusy(true);
                setNotice(undefined);
                void client
                  .invokeAction(conversationId, instanceId, {
                    actionBindingId: action.actionBindingId,
                    expectedRevision: live.revision,
                    expectedBindingDigest: digestForBinding(live, action.actionBindingId),
                    input: intent.input,
                    // A fresh id per attempt: the id is what makes a repeated press one effect, and
                    // reusing it for a genuinely new attempt would be refused as a reused key.
                    invocationId: newOwnerToken(),
                  })
                  .then((result) => {
                    onTimeline(result.timeline);
                    if (result.duplicate) setNotice("Thao tác này đã được thực hiện trước đó.");
                    return load();
                  })
                  .catch((cause: unknown) => {
                    const message = cause instanceof Error ? cause.message : String(cause);
                    setNotice(
                      message.includes("REVISION_MISMATCH")
                        ? "Bản hiển thị đã cũ so với máy chủ. Đã tải lại; thao tác chưa được áp dụng."
                        : message,
                    );
                    return load();
                  })
                  .finally(() => setBusy(false));
              }
        }
      />
    </div>
  );
}

/**
 * Adapt a live response into the shape the surface renders.
 *
 * Kept next to the pin because it is the pin's read path: history uses the bundle, and this uses
 * current records. Both produce the same view shape, so there is one renderer.
 */
function toSurfaceViewFromLive(
  live: LiveWidgetResponse,
  imageUrls: Record<string, string>,
  readOnly: boolean,
): CompositeSurfaceView {
  void imageUrls;
  return {
    compositionId: live.compositionId,
    instanceId: live.spec.instanceId,
    catalogDigest: live.spec.catalogDigest,
    initialState: {
      period: live.period,
      timezone: live.timezone,
      ...(typeof live.state.selectedDate === "string" ? { selectedDate: live.state.selectedDate } : {}),
    },
    actions: readOnly
      ? []
      : live.spec.actions.map((action) => ({
          actionBindingId: action.actionBindingId,
          sectionId: action.sectionId,
          label: action.label,
          kind: action.kind as CompositeSurfaceView["actions"][number]["kind"],
          effectCategory: action.effectCategory,
        })),
    sections: live.sections.map((section) => ({
      sectionId: section.sectionId,
      slot: section.slot as CompositeSurfaceView["sections"][number]["slot"],
      definitionRef: section.definitionRef,
      props: section.props,
      dataRefs: section.dataRefs,
      ...(section.rows === undefined ? {} : { rows: section.rows }),
      textAlternative: section.textAlternative,
    })),
    revision: live.revision,
    stale: false,
    availability: live.availability,
  };
}

/**
 * The digest a binding was compiled with, as the server last reported it.
 *
 * The client cannot recompile a binding, so it echoes what it was told. A binding whose digest has
 * changed since is refused as stale, which is the intended outcome: the alternative is applying a
 * click to an action that was replaced underneath the user.
 */
function digestForBinding(live: LiveWidgetResponse, actionBindingId: string): string {
  return live.bindings.find((binding) => binding.actionBindingId === actionBindingId)?.bindingDigest ?? "";
}

/** A unique token for a claim or an invocation. */
function newOwnerToken(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID();
  return `tok_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}
