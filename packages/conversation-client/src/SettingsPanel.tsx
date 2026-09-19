/**
 * The settings surface.
 *
 * Behind the gear, and it shows what the node actually is: the model it is configured for, the
 * ceiling on a turn, and every capability with its real readiness. Nothing here is a placeholder
 * row waiting for a backend — a settings screen that shows plausible values is worse than an empty
 * one, because it is believed.
 *
 * It is a modal rather than a route for the reason the blueprint gives: seeing a setting should
 * never cost the conversation. A full-page settings route would unmount the timeline to change a
 * theme, and the user would lose the thread they were reading to check a checkbox. It is a modal
 * rather than the drawer it used to be because the reference design keeps distinct areas apart, and a
 * drawer shows them as one continuous scroll, which reads as a long list rather than as separate
 * places. Autonomy is one of those areas rather than a row inside General: what this node does without
 * asking is a decision of its own, not an appearance preference.
 *
 * Every tab has content of its own. A tab that exists but is empty teaches the user that the tabs
 * are decoration, and the next time they will not bother opening one.
 */

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";

import { MicrophoneCheck } from "./microphone-check.tsx";
import { SearchSelect } from "./search-select.tsx";
import { ToolLists } from "./tool-lists.tsx";

import { contrastRatio, DARK, LIGHT, type ThemeName } from "@clarkcant/design-tokens";
import {
  EXECUTION_POLICIES,
  GUARD_CLASSES,
  type AutonomySettings,
  type ExecutionPolicy,
  type GuardClass,
} from "@clarkcant/contracts";

import { DevicePairingPanel } from "./DevicePairingPanel.tsx";
import { Modal } from "./Modal.tsx";
import type { GatewayClient } from "./api.ts";
import { THEME_CHOICES, type ThemeChoice } from "./theme.ts";

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

const THEME_LABELS: Record<ThemeChoice, string> = {
  dark: "Tối",
  light: "Sáng",
  system: "Theo hệ thống",
};

