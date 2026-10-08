import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversationComposerBar, type ConversationComposerBarProps } from "../src/ConversationComposerBar.tsx";
import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";

function composer(locale: "en" | "vi", overrides: Partial<ConversationComposerBarProps> = {}): string {
  const props: ConversationComposerBarProps = {
    composerWrap: createRef(),
    composerInput: createRef(),
    attachmentInput: createRef(),
    dragging: false,
    setDragging: () => undefined,
    addFiles: async () => undefined,
    chips: [],
    onRemoveChip: () => undefined,
    draft: "",
    setDraft: () => undefined,
    placeholder: "",
    busy: false,
    onSubmit: () => undefined,
    onStop: () => undefined,
    onOpenVoice: () => undefined,
    modelAlias: undefined,
    modelNote: "",
    error: undefined,
    messages: [],
    ...overrides,
  };
  const t = (key: MessageKey) => CATALOGS[locale][key];
  return renderToStaticMarkup(
    createElement(LocaleProvider, { value: { locale, setLocale: () => undefined, t }, children: createElement(ConversationComposerBar, props) }),
  );
}

/** The whole `<button>` carrying the given data attribute, attributes and contents. */
function button(html: string, attribute: string): string {
  const match = new RegExp(`<button(?:(?!<button)[\\s\\S])*?${attribute}="true"[\\s\\S]*?</button>`, "u").exec(html);
  expect(match, `no button with ${attribute}`).not.toBeNull();
  return match?.[0] ?? "";
}

const BUTTONS = [
  { name: "attach", attribute: "data-attachment-open", key: "composer.attach", icon: "paperclip", busy: false },
  { name: "stop", attribute: "data-stop", key: "composer.stop", icon: "stop", busy: true },
  { name: "send", attribute: "data-send", key: "composer.send", icon: "arrow-up", busy: false },
] as const;

/**
 * Attach, Stop and Send sit in one row with the microphone, so they are drawn as the same line icons rather than the
 * text glyphs `+`, `■` and `↑`, and a screen reader hears each one's name once, from its label.
 */
describe("the composer's attach, stop and send buttons", () => {
  for (const entry of BUTTONS) {
    it.each(["en", "vi"] as const)(`draws ${entry.name} as a line icon named by its label in %s`, (locale) => {
      const html = button(composer(locale, { busy: entry.busy }), entry.attribute);
      const label = CATALOGS[locale][entry.key];

      expect(html).toContain('class="cc-icon-btn"');
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`title="${label}"`);

      const icon = /<svg[^>]*>/u.exec(html)?.[0] ?? "";
      expect(icon).toContain(`data-icon="${entry.icon}"`);
      expect(icon).toContain('class="cc-icon"');
      expect(icon).toContain('aria-hidden="true"');
      expect(icon).toContain('stroke="currentColor"');
      expect(icon).toContain('fill="none"');
      // The microphone's box and stroke, so the row stays even.
      expect(icon).toContain('width="15"');
      expect(icon).toContain('height="15"');
      expect(icon).toContain('viewBox="0 0 24 24"');
      expect(icon).toContain('stroke-width="1.8"');
      // No colour of its own anywhere inside, so the theme and forced colours decide it.
      expect(/<svg[\s\S]*<\/svg>/u.exec(html)?.[0] ?? "").not.toMatch(/(?:fill|stroke)="(?!none"|currentColor")/u);
      // Nothing but the icon inside: the name comes from the label, not from visible text a reader would hear twice.
      expect(html.replace(/<svg[\s\S]*<\/svg>/u, "").replace(/<[^>]+>/gu, "").trim()).toBe("");
    });
  }

  it("keeps each button's role in the form: attach and stop are plain buttons, send submits", () => {
    expect(button(composer("en"), "data-attachment-open")).toContain('type="button"');
    expect(button(composer("en", { busy: true }), "data-stop")).toContain('type="button"');
    expect(button(composer("en"), "data-send")).toContain('type="submit"');
  });

  it("keeps send disabled with nothing to send, and enabled once there is", () => {
    expect(button(composer("en"), "data-send")).toContain("disabled");
    expect(button(composer("en", { draft: "hello" }), "data-send")).not.toContain("disabled");
  });

  it("shows stop in send's place while a reply is being written", () => {
    const busy = composer("en", { busy: true });
    expect(busy).toContain('data-stop="true"');
    expect(busy).not.toContain('data-send="true"');
  });

  it("no longer draws the old glyphs anywhere in the composer", () => {
    for (const html of [composer("en"), composer("en", { busy: true })]) {
      const text = html.replace(/<[^>]+>/gu, "");
      expect(text).not.toContain("■");
      expect(text).not.toContain("↑");
      expect(html).not.toMatch(/data-attachment-open="true"[^>]*>\s*\+/u);
    }
  });
});
