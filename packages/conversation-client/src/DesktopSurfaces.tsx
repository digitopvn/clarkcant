/**
 * Menu bar pieces for the desktop shell.
 *
 * A menu bar popover and a notification. Both are small, and both have one job that is easy to get
 * wrong: not overstating the state of the node behind them. The popover shows the same connection
 * state the app window does, and the notification trigger reports whether the host actually
 * supports notifications rather than assuming a desktop shell does.
 */

import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GatewayClient, IsolatedFrameLiveResponse, LiveWidgetResponse, Timeline } from "./api.ts";
import { MiniAppSurface, type CompositeSurfaceView } from "./mini-app-surface.tsx";
import { WidgetFrame } from "./WidgetFrame.tsx";
import { useImageUrls } from "./use-image-urls.ts";

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
  /**
   * Present when this surface can be dismissed.
   *
   * The host owns what closing means (collapsing a pin, restoring focus to whatever opened it), and
   * Escape is wired here because a keyboard user expects the expanded view to close from anywhere
   * inside it — not only while a particular control happens to have focus.
   */
  onClose?: (() => void) | undefined;
  /**
   * Changes when a spoken action has run elsewhere and this surface should re-read. A signal rather than a value,
   * because the surface's truth is the node's answer and nothing the caller could hand it.
   */
  refreshSignal?: number | undefined;
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
/**
 * What the desktop shell offers for detaching, when this build runs inside one.
 *
 * Read from the bridge rather than assumed: a browser has no bridge, and a browser has no second window to detach
 * into - so the control is absent there rather than present and failing. A control that looks usable before its
 * action exists is the thing this avoids.
 */
interface ShellDetachBridge {
  detachWidget(input: {
    conversationId: string;
    instanceId: string;
    title?: string;
    live: unknown;
  }): Promise<{ ok: boolean; refused?: string }>;
  onWidgetReattached?(callback: (payload: { instanceRef?: string }) => void): void;
}

function shellDetachBridge(): ShellDetachBridge | undefined {
  if (typeof window === "undefined") return undefined;
  /*
   * SAFETY: `clarkcant` is injected by the desktop preload through `contextBridge`, so it is a runtime fact with
   * no declared type. The assertion is narrow, and `detachWidget` is checked for being a function before anything
   * is called on it — a browser without the bridge returns `undefined` rather than a half-shaped object.
   */
  const candidate = (window as unknown as { clarkcant?: Record<string, unknown> }).clarkcant;
  if (candidate === undefined || typeof candidate["detachWidget"] !== "function") return undefined;
  /*
   * SAFETY: the check above is what makes this true — a value without a callable `detachWidget` has already
   * returned, so what is left is a bridge. `onWidgetReattached` is optional in the interface because a shell
   * built before this channel existed has no way to push the reattach event, and that is a missing feature
   * rather than a broken shape.
   */
  return candidate as unknown as ShellDetachBridge;
}

