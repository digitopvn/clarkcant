import { type ReactElement, useState } from "react";

import type { WidgetDefinition } from "@clarkcant/contracts";
import { validateProps } from "@clarkcant/widget-catalog";

import { propFields } from "./widget-lab.ts";

/**
 * A props editor generated from the definition's own schema.
 *
 * Schema-backed controls are the default because editing raw JSON to change a title is the wrong
 * default for the properties people actually touch; raw JSON stays available as an advanced view.
 *
 * Nothing is committed until it validates. The same `validateProps` the host uses decides, so a
 * preview cannot be driven into a shape production would have refused - and when it refuses, the
 * preview keeps the last good props rather than disappearing.
 */

export interface WidgetPropsFormProps {
  definition: WidgetDefinition;
  props: Record<string, unknown>;
  onChange: (props: Record<string, unknown>) => void;
}

export function WidgetPropsForm({ definition, props, onChange }: WidgetPropsFormProps): ReactElement {
  const fields = propFields(definition);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawText, setRawText] = useState("");

  const commit = (candidate: Record<string, unknown>): void => {
    const result = validateProps(definition, candidate);
    if (!result.ok) {
      setProblems(result.problems);
      return;
    }
    setProblems([]);
    onChange(candidate);
  };

  const commitRaw = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (cause) {
      setProblems([`JSON không đọc được: ${cause instanceof Error ? cause.message : String(cause)}`]);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setProblems(["JSON phải là một object."]);
      return;
    }
    commit(parsed as Record<string, unknown>);
  };

  return (
    <div className="cc-widget-props" data-widget-props-form="true">
      {fields.map((field) => {
        const value = props[field.key];
        if (field.type === "boolean") {
          return (
            <label className="cc-widget-lab-control cc-widget-lab-check" key={field.key}>
              <input
                type="checkbox"
                checked={value === true}
                onChange={(event) => commit({ ...props, [field.key]: event.target.checked })}
                data-widget-prop={field.key}
              />
              <span>{field.key}</span>
            </label>
          );
        }
        if (field.type === "other") {
          return (
            <p className="cc-panel-note" key={field.key} data-widget-prop-unsupported={field.key}>
              {`${field.key} là kiểu phức tạp — sửa ở chế độ JSON nâng cao.`}
            </p>
          );
        }
        return (
          <label className="cc-widget-lab-control" key={field.key}>
            <span>
              {field.key}
              {field.required ? " *" : ""}
            </span>
            <input
              type={field.type === "number" ? "number" : "text"}
              value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
              {...(field.maxLength === undefined ? {} : { maxLength: field.maxLength })}
              onChange={(event) =>
                commit({
                  ...props,
                  [field.key]: field.type === "number" ? Number(event.target.value) : event.target.value,
                })
              }
              data-widget-prop={field.key}
            />
          </label>
        );
      })}

      <details
        className="cc-widget-props-raw"
        open={rawOpen}
        onToggle={(event) => {
          const next = (event.target as HTMLDetailsElement).open;
          setRawOpen(next);
          if (next) setRawText(JSON.stringify(props, null, 2));
        }}
      >
        <summary>JSON nâng cao</summary>
        <textarea
          value={rawText}
          onChange={(event) => setRawText(event.target.value)}
          aria-label="Props dạng JSON"
          data-widget-props-raw="true"
        />
        <button type="button" className="cc-badge" onClick={commitRaw} data-widget-props-apply="true">
          Áp dụng
        </button>
      </details>

      {problems.length > 0 && (
        <ul className="cc-widget-props-problems" data-widget-props-problems="true" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