const TABS = [
  { id: "general", label: "General" },
  // Provider and model together, because choosing one means choosing the other: the second list belongs to the first.
  { id: "models", label: "Models" },
  { id: "autonomy", label: "Autonomy" },
  { id: "tools", label: "Tools" },
  { id: "devices", label: "Devices" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * The keys this panel can hold, and what each one is for.
 *
 * A list rather than one field per provider, because the third one is a copy and paste of the second: the names are
 * what the node stores them under, and each is entered the same way and reported the same way.
 */
const KEY_FIELDS = [
  {
    name: "gemini",
    label: "Gemini API key",
    purpose: "Dùng cho Gemini Live khi bạn nói. Lần mở voice kế tiếp sẽ dùng khoá này.",
  },
  {
    name: "typesafe",
    label: "TypeSafe API key (Jev)",
    purpose: "Dùng cho Jev khi nó phải quyết định cách xử lý một việc.",
  },
] as const;

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
  /** What the user chose, which may be `system`. */
  themeChoice: ThemeChoice;
  /** What is currently shown, which is always `dark` or `light`. */
  resolvedTheme: ThemeName;
  onThemeChoice: (choice: ThemeChoice) => void;
}

/**
 * The autonomy settings: what this node does on its own, and what may stop it.
 *
 * Read from the node rather than mirrored from a default, because those are two different facts and this
 * screen exists to show the first one. The wording of each choice is what the node actually does with it —
 * `guarded` asks nobody and still lets the guardrail refuse, which is not something a person can guess from
 * the word alone.
 */
const POLICY_LABELS: Record<ExecutionPolicy, string> = {
  auto: "Autonomous — không hỏi, không guardrail",
  guarded: "Autonomous, có guardrail — không hỏi user",
  confirm: "Hỏi trước mọi lệnh (như trước đây)",
  deny: "Không chạy lớp việc này",
};

const GUARD_CLASS_LABELS: Record<GuardClass, string> = {
  commands: "Commands",
  "local-writes": "Local writes",
  "external-writes": "External writes",
  communication: "Communication",
  financial: "Financial",
  reads: "Reads",
};

function AutonomyTab({ client }: { client: GatewayClient }): ReactElement {
  const [settings, setSettings] = useState<AutonomySettings | undefined>(undefined);
  const [narrowing, setNarrowing] = useState<{ id: string; description: string }[]>([]);
  const [status, setStatus] = useState("");
  const [unreadable, setUnreadable] = useState(false);

  useEffect(() => {
    let live = true;
    client
      .autonomy()
      .then((answer) => {
        if (!live) return;
        setSettings(answer.settings);
        setNarrowing(answer.narrowing);
      })
      .catch(() => {
        if (live) setUnreadable(true);
      });
    return () => {
      live = false;
    };
  }, [client]);

  if (unreadable) return <p className="cc-setting-desc">Không đọc được cấu hình autonomy của node này.</p>;
  if (settings === undefined) return <p className="cc-setting-desc">Đang đọc cấu hình…</p>;

  const update = (patch: Partial<AutonomySettings>): void => setSettings({ ...settings, ...patch });
  const toggleClass = (guardClass: GuardClass): void =>
    update({
      guardedClasses: settings.guardedClasses.includes(guardClass)
        ? settings.guardedClasses.filter((entry) => entry !== guardClass)
        : [...settings.guardedClasses, guardClass],
    });
  const save = (): void => {
    client
      .putAutonomy(settings)
      .then(() => setStatus("Đã lưu. Áp dụng cho lệnh tiếp theo node chạy."))
      .catch(() => setStatus("Không lưu được cấu hình."));
  };

  return (
    <section className="cc-settings-section" data-autonomy-tab="true">
      <h3>Execution mode</h3>
      <SettingsRow
        label="Cách node quyết định chạy"
        description="Guarded là mặc định: không hỏi bạn, nhưng guardrail vẫn có thể từ chối hoặc thu hẹp. Confirm giữ nguyên hành vi cũ."
      >
        <select
          value={settings.executionPolicy}
          data-autonomy-policy="true"
          onChange={(event) => update({ executionPolicy: event.target.value as ExecutionPolicy })}
        >
          {EXECUTION_POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {POLICY_LABELS[policy]}
            </option>
          ))}
        </select>
      </SettingsRow>

      <SettingsRow
        label="Jev guardrails"
        description="Tắt thì guarded chạy như auto. Preflight của host vẫn chạy trong mọi trường hợp."
      >
        <input
          type="checkbox"
          checked={settings.jevGuardrails}
          data-autonomy-guardrails="true"
          onChange={(event) => update({ jevGuardrails: event.target.checked })}
        />
      </SettingsRow>

      <SettingsRow label="Instructions" description="Luật của bạn, bằng lời của bạn. Guardrail chỉ có thể thu hẹp thêm, không bao giờ nới.">
        <textarea
          value={settings.instructions}
          rows={4}
          data-autonomy-instructions="true"
          placeholder="Ví dụ: Never delete git repositories."
          onChange={(event) => update({ instructions: event.target.value })}
        />
      </SettingsRow>

      <h3>Guard</h3>
      <SettingsRow label="Lớp việc guardrail được phép phán đoán" description="Lớp không được chọn thì chạy thẳng, không tốn một call nào.">
        <div className="cc-guard-classes">
          {GUARD_CLASSES.map((guardClass) => (
            <label key={guardClass}>
              <input
                type="checkbox"
                checked={settings.guardedClasses.includes(guardClass)}
                data-autonomy-class={guardClass}
                onChange={() => toggleClass(guardClass)}
              />
              {GUARD_CLASS_LABELS[guardClass]}
            </label>
          ))}
        </div>
      </SettingsRow>

      <SettingsRow
        label="Khi Jev không dùng được"
        description="Fail-open bỏ lớp phán đoán, không bỏ preflight hay containment."
      >
        <select
          value={settings.whenJevUnavailable}
          data-autonomy-failopen="true"
          onChange={(event) => update({ whenJevUnavailable: event.target.value === "deny" ? "deny" : "allow" })}
        >
          <option value="allow">Allow — chạy tiếp</option>
          <option value="deny">Deny — không chạy</option>
        </select>
      </SettingsRow>

      {narrowing.length > 0 && (
        <p className="cc-setting-desc">
          Guardrail chỉ được chọn trong {narrowing.length} cách thu hẹp do host đặt ra:{" "}
          {narrowing.map((entry) => entry.description).join("; ")}.
        </p>
      )}

      <button type="button" className="cc-chip" data-autonomy-save="true" onClick={save}>
        Lưu autonomy
      </button>
      {status !== "" && <p className="cc-setting-desc">{status}</p>}
    </section>
  );
}

