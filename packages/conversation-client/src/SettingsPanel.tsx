/**
 * The settings surface.
 *
 * Behind the gear, and it shows what the node actually is: the model it is configured for, the
 * ceiling on a turn, and every capability with its real readiness. Nothing here is a placeholder
 * row waiting for a backend — a settings screen that shows plausible values is worse than an empty
 * one, because it is believed.
 *
 * It is a drawer rather than a page for the reason the blueprint gives: seeing a setting should
 * never cost the conversation. A full-page settings route would unmount the timeline to change a
 * theme, and the user would lose the thread they were reading to check a checkbox.
 */

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";

import { contrastRatio, AA_NORMAL_TEXT, DARK, LIGHT, type ThemeName } from "@clarkcant/design-tokens";

import { TokenSpecimens, readVar } from "./TokenSpecimens.tsx";
import type { GatewayClient } from "./api.ts";

/**
 * Accents worth comparing.
 *
 * The first is the specification's. The second is the saturated indigo this palette replaced,
 * kept so the difference the "quiet chrome" decision made can be seen rather than argued about.
 * These are a preview, not a stored preference: the accent is a design decision, and nothing here
 * writes it anywhere.
 */
const ACCENT_CHOICES: { label: string; dark: string; light: string; note: string }[] = [
  { label: "Spec lavender", dark: "#B8AEDC", light: "#6B5FA8", note: "the specification's" },
  { label: "Previous indigo", dark: "#7C7CF5", light: "#4F46E5", note: "replaced" },
  { label: "Muted sage", dark: "#9BBFAC", light: "#41705A", note: "alternative" },
  { label: "Clay", dark: "#D2A69C", light: "#8E5449", note: "alternative" },
];

/** Nodes the settings surface needs, loaded once when it opens. */
interface NodeFacts {
  nodeId: string;
  label: string;
  createdAt: string;
  model: { provider: string; id: string; maxWallClockMs: number; maxTokens: number } | null;
}

interface ToolFacts {
  ref: string;
  summary: string;
  usable: boolean;
  blockedReason?: string;
}

export interface SettingsRowProps {
  label: string;
  /** What the row means or why it is the way it is. Shown under the label, never as a tooltip. */
  description?: string;
  /** `blocked` states a limitation rather than hiding the control behind a spinner. */
  state?: "ok" | "blocked" | "absent";
  children?: ReactNode;
}

/**
 * One setting.
 *
 * The description is always rendered rather than tucked into a `title` attribute: a limitation
 * that only appears on hover is a limitation most people never learn about.
 */
export function SettingsRow({ label, description, state, children }: SettingsRowProps): ReactElement {
  return (
    <div className="cc-setting-row" data-state={state ?? "ok"}>
      <div className="cc-setting-text">
        <span className="cc-setting-label">{label}</span>
        {description !== undefined && <span className="cc-setting-desc">{description}</span>}
      </div>
      {children !== undefined && <div className="cc-setting-control">{children}</div>}
    </div>
  );
}

export interface ToolRowProps {
  /**
   * The capability reference, e.g. `project.code.change@1`.
   *
   * Not named `ref`: React treats that name specially on a component, so a prop called `ref` is
   * intercepted before the component sees it.
   */
  toolRef: string;
  summary: string;
  usable: boolean;
  blockedReason?: string;
}

/**
 * One capability.
 *
 * Usable and unusable look different on purpose, and the reason is always shown when there is one.
 * The blueprint's rule for a blocked gate applies here too: a capability that is declared but not
 * loaded is reported as blocked, with what would unblock it — never rounded up to available.
 */
export function ToolRow({ toolRef, summary, usable, blockedReason }: ToolRowProps): ReactElement {
  return (
    <div className="cc-tool-row" data-usable={usable} data-tool-ref={toolRef}>
      <div className="cc-setting-text">
        <span className="cc-setting-label">
          <code>{toolRef}</code>
        </span>
        <span className="cc-setting-desc">{summary}</span>
        {blockedReason !== undefined && blockedReason !== "" && (
          <span className="cc-setting-desc cc-tool-blocked" data-blocked-reason="true">
            {blockedReason}
          </span>
        )}
      </div>
      {/* A word, not a colour: the state has to read without the swatch. */}
      <span className="cc-badge" data-tone={usable ? "ok" : "warn"}>
        {usable ? "dùng được" : "chưa dùng được"}
      </span>
    </div>
  );
}

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  client: GatewayClient;
  theme: ThemeName;
  onTheme: (theme: ThemeName) => void;
}

