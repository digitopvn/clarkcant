import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  GatewayClient,
  ResolvedDataset,
  SnapshotPresentationResponse,
  Timeline,
} from "./api.ts";
import { renderBlock, type SurfaceBlockRef } from "./blocks.tsx";
import {
  applyResolvedTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  systemPrefersLight,
  watchSystemTheme,
  type ThemeChoice,
} from "./theme.ts";
import type { ThemeName } from "@clarkcant/design-tokens";
import { Orb } from "./Orb.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { resolveRenderer, toRendererDataset } from "./renderers.tsx";
import { MiniAppSurface, type CompositeSurfaceView } from "./mini-app-surface.tsx";
import { PinnedLiveSurface } from "./DesktopSurfaces.tsx";

/**
 * Conversation surface.
 *
 * One timeline, one composer, an optional pin shelf, and a status that never claims more
 * than it knows. There is no session picker and no sidebar, because the blueprint's
 * position is that the conversation is the interface: extra navigation is a cost the user
 * pays to learn the tool, not a feature.
 *
 * Two behaviours are load-bearing rather than cosmetic:
 *
 *   - **The status dot reports the gateway, not the model.** "Ready" means the runtime
 *     answered; it does not mean a provider credential is configured, and the empty state
 *     says so when nothing can answer.
 *   - **Suggestion chips are labelled as samples.** Clicking one runs a scripted recipe, so
 *     the label has to be visible before the click, not a footnote after it.
 */

export interface ConversationProps {
  client: GatewayClient;
  /** Pre-existing conversation, or `undefined` to create one on first send. */
  conversationId?: string;
  /** Injected so tests can assert behaviour without waiting on a wall clock. */
  onTimelineChange?: (timeline: Timeline) => void;
  /** Called once a conversation exists, so the host can remember it across reloads. */
  onConversationReady?: (conversationId: string) => void;
  /**
   * Called when the session is restarted, so the host can forget what it remembered.
   *
   * The conversation id lives in the host's storage rather than here, and a restart that left it
   * behind would be undone by the next reload: the start screen would appear, and then the old
   * conversation would come back. Clearing it is the host's job because remembering it is.
   */
  onSessionReset?: () => void;
  /** Loads an existing conversation on mount instead of starting empty. */
  initialAfter?: number;
}

type ConnectionState = "connecting" | "ready" | "offline";

/**
 * The four things the empty state offers.
 *
 * Four, and every one of them actually runs. The first three reach a scripted recipe over the
 * sample dataset, so they work with no provider configured; the fourth is an ordinary message and
 * needs a model to answer it. Nothing here is a label that looks like a feature — a chip that sends
 * a message nobody can handle teaches the user that the app is broken rather than that a model is
 * missing, and the fourth chip says which of those is true.
 */
const SUGGESTIONS = [
  { label: "Làm gì đó", text: "cho tui xem biểu đồ", detail: "chạy trên dữ liệu mẫu" },
  { label: "Sửa một lỗi", text: "tạo note nhanh cho tui", detail: "chạy trên dữ liệu mẫu" },
  { label: "Xem dự án của tui", text: "cho tui xem bảng dữ liệu", detail: "chạy trên dữ liệu mẫu" },
  { label: "Chỉ trò chuyện", text: "chào bạn, bạn làm được gì?", detail: "cần model" },
] as const;