export function SettingsPanel({
  open,
  onClose,
  client,
  themeChoice,
  resolvedTheme,
  onThemeChoice,
}: SettingsPanelProps): ReactElement | null {
  const [facts, setFacts] = useState<NodeFacts | undefined>(undefined);

  /**
   * The providers and models this node can run, or undefined before the node has answered.
   *
   * Kept apart from `facts`, which is a snapshot of what the node is: this comes from pi's own catalogue, so a
   * provider added by upgrading pi appears here without the node changing. Undefined means not read yet, which is a
   * different thing from an empty list, and the two are shown differently.
   */
  const [catalogue, setCatalogue] = useState<
    | { id: string; models: { provider: string; id: string; contextWindow?: number; current: boolean }[] }[]
    | undefined
  >(undefined);

  /** What became of the last model choice: a status, never a value, and never shown as if it applied already. */

  /** What the two fields hold while somebody types: nothing is stored until it is asked for. */
  const [providerDraft, setProviderDraft] = useState<string | undefined>(undefined);
  const [modelDraft, setModelDraft] = useState<string | undefined>(undefined);

  /** The provider whose models the second field offers: what was typed, or what the node is running. */
  const chosenProvider = providerDraft ?? facts?.model?.provider ?? "";
  const chosenModels = catalogue?.find((provider) => provider.id === chosenProvider)?.models ?? [];

  /** Store the pair somebody typed, refusing one this node cannot run before it leaves the page. */
  const saveModelChoice = (): void => {
    const provider = chosenProvider.trim();
    const id = (modelDraft ?? facts?.model?.id ?? "").trim();
    if (provider === "" || id === "") {
      setModelStatus("Chọn một provider và một model trước đã.");
      return;
    }
    if (catalogue !== undefined && catalogue.length > 0 && !chosenModels.some((model) => model.id === id)) {
      // Refused in front of the field it was typed into, rather than by the node after a round trip.
      setModelStatus(`${provider} không có model ${id}.`);
      return;
    }
    client
      .chooseModel({ provider, id })
      .then(() => setModelStatus(`Đã lưu ${provider}/${id}. Áp dụng cho hội thoại mới.`))
      .catch(() => setModelStatus("Không lưu được lựa chọn."));
  };

  /**
   * One key's form: entered here, stored by the node, and never shown again.
   *
   * A function rather than a copy, because the same field appears in two tabs and a second copy of a credential
   * form is the one kind of duplication that goes wrong quietly.
   */
  const keyForm = (entry: (typeof KEY_FIELDS)[number]) => (
              <form
                key={entry.name}
                className="cc-credential-form"
                data-settings-key-form={entry.name}
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = (keyDrafts[entry.name] ?? "").trim();
                  if (value === "") return;
                  client
                    .putCredential({ fields: [{ name: entry.name, value }] })
                    .then((result) => {
                      // Cleared the moment it is sent, so nothing later can read it off the screen or out of state.
                      setKeyDrafts((current) => ({ ...current, [entry.name]: "" }));
                      setKeyStatuses((current) => ({
                        ...current,
                        [entry.name]: result.names.includes(entry.name)
                          ? "Đã lưu khoá."
                          : "Đã gửi, nhưng node không ghi nhận tên khoá nào.",
                      }));
                    })
                    .catch(() =>
                      // The message says nothing about what was typed: an error that repeated the value would be the
                      // leak this field exists to avoid.
                      setKeyStatuses((current) => ({ ...current, [entry.name]: "Không lưu được khoá. Thử lại." })),
                    );
                }}
              >
                <label className="cc-credential-field">
                  <span>{entry.label}</span>
                  <input
                    type="password"
                    name={entry.name}
                    autoComplete="off"
                    data-settings-key-field={entry.name}
                    value={keyDrafts[entry.name] ?? ""}
                    onChange={(event) => setKeyDrafts((current) => ({ ...current, [entry.name]: event.target.value }))}
                  />
                </label>
                <button
                  type="submit"
                  className="cc-icon-btn"
                  style={{ width: "auto", padding: "0 var(--cc-space-sm)" }}
                  disabled={(keyDrafts[entry.name] ?? "").trim() === ""}
                  data-settings-key-submit={entry.name}
                >
                  Lưu khoá
                </button>
                <p className="cc-freshness">{entry.purpose}</p>
                {keyStatuses[entry.name] !== undefined && (
                  <p className="cc-freshness" data-settings-key-status={entry.name}>
                    {keyStatuses[entry.name]}
                  </p>
                )}
                              <button
                  type="button"
                  className="cc-chip"
                  data-settings-key-remove={entry.name}
                  onClick={() => {
                    client
                      .deleteCredential(entry.name)
                      .then(() => {
                        setKeyStatuses((current) => ({
                          ...current,
                          [entry.name]: "Đã đăng xuất: node không còn giữ khoá này.",
                        }));
                      })
                      .catch(() =>
                        // A refusal here usually means there was nothing to remove, which is a different answer from a
                        // failure and is said as one rather than dressed up as an error.
                        setKeyStatuses((current) => ({
                          ...current,
                          [entry.name]: "Không xoá được — có thể node chưa giữ khoá này.",
                        })),
                      );
                  }}
                >
                  Đăng xuất
                </button>
                </form>
  );

  const [modelStatus, setModelStatus] = useState<string | undefined>(undefined);

  /** What pi loads on this machine, or undefined before the node has answered. */
  const [piExtensions, setPiExtensions] = useState<{ name: string; kind: string }[] | undefined>(undefined);

  /** pi's own configuration, read from the same place and shown as lines: a key and a value, never a secret. */
  const [piSettingLines, setPiSettingLines] = useState<{ key: string; value: string }[] | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void client
      .extensions()
      .then((answer) => {
        if (!cancelled) setPiExtensions(answer.extensions);
      })
      .catch(() => {
        // An empty list rather than an error: what this section answers is what pi loads, and a node that cannot say
        // still leaves the rest of the tab working.
        if (!cancelled) setPiExtensions([]);
      });
    void client
      .piSettings()
      .then((answer) => {
        if (!cancelled) setPiSettingLines(answer.settings);
      })
      .catch(() => {
        // The same reasoning: configuration that cannot be read is reported as none rather than as a failure, because
        // the person in front of the panel cannot act on a read error either way.
        if (!cancelled) setPiSettingLines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void client
      .model()
      .then((answer) => {
        if (!cancelled) setCatalogue(answer.catalogue);
      })
      .catch(() => {
        // Reported as an empty list rather than as an error. The question this section answers is what can be chosen,
        // and a failure to read the list is not something the person in front of the panel can act on.
        if (!cancelled) setCatalogue([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client]);
  const [tools, setTools] = useState<ToolFacts[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /**
   * What has been typed into each key field, and what the node said about it.
   *
   * A draft is cleared the moment it is sent, and nothing here ever holds a stored value: the node answers with the
   * names it has and never with a value, so there is nothing to show a second time.
   */
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [keyStatuses, setKeyStatuses] = useState<Record<string, string>>({});  const [accentIndex, setAccentIndex] = useState(0);
  const [tab, setTab] = useState<TabId>("general");
  // Bumped after a theme or accent change so the contrast readout re-reads computed values.

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

  // Opened on General each time. Remembering the last tab sounds helpful and is not: someone who
  // opened Devices once to check a thing would land there every time they wanted the theme.
  useEffect(() => {
    if (!open) return;
    setTab("general");
  }, [open]);

  const chooseTheme = useCallback(
    (next: ThemeChoice) => {
      onThemeChoice(next);
    },
    [onThemeChoice],
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
      const value = resolvedTheme === "dark" ? choice.dark : choice.light;
      const root = document.documentElement;
      const tokens = resolvedTheme === "dark" ? DARK : LIGHT;
      root.style.setProperty("--cc-accent", value);
      root.style.setProperty(
        "--cc-on-accent",
        contrastRatio("#ffffff", value) >= contrastRatio(tokens.canvas, value) ? "#ffffff" : tokens.canvas,
      );
      setAccentIndex(index);
    },
    [resolvedTheme],
  );

  // Re-applied when the resolved theme changes, so switching theme does not leave the other
  // theme's accent painted over the new one. Deliberately not keyed on `accentIndex`: this exists
  // to re-paint the current choice against a new theme, and keying on the index would make it
  // write the same value on every pick as well.
  useEffect(() => {
    if (!open) return;
    applyAccent(accentIndex);
  }, [open, resolvedTheme]);

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
            onClick={() => setTab(entry.id)}
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
      >
        {tab === "general" && (
          <>
            {problem !== undefined && (
              <section className="cc-panel-section">
                <h3>Không đọc được trạng thái node</h3>
                <p className="cc-panel-note" data-settings-error="true">
                  {problem}
                </p>
              </section>
            )}

            <section className="cc-panel-section">
              <h3>Experience</h3>
              <SettingsRow label="Appearance" description="Áp dụng ngay, và giữ nguyên sau khi tải lại.">
                <div className="cc-panel-row">
                  {THEME_CHOICES.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      className="cc-badge"
                      aria-pressed={themeChoice === choice}
                      data-selected={themeChoice === choice}
                      data-theme-choice={choice}
                      onClick={() => chooseTheme(choice)}
                    >
                      {THEME_LABELS[choice]}
                    </button>
                  ))}
                </div>
              </SettingsRow>
              <p className="cc-panel-note" data-resolved-theme={resolvedTheme}>
                Đang hiển thị: {THEME_LABELS[resolvedTheme]}
                {themeChoice === "system" ? " (theo hệ thống)" : ""}
              </p>
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
                      style={{ background: resolvedTheme === "dark" ? choice.dark : choice.light }}
                    />
                  ))}
                </div>
              </SettingsRow>
              <p className="cc-panel-note">{ACCENT_CHOICES[accentIndex]?.note ?? ""}</p>
            </section>

          </>
        )}

        {tab === "models" && (
          <>
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
                  <SettingsRow label="Trần một lượt" description="Một lượt vượt trần sẽ bị dừng, không chạy tiếp.">
                    <code>
                      {facts.model.maxWallClockMs} ms · {facts.model.maxTokens} token
                    </code>
                  </SettingsRow>
                </>
              )}
            </section>

            <section className="cc-panel-section" data-providers="true">
              <h3>Chọn provider và model</h3>
              {catalogue === undefined ? (
                <p className="cc-panel-note">Đang đọc…</p>
              ) : catalogue.length === 0 ? (
                <p className="cc-panel-note" data-providers="none">
                  Node chưa báo provider nào. Danh sách này đọc từ pi trên máy, nên nó rỗng khi pi chưa
                  thấy provider nào — hoặc khi node không dựng được model turn.
                </p>
              ) : (
                <>
                  <label className="cc-credential-field">
                    <span>Provider</span>
                    <SearchSelect
                      name="provider"
                      placeholder="Gõ để tìm provider"
                      value={chosenProvider}
                      options={catalogue.map((provider) => ({
                        value: provider.id,
                        label: provider.id,
                        note: `${provider.models.length} model`,
                      }))}
                      onChange={(next) => {
                        setProviderDraft(next);
                        // A different provider is a different catalogue, so a model chosen for the old one is not a
                        // choice any more - keeping it would offer a pair this node cannot run.
                        setModelDraft("");
                      }}
                      emptyNote="Không có provider nào khớp."
                    />
                  </label>

                  <label className="cc-credential-field">
                    <span>Model</span>
                    <SearchSelect
                      name="model"
                      placeholder="Gõ để tìm model"
                      value={modelDraft ?? facts?.model?.id ?? ""}
                      options={chosenModels.map((model) => ({
                        value: model.id,
                        label: model.id,
                        ...(model.contextWindow === undefined
                          ? {}
                          : { note: `${Math.round(model.contextWindow / 1000)}K` }),
                      }))}
                      onChange={setModelDraft}
                      emptyNote="Không có model nào khớp."
                    />
                  </label>

                  <div className="cc-chip-row">
                    <button type="button" className="cc-chip" data-model-save="true" onClick={saveModelChoice}>
                      Lưu lựa chọn
                    </button>
                  </div>
                </>
              )}
              {modelStatus === undefined ? null : (
                <p className="cc-panel-note" data-model-status="true">
                  {modelStatus}
                </p>
              )}
            </section>

            <section className="cc-panel-section" data-models-key="true">
              <h3>Khoá TypeSafe</h3>
              <p className="cc-panel-note">
                Jev dùng TypeSafe khi nó phải quyết định cách xử lý một việc. Ở đây cùng provider và model, vì cả ba
                đều là chuyện chọn cái gì để chạy.
              </p>
              {KEY_FIELDS.filter((entry) => entry.name === "typesafe").map(keyForm)}
            </section>
          </>
        )}

        {tab === "tools" && (
          <section className="cc-panel-section">
            <h3>Tools</h3>
            <p className="cc-panel-note">
              Capability đã đăng ký trên node này. Thứ gì chưa nạp thì nói rõ vì sao, không được
              làm tròn thành “dùng được”.
            </p>
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
            {/*
              The tools, told apart by which half holds them.

              The capability list above is what this node has registered as a capability; these two are the tools
              themselves - the node's own and the agent's - because a person asking "can this thing do X" is asking
              about both and needs to know which one would be doing it.
            */}
            <ToolLists client={client} />

            <section className="cc-panel-section" data-pi-extensions="true">
              <h3>Extension của pi trên máy này</h3>
              {piExtensions === undefined ? (
                <p className="cc-panel-note">Đang đọc…</p>
              ) : piExtensions.length === 0 ? (
                <p className="cc-panel-note" data-pi-extensions="none">
                  pi trên máy này chưa nạp extension nào. Danh sách chỉ có tên và loại, không bao giờ có nội dung tệp.
                </p>
              ) : (
                // Names and kinds, and deliberately nothing else: an extension on a real machine can hold a credential,
                // and a section that showed what was inside one would be the place it leaked from.
                <div className="cc-panel-note">
                  {piExtensions.map((entry) => (
                    <code key={entry.name} data-pi-extension={entry.name} data-kind={entry.kind}>
                      {entry.name}
                    </code>
                  ))}
                </div>
              )}
            </section>

            <section className="cc-panel-section" data-pi-settings="true">
              <h3>Cấu hình pi trên máy này</h3>
              {piSettingLines === undefined ? (
                <p className="cc-panel-note">Đang đọc…</p>
              ) : piSettingLines.length === 0 ? (
                <p className="cc-panel-note" data-pi-settings="none">
                  Chưa đọc được cấu hình nào từ pi trên máy này.
                </p>
              ) : (
                // A key and a value per line. Anything whose name sounds like a secret arrives already redacted by the
                // node, because the node is the only thing that can see the file it came from.
                <div className="cc-panel-note">
                  {piSettingLines.map((line) => (
                    <code key={line.key} data-pi-setting={line.key}>
                      {line.key}: {line.value}
                    </code>
                  ))}
                </div>
              )}
            </section>
          </section>
        )}

        {tab === "autonomy" && <AutonomyTab client={client} />}

        {tab === "devices" && (
          <section className="cc-panel-section">
            <h3>Devices</h3>
            <DevicePairingPanel
              nodeId={facts?.nodeId ?? "(chưa đọc được)"}
              nodeLabel={facts?.label ?? "(chưa đọc được)"}
              unblockedBy="chạy node thứ hai trên máy khác rồi ghép nối"
            />

            {/*
              The key the live voice provider needs.
              
              It lives beside the device settings because that is what it is for: a microphone session that cannot
              start without it. The name it is stored under is the node's - `gemini`, the same string
              voice-session.ts exports as VOICE_CREDENTIAL_NAME - and it cannot be imported here, because the
              runtime is not something the browser ships. A name is cheaper to keep in step than a package.
            */}
            <h3>Giọng nói và khoá</h3>
            {KEY_FIELDS.filter((entry) => entry.name !== "typesafe").map(keyForm)}
            <MicrophoneCheck />
            {/*
              One field per key: entered here, stored by the node, and never shown again.

              A list rather than one hand-written form per provider, because the second is a copy of the first and a
              third would be too. The names are the node's own - it is the node that reads a value when it needs one -
              and the purpose under each field says what breaks without it.
            */}
          </section>
        )}
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
