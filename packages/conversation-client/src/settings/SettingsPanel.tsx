import { useCallback, useEffect, useState, type ReactElement } from "react";

import { Modal } from "../Modal.tsx";
import type { GatewayClient } from "../api.ts";
import type { ThemeName } from "@clarkcant/design-tokens";
import type { ThemeChoice } from "../theme.ts";
import { AiRoutingSettings } from "./AiRoutingSettings.tsx";
import { ControlSettings } from "./ControlSettings.tsx";
import { DeveloperSettings } from "./DeveloperSettings.tsx";
import { DevicesVoiceSettings } from "./DevicesVoiceSettings.tsx";
import { ExperienceSettings } from "./ExperienceSettings.tsx";
import { ExtensionsSettings } from "./ExtensionsSettings.tsx";
import { MemorySettings } from "./MemorySettings.tsx";
import { usePreferences } from "./controls/use-preferences.ts";

export { SettingsRow, type SettingsRowProps, ToolRow, type ToolRowProps } from "./controls/SettingsRow.tsx";

/**
 * The settings surface.
 *
 * Behind the gear, and it shows what the node actually is: the model it is configured for, the ceiling on a
 * turn, and every capability with its real readiness. Nothing here is a placeholder row waiting for a backend
 * — a settings screen that shows plausible values is worse than an empty one, because it is believed.
 *
 * It is a modal rather than a route for the reason the blueprint gives: seeing a setting should never cost the
 * conversation. A full-page settings route would unmount the timeline to change a theme, and the user would
 * lose the thread they were reading to check a checkbox.
 *
 * The six tabs are the user's own mental model rather than the architecture's:
 *
 *   Experience, AI & Routing, Control, Extensions & Widgets, Devices & Voice, and Developer.
 *
 * They replaced General / Models / Tools / Devices, which named the system's parts. The old structure put the
 * node id, raw pi settings and capability references in tabs a normal user reads, and left no place at all for
 * execution policy or the orb. Each tab now lives in its own file, so the panel is a composition rather than
 * the seven-hundred-line component it had become.
 *
 * A control appears here only when the behaviour behind it exists. Execution policy has a control because
 * `decideExecution` reads it; the orb has controls because the renderer clamps them; density, background
 * routing and the voice picker are declared in the registry and deliberately have none, with the reason shown
 * where a user would look for them. A switch that changes nothing teaches the user that settings are
 * decoration.
 */

const TABS = [
  { id: "experience", label: "Experience" },
  // Provider and model together, because choosing one means choosing the other: the second list belongs to
  // the first. Personal instructions land here with the phase that makes them reach the model.
  { id: "ai", label: "AI & Routing" },
  { id: "control", label: "Control" },
  { id: "extensions", label: "Extensions" },
  { id: "devices", label: "Devices & Voice" },
  // What the node remembers, and the way to remove it. A report like Developer, and placed next to it for the
  // same reason: nothing here is a choice the user is making about behaviour.
  { id: "memory", label: "Memory" },
  // Last, and it is the only one whose contents are a report rather than a choice.
  { id: "developer", label: "Developer" },
] as const;

type TabId = (typeof TABS)[number]["id"];

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

interface RecentEffect {
  at: string;
  kind: string;
  mode: string;
  category: string;
  description: string;
  operationDigest: string;
  because: string;
}

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  client: GatewayClient;
  /** What the user chose, which may be `system`. */
  themeChoice: ThemeChoice;
  /** What is currently shown, which is always `dark` or `light`. */
  resolvedTheme: ThemeName;
  onThemeChoice: (choice: ThemeChoice) => void;
  /** Called after a write that changes the orb, so the orb on screen follows the control that changed it. */
  onOrbChange?: () => void;
  /**
   * The tab to show, when something other than the panel chose one.
   *
   * A spoken command names a tab, and the speech path has to land where clicking that tab lands. Without this the
   * command was understood and then quietly ignored, which reads as the microphone not working.
   */
  openAt?: TabId | undefined;
}

