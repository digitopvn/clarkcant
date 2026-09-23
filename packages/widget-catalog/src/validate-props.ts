import type { MessageBlock, WidgetDefinition } from "@clarkcant/contracts";

/**
 * Props validation, as a pure function.
 *
 * This lives here rather than in `@clarkcant/widget-host` because the widget host's package
 * **root** reads `node:crypto`, and the Widget Lab runs in a browser. Importing the validator from
 * that root would pull a Node builtin into the web bundle; `widget-host` therefore re-exports this
 * implementation instead of owning it, so there is still exactly one copy of the rules.
 *
 * The check is deliberately a minimal structural one rather than a full JSON Schema engine: what
 * matters is that unknown keys never reach the DOM, a wrong type is caught, and a failure still
 * produces a readable fallback so the timeline stays usable.
 */

export type PropsValidation =
  | { ok: true; props: Record<string, unknown> }
  | { ok: false; fallback: MessageBlock; problems: string[] };

export function validateProps(
  definition: WidgetDefinition,
  props: Record<string, unknown>,
): PropsValidation {
  const schema = definition.propsSchema as {
    properties?: Record<string, { type?: string; maxLength?: number }>;
    required?: string[];
    additionalProperties?: boolean;
  };

  const problems: string[] = [];
  const allowed = schema.properties ?? {};

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(props)) {
      if (!(key in allowed)) problems.push(`unknown property "${key}"`);
    }
  }

  for (const key of schema.required ?? []) {
    if (!(key in props)) problems.push(`required property "${key}" is missing`);
  }

  for (const [key, value] of Object.entries(props)) {
    const spec = allowed[key];
    if (!spec) continue;
    if (spec.type === "string" && typeof value !== "string") {
      problems.push(`property "${key}" must be a string`);
    }
    if (spec.type === "number" && typeof value !== "number") {
      problems.push(`property "${key}" must be a number`);
    }
    if (spec.type === "boolean" && typeof value !== "boolean") {
      problems.push(`property "${key}" must be a boolean`);
    }
    if (spec.type === "string" && typeof value === "string" && spec.maxLength !== undefined && value.length > spec.maxLength) {
      problems.push(`property "${key}" exceeds its maximum length of ${spec.maxLength}`);
    }
  }

  if (problems.length === 0) return { ok: true, props };

  return {
    ok: false,
    problems,
    fallback: {
      type: "text",
      format: "plain",
      content: definition.textFallback,
      streaming: false,
    },
  };
}
