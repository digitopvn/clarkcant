import { useEffect, useState, type ReactElement } from "react";

import type { EffectCategory, ExecutionRule, InboxNotificationGroup, InboxNotificationsPreference } from "@clarkcant/contracts";
import {
  DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE,
  GUARD_CLASSES,
  INBOX_NOTIFICATION_GROUPS,
  inboxNotificationsPreferenceSchema,
  type AutonomySettings,
  type ExecutionPolicy,
  type GuardClass,
} from "@clarkcant/contracts";

import { InlineStatus, SegmentedControl, SettingsRow, ToggleSwitch } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";
import type { GatewayClient } from "../api.ts";
import { hasDesktopChrome } from "../desktop-compact.ts";
import { useT } from "../i18n/locale-context.tsx";
import type { MessageKey } from "../i18n/messages.ts";

/**
 * Control: how much this node does on its own.
 *
 * One policy surface, and exactly one control that changes the mode. `decideExecution` reads the policy this
 * surface writes, so what this screen offers is what the runtime enforces; nothing here is a promise about
 * future behaviour.
 *
 * The mode notes are the policy in the user's words rather than a marketing summary, including the parts that
 * are easy to get wrong: Autonomous is not a promise to do things nobody asked for, and no mode lifts an OS or
 * account permission.
 *
 * The legacy `execution.mode` preference is a projection of this policy and is no longer written from here.
 * It used to have a second segmented control of its own in this tab, and a save on either control could write
 * over a mode just chosen on the other one within the same open Settings; a mode a person can silently lose is
 * worse than a control they have to find.
 */

/**
 * The categories a rule can be written about, in the taxonomy's own words.
 *
 * A closed list, matching `effectCategorySchema`: a rule cannot be written about a category the resolver does
 * not know, because a rule nothing matches is a rule the user believes is protecting them.
 */
function categoryLabels(t: (key: MessageKey) => string): Record<EffectCategory, string> {
  return {
    read: t("settings.control.category.read"),
    "local-write": t("settings.control.category.localWrite"),
    "external-write": t("settings.control.category.externalWrite"),
    destructive: t("settings.control.category.destructive"),
    financial: t("settings.control.category.financial"),
    communication: t("settings.control.category.communication"),
    "media-capture": t("settings.control.category.mediaCapture"),
  };
}

function decisionLabels(t: (key: MessageKey) => string): Record<ExecutionRule["decision"], string> {
  return {
    execute: t("settings.control.decision.execute"),
    ask: t("settings.control.decision.ask"),
    deny: t("settings.control.decision.deny"),
  };
}

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
  /** Called after a successful autonomy save, so the shell's `data-policy-mode` follows it. */
  onPolicyChange?: () => void;
}

/** The words the node acts on, rather than a summary of them. */
function policyOptions(
  t: (key: MessageKey) => string,
): readonly { value: ExecutionPolicy; label: string; note: string }[] {
  return [
    { value: "auto", label: t("settings.control.policy.auto.label"), note: t("settings.control.policy.auto.note") },
    {
      value: "guarded",
      label: t("settings.control.policy.guarded.label"),
      note: t("settings.control.policy.guarded.note"),
    },
    {
      value: "confirm",
      label: t("settings.control.policy.confirm.label"),
      note: t("settings.control.policy.confirm.note"),
    },
    { value: "deny", label: t("settings.control.policy.deny.label"), note: t("settings.control.policy.deny.note") },
  ];
}

function failOpenOptions(
  t: (key: MessageKey) => string,
): readonly { value: "allow" | "deny"; label: string; note: string }[] {
  return [
    { value: "allow", label: t("settings.control.failOpen.allow.label"), note: t("settings.control.failOpen.allow.note") },
    { value: "deny", label: t("settings.control.failOpen.deny.label"), note: t("settings.control.failOpen.deny.note") },
  ];
}

