import type { WidgetDefinition } from "@clarkcant/contracts";
import type { WidgetFixture } from "@clarkcant/contracts";
import type { PreviewTheme, WidgetCatalogEntry } from "@clarkcant/widget-catalog";
import { MESSAGES_VI, type MessageKey } from "../i18n/messages.ts";

/**
 * The Vietnamese catalog lookup, used as `inspectorPanels`' default `t`.
 *
 * `inspectorPanels` is called directly by its own unit tests rather than through a component's
 * render pass, so its `t` parameter defaults rather than requiring a live `useT()` result.
 */
const defaultT = (key: MessageKey): string => MESSAGES_VI[key];

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
	t: (key: MessageKey) => string = defaultT,
): readonly InspectorPanel[] {
	const definition = entry.definition;
	const sizing = definition.sizing;

	return [
		{
			id: "props",
			label: t("widgets.lab.panel.props"),
			rows: propFields(definition).map((field) => ({
				label: field.key,
				value: [
					field.type,
					field.required ? t("widgets.lab.required") : t("widgets.lab.optional"),
					...(field.maxLength === undefined
						? []
						: [t("widgets.lab.maxLength").replace("{max}", String(field.maxLength))]),
				].join(" · "),
			})),
		},
		{
			id: "state",
			label: t("widgets.lab.panel.state"),
			rows: [
				{
					label: t("widgets.lab.currentValue"),
					value: fixture?.state === undefined ? t("widgets.lab.fixtureNoState") : JSON.stringify(fixture.state),
				},
				{
					label: "stateSchema",
					value: definition.stateSchema === undefined ? t("widgets.lab.notDeclared") : t("widgets.lab.declared"),
				},
				{
					label: "stateVersion",
					value:
						definition.stateVersion === undefined ? t("widgets.lab.notDeclared") : String(definition.stateVersion),
				},
			],
		},
		{
			id: "events",
			label: t("widgets.lab.panel.events"),
			rows: Object.keys(definition.eventSchemas ?? {}).map((name) => ({
				label: name,
				value: t("widgets.lab.eventDeclared"),
			})),
		},
		{
			id: "actions",
			label: t("widgets.lab.panel.actions"),
			rows: [
				{
					label: t("widgets.lab.effectCategories"),
					value: definition.effectCategories.join(", ") || t("widgets.lab.none"),
				},
				{
					label: t("widgets.lab.runnableInLab"),
					value: isActionExecutable(definition) ? t("widgets.lab.runnableYes") : t("widgets.lab.runnableNo"),
				},
				{
					label: t("widgets.lab.needsApproval"),
					value: requiresApproval(definition)
						? t("widgets.lab.needsApprovalMaybe")
						: t("widgets.lab.needsApprovalNo"),
				},
			],
		},
		{
			id: "semantic",
			label: t("widgets.lab.panel.semantic"),
			rows: [{ label: "semanticDescription", value: definition.semanticDescription }],
		},
		{
			id: "sizing",
			label: t("widgets.lab.panel.sizing"),
			rows: [
				{ label: "compact", value: sizing.compact ? t("widgets.lab.supported") : t("widgets.lab.unsupported") },
				{ label: "expanded", value: sizing.expanded ? t("widgets.lab.supported") : t("widgets.lab.unsupported") },
				{ label: "minHeight", value: `${sizing.minHeight}px` },
			],
		},
		{
			id: "capabilities",
			label: t("widgets.lab.panel.capabilities"),
			rows:
				definition.requestedCapabilities.length === 0
					? [{ label: t("widgets.lab.capabilitiesRequestedLabel"), value: t("widgets.lab.capabilitiesNoneRequested") }]
					: definition.requestedCapabilities.map((capability) => ({
							label: String(capability),
							value: t("widgets.lab.capabilityRequested"),
						})),
		},
		{
			id: "fallback",
			label: t("widgets.lab.panel.fallback"),
			rows: [
				{ label: "semanticDescription", value: definition.semanticDescription },
				{ label: "textFallback", value: definition.textFallback },
			],
		},
	];
}