export function Conversation({
  client,
  conversationId: initialConversationId,
  onTimelineChange,
  onConversationReady,
  onSessionReset,
}: ConversationProps): ReactElement {
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [timeline, setTimeline] = useState<Timeline | undefined>(undefined);
  const [datasets, setDatasets] = useState<Record<string, ResolvedDataset>>({});
  /**
   * The immutable presentation each message captured, keyed by snapshot.
   *
   * Fetched once and kept: a bundle is written once and never updated, so re-reading it on every
   * render would be a request per keystroke for data that cannot have changed. The live instance is
   * a different read, and it lives in the pinned surface that claims ownership of it.
   */
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotPresentationResponse>>({});
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [uiCheckOpen, setUiCheckOpen] = useState(false);
  /**
   * Which session the interface is showing.
   *
   * Incremented by a restart, and captured by anything that is about to write a result back. A
   * reply that arrives after the user restarted belongs to a conversation they have left, so it
   * is dropped rather than drawn into the fresh start screen.
   */
  const sessionGeneration = useRef(0);
  /**
   * The theme the user chose, which is `dark`, `light` or `system`.
   *
   * The choice is held, not the resolved theme. Holding the resolved theme would silently turn
   * `system` into whichever theme the operating system happened to be in when the page loaded,
   * and the interface would then stop following the system it was asked to follow.
   */
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => readStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<ThemeName>(() =>
    resolveTheme(readStoredTheme(), systemPrefersLight()),
  );

  /**
   * Apply the choice: store it, resolve it, and write the result onto the document.
   *
   * Storing the choice rather than the resolved value is what lets `system` keep meaning
   * `system` across a reload.
   */
  const applyThemeChoice = useCallback((next: ThemeChoice) => {
    storeTheme(next);
    const resolved = resolveTheme(next, systemPrefersLight());
    applyResolvedTheme(resolved);
    setThemeChoice(next);
    setResolvedTheme(resolved);
  }, []);

  /*
   * Follow the operating system, but only while the user has actually asked for `system`.
   * A listener that keeps firing after the user picks an explicit theme would override their
   * choice the next time their machine switched to night mode.
   */
  useEffect(() => {
    if (themeChoice !== "system") return;
    return watchSystemTheme((prefersLight) => {
      const resolved = resolveTheme("system", prefersLight);
      applyResolvedTheme(resolved);
      setResolvedTheme(resolved);
    });
  }, [themeChoice]);
  const scroller = useRef<HTMLDivElement>(null);

  /* Connectivity is checked once, so the status reflects reality rather than optimism. */
  useEffect(() => {
    let cancelled = false;
    client
      .health()
      .then(() => {
        if (!cancelled) setConnection("ready");
      })
      .catch(() => {
        if (!cancelled) setConnection("offline");
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const applyTimeline = useCallback(
    (next: Timeline) => {
      setTimeline(next);
      onTimelineChange?.(next);
    },
    [onTimelineChange],
  );

  /* Load any existing conversation once, so a reload is not a new conversation. */
  useEffect(() => {
    if (initialConversationId === undefined) return;
    let cancelled = false;
    client
      .timeline(initialConversationId)
      .then((loaded) => {
        if (!cancelled) applyTimeline(loaded);
      })
      .catch(() => {
        // A conversation that no longer exists is not an error the user needs to see; the
        // next send creates a fresh one.
        if (!cancelled) setConversationId(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [applyTimeline, client, initialConversationId]);

  /* Resolve every dataset a visible widget references, and record its freshness. */
  const datasetRefs = useMemo(() => {
    const refs = new Set<string>();
    for (const instance of timeline?.instances ?? []) {
      const ref = instance.props.datasetRef;
      if (typeof ref === "string") refs.add(ref);
    }
    return [...refs].sort().join(",");
  }, [timeline]);

  useEffect(() => {
    if (datasetRefs === "") return;
    let cancelled = false;
    for (const datasetId of datasetRefs.split(",")) {
      if (datasets[datasetId] !== undefined) continue;
      client
        .dataset(datasetId)
        .then((resolved) => {
          if (!cancelled) setDatasets((current) => ({ ...current, [datasetId]: resolved }));
        })
        .catch(() => {
          // A missing dataset is normal: the renderer shows its own unavailable message.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [client, datasetRefs, datasets]);

  const instanceById = useMemo(() => {
    const map = new Map<string, Timeline["instances"][number]>();
    for (const instance of timeline?.instances ?? []) map.set(instance.instanceId, instance);
    return map;
  }, [timeline]);

  /**
   * The snapshot behind every composed message, and only those with a bundle.
   *
   * A snapshot written before bundles existed has nothing to render from, which is why the absence
   * of a bundle is carried forward as the reason to show the message's text alternative rather
   * than the live instance's current props.
   */
  const composedSnapshots = useMemo(() => {
    const entries: { snapshotId: string; instanceId: string | undefined }[] = [];
    for (const block of blocksOf(timeline)) {
      if (block.type !== "surface") continue;
      const snapshot = (block.snapshot ?? {}) as Record<string, unknown>;
      const definitionRef = (block.definitionRef ?? {}) as Record<string, unknown>;
      const instanceId = typeof snapshot.instanceId === "string" ? snapshot.instanceId : undefined;
      const definitionId =
        typeof definitionRef.id === "string" ? definitionRef.id : instanceId === undefined ? "" : instanceById.get(instanceId)?.definitionId ?? "";
      if (definitionId !== "canvas.overview@1") continue;
      const snapshotId = typeof snapshot.snapshotId === "string" ? snapshot.snapshotId : "";
      if (snapshotId === "" || typeof snapshot.bundleRef !== "string") continue;
      entries.push({ snapshotId, instanceId });
    }
    return entries;
  }, [instanceById, timeline]);

  useEffect(() => {
    if (conversationId === undefined) return;
    for (const entry of composedSnapshots) {
      if (snapshots[entry.snapshotId] !== undefined) continue;
      void client
        .snapshotPresentation(conversationId, entry.snapshotId)
        .then((loaded) => setSnapshots((current) => ({ ...current, [entry.snapshotId]: loaded })))
        .catch(() => {
          // A snapshot that cannot be read is not an error state for the conversation: the message
          // falls back to its text alternative, which is what history keeps regardless.
        });
    }
  }, [client, composedSnapshots, conversationId, snapshots]);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [timeline]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "" || busy) return;

      setBusy(true);
      setError(undefined);
      setDraft("");
      const generation = sessionGeneration.current;
      try {
        const target = conversationId ?? (await client.createConversation("Conversation")).conversationId;
        // The user may have restarted while the conversation was being created or the model was
        // answering. Everything after this point belongs to the session they left.
        if (sessionGeneration.current !== generation) return;
        if (conversationId === undefined) {
          setConversationId(target);
          onConversationReady?.(target);
        }
        const response = await client.sendMessage(target, trimmed);
        if (sessionGeneration.current !== generation) return;
        applyTimeline(response.timeline);
      } catch (cause) {
        if (sessionGeneration.current !== generation) return;
        // The draft is restored so a failed send does not lose the user's text.
        setDraft(trimmed);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [applyTimeline, busy, client, conversationId, onConversationReady],
  );

  /**
   * Back to the start screen, with a new session.
   *
   * Deliberately not a delete: the conversation stays in the node's history, because that is a
   * record of what happened rather than a draft to discard. This only stops the interface from
   * showing it, and the next message opens a new one.
   */
  const restartSession = useCallback((): void => {
    sessionGeneration.current += 1;
    setConversationId(undefined);
    setTimeline(undefined);
    setDatasets({});
    setSnapshots({});
    setDraft("");
    setError(undefined);
    setBusy(false);
    onSessionReset?.();
  }, [onSessionReset]);

  const renderSurface = useCallback(
    (input: SurfaceBlockRef): ReactElement => {
      const instance = input.instanceId === undefined ? undefined : instanceById.get(input.instanceId);
      const definitionId = instance?.definitionId ?? input.definitionId;
      const Renderer = resolveRenderer(definitionId);

      if (!Renderer || !instance) {
        // An unknown definition is a normal outcome, not a failure: the snapshot's text
        // alternative is what history keeps.
        return (
          <div className="cc-card cc-freshness" data-widget-fallback="true" style={{ padding: "var(--cc-space-md)" }}>
            {input.textAlternative}
          </div>
        );
      }

      if (definitionId === "canvas.overview@1") {
        const captured = input.snapshotId === "" ? undefined : snapshots[input.snapshotId];
        return (
          <div
            data-widget-instance={instance.instanceId}
            data-widget-definition={definitionId}
            data-snapshot={input.snapshotId}
            data-snapshot-stale={input.stale ? "true" : "false"}
          >
            {captured === undefined ? (
              // History without a stored bundle shows what the message itself carries. Substituting
              // the live instance here is the failure mode this whole split exists to prevent.
              <div className="cc-card cc-freshness" data-widget-fallback="true" style={{ padding: "var(--cc-space-md)" }}>
                {input.textAlternative}
              </div>
            ) : (
              <MiniAppSurface view={toSurfaceViewFromSnapshot(captured, instance.revision)} title={typeof instance.props.title === "string" ? instance.props.title : undefined} />
            )}
            {conversationId !== undefined && (
              <button
                className="cc-icon-btn"
                style={{ width: "auto", padding: "0 var(--cc-space-sm)", marginTop: "var(--cc-space-xs)" }}
                data-open-live={instance.instanceId}
                onClick={() => {
                  // "Open the current view" is an expanded pin: the pinned surface is where the
                  // live instance is mounted, and it is the one that claims ownership of it.
                  void client
                    .pin(conversationId, instance.instanceId, "expanded")
                    .then((result) => applyTimeline(result.timeline))
                    .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
                }}
              >
                Mở bản hiện tại
              </button>
            )}
          </div>
        );
      }

      const datasetRef = instance.props.datasetRef;
      const resolved = typeof datasetRef === "string" ? datasets[datasetRef] : undefined;
      const dataset = resolved === undefined ? undefined : toRendererDataset(resolved);

      return (
        <div data-widget-instance={instance.instanceId} data-widget-definition={definitionId}>
          <Renderer
            definitionId={definitionId}
            props={instance.props}
            dataset={dataset}
            onAction={(action) => {
              // View actions only for now: an action that would cause an effect goes through
              // the approval route, and there is no code path here that bypasses it.
              void action;
            }}
          />
          {conversationId !== undefined && (
            <button
              className="cc-icon-btn"
              style={{ width: "auto", padding: "0 var(--cc-space-sm)", marginTop: "var(--cc-space-xs)" }}
              data-pin-instance={instance.instanceId}
              onClick={() => {
                void client
                  .pin(conversationId, instance.instanceId)
                  .then((result) => applyTimeline(result.timeline))
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
              }}
            >
              Ghim lại
            </button>
          )}
        </div>
      );
    },
    [applyTimeline, client, conversationId, instanceById, snapshots],
  );

  const blocks = timeline?.messages ?? [];
  const pins = timeline?.pins ?? [];

  return (
    <div className="cc-shell">
      <header className="cc-header">
        {/*
          The logo is the way back to the start screen, which is where a user looks first when
          they want to begin again. It is a button rather than a decorated div so it can be reached
          and announced: a click target only a mouse can find is half a control.
        */}
        <button
          type="button"
          className="cc-brand"
          data-home="true"
          onClick={restartSession}
          title="Bắt đầu lại"
          aria-label="Bắt đầu lại: về màn hình đầu và mở một phiên mới"
        >
          <Orb size={30} className="cc-orb" label="" />
          <span>Agent</span>
        </button>
        <div className="cc-header-end">
          <div className="cc-status" role="status" aria-live="polite" data-connection={connection}>
            <span className="cc-dot" data-state={connection} aria-hidden="true" />
            {connection === "ready" ? "Ready" : connection === "connecting" ? "Đang kết nối" : "Mất kết nối"}
          </div>
          {/*
            The gear is the only settings affordance, which is why it is here rather than in a
            menu: a setting that is two clicks deep is a setting nobody checks. It opens a panel
            that reads the live tokens back off the document, so what it shows is what rendered.
          */}
          <button type="button" className="cc-icon-btn" aria-label="Cài đặt" title="Cài đặt" data-settings="true" onClick={() => setUiCheckOpen(true)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      <div className="cc-scroll" ref={scroller}>
        {blocks.length === 0 ? (
          <div className="cc-empty">
            <Orb size={148} className="cc-empty-orb" label="Đang chờ bạn nói điều muốn làm" />
            <h1>Bạn đang nghĩ gì?</h1>
            <p>Nói việc bạn muốn làm, hoặc bắt đầu từ một trong bốn gợi ý dưới đây.</p>
            <div className="cc-chip-row" data-suggestion-count={SUGGESTIONS.length}>
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.text}
                  type="button"
                  className="cc-chip"
                  data-suggestion={suggestion.text}
                  data-suggestion-detail={suggestion.detail}
                  // The detail is in the accessible name as well as visible text, because a person
                  // using a screen reader has the same question about which chips need a model.
                  aria-label={`${suggestion.label} — ${suggestion.detail}`}
                  onClick={() => void send(suggestion.text)}
                >
                  <span className="cc-chip-label">{suggestion.label}</span>
                  <span className="cc-chip-detail">{suggestion.detail}</span>
                </button>
              ))}
            </div>
            <p className="cc-freshness">
              Gợi ý đánh dấu “cần model” sẽ báo lỗi nếu node này chưa cấu hình model.
            </p>
          </div>
        ) : (
          <div className="cc-timeline" aria-live="polite" aria-relevant="additions">
            {blocks.map((message, index) => (
              <article key={`${message.messageId}-${index}`} className="cc-row" data-role={message.role}>
                {message.role === "assistant" ? (
                  <div className="cc-assistant">
                    <span className="cc-avatar" aria-hidden="true" />
                    <div style={{ display: "flex", flexDirection: "column", gap: "var(--cc-space-sm)", minWidth: 0, flex: 1 }}>
                      {message.blocks.map((block, blockIndex) => renderBlock(block, blockIndex, renderSurface))}
                    </div>
                  </div>
                ) : (
                  message.blocks.map((block, blockIndex) => renderBlock(block, blockIndex, renderSurface))
                )}
              </article>
            ))}
          </div>
        )}
      </div>

      {/*
        The expanded live view of a pinned instance. This is the only place a composed surface can
        be acted on: the copy in the transcript is history, and mounting a second live instance
        beside it would be two owners for one logical widget.
      */}
      {conversationId !== undefined &&
        pins
          .filter((pin) => pin.displayMode === "expanded" && instanceById.get(pin.instanceId)?.definitionId === "canvas.overview@1")
          .map((pin) => (
            <div key={`live-${pin.pinId}`} className="cc-pin-expanded" data-pin-live={pin.pinId}>
              <PinnedLiveSurface
                client={client}
                conversationId={conversationId}
                instanceId={pin.instanceId}
                displayMode="expanded"
                title={typeof instanceById.get(pin.instanceId)?.props.title === "string" ? String(instanceById.get(pin.instanceId)?.props.title) : undefined}
                onTimeline={applyTimeline}
              />
            </div>
          ))}

      {pins.length > 0 && (
        <div className="cc-pins" data-pin-shelf="true">
          {pins.map((pin) => {
            const instance = instanceById.get(pin.instanceId);
            return (
              <span key={pin.pinId} className="cc-pin" data-pin-id={pin.pinId} data-refresh-policy={pin.refreshPolicy}>
                <span>{instance?.definitionId ?? pin.instanceId}</span>
                <button
                  aria-label="Bỏ ghim"
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
      )}

      <div className="cc-composer-wrap">
        <form
          className="cc-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <button type="button" className="cc-icon-btn" aria-label="Đính kèm" disabled title="Chưa hỗ trợ đính kèm">
            +
          </button>
          <textarea
            value={draft}
            aria-label="Nhập tin nhắn"
            placeholder="Message anything…"
            rows={1}
            data-composer="true"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          <button type="button" className="cc-icon-btn" aria-label="Nhập bằng giọng nói" disabled title="Live voice cần provider account">
            ◉
          </button>
          <button type="submit" className="cc-icon-btn" aria-label="Gửi" disabled={busy || draft.trim() === ""} data-send="true">
            ↑
          </button>
        </form>
        <div className="cc-hint">
          <span>{error === undefined ? "Một hội thoại. Mọi thứ trong tầm với." : error}</span>
          <span>Enter để gửi · Shift+Enter xuống dòng</span>
        </div>
      </div>

      <SettingsPanel
        open={uiCheckOpen}
        onClose={() => setUiCheckOpen(false)}
        client={client}
        {...(conversationId === undefined ? {} : { conversationId })}
        themeChoice={themeChoice}
        resolvedTheme={resolvedTheme}
        onThemeChoice={applyThemeChoice}
      />
    </div>
  );
}

/**
 * Every block in a timeline, flattened.
 *
 * A small helper rather than two nested loops in each caller: the composition effect and the
 * dataset effect both need the same walk, and writing it twice is how the two drift into
 * disagreeing about which blocks count.
 */
function blocksOf(timeline: Timeline | undefined): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const message of timeline?.messages ?? []) {
    for (const block of message.blocks ?? []) blocks.push(block);
  }
  return blocks;
}

/**
 * Turn a captured bundle into what the surface renders.
 *
 * Nothing here reaches the live rows. A region with no materialised rows is reported as `missing`
 * rather than filled from the current dataset, which is the difference between history and a view
 * that quietly rewrites itself. `actions` is deliberately empty: a snapshot declares the bindings
 * that existed when it was taken, and the read-only route that produced this data does not carry
 * them, so a historical surface cannot mutate anything even if a client tried.
 */
function toSurfaceViewFromSnapshot(
  captured: SnapshotPresentationResponse,
  revision: number,
): CompositeSurfaceView {
  const materialised = new Map(captured.sections.map((section) => [section.sectionId, section]));
  const availability: Record<string, "live" | "missing"> = {};
  const sections = captured.sections.map((section) => {
    const rows = materialised.get(section.sectionId)?.rows;
    availability[section.sectionId] = rows === undefined ? "missing" : "live";
    return {
      sectionId: section.sectionId,
      slot: section.slot as CompositeSurfaceView["sections"][number]["slot"],
      definitionRef: section.definitionRef,
      props: section.props,
      dataRefs: section.dataRefs,
      ...(rows === undefined ? {} : { rows }),
      textAlternative: section.textAlternative,
    };
  });

  const spec = captured.spec;
  return {
    compositionId: spec?.compositionId ?? "",
    instanceId: spec?.instanceId ?? captured.snapshot.instanceId ?? "",
    catalogDigest: captured.catalogDigest ?? "",
    // The period a snapshot was captured at is the period it shows. A later filter change belongs
    // to the live instance, not to this message.
    initialState: spec?.initialState ?? { period: "week", timezone: "UTC" },
    actions: [],
    sections,
    revision,
    ...(typeof captured.snapshot.capturedAt === "string" ? { capturedAt: captured.snapshot.capturedAt } : {}),
    stale: captured.snapshot.stale === true,
    tombstone: captured.tombstone,
    availability,
  };
}