export function SettingsPanel({ open, onClose, client, theme, onTheme }: SettingsPanelProps): ReactElement | null {
  const [facts, setFacts] = useState<NodeFacts | undefined>(undefined);
  const [tools, setTools] = useState<ToolFacts[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [accentIndex, setAccentIndex] = useState(0);
  // Bumped after a theme or accent change so the contrast readout re-reads computed values.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [node, capabilities] = await Promise.all([client.node(), client.capabilities()]);
        if (cancelled) return;
        setFacts(node);
        setTools(capabilities.capabilities);
        setProblem(undefined);
      } catch (cause) {
        if (cancelled) return;
        // Reported rather than left blank: an empty settings screen and an unreachable node look
        // identical, and only one of them is a problem the user can act on.
        setProblem(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  const applyTheme = useCallback(
    (next: ThemeName) => {
      onTheme(next);
      setRevision((n) => n + 1);
    },
    [onTheme],
  );

  /**
   * Preview one accent.
   *
   * The label colour is chosen rather than assumed: a pale accent needs dark text on it and a
   * saturated one needs light, and picking wrong is the classic unreadable-button bug that a
   * hard-coded white `onAccent` produces.
   */
  const applyAccent = useCallback(
    (index: number) => {
      const choice = ACCENT_CHOICES[index];
      if (choice === undefined || typeof document === "undefined") return;
      const value = theme === "dark" ? choice.dark : choice.light;
      const root = document.documentElement;
      const tokens = theme === "dark" ? DARK : LIGHT;
      root.style.setProperty("--cc-accent", value);
      root.style.setProperty(
        "--cc-on-accent",
        contrastRatio("#ffffff", value) >= contrastRatio(tokens.canvas, value) ? "#ffffff" : tokens.canvas,
      );
      setAccentIndex(index);
      setRevision((n) => n + 1);
    },
    [theme],
  );

  // Re-applied when the theme changes, so switching theme does not leave the other theme's
  // accent painted over the new one. Deliberately not keyed on `accentIndex`: this exists to
  // re-paint the current choice against a new theme, and keying on the index would make it write
  // the same value on every pick as well.
  useEffect(() => {
    if (!open) return;
    applyAccent(accentIndex);
  }, [open, theme]);

  if (!open) return null;

  const contrastReadout = (): { label: string; ratio: number }[] => {
    void revision;
    const pairs: { label: string; foreground: string; background: string }[] = [
      { label: "body text on canvas", foreground: readVar("--cc-text"), background: readVar("--cc-canvas") },
      { label: "caption text on a card", foreground: readVar("--cc-text-muted"), background: readVar("--cc-card") },
      {
        label: "tertiary text on canvas",
        foreground: readVar("--cc-text-tertiary"),
        background: readVar("--cc-canvas"),
      },
      { label: "label on accent", foreground: readVar("--cc-on-accent"), background: readVar("--cc-accent") },
    ];
    const measured: { label: string; ratio: number }[] = [];
    for (const pair of pairs) {
      if (pair.foreground === "" || pair.background === "") continue;
      try {
        measured.push({ label: pair.label, ratio: contrastRatio(pair.foreground, pair.background) });
      } catch {
        // A value the parser does not understand is left out rather than reported as a pass.
        continue;
      }
    }
    return measured;
  };

  return (
    <>
      <div className="cc-panel-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="cc-panel" role="dialog" aria-modal="true" aria-labelledby="cc-settings-title">
        <header className="cc-panel-head">
          <h2 id="cc-settings-title">Cài đặt</h2>
          <button type="button" className="cc-icon-btn" onClick={onClose} aria-label="Đóng cài đặt">
            ✕
          </button>
        </header>

        <div className="cc-panel-body">
          {problem !== undefined && (
            <section className="cc-panel-section">
              <h3>Không đọc được trạng thái node</h3>
              <p className="cc-panel-note" data-settings-error="true">
                {problem}
              </p>
            </section>
          )}

          <section className="cc-panel-section">
            <h3>Giao diện</h3>
            <SettingsRow label="Chủ đề" description="Áp dụng ngay, không cần tải lại.">
              <div className="cc-panel-row">
                {(["dark", "light"] as ThemeName[]).map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="cc-badge"
                    aria-pressed={theme === name}
                    data-selected={theme === name}
                    onClick={() => applyTheme(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </SettingsRow>
            <SettingsRow
              label="Accent"
              description="Xem thử, không lưu. Màu chữ trên accent được chọn theo độ tương phản."
            >
              <div className="cc-panel-row">
                {ACCENT_CHOICES.map((choice, index) => (
                  <button
                    key={choice.label}
                    type="button"
                    className="cc-swatch"
                    aria-pressed={accentIndex === index}
                    aria-label={`${choice.label} (${choice.note})`}
                    onClick={() => applyAccent(index)}
                    style={{ background: theme === "dark" ? choice.dark : choice.light }}
                  />
                ))}
              </div>
            </SettingsRow>
            <p className="cc-panel-note">{ACCENT_CHOICES[accentIndex]?.note ?? ""}</p>
          </section>

          <section className="cc-panel-section">
            <h3>Model</h3>
            {facts === undefined ? (
              <p className="cc-panel-note">Đang đọc…</p>
            ) : facts.model === null ? (
              // A node with no model is a working node. Saying so is the point.
              <p className="cc-panel-note" data-model="none">
                Node này chưa cấu hình model. Nó trả lời bằng recipe và capability đã cài, và không
                gọi provider nào.
              </p>
            ) : (
              <>
                <SettingsRow label="Provider" description="Đặt bằng CC_MODEL_PROVIDER.">
                  <code>{facts.model.provider}</code>
                </SettingsRow>
                <SettingsRow label="Model" description="Đặt bằng CC_MODEL_ID.">
                  <code>{facts.model.id}</code>
                </SettingsRow>
                <SettingsRow
                  label="Trần một lượt"
                  description="Một lượt vượt trần sẽ bị dừng, không chạy tiếp."
                >
                  <code>
                    {facts.model.maxWallClockMs} ms · {facts.model.maxTokens} token
                  </code>
                </SettingsRow>
              </>
            )}
          </section>

          <section className="cc-panel-section">
            <h3>Công cụ</h3>
            {tools === undefined ? (
              <p className="cc-panel-note">Đang đọc…</p>
            ) : tools.length === 0 ? (
              <p className="cc-panel-note">Chưa có capability nào trên node này.</p>
            ) : (
              tools.map((tool) => (
                <ToolRow
                  key={tool.ref}
                  toolRef={tool.ref}
                  summary={tool.summary}
                  usable={tool.usable}
                  {...(tool.blockedReason === undefined ? {} : { blockedReason: tool.blockedReason })}
                />
              ))
            )}
          </section>

          <section className="cc-panel-section">
            <h3>Node</h3>
            {facts === undefined ? (
              <p className="cc-panel-note">Đang đọc…</p>
            ) : (
              <>
                <SettingsRow label="Nhãn">
                  <code>{facts.label}</code>
                </SettingsRow>
                <SettingsRow label="Mã node">
                  <code>{facts.nodeId}</code>
                </SettingsRow>
              </>
            )}
          </section>

          <section className="cc-panel-section">
            <h3>Độ tương phản, đo trực tiếp</h3>
            <ul className="cc-panel-readout">
              {contrastReadout().map((row) => (
                <li key={row.label} data-pass={row.ratio >= AA_NORMAL_TEXT}>
                  <span>{row.label}</span>
                  <span>
                    {row.ratio.toFixed(2)}:1 {row.ratio >= AA_NORMAL_TEXT ? "✓" : "✗ dưới 4.5"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {/* The same specimens the UI panel shows. A user checking what the interface is built
              from should not have to open a second tool to find out. */}
          <TokenSpecimens />
        </div>
      </aside>
    </>
  );
}
