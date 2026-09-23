import type { WidgetCatalogEntry } from "./registry.ts";

/**
 * Catalog search.
 *
 * Accents are stripped rather than listed twice, because speech transcription and hurried typing are
 * both inconsistent about tone marks: a person looking for the calendar may type `lịch` or `lich`,
 * and a search that only matched one of them would look broken half the time. Vietnamese `đ` is not
 * decomposed by Unicode normalisation, so it is folded explicitly.
 */

export function normaliseQuery(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreEntry(entry: WidgetCatalogEntry, query: string): number {
  const id = normaliseQuery(entry.definition.id);
  const name = normaliseQuery(entry.displayName);
  const family = normaliseQuery(entry.family);
  const description = normaliseQuery(entry.description);
  const tags = entry.tags.map(normaliseQuery);
  const aliases = entry.aliases.map(normaliseQuery);

  let score = 0;

  if (id === query) score += 100;
  else if (id.includes(query)) score += 60;

  if (aliases.some((alias) => alias === query)) score += 80;
  else if (aliases.some((alias) => alias.includes(query))) score += 45;

  if (name === query) score += 70;
  else if (name.includes(query)) score += 40;

  if (family === query) score += 35;
  else if (family.includes(query)) score += 20;

  if (tags.some((tag) => tag === query)) score += 30;
  else if (tags.some((tag) => tag.includes(query))) score += 15;

  if (description.includes(query)) score += 10;

  return score;
}

/**
 * Entries matching a query, best first.
 *
 * An empty query is not a filter: it returns everything, because a library that showed nothing until
 * something was typed would read as broken.
 */
export function searchCatalog(
  entries: readonly WidgetCatalogEntry[],
  query: string,
): readonly WidgetCatalogEntry[] {
  const normalised = normaliseQuery(query);
  if (normalised === "") return entries;

  const scored: { entry: WidgetCatalogEntry; score: number }[] = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, normalised);
    if (score > 0) scored.push({ entry, score });
  }

  return scored.sort((a, b) => b.score - a.score).map((hit) => hit.entry);
}