export function PinnedLiveSurface({
  client,
  conversationId,
  instanceId,
  displayMode,
  title,
  onTimeline,
  onClose,
  refreshSignal,
}: PinnedLiveSurfaceProps): ReactElement {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [live, setLive] = useState<LiveWidgetResponse | IsolatedFrameLiveResponse | undefined>(undefined);
  const [ownership, setOwnership] = useState<"claiming" | "owner" | "elsewhere" | "error">("claiming");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  /*
   * Whether the surface is near the viewport.
   *
   * Two things hang off this, and they are the same thing seen twice: a heavy surface is not mounted until it is
   * close, and an offscreen one does not keep a live subscription. The second is the one that matters — a pinned
   * surface left open in a tab nobody is looking at would otherwise keep claiming the lease and re-reading the
   * widget on a timer, which is work nobody asked for and a lease nobody is using.
   */
  const [inView, setInView] = useState(false);
  const ownerToken = useRef<string>(newOwnerToken());

  useEffect(() => {
    const element = panel.current;
    if (element === null) return;
    /*
     * `rootMargin` rather than a bare threshold: mounting exactly at the edge would make the surface appear only
     * once the user has already scrolled to it, which turns lazy mounting into a visible pop-in. A screen's worth of
     * margin means it is ready before it is looked at.
     */
    const observer = new IntersectionObserver(
      (entries) => {
        setInView(entries[0]?.isIntersecting ?? true);
      },
      { rootMargin: "400px 0px", threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const resolved = await client.liveWidget(conversationId, instanceId);
      setLive(resolved);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
      setOwnership("error");
    }
  }, [client, conversationId, instanceId]);

  // Skipped on the first render on purpose: the claim effect already reads the surface, and a second read of the
  // same revision would be noise. Only a change means a spoken action landed.
  const lastRefresh = useRef(refreshSignal ?? 0);
  useEffect(() => {
    const signal = refreshSignal ?? 0;
    if (signal === lastRefresh.current) return;
    lastRefresh.current = signal;
    void load();
  }, [refreshSignal, load]);

  useEffect(() => {
    /*
     * Offscreen means no subscription. The cleanup below releases the lease and clears the timer, so leaving the
     * viewport suspends the surface the same way unmounting it does — and returning re-claims with the *same* owner
     * token, which is the same owner rather than a second one.
     */
    if (!inView) {
      // The cleanup below released the lease, so the surface must stop saying it holds the live view. Saying
      // "owner" while holding nothing is the exact claim this component exists to avoid making.
      setOwnership("claiming");
      return;
    }
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
  }, [client, conversationId, instanceId, inView, load]);

  /*
   * Escape closes the expanded view, from anywhere inside it.
   *
   * On `window` rather than on the panel because the panel is not modal: focus can be sitting on a
   * control the surface drew, and a listener scoped to the container would miss Escape after a click
   * that moved focus into an iframe-like subtree. The handler is only attached when the host offered
   * a way to close, so a compact pin never swallows the key.
   */
  useEffect(() => {
    if (onClose === undefined) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /*
   * Focus moves to the close control when the expanded view appears.
   *
   * Otherwise a keyboard user who opened it is left at the trigger, one Tab away from content they
   * cannot see the shape of, and Escape would be undiscoverable. It is the same reason a dialog takes
   * focus when it opens — without the modal part, because this view is inline.
   */
  useEffect(() => {
    if (displayMode !== "expanded") return;
    closeButton.current?.focus();
  }, [displayMode]);

  /* Imported images are fetched through the authenticated client, not linked to directly. */
  const imageRefs = useMemo(() => {
    const refs = new Set<string>();
    // Only a composition has sections to look through; a frame's pictures are its own document's business.
    for (const section of live?.kind === "composition" ? live.sections : []) {
      const ref = section.props.imageRef;
      if (typeof ref === "string" && ref !== "") refs.add(ref);
    }
    return [...refs];
  }, [live]);

  const imageUrl = useImageUrls(client, imageRefs);

  const readOnly = ownership !== "owner";

  /**
   * Hand this instance to its own window.
   *
   * The lease is released *before* the host claims it, and that order is the whole handoff: the node refuses a
   * second owner, so a shell that asked for a detached window while still holding the lease would have its own
   * request refused, and the instance would stay here with a window that never opened. Letting go and handing over
   * are the same act.
   *
   * If the window does not open, the lease is taken back rather than left in nobody's hands.
   */
  const detach = useCallback(async (): Promise<void> => {
    const bridge = shellDetachBridge();
    if (bridge === undefined || live === undefined) return;
    try {
      await client.releaseLiveOwner(conversationId, instanceId, ownerToken.current);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const answer = await bridge.detachWidget({
      conversationId,
      instanceId,
      ...(title === undefined ? {} : { title }),
      live,
    });
    if (!answer.ok) {
      setNotice(answer.refused ?? "Không mở được cửa sổ riêng.");
      await client
        .claimLiveOwner(conversationId, instanceId, {
          ownerToken: ownerToken.current,
          surface: "pin",
          leaseMs: CLAIM_REFRESH_MS * 3,
        })
        .then(() => setOwnership("owner"))
        .catch(() => undefined);
      return;
    }
    setOwnership("elsewhere");
    setNotice("Widget đang mở trong một cửa sổ riêng.");
  }, [client, conversationId, instanceId, live, title]);

  /*
   * Taking the instance back when its window closes.
   *
   * The claim is re-made rather than assumed: the host released the lease on the way out, so this surface holds
   * nothing until it asks again - and a surface that said "owner" without asking would be claiming a lease nobody
   * granted.
   */
  useEffect(() => {
    const bridge = shellDetachBridge();
    if (bridge?.onWidgetReattached === undefined) return;
    bridge.onWidgetReattached(() => {
      void client
        .claimLiveOwner(conversationId, instanceId, {
          ownerToken: ownerToken.current,
          surface: "pin",
          leaseMs: CLAIM_REFRESH_MS * 3,
        })
        .then(() => {
          setOwnership("owner");
          setNotice(undefined);
          return load();
        })
        .catch(() => {
          setOwnership("elsewhere");
        });
    });
  }, [client, conversationId, instanceId, load]);

  const detachAvailable = shellDetachBridge() !== undefined;

  const head =
    onClose === undefined ? undefined : (
      <div className="cc-live-head">
        {/*
          Offered only to the surface holding the lease, and only where a second window exists to detach into. A
          button that could not hand the instance over would be a control whose action does not exist.
        */}
        {detachAvailable && ownership === "owner" && (
          <button
            type="button"
            className="cc-icon-btn"
            style={{ width: "auto", padding: "0 var(--cc-space-sm)" }}
            data-detach-widget="true"
            aria-label="Mở widget này trong một cửa sổ riêng"
            onClick={() => void detach()}
          >
            Cửa sổ riêng
          </button>
        )}
        <button
          ref={closeButton}
          type="button"
          className="cc-icon-btn"
          style={{ width: "auto", padding: "0 var(--cc-space-sm)" }}
          data-close-live="true"
          aria-label="Đóng bản hiện tại (Escape)"
          onClick={onClose}
        >
          Đóng (Esc)
        </button>
      </div>
    );

  /*
   * Offscreen means unmounted. Not polling while still rendering the surface would leave the heavy part on screen
   * doing nothing — and the point of both items is that a surface nobody is looking at costs nothing.
   */
  if (live === undefined || !inView) {
    return (
      <div
        ref={panel}
        className="cc-live-surface"
        data-live-instance={instanceId}
        data-ownership={ownership}
        data-display-mode={displayMode}
        data-lazy={inView ? "false" : "true"}
        role={displayMode === "expanded" ? "region" : undefined}
        aria-label={displayMode === "expanded" ? `Bản hiện tại: ${title ?? instanceId}` : undefined}
      >
        {/* The close control is here in the loading state as well: a surface that is still opening is
            exactly when a keyboard user wants to be able to back out. */}
        {head}
        {/*
          Two different waits, said differently. "Chưa hiển thị" is the lazy state and it names what is missing
          rather than looking like a failure; a reader who cannot see the surface still gets the title, so the
          placeholder is a text alternative rather than an empty box.
        */}
        <p className="cc-freshness" data-live-waiting={inView ? "opening" : "offscreen"} style={{ margin: 0 }}>
          {notice ??
            (inView
              ? "Đang mở bản hiện tại…"
              : `Chưa hiển thị${title === undefined ? "" : `: ${title}`} — cuộn tới để mở.`)}
        </p>
      </div>
    );
  }

  /*
   * A widget that runs in its own frame is mounted, not drawn.
   *
   * The branch is here rather than in a caller because this component is what owns the surface's lifecycle — the
   * claim, the lazy mount, the release — and both shapes want exactly that. What differs is only what goes in the
   * body.
   */
  if (live.kind === "isolated-frame") {
    return (
      <div
        ref={panel}
        className="cc-live-surface"
        data-live-instance={instanceId}
        data-ownership={ownership}
        data-display-mode={displayMode}
        data-lazy={inView ? "false" : "true"}
        role={displayMode === "expanded" ? "region" : undefined}
        aria-label={displayMode === "expanded" ? `Bản hiện tại: ${title ?? instanceId}` : undefined}
      >
        {head}
        <WidgetFrame
          instanceId={live.instanceId}
          url={client.nodeUrl(live.frame.url)}
          title={title ?? instanceId}
          props={live.props}
          brokeredCapabilities={live.frame.requestedCapabilities}
          allowedOrigins={live.frame.allowedOrigins}
          knownActionBindings={live.bindings.map((entry) => entry.actionBindingId)}
          revision={live.revision}
          /*
           * The frame asks; this authorizes and performs. Every invocation goes through the same route a click in
           * the conversation takes, against the same instance, digest and revision — so a widget in a frame is not a
           * second way to reach an effect.
           */
          invokeAction={async (intent) => {
            try {
              /*
               * The digest comes from the binding the frame named, not from a composition. A frame has no
               * composition, and the node re-authorizes against exactly this value — so sending the wrong one is
               * refused rather than papered over.
               */
              const binding = live.bindings.find((entry) => entry.actionBindingId === intent.actionBindingId);
              if (binding === undefined) {
                return { status: "refused", message: "Hành động này không còn được gắn với widget." };
              }
              await client.invokeAction(conversationId, instanceId, {
                actionBindingId: intent.actionBindingId,
                expectedRevision: intent.expectedRevision,
                expectedBindingDigest: binding.bindingDigest,
                input: intent.input,
                invocationId: intent.invocationId,
              });
              return { status: "accepted", message: "Đã gửi hành động." };
            } catch (cause) {
              return {
                status: "refused",
                message: cause instanceof Error ? cause.message : "Máy chủ từ chối hành động này.",
              };
            }
          }}
          chrome={{
            focus: () => panel.current?.focus(),
            resize: () => undefined,
            requestPin: () => undefined,
            openExternal: () => undefined,
          }}
        />
      </div>
    );
  }

  const view = toSurfaceViewFromLive(live, readOnly);

  return (
    <div
      ref={panel}
      className="cc-live-surface"
      data-live-instance={instanceId}
      data-ownership={ownership}
      data-display-mode={displayMode}
      data-lazy="false"
      role={displayMode === "expanded" ? "region" : undefined}
      aria-label={displayMode === "expanded" ? `Bản hiện tại: ${title ?? instanceId}` : undefined}
    >
      {head}
      {notice !== undefined && (
        <p className="cc-freshness" data-live-notice="true" style={{ margin: "0 0 var(--cc-space-xs)" }}>
          {notice}
        </p>
      )}
      <MiniAppSurface
        view={view}
        title={title}
        busy={busy}
        imageUrl={imageUrl}
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
export function toSurfaceViewFromLive(live: LiveWidgetResponse, readOnly: boolean): CompositeSurfaceView {
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
    // Ownership is what decides this, and it is decided on the server: a surface that does not hold
    // the claim renders read-only rather than offering controls that would be refused.
    readOnly,
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
