import { useEffect, useState, type ReactElement } from "react";

import type { EffectCategory, ExecutionRule } from "@clarkcant/contracts";
import {
  GUARD_CLASSES,
  type AutonomySettings,
  type ExecutionPolicy,
  type GuardClass,
} from "@clarkcant/contracts";

import { InlineStatus, SegmentedControl, SettingsRow, ToggleSwitch } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";
import type { GatewayClient } from "../api.ts";

/**
 * Control: how much this node does on its own.
 *
 * The one tab whose controls are backed by a resolver that was written before it: `decideExecution` reads
 * exactly these two preferences, so what this screen offers is what the runtime enforces. Nothing here is a
 * promise about future behaviour.
 *
 * The mode notes are the policy in the user's words rather than a marketing summary, including the parts that
 * are easy to get wrong: Autonomous is not a promise to do things nobody asked for, and no mode lifts an OS or
 * account permission.
 */

const MODE_OPTIONS = [
  {
    value: "autonomous",
    label: "Tự chủ",
    note: "Việc bạn yêu cầu thì chạy ngay, không hỏi lại. Việc vượt ra ngoài máy này mà agent tự nghĩ ra thì vẫn hỏi.",
  },
  {
    value: "guarded",
    label: "Có rào",
    note: "Việc trong máy này chạy ngay. Việc gửi ra ngoài, xoá, chi tiêu hoặc liên lạc thì hỏi.",
  },
  {
    value: "ask",
    label: "Hỏi mỗi lần",
    note: "Mọi thay đổi đều hiện thẻ duyệt trước khi chạy.",
  },
] as const;

/**
 * The categories a rule can be written about, in the taxonomy's own words.
 *
 * A closed list, matching `effectCategorySchema`: a rule cannot be written about a category the resolver does
 * not know, because a rule nothing matches is a rule the user believes is protecting them.
 */
const CATEGORY_LABELS: Record<EffectCategory, string> = {
  read: "Đọc",
  "local-write": "Ghi trong máy này",
  "external-write": "Gửi ra ngoài",
  destructive: "Xoá / phá huỷ",
  financial: "Chi tiêu",
  communication: "Liên lạc",
  "media-capture": "Ghi âm / ghi hình",
};

const DECISION_LABELS: Record<ExecutionRule["decision"], string> = {
  execute: "Chạy",
  ask: "Hỏi",
  deny: "Từ chối",
};

export interface ControlSettingsProps {
  prefs: PreferencesHandle;
  /**
   * The node itself, for the reads and writes on this tab that are not preferences: the autonomy settings that
   * govern a command, and the effects the node already performed without asking.
   */
  client: GatewayClient;
  /** The effects this node performed without an approval card, newest first. */
  recentEffects: readonly { at: string; description: string; mode: string; category: string }[];
  recentProblem: string | undefined;
}

/** The words the node acts on, rather than a summary of them. */
const POLICY_OPTIONS = [
  {
    value: "auto",
    label: "Tự chủ",
    note: "Không hỏi và không gọi guardrail. Preflight của host và containment vẫn chạy.",
  },
  {
    value: "guarded",
    label: "Có rào",
    note: "Mặc định: không hỏi bạn, nhưng guardrail vẫn có thể từ chối hoặc thu hẹp lệnh.",
  },
  {
    value: "confirm",
    label: "Hỏi mỗi lệnh",
    note: "Như trước đây: mọi lệnh hiện thẻ duyệt trước khi chạy.",
  },
  { value: "deny", label: "Không chạy", note: "Lớp lệnh bị tắt hoàn toàn." },
] as const satisfies readonly { value: ExecutionPolicy; label: string; note: string }[];

const FAIL_OPEN_OPTIONS = [
  {
    value: "allow",
    label: "Allow — chạy tiếp",
    note: "Bỏ lớp phán đoán, không bỏ preflight hay containment.",
  },
  { value: "deny", label: "Deny — không chạy", note: "Không có phán đoán thì lệnh này không chạy." },
] as const;

const GUARD_CLASS_LABELS: Record<GuardClass, string> = {
  commands: "Lệnh",
  "local-writes": "Ghi trong máy này",
  "external-writes": "Gửi ra ngoài",
  communication: "Liên lạc",
  financial: "Chi tiêu",
  reads: "Đọc",
};

/**
 * What this node does without asking, for the commands it runs.
 *
 * Read whole from the node and written whole, because these are one decision a person makes about this node
 * rather than a set of independent switches: whether anything is asked, whether the policy layer may
 * intervene, which classes it covers, and what happens when it cannot be reached.
 *
 * It sits **beside** the autonomy level above rather than replacing it, and the reason is a fact about the
 * merged build: `execution.mode` and `execution.rules` are still read by the paths that decide widget actions
 * and installations, so a screen that dropped those controls would be removing a setting from something that
 * still obeys it. Two policies is one more than this product wants; saying so here is better than a control
 * that lies. The narrowing table travels with the read because the panel shows what the guardrail may ask for
 * — a list the host owns, and a model may only pick from.
 */
