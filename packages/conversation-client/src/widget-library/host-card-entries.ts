import { normaliseQuery } from "@clarkcant/widget-catalog";

import type { MessageKey } from "../i18n/messages.ts";

/**
 * Host-owned cards the Widget Library describes without previewing.
 *
 * These are not catalog entries and deliberately cannot become one: a catalog entry is drawn from a fixture by a
 * trusted renderer, while a host card is bound to live host state (a real shell, a credential prompt) that a
 * fixture has no way to produce. Showing one through the preview path would either fake that state or open a real
 * effect from Settings, and conversation is where these cards are created. So the library lists them as
 * description plus a static illustration that says it is an illustration, and tells the person how to ask for one.
 */
export interface HostCardEntry {
  /** The block type the host renders, which is also this entry's identity in the DOM. */
  id: string;
  nameKey: MessageKey;
  descriptionKey: MessageKey;
  /** What to say to Clark to get one; conversation is the only way these open. */
  openHintKey: MessageKey;
  /** Extra search words beyond the name and description, in both languages and without accents. */
  aliases: readonly string[];
}

export const HOST_CARD_ENTRIES: readonly HostCardEntry[] = [
  {
    id: "terminal-session-card",
    nameKey: "widgets.hostCards.terminal.name",
    descriptionKey: "widgets.hostCards.terminal.description",
    openHintKey: "widgets.hostCards.terminal.openHint",
    aliases: ["terminal", "shell", "console", "pty", "bash", "zsh", "tui", "lenh", "dong lenh", "tien trinh", "process", "pi"],
  },
];

/**
 * The host cards the browse view shows for the current filter.
 *
 * A host card has no family, so a family facet other than "all" hides them rather than pretending they belong to
 * it. The query matches the translated name and description as well as the aliases, accent-insensitively, the
 * same way catalog search does.
 */
export function visibleHostCards(
  entries: readonly HostCardEntry[],
  filter: { family: string; query: string },
  t: (key: MessageKey) => string,
): readonly HostCardEntry[] {
  if (filter.family !== "all") return [];
  const query = normaliseQuery(filter.query);
  if (query === "") return entries;
  return entries.filter((entry) =>
    [t(entry.nameKey), t(entry.descriptionKey), entry.id, ...entry.aliases].some((text) =>
      normaliseQuery(text).includes(query),
    ),
  );
}
