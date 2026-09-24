import { useEffect, useState, type ReactElement } from "react";

import type { EffectCategory, ExecutionRule, InboxNotificationGroup, InboxNotificationsPreference } from "@clarkcant/contracts";
import {
  GUARD_CLASSES,
  INBOX_NOTIFICATION_GROUPS,
  parseInboxNotificationsPreference,
  timeOfDaySchema,
  type AutonomySettings,
  type ExecutionPolicy,
  type GuardClass,
} from "@clarkcant/contracts";

import { InlineStatus, SegmentedControl, SettingsRow, ToggleSwitch } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";
import type { GatewayClient } from "../api.ts";
import { hasDesktopChrome } from "../desktop-compact.ts";
import { effectCategoryLabels } from "../inbox/inbox-model.ts";
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
 * Why the last explicit ask for web permission did not turn the toggle on.
 *
 * `dismissed` and `denied` are different facts and read differently: closing the browser's own prompt without
 * choosing (`Notification.permission` answers `"default"`) is not the same as the browser refusing outright
 * (`"denied"`), and telling the person they were refused when they simply clicked away would be inventing a
 * decision nobody made.
 */
type WebPermissionRefusal = "unsupported" | "denied" | "dismissed" | "requestFailed";

function webRefusalMessageKey(refusal: WebPermissionRefusal): MessageKey {
  switch (refusal) {
    case "unsupported":
      return "settings.control.notifications.web.unsupported";
    case "denied":
      return "settings.control.notifications.web.denied";
    case "dismissed":
      return "settings.control.notifications.web.dismissed";
    case "requestFailed":
      return "settings.control.notifications.web.requestFailed";
  }
}

/**
 * `Notification.requestPermission()` in both shapes a browser offers it: the modern one returns a Promise, and
 * an old Safari accepts only a callback and returns `undefined` — calling `.then` on that return value throws.
 * Passing `settle` as the (deprecated but still honoured) callback argument answers both: a modern browser
 * invokes it once and also resolves the Promise this awaits below, and old Safari has nothing else that ever
 * calls it. `settled` keeps the double-fire from a modern browser harmless.
 */
function requestWebPermission(NotificationApi: typeof Notification): Promise<NotificationPermission> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (permission: NotificationPermission): void => {
      if (settled) return;
      settled = true;
      resolve(permission);
    };
    let returned: unknown;
    try {
      returned = NotificationApi.requestPermission(settle);
    } catch (cause) {
      reject(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }
    const maybeThenable = returned as { then?: unknown } | null | undefined;
    if (typeof maybeThenable?.then === "function") {
      (returned as Promise<NotificationPermission>).then(settle, reject);
    }
  });
}

/**
 * Per-group toggles, the OS/web channel switches and quiet hours for #171, once the stored preference is known.
 *
 * The browser's notification permission is a hard consent boundary this control does not lift: `web` only ever
 * becomes `true` here, from the explicit act of turning this toggle on, and only after `requestWebPermission`
 * itself answers `"granted"` — never from the background poll that later delivers a notification, and never
 * assumed from a previous session. The toggle's own `checked` reflects that live permission rather than the
 * stored choice alone, so a permission revoked from the browser's own settings since the value was saved shows
 * as off rather than as a control lying about what will happen.
 */