function CommandAutonomySettings({ client }: { client: GatewayClient }): ReactElement {
  const [settings, setSettings] = useState<AutonomySettings | undefined>(undefined);
  const [narrowing, setNarrowing] = useState<{ id: string; description: string }[]>([]);
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
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

  if (unreadable) {
    return (
      <section className="cc-panel-section" data-autonomy-tab="true">
        <h3>Lệnh chạy trên máy này</h3>
        <p className="cc-panel-note" data-autonomy-error="true">
          Không đọc được cấu hình autonomy của node này.
        </p>
      </section>
    );
  }
  if (settings === undefined) {
    return (
      <section className="cc-panel-section" data-autonomy-tab="true">
        <h3>Lệnh chạy trên máy này</h3>
        <p className="cc-panel-note">Đang đọc cấu hình…</p>
      </section>
    );
  }

  const update = (patch: Partial<AutonomySettings>): void => setSettings({ ...settings, ...patch });
  const toggleClass = (guardClass: GuardClass): void =>
    update({
      guardedClasses: settings.guardedClasses.includes(guardClass)
        ? settings.guardedClasses.filter((entry) => entry !== guardClass)
        : [...settings.guardedClasses, guardClass],
    });
  const save = (): void => {
    setPending(true);
    client
      .putAutonomy(settings)
      .then(() => setStatus("Đã lưu. Áp dụng cho lệnh tiếp theo node chạy."))
      .catch(() => setStatus("Không lưu được cấu hình."))
      .finally(() => setPending(false));
  };

  return (
    <section className="cc-panel-section" data-autonomy-tab="true">
      <h3>Lệnh chạy trên máy này</h3>
      <p className="cc-panel-note">
        Preflight của host luôn chạy trước mọi lệnh: hiệu ứng phải nằm trong thư mục node sở hữu. Phần dưới đây
        nói thêm điều gì xảy ra khi nó đã hợp lệ.
      </p>

      <SettingsRow
        label="Cách node quyết định chạy"
        description="Áp dụng cho lệnh agent đề xuất. Mức tự chủ ở trên vẫn quyết định hành động của widget và cài đặt."
      >
        <SegmentedControl
          name="autonomy-policy"
          label="Cách node quyết định chạy một lệnh"
          options={POLICY_OPTIONS}
          value={settings.executionPolicy}
          pending={pending}
          onChange={(value) => update({ executionPolicy: value })}
        />
      </SettingsRow>

      <SettingsRow
        label="Jev guardrails"
        description="Tắt thì guarded chạy như auto. Preflight của host vẫn chạy trong mọi trường hợp."
      >
        <ToggleSwitch
          name="autonomy-guardrails"
          label="Jev guardrails"
          checked={settings.jevGuardrails}
          pending={pending}
          onChange={(next) => update({ jevGuardrails: next })}
        />
      </SettingsRow>

      <SettingsRow
        label="Instructions"
        description="Luật của bạn, bằng lời của bạn. Guardrail chỉ có thể thu hẹp thêm, không bao giờ nới."
      >
        <textarea
          value={settings.instructions}
          rows={4}
          data-autonomy-instructions="true"
          placeholder="Ví dụ: Never delete git repositories."
          onChange={(event) => update({ instructions: event.target.value })}
        />
      </SettingsRow>

      <SettingsRow
        label="Lớp việc guardrail được phép phán đoán"
        description="Lớp không được chọn thì chạy thẳng, không tốn một call nào."
      >
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
        <SegmentedControl
          name="autonomy-failopen"
          label="Khi Jev không dùng được"
          options={FAIL_OPEN_OPTIONS}
          value={settings.whenJevUnavailable}
          pending={pending}
          onChange={(value) => update({ whenJevUnavailable: value })}
        />
      </SettingsRow>

      {narrowing.length === 0 ? null : (
        <p className="cc-panel-note">
          Guardrail chỉ được chọn trong {narrowing.length} cách thu hẹp do host đặt ra:{" "}
          {narrowing.map((entry) => entry.description).join("; ")}.
        </p>
      )}

      <div className="cc-panel-row">
        <button type="button" className="cc-chip" data-autonomy-save="true" disabled={pending} onClick={save}>
          Lưu autonomy
        </button>
      </div>
      {status === "" ? null : <p className="cc-panel-note">{status}</p>}
    </section>
  );
}

