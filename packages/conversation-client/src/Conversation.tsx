import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GatewayClient, ResolvedDataset, Timeline } from "./api.ts";
import { renderBlock } from "./blocks.tsx";
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
  /** Loads an existing conversation on mount instead of starting empty. */
  initialAfter?: number;
}

type ConnectionState = "connecting" | "ready" | "offline";

const SUGGESTIONS = [
  { label: "Xem thử một biểu đồ", text: "cho tui xem biểu đồ" },
  { label: "Tạo ghi chú nhanh", text: "tạo note nhanh cho tui" },
  { label: "Xem bảng dữ liệu mẫu", text: "cho tui xem bảng dữ liệu" },
] as const;

export function Conversation({
  client,
  conversationId: initialConversationId,
  onTimelineChange,
  onConversationReady,
}: ConversationProps): ReactElement {
  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [timeline, setTimeline] = useState<Timeline | undefined>(undefined);
  const [datasets, setDatasets] = useState<Record<string, ResolvedDataset>>({});
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [uiCheckOpen, setUiCheckOpen] = useState(false);
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
      try {
        const target = conversationId ?? (await client.createConversation("Conversation")).conversationId;
        if (conversationId === undefined) {
          setConversationId(target);
          onConversationReady?.(target);
        }
        const response = await client.sendMessage(target, trimmed);
        applyTimeline(response.timeline);
      } catch (cause) {
        // The draft is restored so a failed send does not lose the user's text.
        setDraft(trimmed);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [applyTimeline, busy, client, conversationId, onConversationReady],
  );

  const instanceById = useMemo(() => {
    const map = new Map<string, Timeline["instances"][number]>();
    for (const instance of timeline?.instances ?? []) map.set(instance.instanceId, instance);
    return map;
  }, [timeline]);

  const renderSurface = useCallback(
    (input: { instanceId: string | undefined; definitionId: string; textAlternative: string; revision: number }): ReactElement => {
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
    [applyTimeline, client, conversationId, datasets, instanceById],
  );

  const blocks = timeline?.messages ?? [];
  const pins = timeline?.pins ?? [];

  return (
    <div className="cc-shell">
      <header className="cc-header">
        <div className="cc-brand">
          <Orb size={30} className="cc-orb" label="" />
          <span>Agent</span>
        </div>
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
          <button type="button" className="cc-icon-btn" aria-label="UI Check" title="UI Check" data-ui-check="true" onClick={() => setUiCheckOpen(true)}>
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
            <h1>Bạn muốn làm gì?</h1>
            <p>Cứ nói việc bạn muốn. Ba gợi ý dưới đây chạy trên dữ liệu mẫu, không cần kết nối gì.</p>
            <div style={{ display: "flex", gap: "var(--cc-space-sm)", flexWrap: "wrap", justifyContent: "center" }}>
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.text}
                  className="cc-badge"
                  style={{ cursor: "pointer", font: "inherit", padding: "var(--cc-space-sm) var(--cc-space-md)" }}
                  data-suggestion={suggestion.text}
                  onClick={() => void send(suggestion.text)}
                >
                  {suggestion.label}
                </button>
              ))}
            </div>
            <p className="cc-freshness">Gợi ý là dữ liệu mẫu / demo tương tác.</p>
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
        themeChoice={themeChoice}
        resolvedTheme={resolvedTheme}
        onThemeChoice={applyThemeChoice}
      />
    </div>
  );
}