function guardClassLabels(t: (key: MessageKey) => string): Record<GuardClass, string> {
  return {
    commands: t("settings.control.guardClass.commands"),
    "local-writes": t("settings.control.guardClass.localWrites"),
    "external-writes": t("settings.control.guardClass.externalWrites"),
    communication: t("settings.control.guardClass.communication"),
    financial: t("settings.control.guardClass.financial"),
    reads: t("settings.control.guardClass.reads"),
  };
}

/** The categories a rule may be written about, matching `effectCategorySchema`. Static, so `readRules` needs no translator. */
const VALID_CATEGORIES: readonly EffectCategory[] = [
  "read",
  "local-write",
  "external-write",
  "destructive",
  "financial",
  "communication",
  "media-capture",
];

/**
 * The one policy surface: the mode, the guardrails, and what the host preflight still enforces underneath.
 *
 * There is one policy, and this writes it: the node projects the canonical policy into the five fields this shape
 * has always posted and translates them back on save, keeping the per-category rules the shape has no way to name.
 * The mode options therefore mean what the canonical resolver does, not what the four-value vocabulary used to do —
 * "Có rào" asks before the effects that reach past this machine, which is a declared change and not a translation,
 * and "Từ chối tất cả" is the structural refusal that no consent screen can lift.
 *
 * The mode is changed here and nowhere else. A second control used to write `execution.mode` beside this one, so
 * saving either could overwrite a choice just made on the other; that preference is now a projection of this
 * policy, read by clients that still spell it and written by nothing on this screen.
 *
 * The narrowing table travels with the read because the panel shows what the guardrail may ask for — a list the
 * host owns, and a model may only pick from.
 */
function ExecutionPolicySettings({
  client,
  onPolicyChange,
}: {
  client: GatewayClient;
  onPolicyChange?: () => void;
}): ReactElement {
  const t = useT();
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
        <h3>{t("settings.control.autonomy.heading")}</h3>
        <p className="cc-panel-note" data-autonomy-error="true">
          {t("settings.control.autonomy.readFailed")}
        </p>
      </section>
    );
  }
  if (settings === undefined) {
    return (
      <section className="cc-panel-section" data-autonomy-tab="true">
        <h3>{t("settings.control.autonomy.heading")}</h3>
        <p className="cc-panel-note">{t("settings.control.autonomy.loading")}</p>
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
      .then(() => {
        setStatus(t("settings.control.saved"));
        onPolicyChange?.();
      })
      .catch(() => setStatus(t("settings.control.saveFailed")))
      .finally(() => setPending(false));
  };

  const GUARD_CLASS_LABELS = guardClassLabels(t);

  return (
    <section className="cc-panel-section" data-autonomy-tab="true">
      <h3>{t("settings.control.autonomy.heading")}</h3>
      <p className="cc-panel-note">{t("settings.control.autonomy.intro")}</p>

      <SettingsRow
        label={t("settings.control.autonomy.mode.label")}
        description={t("settings.control.autonomy.mode.description")}
      >
        <SegmentedControl
          name="autonomy-policy"
          label={t("settings.control.autonomy.mode.label")}
          options={policyOptions(t)}
          value={settings.executionPolicy}
          pending={pending}
          onChange={(value) => update({ executionPolicy: value })}
        />
      </SettingsRow>

      {/*
        Said plainly rather than left to be discovered. These are not this application's permissions to grant, so no
        mode and no rule can lift them, and a user who expected otherwise would find out at the worst possible
        moment.
      */}
      <p className="cc-panel-note">{t("settings.control.autonomy.osNote")}</p>

      <SettingsRow
        label={t("settings.control.autonomy.guardrails.label")}
        description={t("settings.control.autonomy.guardrails.description")}
      >
        <ToggleSwitch
          name="autonomy-guardrails"
          label={t("settings.control.autonomy.guardrails.label")}
          checked={settings.jevGuardrails}
          pending={pending}
          onChange={(next) => update({ jevGuardrails: next })}
        />
      </SettingsRow>

      <SettingsRow label={t("control.instructions")} description={t("settings.control.instructions.description")}>
        <textarea
          value={settings.instructions}
          rows={4}
          data-autonomy-instructions="true"
          placeholder={t("settings.control.instructions.placeholder")}
          onChange={(event) => update({ instructions: event.target.value })}
        />
      </SettingsRow>

      <SettingsRow
        label={t("settings.control.guardedCategories.label")}
        description={t("settings.control.guardedCategories.description")}
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
        label={t("settings.control.failOpen.label")}
        description={t("settings.control.failOpen.description")}
      >
        <SegmentedControl
          name="autonomy-failopen"
          label={t("settings.control.failOpen.label")}
          options={failOpenOptions(t)}
          value={settings.whenJevUnavailable}
          pending={pending}
          onChange={(value) => update({ whenJevUnavailable: value })}
        />
      </SettingsRow>

      {narrowing.length === 0 ? null : (
        <p className="cc-panel-note">
          {t("settings.control.narrowing.prefix")} {narrowing.length} {t("settings.control.narrowing.waysSuffix")}{" "}
          {/* Each narrowing's description is worded by the node (apps/runtime/src/autonomy-settings.ts), not
              this catalog's copy, so it is marked as node data rather than swept up as UI text. */}
          <span data-node-narrowing="true">{narrowing.map((entry) => entry.description).join("; ")}</span>.
        </p>
      )}

      <div className="cc-panel-row">
        <button type="button" className="cc-chip" data-autonomy-save="true" disabled={pending} onClick={save}>
          {t("settings.control.save")}
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
    if (!VALID_CATEGORIES.includes(category as EffectCategory)) continue;
    if (decision !== "execute" && decision !== "ask" && decision !== "deny") continue;
    rules.push({ effectCategory: category as EffectCategory, decision });
  }
  return rules;
}

