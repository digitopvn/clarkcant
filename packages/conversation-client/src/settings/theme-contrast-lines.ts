import type { ColorTokenName, ThemeContrastFailureView, ThemeProtectedFailureView } from "@clarkcant/contracts";

import type { LocaleChoice } from "../i18n/locale.ts";
import type { MessageKey } from "../i18n/messages.ts";

/**
 * A theme's failing colour pairs, worded in the reader's language.
 *
 * The node and the page's own audit both say which pairs fail as data — scheme, the two tokens, the ratio and the ratio
 * needed — and this is where that data becomes a sentence. The English `message` beside it is for logs; a person reads
 * one line per pair, in their own words and number format.
 */

const TOKEN_KEYS: Readonly<Record<ColorTokenName, MessageKey>> = {
  canvas: "settings.experience.themePicker.contrast.token.canvas",
  window: "settings.experience.themePicker.contrast.token.window",
  card: "settings.experience.themePicker.contrast.token.card",
  elevated: "settings.experience.themePicker.contrast.token.elevated",
  code: "settings.experience.themePicker.contrast.token.code",
  border: "settings.experience.themePicker.contrast.token.border",
  text: "settings.experience.themePicker.contrast.token.text",
  textMuted: "settings.experience.themePicker.contrast.token.textMuted",
  textTertiary: "settings.experience.themePicker.contrast.token.textTertiary",
  accent: "settings.experience.themePicker.contrast.token.accent",
  onAccent: "settings.experience.themePicker.contrast.token.onAccent",
  success: "settings.experience.themePicker.contrast.token.success",
  warning: "settings.experience.themePicker.contrast.token.warning",
  danger: "settings.experience.themePicker.contrast.token.danger",
  focus: "settings.experience.themePicker.contrast.token.focus",
};

/** The accent is text in front of a surface, but a button behind its label: the same token, named for its role. */
function backgroundKey(token: ColorTokenName): MessageKey {
  return token === "accent" ? "settings.experience.themePicker.contrast.accentButton" : TOKEN_KEYS[token];
}

/** One line per failing pair, e.g. "Chữ nhấn trên nền trang (tối): 2,00:1, cần 4,5:1". */
export function contrastLines(
  failures: readonly ThemeContrastFailureView[],
  t: (key: MessageKey) => string,
  locale: LocaleChoice,
): string[] {
  const tag = locale === "vi" ? "vi-VN" : "en-US";
  // Two decimals for the measured ratio, as it was rounded; the threshold as it is written in WCAG (4.5, 3).
  const ratio = new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const minimum = new Intl.NumberFormat(tag, { maximumFractionDigits: 2 });
  return failures.map((failure) => {
    const line = t("settings.experience.themePicker.contrast.line")
      .replace("{foreground}", t(TOKEN_KEYS[failure.foreground]))
      .replace("{background}", t(backgroundKey(failure.background)))
      .replace("{scheme}", t(`settings.experience.themePicker.contrast.scheme.${failure.scheme}`))
      .replace("{ratio}", ratio.format(failure.ratio))
      .replace("{minimum}", minimum.format(failure.minimum));
    return line.charAt(0).toLocaleUpperCase(tag) + line.slice(1);
  });
}

/**
 * One line per protected check a theme fails, e.g. "Viền tiêu điểm lẫn vào đường kẻ: viền tiêu điểm và đường kẻ (tối)
 * cách nhau 9,10, cần ít nhất 15". A distance is a perceptual one; readability over a surface effect is a contrast ratio
 * and is worded as one.
 */
export function protectedLines(
  failures: readonly ThemeProtectedFailureView[],
  t: (key: MessageKey) => string,
  locale: LocaleChoice,
): string[] {
  const tag = locale === "vi" ? "vi-VN" : "en-US";
  const measured = new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const minimum = new Intl.NumberFormat(tag, { maximumFractionDigits: 2 });
  return failures.map((failure) =>
    t(failure.check === "surface-readable" ? "settings.experience.themePicker.protected.lineRatio" : "settings.experience.themePicker.protected.line")
      .replace("{check}", t(`settings.experience.themePicker.protected.check.${failure.check}`))
      .replace("{first}", t(TOKEN_KEYS[failure.first]))
      .replace("{second}", t(failure.check === "surface-readable" ? backgroundKey(failure.second) : TOKEN_KEYS[failure.second]))
      .replace("{scheme}", t(`settings.experience.themePicker.contrast.scheme.${failure.scheme}`))
      .replace("{value}", measured.format(failure.value))
      .replace("{minimum}", minimum.format(failure.minimum)),
  );
}
