import type { ReactElement } from "react";

import type { EffectCategory, ExecutionRule } from "@clarkcant/contracts";

import { InlineStatus, SegmentedControl, SettingsRow } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";

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
  /** The effects this node performed without an approval card, newest first. */
  recentEffects: readonly { at: string; description: string; mode: string; category: string }[];
  recentProblem: string | undefined;
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

export function ControlSettings({ prefs, recentEffects, recentProblem }: ControlSettingsProps): ReactElement {
  const rules = readRules(prefs.preference("execution.rules")?.value);

  /** Replace one category's rule, or remove it when the decision is the mode's own default. */
  const setRule = (category: EffectCategory, decision: ExecutionRule["decision"] | "default"): void => {
    const kept = rules.filter((rule) => rule.effectCategory !== category);
    const next = decision === "default" ? kept : [...kept, { effectCategory: category, decision }];
    prefs.write("execution.rules", next);
  };

  return (
    <>
      <section className="cc-panel-section" data-execution-mode="true">
        <h3>Mức tự chủ</h3>
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
