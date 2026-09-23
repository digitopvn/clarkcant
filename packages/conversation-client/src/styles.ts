/**
 * Component stylesheet.
 *
 * One string rather than a CSS file so a host can inject it without a bundler plugin, and
 * so the desktop shell and the web client cannot drift into two different looks. Every
 * colour and duration is a token variable, which means the WCAG audit in
 * `@clarkcant/design-tokens` is auditing the values this sheet actually uses.
 *
 * The rules themselves live in `./styles/*.ts`, one module per feature area, because a single
 * 1600-line string was one file nobody could scan for the rule they needed. Each module wraps
 * its rules in a CSS `@layer` of the same name; the `@layer` statement below declares those
 * layers in the exact order the original single string had them in, so splitting the string
 * changes nothing about which rule wins a cascade tie — the concatenation order below is
 * cosmetic, the layer order is what is authoritative.
 */
import { BASE_CSS } from "./styles/base.ts";
import { TIMELINE_CSS } from "./styles/timeline.ts";
import { CARDS_CSS } from "./styles/cards.ts";
import { COMPOSER_CSS } from "./styles/composer.ts";
import { VOICE_CSS } from "./styles/voice.ts";
import { PANELS_CSS } from "./styles/panels.ts";

export const APP_CSS = `
@layer base, timeline, cards, composer, voice, panels;
${BASE_CSS}${TIMELINE_CSS}${CARDS_CSS}${COMPOSER_CSS}${VOICE_CSS}${PANELS_CSS}
`;
