import type { WidgetDefinition, WidgetFixture } from "@clarkcant/contracts";
import { FAMILY_BY_DEFINITION, NOTE, WIDGETS } from "@clarkcant/data-canvas";

import { fixturesFor } from "./fixtures.ts";

/**
 * The canonical catalog.
 *
 * Everything that wants to describe, list, filter, test or preview a built-in widget reads this
 * layer, so there is one place where a definition's family, display name, tags and fixtures live.
 * Rendering stays out of it on purpose: an entry names a definition id and never a component, which
 * is what keeps the descriptor usable from Node tooling as well as from the browser client.
 */

export type CatalogSource = "builtin" | "installed" | "local";
export type CatalogStatus = "stable" | "experimental";

export interface WidgetCatalogEntry {
  definition: WidgetDefinition;
  family: string;
  displayName: string;
  description: string;
  tags: readonly string[];
  aliases: readonly string[];
  source: CatalogSource;
  status: CatalogStatus;
  fixtures: readonly WidgetFixture[];
}

interface CatalogMeta {
  displayName: string;
  tags: readonly string[];
  aliases: readonly string[];
  status: CatalogStatus;
  /**
   * Family for a definition that is not in the pack's `WIDGETS` list.
   *
   * `canvas.note@1` is such a case: its definition lives in the pack's sample recipe so that adding
   * it to the library does not add it to the model's callable view vocabulary, which means
   * `FAMILY_BY_DEFINITION` (and its stale-entry test) must not learn about it.
   */
  family?: string;
}

/**
 * Metadata that belongs to this catalog rather than to the widget format.
 *
 * Kept beside the definitions instead of inside the contract, for the same reason the family map
 * is: a display name and a search alias are properties of *this* catalog, not of every widget
 * everywhere. A definition without an entry here is caught by `catalogMetaIds` in the tests.
 */
const META: Record<string, CatalogMeta> = {
  "canvas.line@1": {
    displayName: "Biểu đồ đường",
    tags: ["chart", "trend"],
    aliases: ["line", "chart", "biểu đồ", "đồ thị", "xu hướng"],
    status: "stable",
  },
  "canvas.bar@1": {
    displayName: "Biểu đồ cột",
    tags: ["chart", "trend"],
    aliases: ["bar", "chart", "biểu đồ", "cột", "so sánh"],
    status: "stable",
  },
  "canvas.donut@1": {
    displayName: "Biểu đồ tròn",
    tags: ["chart", "trend"],
    aliases: ["donut", "pie", "biểu đồ tròn", "tỷ lệ"],
    status: "stable",
  },
  "canvas.table@1": {
    displayName: "Bảng dữ liệu",
    tags: ["table", "data"],
    aliases: ["table", "bảng", "dữ liệu", "thống kê"],
    status: "stable",
  },
  "canvas.overview@1": {
    displayName: "Tổng quan",
    tags: ["layout", "composition"],
    aliases: ["overview", "tổng quan"],
    status: "stable",
  },
  "canvas.metrics@1": {
    displayName: "Số liệu tổng hợp",
    tags: ["metrics", "summary"],
    aliases: ["metrics", "số liệu", "chỉ số"],
    status: "stable",
  },
  "canvas.filter@1": {
    displayName: "Chọn khoảng thời gian",
    tags: ["filter", "period"],
    aliases: ["filter", "lọc", "khoảng thời gian", "tuần", "tháng"],
    status: "stable",
  },
  "canvas.calendar@1": {
    displayName: "Lịch",
    tags: ["calendar", "time"],
    aliases: ["calendar", "lịch", "ngày"],
    status: "stable",
  },
  "canvas.image@1": {
    displayName: "Ảnh",
    tags: ["media", "image"],
    aliases: ["image", "ảnh", "hình"],
    status: "stable",
  },
  "canvas.carousel@1": {
    displayName: "Bộ ảnh lần lượt",
    tags: ["media", "image"],
    aliases: ["carousel", "bộ ảnh", "slide"],
    status: "stable",
  },
  "canvas.gallery@1": {
    displayName: "Thư viện ảnh",
    tags: ["media", "image"],
    aliases: ["gallery", "thư viện ảnh", "lưới ảnh"],
    status: "stable",
  },
  "canvas.youtube@1": {
    displayName: "Video YouTube",
    tags: ["media", "video"],
    aliases: ["youtube", "video"],
    status: "stable",
  },
  "canvas.video@1": {
    displayName: "Video trên máy",
    tags: ["media", "video"],
    aliases: ["video", "phim"],
    status: "stable",
  },
  "canvas.cta@1": {
    displayName: "Nút hành động",
    tags: ["cta", "action"],
    aliases: ["cta", "action", "nút", "lưu"],
    status: "stable",
  },
  "canvas.note@1": {
    displayName: "Ghi chú",
    tags: ["note", "local"],
    aliases: ["note", "ghi chú", "checklist"],
    status: "stable",
    family: "note",
  },
};

/**
 * Definitions that are containers rather than leaves.
 *
 * A composition container is drawn by the composition path in `Conversation.tsx`, not by a catalog
 * renderer, and its props name a host-compiled document that a preview has no way to produce. It is
 * therefore outside the library-visible set and outside the fixture requirement.
 */
export const CONTAINER_DEFINITION_IDS: readonly string[] = ["canvas.overview@1"];

export function isContainerDefinition(definitionId: string): boolean {
  return CONTAINER_DEFINITION_IDS.includes(definitionId);
}

/**
 * Every definition the library can describe.
 *
 * `WIDGETS` plus the note, which the pack exports outside `WIDGETS` because that list is the model's
 * callable view vocabulary. The note is imported from the pack's barrel rather than from its
 * `sample` subpath on purpose: `sample.ts` imports `@clarkcant/core`, and reaching it from here would
 * pull a Node-only module graph (`node:sqlite`, `node:crypto`) into the browser bundle - which is
 * exactly what the `browser-entries-avoid-node-builtins` invariant catches.
 */
export const CATALOG_DEFINITIONS: readonly WidgetDefinition[] = [...WIDGETS, NOTE];

export const CATALOG_ENTRIES: readonly WidgetCatalogEntry[] = CATALOG_DEFINITIONS.map((definition) => {
  const meta = META[definition.id];
  return {
    definition,
    family: meta?.family ?? FAMILY_BY_DEFINITION[definition.id] ?? "unknown",
    displayName: meta?.displayName ?? definition.id,
    description: definition.semanticDescription,
    tags: meta?.tags ?? [],
    aliases: meta?.aliases ?? [],
    source: "builtin" as const,
    status: meta?.status ?? "stable",
    fixtures: fixturesFor(definition.id),
  };
});

/** Every definition id that has explicit metadata, so a missing entry is a test failure rather than a fallback. */
export function catalogMetaIds(): readonly string[] {
  return Object.keys(META).sort((a, b) => a.localeCompare(b));
}

export function catalogEntry(definitionId: string): WidgetCatalogEntry | undefined {
  return CATALOG_ENTRIES.find((entry) => entry.definition.id === definitionId);
}

/** Entries a library may show: leaves only, and only those a shipping catalog renderer can draw. */
export function libraryEntries(): readonly WidgetCatalogEntry[] {
  return CATALOG_ENTRIES.filter(
    (entry) => !isContainerDefinition(entry.definition.id) && entry.definition.renderer === "catalog",
  );
}

export function catalogFamilies(): readonly string[] {
  return [...new Set(libraryEntries().map((entry) => entry.family))].sort();
}