/** Read the stored rules, refusing anything that is not one the resolver would accept. */
function readRules(value: unknown): ExecutionRule[] {
  if (!Array.isArray(value)) return [];
  const rules: ExecutionRule[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const category = record.effectCategory;
    const decision = record.decision;
    if (typeof category !== "string" || typeof decision !== "string") continue;
    if (!(category in CATEGORY_LABELS)) continue;
    if (decision !== "execute" && decision !== "ask" && decision !== "deny") continue;
    rules.push({ effectCategory: category as EffectCategory, decision });
  }
  return rules;
}

export function ControlSettings({ prefs, client, recentEffects, recentProblem }: ControlSettingsProps): ReactElement {
  const rules = readRules(prefs.preference("execution.rules")?.value);

  /** Replace one category's rule, or remove it when the decision is the mode's own default. */
  const setRule = (category: EffectCategory, decision: ExecutionRule["decision"] | "default"): void => {
    const kept = rules.filter((rule) => rule.effectCategory !== category);
    const next = decision === "default" ? kept : [...kept, { effectCategory: category, decision }];
    prefs.write("execution.rules", next);
  };

  return (
    <>
      {/*
        First, because it is the control that decides what the default is: under `guarded` the node runs a command
        a person asked for without a card, and everything below is the fallback for the effects it does not cover.
      */}
      <CommandAutonomySettings client={client} />

      <section className="cc-panel-section" data-execution-mode="true">
        <h3>Mức tự chủ cho hiệu ứng khác</h3>
        <SettingsRow
          label="Khi Clark làm gì đó có hiệu lực"
          description="Áp dụng ngay cho lệnh, hành động của widget và cài đặt."
        >
          <SegmentedControl
            name="execution-mode"
            label="Mức tự chủ"
            options={MODE_OPTIONS}
            value={prefs.text("execution.mode", "autonomous")}
            pending={prefs.pending === "execution.mode"}
            onChange={(value) => prefs.write("execution.mode", value)}
          />
        </SettingsRow>
        <InlineStatus status={prefs.status} forKey="execution.mode" />
        {/*
          Said plainly rather than left to be discovered. These are not this application's permissions to grant,
          so no mode and no rule can lift them, and a user who expected otherwise would find out at the worst
          possible moment.
        */}
        <p className="cc-panel-note">
          Quyền của hệ điều hành, của tài khoản provider, của trình duyệt và của bên thứ ba vẫn luôn được hỏi, ở mọi
          mức — đó không phải là quyết định của ClarkCant.
        </p>
      </section>

      <section className="cc-panel-section" data-execution-rules="true">
        <h3>Quy tắc theo loại việc</h3>
        <p className="cc-panel-note">
          Mặc định là theo mức ở trên. Đặt riêng ở đây thì quy tắc thắng, và “Từ chối” luôn thắng ở mọi mức.
        </p>
        {(Object.keys(CATEGORY_LABELS) as EffectCategory[]).map((category) => {
          const current = rules.find((rule) => rule.effectCategory === category)?.decision ?? "default";
          return (
            <SettingsRow key={category} label={CATEGORY_LABELS[category]}>
              <SegmentedControl
                name={`rule-${category}`}
                label={CATEGORY_LABELS[category]}
                options={[
                  { value: "default", label: "Theo mức" },
                  { value: "execute", label: DECISION_LABELS.execute },
                  { value: "ask", label: DECISION_LABELS.ask },
                  { value: "deny", label: DECISION_LABELS.deny },
                ]}
                value={current}
                pending={prefs.pending === "execution.rules"}
                onChange={(value) => setRule(category, value as ExecutionRule["decision"] | "default")}
              />
            </SettingsRow>
          );
        })}
        <InlineStatus status={prefs.status} forKey="execution.rules" />
      </section>

      <section className="cc-panel-section" data-recent-effects="true">
        <h3>Việc đã chạy không hỏi</h3>
        <p className="cc-panel-note">
          Ở mức tự chủ, việc chạy mà không có thẻ duyệt vẫn để lại dấu vết ở đây. Đây là chỗ kiểm tra lại.
        </p>
        {recentProblem !== undefined ? (
          <p className="cc-panel-note" data-recent-effects-problem="true">
            {recentProblem}
          </p>
        ) : recentEffects.length === 0 ? (
          // An empty list is a fact, not a missing feature: nothing has run without a card yet.
          <p className="cc-panel-note" data-recent-effects="none">
            Chưa có việc nào chạy mà không hỏi.
          </p>
        ) : (
          <ul className="cc-effect-list">
            {recentEffects.map((effect) => (
              <li key={`${effect.at}-${effect.description}`} data-effect-entry="true">
                <code>{effect.category}</code> {effect.description}
                <span className="cc-setting-desc"> · {effect.mode} · {effect.at}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