/** The stored limit as one of the choices offered, falling back to the node's default for anything else. */
function readBackgroundLimit(value: unknown): "1" | "3" | "5" {
  return value === 1 || value === 5 ? (String(value) as "1" | "5") : "3";
}

const INBOX_NOTIFICATIONS_KEY = "inbox.notifications";

/** The current preference, read defensively: an unreadable or not-yet-answered value falls back to the default. */
function readInboxNotifications(prefs: PreferencesHandle): InboxNotificationsPreference {
  const parsed = inboxNotificationsPreferenceSchema.safeParse(prefs.preference(INBOX_NOTIFICATIONS_KEY)?.value);
  return parsed.success ? parsed.data : DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE;
}

function groupLabelKey(group: InboxNotificationGroup): MessageKey {
  switch (group) {
    case "waitingApprovals":
      return "settings.control.notifications.group.waitingApprovals";
    case "backgroundResults":
      return "settings.control.notifications.group.backgroundResults";
    case "updates":
      return "settings.control.notifications.group.updates";
    case "otherDevices":
      return "settings.control.notifications.group.otherDevices";
  }
}

/** The global `Notification` constructor, or nothing when the platform has none — never read at module load. */
function webNotificationApi(): typeof Notification | undefined {
  const candidate = (globalThis as { Notification?: unknown }).Notification;
  return typeof candidate === "function" ? (candidate as typeof Notification) : undefined;
}

/**
 * Per-group toggles, the OS/web channel switches and quiet hours for #171.
 *
 * The browser's notification permission is a hard consent boundary this control does not lift: `web` only
 * ever becomes `true` here, from the explicit act of turning this toggle on, and only after
 * `Notification.requestPermission()` itself answers `granted` — never from the background poll that later
 * delivers a notification, and never assumed from a previous session.
 */
