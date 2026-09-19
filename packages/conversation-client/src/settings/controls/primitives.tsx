import type { ReactElement } from "react";

// Re-exported so a tab imports one module for its controls, and so a caller cannot end up with two copies of the
// row component that look identical and drift.
export { SettingsRow, ToolRow, type SettingsRowProps, type ToolRowProps } from "./SettingsRow.tsx";

/**
 * The settings controls, each for one shape of decision.
 *
 * AGENTS.md is specific about this: a segmented control for a small exclusive mode set, a toggle for an
 * immediate boolean, a search-select for a long list, a button for a one-time action, and inline status for
 * the outcome of a mutation. The reason is not tidiness — it is that a radio group used for a boolean, or a
 * save button for a reversible preference, tells the user something false about what will happen when they
 * touch it.
 *
 * All of these are controlled and stateless: the value they show is what the node stored, and a write is
 * reported back through `InlineStatus`. None of them updates itself optimistically.
 */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** What this choice means, shown under the control rather than in a tooltip. */
  note?: string;
}

export interface SegmentedControlProps<T extends string> {
  /** Names the group in the DOM, so a test can find the one it means. */
  name: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** True while a write for this group is in flight, so the control can say so without freezing. */
  pending?: boolean;
  label: string;
}

/**
 * A small exclusive set of modes.
 *
 * `aria-pressed` on buttons rather than a radio group, matching the theme picker this repository already
 * had: these are immediate actions rather than a form that is submitted, and a radio group would imply a
 * pending edit that has to be committed.
 */
export function SegmentedControl<T extends string>({
  name,
  options,
  value,
  onChange,
  pending,
  label,
}: SegmentedControlProps<T>): ReactElement {
  const chosen = options.find((option) => option.value === value);
  return (
    <div className="cc-segmented-wrap">
      <div className="cc-segmented" role="group" aria-label={label} data-segmented={name} data-pending={pending === true}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className="cc-badge"
            aria-pressed={option.value === value}
            data-selected={option.value === value}
            data-segment={option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {/* What the current choice means, always visible: the note is the explanation, not decoration. */}
      {chosen?.note === undefined ? null : (
        <p className="cc-panel-note" data-segment-note={value}>
          {chosen.note}
        </p>
      )}
    </div>
  );
}

export interface ToggleSwitchProps {
  name: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The accessible name, when the visible label is a separate row label. */
  label: string;
  pending?: boolean;
  /** Shown when the toggle cannot be used, which is a reason rather than a disabled look alone. */
  disabledReason?: string;
}

/**
 * An immediate boolean.
 *
 * A real checkbox rather than a styled div, so keyboard and screen-reader behaviour is the browser's rather
 * than something reimplemented here. `role="switch"` because these take effect at once rather than being
 * collected and submitted.
 */
export function ToggleSwitch({
  name,
  checked,
  onChange,
  label,
  pending,
  disabledReason,
}: ToggleSwitchProps): ReactElement {
  const disabled = disabledReason !== undefined;
  return (
    <div className="cc-toggle-wrap">
      <label className="cc-toggle" data-toggle={name} data-pending={pending === true}>
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          aria-label={label}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="cc-toggle-track" aria-hidden="true" />
        <span className="cc-toggle-state">{checked ? "Bật" : "Tắt"}</span>
      </label>
      {/*
        A control that cannot be used says why, in words. AGENTS.md: disable it with a visible reason or omit
        it — an unexplained disabled control is a bug report waiting to happen.
      */}
      {disabledReason === undefined ? null : (
        <p className="cc-panel-note" data-toggle-blocked={name}>
          {disabledReason}
        </p>
      )}
    </div>
  );
}

export interface InlineStatusProps {
  status: { key: string; tone: "ok" | "error"; message: string } | undefined;
  /** Only render when the status belongs to this key, so one tab's message cannot appear under another's control. */
  forKey: string;
}

/**
 * The outcome of a mutation, next to the control that caused it.
 *
 * Rendered from the node's own answer, including its refusal message, which names the field and never the
 * value. There is no separate error banner: a message that appears somewhere else on the page is a message
 * the user has to go looking for.
 */
export function InlineStatus({ status, forKey }: InlineStatusProps): ReactElement | null {
  if (status === undefined || status.key !== forKey) return null;
  return (
    <p className="cc-panel-note cc-inline-status" data-inline-status={forKey} data-tone={status.tone} role="status">
      {status.message}
    </p>
  );
}

export interface RangeFieldProps {
  name: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** What the number means, so the slider is not the only explanation. */
  note?: string;
  onChange: (value: number) => void;
}

/**
 * A bounded number, with the number visible.
 *
 * Both a slider and a numeric field, because they answer different questions: the slider is for finding a
 * value by feel, and the field is for setting one you already know. The bounds come from the contracts
 * registry rather than being written here, so the control cannot offer a value the node would refuse.
 */
export function RangeField({ name, label, value, min, max, step, note, onChange }: RangeFieldProps): ReactElement {
  const clamp = (next: number): number => Math.min(Math.max(next, min), max);
  return (
    <div className="cc-range" data-range={name}>
      <div className="cc-range-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step ?? 1}
          value={value}
          aria-label={label}
          data-range-slider={name}
          onChange={(event) => onChange(clamp(Number(event.target.value)))}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step ?? 1}
          value={value}
          aria-label={`${label} (số)`}
          data-range-number={name}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(clamp(next));
          }}
        />
      </div>
      <span className="cc-setting-desc">
        {min}–{max}
        {note === undefined ? "" : ` · ${note}`}
      </span>
    </div>
  );
}
