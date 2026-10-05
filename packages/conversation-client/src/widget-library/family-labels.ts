import type { MessageKey } from "../i18n/messages.ts";

/**
 * A widget family in the reader's words.
 *
 * The family is a catalog id, stable and English, which is right for filtering and wrong for a label: a Vietnamese
 * library offered "trend", "cta" and "tables" as its categories. A family this build has no words for, such as one an
 * installed package names after itself, is shown as it came rather than hidden.
 */
const FAMILY_KEYS: Record<string, MessageKey> = {
  action: "widgets.family.action",
  artifact: "widgets.family.artifact",
  board: "widgets.family.board",
  calendar: "widgets.family.calendar",
  chart: "widgets.family.chart",
  choice: "widgets.family.choice",
  cta: "widgets.family.cta",
  diagram: "widgets.family.diagram",
  filter: "widgets.family.filter",
  form: "widgets.family.form",
  hierarchy: "widgets.family.hierarchy",
  input: "widgets.family.input",
  layout: "widgets.family.layout",
  list: "widgets.family.list",
  map: "widgets.family.map",
  media: "widgets.family.media",
  metrics: "widgets.family.metrics",
  note: "widgets.family.note",
  search: "widgets.family.search",
  status: "widgets.family.status",
  tables: "widgets.family.tables",
  timeline: "widgets.family.timeline",
  trend: "widgets.family.trend",
};

export function familyLabel(family: string, t: (key: MessageKey) => string): string {
  const key = FAMILY_KEYS[family];
  return key === undefined ? family : t(key);
}