function InboxNotificationSettings({ prefs }: { prefs: PreferencesHandle }): ReactElement {
  const t = useT();
  const value = readInboxNotifications(prefs);
  const pending = prefs.pending === INBOX_NOTIFICATIONS_KEY;
  const desktop = hasDesktopChrome();
  const [webRefusal, setWebRefusal] = useState<"unsupported" | "denied" | undefined>(undefined);
  const [startDraft, setStartDraft] = useState<string | undefined>(undefined);
  const [endDraft, setEndDraft] = useState<string | undefined>(undefined);

  const write = (patch: Partial<InboxNotificationsPreference>): void => {
    prefs.write(INBOX_NOTIFICATIONS_KEY, { ...value, ...patch });
  };

  const toggleWeb = (next: boolean): void => {
    setWebRefusal(undefined);
    if (!next) {
      write({ web: false });
      return;
    }
    const api = webNotificationApi();
    if (api === undefined) {
      setWebRefusal("unsupported");
      return;
    }
    void api.requestPermission().then((permission) => {
      if (permission === "granted") {
        write({ web: true });
      } else {
        setWebRefusal("denied");
      }
    });
  };

  const commitQuietTime = (field: "start" | "end", draft: string | undefined): void => {
    if (draft === undefined || draft.length === 0 || draft === value.quietHours[field]) return;
    write({ quietHours: { ...value.quietHours, [field]: draft } });
  };

  return (
    <section className="cc-panel-section" data-inbox-notifications="true">
      <h3>{t("settings.control.notifications.heading")}</h3>
      <p className="cc-panel-note">{t("settings.control.notifications.intro")}</p>

      {INBOX_NOTIFICATION_GROUPS.map((group) => (
        <SettingsRow key={group} label={t(groupLabelKey(group))}>
          <ToggleSwitch
            name={`inbox-notify-group-${group}`}
            label={t(groupLabelKey(group))}
            checked={value.groups[group]}
            pending={pending}
            onChange={(next) => write({ groups: { ...value.groups, [group]: next } })}
          />
        </SettingsRow>
      ))}

      <SettingsRow
        label={t("settings.control.notifications.os.label")}
        description={t("settings.control.notifications.os.description")}
      >
        <ToggleSwitch
          name="inbox-notify-os"
          label={t("settings.control.notifications.os.label")}
          checked={value.os}
          pending={pending}
          onChange={(next) => write({ os: next })}
          {...(desktop ? {} : { disabledReason: t("settings.control.notifications.os.needsDesktop") })}
        />
      </SettingsRow>

      <SettingsRow
        label={t("settings.control.notifications.web.label")}
        description={t("settings.control.notifications.web.description")}
      >
        <ToggleSwitch
          name="inbox-notify-web"
          label={t("settings.control.notifications.web.label")}
          checked={value.web}
          pending={pending}
          onChange={toggleWeb}
        />
      </SettingsRow>
      {webRefusal === undefined ? null : (
        <p className="cc-panel-note" data-inbox-notify-web-refusal={webRefusal}>
          {t(
            webRefusal === "unsupported"
              ? "settings.control.notifications.web.unsupported"
              : "settings.control.notifications.web.denied",
          )}
        </p>
      )}

      <SettingsRow
        label={t("settings.control.notifications.quietHours.label")}
        description={t("settings.control.notifications.quietHours.description")}
      >
        <ToggleSwitch
          name="inbox-notify-quiet"
          label={t("settings.control.notifications.quietHours.label")}
          checked={value.quietHours.enabled}
          pending={pending}
          onChange={(next) => write({ quietHours: { ...value.quietHours, enabled: next } })}
        />
      </SettingsRow>
      {!value.quietHours.enabled ? null : (
        <div className="cc-panel-row" data-inbox-notify-quiet-hours="true">
          <label className="cc-credential-field">
            <span>{t("settings.control.notifications.quietHours.start")}</span>
            <input
              type="time"
              value={startDraft ?? value.quietHours.start}
              onChange={(event) => setStartDraft(event.target.value)}
              onBlur={() => {
                commitQuietTime("start", startDraft);
                setStartDraft(undefined);
              }}
            />
          </label>
          <label className="cc-credential-field">
            <span>{t("settings.control.notifications.quietHours.end")}</span>
            <input
              type="time"
              value={endDraft ?? value.quietHours.end}
              onChange={(event) => setEndDraft(event.target.value)}
              onBlur={() => {
                commitQuietTime("end", endDraft);
                setEndDraft(undefined);
              }}
            />
          </label>
        </div>
      )}

      <InlineStatus status={prefs.status} forKey={INBOX_NOTIFICATIONS_KEY} />
    </section>
  );
}

