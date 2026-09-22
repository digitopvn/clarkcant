import type { WidgetDefinition } from "@clarkcant/contracts";
import type { WidgetFixture } from "@clarkcant/contracts";
import type { PreviewTheme, WidgetCatalogEntry } from "@clarkcant/widget-catalog";

/**
 * The Widget Lab's derivations.
 *
 * Everything here is a pure function over a definition or a fixture. That is deliberate: the repo
 * runs Vitest in Node with no DOM, so the parts of the lab that carry meaning - which fields a props
 * schema has, what the inspector should say, whether an action may be driven from a preview, and
 * which theme attribute a preview takes - are computed here where they can be asserted directly.
 * Rendering them is the components' job, and the rendered behaviour is checked in Playwright.
 */

export interface PropField {
  key: string;
  type: "string" | "number" | "boolean" | "other";
  required: boolean;
  maxLength?: number;
}

export function propFields(definition: WidgetDefinition): readonly PropField[] {
  const schema = definition.propsSchema as {
    properties?: Record<string, { type?: string; maxLength?: number }>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);

  return Object.entries(schema.properties ?? {})
    .map(([key, spec]) => {
      const type =
        spec.type === "string" || spec.type === "number" || spec.type === "boolean" ? spec.type : "other";
      return {
        key,
        type,
        required: required.has(key),
        ...(spec.maxLength === undefined ? {} : { maxLength: spec.maxLength }),
      } satisfies PropField;
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Whether a preview may drive this widget's actions.
 *
 * A catalog preview is a document, not a live instance, so the only honest answer for anything with
 * an effect is "no". A fixture that would be actionable in conversation is therefore shown
 * read-only, and the inspector says so rather than offering a button that cannot work.
 */
export function isActionExecutable(definition: WidgetDefinition): boolean {
  return definition.effectCategories.every((kind) => kind === "read");
}

/** Whether production would route this widget's effects through an approval. */
export function requiresApproval(definition: WidgetDefinition): boolean {
  return definition.effectCategories.some((kind) => kind !== "read" && kind !== "local-write");
}

/**
 * The theme attribute a preview subtree takes.
 *
 * `system` returns `undefined` rather than a guess: the preview then inherits the surrounding theme,
 * which is what "follow the current theme" means. Returning a concrete value here would make the
 * control look like it did something while quietly disagreeing with the rest of the window.
 */
export function themeAttributeFor(theme: PreviewTheme): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme;
}

export function fixtureIds(entry: WidgetCatalogEntry): readonly string[] {
  return entry.fixtures.map((fixture) => fixture.id);
}

export function fixtureById(entry: WidgetCatalogEntry, fixtureId: string): WidgetFixture | undefined {
  return entry.fixtures.find((fixture) => fixture.id === fixtureId);
}

export interface InspectorRow {
  label: string;
  value: string;
}

export interface InspectorPanel {
  id: string;
  label: string;
  rows: readonly InspectorRow[];
}

/** The inspector's panels, in the order the developer standard lists them. */
export function inspectorPanels(
  entry: WidgetCatalogEntry,
  fixture: WidgetFixture | undefined,
): readonly InspectorPanel[] {
  const definition = entry.definition;
  const sizing = definition.sizing;

  return [
    {
      id: "props",
      label: "Props",
      rows: propFields(definition).map((field) => ({
        label: field.key,
        value: [
          field.type,
          field.required ? "bắt buộc" : "tuỳ chọn",
          ...(field.maxLength === undefined ? [] : [`tối đa ${field.maxLength}`]),
        ].join(" · "),
      })),
    },
    {
      id: "state",
      label: "State",
      rows: [
        {
          label: "Giá trị hiện tại",
          value: fixture?.state === undefined ? "fixture này không khai báo state" : JSON.stringify(fixture.state),
        },
        {
          label: "stateSchema",
          value: definition.stateSchema === undefined ? "không khai báo" : "có khai báo",
        },
        {
          label: "stateVersion",
          value: definition.stateVersion === undefined ? "không khai báo" : String(definition.stateVersion),
        },
      ],
    },
    {
      id: "events",
      label: "Events",
      rows: Object.keys(definition.eventSchemas ?? {}).map((name) => ({ label: name, value: "khai báo" })),
    },
    {
      id: "actions",
      label: "Actions",
      rows: [
        { label: "effectCategories", value: definition.effectCategories.join(", ") || "không" },
        {
          label: "Chạy được trong Lab",
          value: isActionExecutable(definition) ? "có" : "không — preview chỉ đọc",
        },
        { label: "Cần phê duyệt", value: requiresApproval(definition) ? "có thể" : "không" },
      ],
    },
    {
      id: "semantic",
      label: "Semantic",
      rows: [{ label: "semanticDescription", value: definition.semanticDescription }],
    },
    {
      id: "sizing",
      label: "Sizing",
      rows: [
        { label: "compact", value: sizing.compact ? "hỗ trợ" : "không" },
        { label: "expanded", value: sizing.expanded ? "hỗ trợ" : "không" },
        { label: "minHeight", value: `${sizing.minHeight}px` },
      ],
    },
    {
      id: "capabilities",
      label: "Capabilities",
      rows:
        definition.requestedCapabilities.length === 0
          ? [{ label: "yêu cầu", value: "không yêu cầu capability nào" }]
          : definition.requestedCapabilities.map((capability) => ({
              label: String(capability),
              value: "được yêu cầu",
            })),
    },
    {
      id: "fallback",
      label: "Fallback",
      rows: [
        { label: "semanticDescription", value: definition.semanticDescription },
        { label: "textFallback", value: definition.textFallback },
      ],
    },
  ];
}
