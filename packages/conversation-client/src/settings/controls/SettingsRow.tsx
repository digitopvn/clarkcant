import type { ReactElement, ReactNode } from "react";

import type { MessageKey } from "../../i18n/messages.ts";

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
  /**
   * Passed in explicitly rather than read via `useT()`: this component, like `SettingsRow`, is exercised by
   * plain function calls in unit tests with no `LocaleProvider` mounted, so the translator has to arrive as
   * data rather than through a hook.
   */
  t: (key: MessageKey) => string;
}

/**
 * One capability.
 *
 * Usable and unusable look different on purpose, and the reason is always shown when there is one.
 * The blueprint's rule for a blocked gate applies here too: a capability that is declared but not
 * loaded is reported as blocked, with what would unblock it — never rounded up to available.
 */
export function ToolRow({ toolRef, summary, usable, blockedReason, t }: ToolRowProps): ReactElement {
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
        {usable ? t("settings.toolRow.usable") : t("settings.toolRow.unusable")}
      </span>
    </div>
  );
}