export function ControlSettings({
  prefs,
  client,
  recentEffects,
  recentProblem,
  onPolicyChange,
}: ControlSettingsProps): ReactElement {
  const t = useT();
  const rules = readRules(prefs.preference("execution.rules")?.value);
  const CATEGORY_LABELS = categoryLabels(t);
  const DECISION_LABELS = decisionLabels(t);

  /** Replace one category's rule, or remove it when the decision is the mode's own default. */
  const setRule = (category: EffectCategory, decision: ExecutionRule["decision"] | "default"): void => {
    const kept = rules.filter((rule) => rule.effectCategory !== category);
    const next = decision === "default" ? kept : [...kept, { effectCategory: category, decision }];
    prefs.write("execution.rules", next);
  };

  return (
    <>
      {/*
        One policy surface, and one control that changes the mode. A second mode control used to sit below this one,
        writing the legacy `execution.mode` preference; both reached the same policy, so a save on either could
        overwrite a mode just chosen on the other. The mode lives here now, and `execution.mode` is a projection of
        it that nothing on this screen writes.
      */}
      <ExecutionPolicySettings client={client} {...(onPolicyChange === undefined ? {} : { onPolicyChange })} />

      <section className="cc-panel-section" data-execution-rules="true">
        <h3>{t("settings.control.rules.heading")}</h3>
        <p className="cc-panel-note">{t("settings.control.rules.intro")}</p>
        {VALID_CATEGORIES.map((category) => {
          const current = rules.find((rule) => rule.effectCategory === category)?.decision ?? "default";
          return (
            <SettingsRow key={category} label={CATEGORY_LABELS[category]}>
              <SegmentedControl
                name={`rule-${category}`}
                label={CATEGORY_LABELS[category]}
                options={[
                  { value: "default", label: t("settings.control.rules.default") },
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

      {/*
        How much background work runs at once. Read by the node at every admission, so a choice here applies to the
        next request without a restart; work already running is never stopped by lowering it.
      */}
      <section className="cc-panel-section" data-background-limit="true">
        <h3>{t("settings.control.background.heading")}</h3>
        <p className="cc-panel-note">{t("settings.control.background.intro")}</p>
        <SettingsRow label={t("settings.control.background.label")}>
          <SegmentedControl
            name="background-limit"
            label={t("settings.control.background.heading")}
            options={[
              { value: "1", label: "1", note: t("settings.control.background.one.note") },
              { value: "3", label: "3", note: t("settings.control.background.three.note") },
              { value: "5", label: "5", note: t("settings.control.background.five.note") },
            ]}
            value={readBackgroundLimit(prefs.preference("execution.backgroundLimit")?.value)}
            pending={prefs.pending === "execution.backgroundLimit"}
            onChange={(value) => prefs.write("execution.backgroundLimit", Number(value))}
          />
        </SettingsRow>
        <InlineStatus status={prefs.status} forKey="execution.backgroundLimit" />
      </section>

      <section className="cc-panel-section" data-recent-effects="true">
        <h3>{t("settings.control.effects.heading")}</h3>
        <p className="cc-panel-note">{t("settings.control.effects.intro")}</p>
        {recentProblem !== undefined ? (
          <p className="cc-panel-note" data-recent-effects-problem="true">
            {recentProblem}
          </p>
        ) : recentEffects.length === 0 ? (
          // An empty list is a fact, not a missing feature: nothing has run without a card yet.
          <p className="cc-panel-note" data-recent-effects="none">
            {t("settings.control.effects.none")}
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

      <InboxNotificationSettings prefs={prefs} />
    </>
  );
}
