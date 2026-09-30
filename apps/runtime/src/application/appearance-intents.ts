import {
  BUILTIN_CLARK_THEME_REF,
  describeAppIntent,
  parseThemeRef,
  type AppIntent,
  type AppIntentLocale,
} from "@clarkcant/contracts";
import type { ThemeTarget } from "@clarkcant/core";

import { resolveThemeRef, type ThemeRegistry } from "./themes.ts";

/**
 * The node's half of the appearance intents: which themes a sentence may name, and whether a theme a sentence, a click
 * or the agent named can be drawn here.
 *
 * Both answers come from the one theme registry, the same one `GET /themes` lists and `PUT /preferences` checks a
 * choice against, so a command can neither offer a theme the picker does not show nor choose one the preference write
 * would refuse.
 */

/** Clark Default by the name a person says, beside its display name. */
const CLARK_NAME = "Clark Default";

/**
 * Every theme this node can draw, by display name and by id.
 *
 * The id is offered with its separators read as spaces, so "neo-brutalism" is found in "đổi giao diện sang neo
 * brutalism". Only listed themes are offered: one the audits refuse is not in `registry.themes`, so no sentence can
 * reach it.
 */
export function themeTargets(registry: ThemeRegistry): ThemeTarget[] {
  const targets: ThemeTarget[] = [{ phrase: "clark", themeRef: BUILTIN_CLARK_THEME_REF, name: CLARK_NAME }];
  for (const theme of registry.themes) {
    targets.push({ phrase: theme.displayName, themeRef: theme.themeRef, name: theme.displayName });
    const parts = parseThemeRef(theme.themeRef);
    const id = parts === undefined ? undefined : parts.kind === "package" ? parts.facetId : parts.name;
    if (id !== undefined) targets.push({ phrase: id.replace(/[-_.]+/g, " "), themeRef: theme.themeRef, name: theme.displayName });
  }
  return targets;
}

/** The themes a refusal lists, so whoever asked can ask again with a name that works. */
function availableNames(registry: ThemeRegistry): string {
  return registry.themes.map((theme) => theme.displayName).join(", ");
}

export type CheckedThemeChoice = { ok: true; intent: AppIntent; readBack: string } | { ok: false; say: string };

/**
 * An `appearance.set-theme` checked against what this node can draw, with the theme's display name filled in.
 *
 * `asked` is a theme reference, or a theme's name or id, as the agent may know a theme only by what the picker shows.
 * A theme the registry would not draw is refused with the list that would work: choosing it would store a preference
 * the page then ignores, which is a change that changes nothing.
 */
export function checkThemeChoice(
  registry: ThemeRegistry | undefined,
  asked: string,
  locale: AppIntentLocale,
): CheckedThemeChoice {
  const en = locale === "en";
  if (registry === undefined) {
    return {
      ok: false,
      say: en
        ? "This node cannot read its list of themes, so I have not changed the appearance."
        : "Máy này chưa đọc được danh sách chủ đề, nên tôi chưa đổi giao diện.",
    };
  }
  const spoken = asked.trim().toLowerCase().replace(/[-_.]+/g, " ");
  const byName = themeTargets(registry).find((target) => target.themeRef === asked || target.phrase.toLowerCase() === spoken);
  const themeRef = byName?.themeRef ?? asked;
  const resolved = parseThemeRef(themeRef) === undefined ? undefined : resolveThemeRef(registry, themeRef);
  if (resolved === undefined || !resolved.ok) {
    // Bounded, because the agent's argument is unchecked text and the sentence is shown and read aloud.
    const shown = asked.trim().slice(0, 80);
    return {
      ok: false,
      say: en
        ? `The theme “${shown}” cannot be drawn on this node, so I have not changed the appearance. Themes available: ${availableNames(registry)}.`
        : `Chủ đề “${shown}” chưa dùng được trên máy này, nên tôi chưa đổi giao diện. Các chủ đề đang có: ${availableNames(registry)}.`,
    };
  }
  const name = registry.themes.find((theme) => theme.themeRef === themeRef)?.displayName ?? CLARK_NAME;
  const checked: AppIntent = { kind: "appearance.set-theme", themeRef, themeName: name };
  return { ok: true, intent: checked, readBack: describeAppIntent(checked, locale) };
}