function InboxNotificationSettingsReady({ prefs, value }: { prefs: PreferencesHandle; value: InboxNotificationsPreference }): ReactElement {
  const t = useT();
  const pending = prefs.pending === INBOX_NOTIFICATIONS_KEY;
  // Every control in this section writes the same preference key, and `usePreferences` serializes writes to one
  // in-flight request per key — a second click before the first resolves would otherwise send a patch built on
  // an already-stale `value`, silently discarding whatever the first write was about to confirm.
  const pendingReason = pending ? t("settings.control.notifications.pending") : undefined;
  const desktop = hasDesktopChrome();
  const NotificationApi = webNotificationApi();
  const webGranted = NotificationApi !== undefined && NotificationApi.permission === "granted";
  const webSupported = NotificationApi !== undefined;
  const [webRefusal, setWebRefusal] = useState<WebPermissionRefusal | undefined>(undefined);
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
    if (NotificationApi === undefined) {
      setWebRefusal("unsupported");
      return;
    }
    void requestWebPermission(NotificationApi)
      .then((permission) => {
        if (permission === "granted") write({ web: true });
        // "default" is the browser's own prompt closed with no choice made — not a refusal.
        else setWebRefusal(permission === "denied" ? "denied" : "dismissed");
      })
      .catch(() => setWebRefusal("requestFailed"));
  };

  const commitQuietTime = (field: "start" | "end", draft: string | undefined): void => {
    if (draft === undefined || draft === value.quietHours[field]) return;
    if (!timeOfDaySchema.safeParse(draft).success) return;
    write({ quietHours: { ...value.quietHours, [field]: draft } });
  };

  const quietTimeField = (
    field: "start" | "end",
    draft: string | undefined,
    setDraft: (next: string | undefined) => void,
  ): ReactElement => (
    <input
      type="time"
      value={draft ?? value.quietHours[field]}
      disabled={pending}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        commitQuietTime(field, next);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        commitQuietTime(field, draft);
        setDraft(undefined);
      }}
      onBlur={() => {
        commitQuietTime(field, draft);
        setDraft(undefined);
      }}
    />
  );

  // The web toggle's own note: the freshest explicit refusal outranks the passive "stored on but not actually
  // granted" note, since it is the more specific and more recent fact.
  const webNote =
    webRefusal !== undefined
      ? { key: `refusal-${webRefusal}`, text: t(webRefusalMessageKey(webRefusal)) }
      : !desktop && webSupported && value.web && !webGranted
        ? { key: "revoked", text: t("settings.control.notifications.web.revoked") }
        : undefined;

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
            // otherDevices has no producer yet (#170's pairing is not built): the preference is kept so a
            // choice made once will already be correct the day it ships, but the row cannot do anything today.
            {...(group === "otherDevices"
              ? { disabledReason: t("settings.control.notifications.group.otherDevices.unavailable") }
              : pendingReason === undefined
                ? {}
                : { disabledReason: pendingReason })}
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
          {...(!desktop
            ? { disabledReason: t("settings.control.notifications.os.needsDesktop") }
            : pendingReason === undefined
              ? {}
              : { disabledReason: pendingReason })}
        />
      </SettingsRow>

      <SettingsRow
        label={t("settings.control.notifications.web.label")}
        description={t("settings.control.notifications.web.description")}
      >
        <ToggleSwitch
          name="inbox-notify-web"
          label={t("settings.control.notifications.web.label")}
          // Live permission, not the stored choice alone: a browser that revoked permission since the value was
          // saved shows off, never a switch claiming an effect that will not happen.
          checked={!desktop && webSupported && value.web && webGranted}
          pending={pending}
          onChange={toggleWeb}
          {...(desktop
            ? { disabledReason: t("settings.control.notifications.web.unavailableOnDesktop") }
            : !webSupported
              ? { disabledReason: t("settings.control.notifications.web.unsupported") }
              : pendingReason === undefined
                ? {}
                : { disabledReason: pendingReason })}
        />
      </SettingsRow>
      {webNote === undefined ? null : (
        <p className="cc-panel-note" data-inbox-notify-web-refusal={webNote.key} role="status">
          {webNote.text}
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
          {...(pendingReason === undefined ? {} : { disabledReason: pendingReason })}
        />
      </SettingsRow>
      {!value.quietHours.enabled ? null : (
        <div className="cc-panel-row" data-inbox-notify-quiet-hours="true">
          <label className="cc-credential-field">
            <span>{t("settings.control.notifications.quietHours.start")}</span>
            {quietTimeField("start", startDraft, setStartDraft)}
          </label>
          <label className="cc-credential-field">
            <span>{t("settings.control.notifications.quietHours.end")}</span>
            {quietTimeField("end", endDraft, setEndDraft)}
          </label>
        </div>
      )}

      <InlineStatus status={prefs.status} forKey={INBOX_NOTIFICATIONS_KEY} />
    </section>
  );
}

/**
 * Gates the section on the one thing every control here needs: the stored preference, or its confirmed absence
 * (the node answered and this key simply was not written, which is a known state — the registry default — not
 * an unknown one). Rendering the controls before that is known would show the default as if it were a choice
 * somebody made, and would let a write happen before there is a confirmed value to patch.
 */
function InboxNotificationSettings({ prefs }: { prefs: PreferencesHandle }): ReactElement {
  const t = useT();
  if (prefs.problem !== undefined) {
    return (
      <section className="cc-panel-section" data-inbox-notifications="true">
        <h3>{t("settings.control.notifications.heading")}</h3>
        <p className="cc-panel-note" data-inbox-notifications-error="true" role="status">
          {t("settings.control.notifications.loadFailed").replace("{reason}", prefs.problem)}
        </p>
      </section>
    );
  }
  if (prefs.preferences === undefined) {
    return (
      <section className="cc-panel-section" data-inbox-notifications="true">
        <h3>{t("settings.control.notifications.heading")}</h3>
        <p className="cc-panel-note">{t("settings.control.notifications.loading")}</p>
      </section>
    );
  }
  const value = parseInboxNotificationsPreference(prefs.preference(INBOX_NOTIFICATIONS_KEY)?.value);
  return <InboxNotificationSettingsReady prefs={prefs} value={value} />;
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
  const CATEGORY_LABELS = effectCategoryLabels(t);
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