export function SettingsPanel({
  open,
  onClose,
  client,
  themeChoice,
  resolvedTheme,
  onThemeChoice,
  onOrbChange,
  openAt,
}: SettingsPanelProps): ReactElement | null {
  const [facts, setFacts] = useState<NodeFacts | undefined>(undefined);
  const [tools, setTools] = useState<ToolFacts[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [effects, setEffects] = useState<readonly RecentEffect[]>([]);
  const [effectsProblem, setEffectsProblem] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<TabId>(openAt ?? "experience");

  // Followed while open as well as at first render: a command that names a tab after the panel is already showing
  // has to move to it, and that is the case a session open across a settings change produces.
  useEffect(() => {
    if (open && openAt !== undefined) setTab(openAt);
  }, [open, openAt]);
  const prefs = usePreferences(client, open);

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
        // Reported rather than left blank: an empty settings screen and an unreachable node look identical,
        // and only one of them is a problem the user can act on.
        setProblem(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void client
      .activity()
      .then((answer) => {
        if (!cancelled) {
          setEffects(answer.effects);
          setEffectsProblem(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // A different failure from the node read above, and reported in the section it belongs to: an empty
        // audit list and an unreadable one mean different things.
        setEffectsProblem(cause instanceof Error ? cause.message : "Không đọc được lịch sử.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  // Opened on Experience each time. Remembering the last tab sounds helpful and is not: someone who opened
  // Developer once to check a node id would land there every time they wanted the theme.
  useEffect(() => {
    if (!open) return;
    setTab("experience");
  }, [open]);

  const orbChanged = useCallback(() => {
    onOrbChange?.();
  }, [onOrbChange]);

  if (!open) return null;

  const nodeStatus = (): string => {
    if (problem !== undefined) return "Không đọc được trạng thái node";
    if (facts === undefined) return "Đang đọc…";
    return `${facts.label} · đã kết nối runtime cục bộ`;
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cài đặt"
      description="Vài tuỳ chọn. Mọi thứ khác nằm trong hội thoại."
      // Narrower than a decision dialog: see the note on the prop. 560 is the design's number.
      width="560px"
    >
      <div className="cc-tabs" role="tablist" aria-label="Nhóm cài đặt">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`cc-tab-${entry.id}`}
            className="cc-tab"
            aria-selected={tab === entry.id}
            aria-controls={`cc-tabpanel-${entry.id}`}
            data-selected={tab === entry.id}
            /*
             * Roving tabindex: one stop in the tab order for the whole group, and arrows move within it. The
             * ARIA tabs pattern requires this — a tablist where every tab is separately tabbable makes a
             * keyboard user press Tab six times to get past the settings header.
             */
            tabIndex={tab === entry.id ? 0 : -1}
            onClick={() => setTab(entry.id)}
            onKeyDown={(event) => {
              const index = TABS.findIndex((candidate) => candidate.id === tab);
              const move = (next: number): void => {
                event.preventDefault();
                // Wraps, which is what the pattern asks for and what a user expects at the end of a list.
                const target = TABS[(next + TABS.length) % TABS.length];
                if (target === undefined) return;
                setTab(target.id);
                // Focus follows selection, so the next arrow press starts from where the eye is.
                document.getElementById(`cc-tab-${target.id}`)?.focus();
              };
              if (event.key === "ArrowRight") move(index + 1);
              else if (event.key === "ArrowLeft") move(index - 1);
              // Home and End are part of the pattern, and cheap: they are what a long list needs.
              else if (event.key === "Home") move(0);
              else if (event.key === "End") move(TABS.length - 1);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`cc-tabpanel-${tab}`}
        aria-labelledby={`cc-tab-${tab}`}
        className="cc-tabpanel"
        data-active-tab={tab}
        // Focusable so a keyboard user can move from the tab strip into the panel's content, which is what the
        // pattern expects when the panel does not begin with a focusable control.
        tabIndex={-1}
      >
        {/*
          One error banner for the node read, above whichever tab is open, because it explains why several tabs
          are thin at once. The preference read reports itself inside the tabs that use it.
        */}
        {problem === undefined ? null : (
          <section className="cc-panel-section">
            <h3>Không đọc được trạng thái node</h3>
            <p className="cc-panel-note" data-settings-error="true">
              {problem}
            </p>
          </section>
        )}
        {prefs.problem === undefined ? null : (
          <section className="cc-panel-section">
            <h3>Không đọc được tuỳ chọn</h3>
            <p className="cc-panel-note" data-settings-preference-error="true">
              {prefs.problem}
            </p>
          </section>
        )}

        {tab === "experience" && (
          <ExperienceSettings
            prefs={prefs}
            themeChoice={themeChoice}
            resolvedTheme={resolvedTheme}
            onThemeChoice={onThemeChoice}
            onOrbChange={orbChanged}
          />
        )}
        {tab === "ai" && <AiRoutingSettings client={client} prefs={prefs} facts={facts} />}
        {tab === "control" && (
          <ControlSettings prefs={prefs} recentEffects={effects} recentProblem={effectsProblem} />
        )}
        {tab === "extensions" && <ExtensionsSettings client={client} tools={tools} />}
        {tab === "devices" && <DevicesVoiceSettings client={client} prefs={prefs} facts={facts} />}
        {tab === "memory" && <MemorySettings client={client} />}
        {tab === "developer" && <DeveloperSettings client={client} facts={facts} />}
      </div>

      <footer className="cc-modal-foot">
        <span className="cc-freshness" data-settings-status={problem === undefined ? "ok" : "error"}>
          {nodeStatus()}
        </span>
        <button type="button" className="cc-badge cc-modal-done" onClick={onClose}>
          Xong
        </button>
      </footer>
    </Modal>
  );
}
