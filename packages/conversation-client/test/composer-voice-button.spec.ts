import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversationComposerBar, type ConversationComposerBarProps } from "../src/ConversationComposerBar.tsx";
import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";

function composer(locale: "en" | "vi"): string {
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
  };
  const t = (key: MessageKey) => CATALOGS[locale][key];
  return renderToStaticMarkup(
    createElement(LocaleProvider, { value: { locale, setLocale: () => undefined, t }, children: createElement(ConversationComposerBar, props) }),
  );
}

/** The whole `<button>` carrying `data-voice-open`, attributes and contents. */
function voiceButton(html: string): string {
  const match = /<button(?:(?!<button)[\s\S])*?data-voice-open="true"[\s\S]*?<\/button>/u.exec(html);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

/**
 * The Voice Mode button beside the composer is a microphone, drawn as the same line icon the header's settings gear
 * and the inbox bell are, so it reads as "speak" rather than as a stray dot, and a screen reader still hears its name.
 */
describe("the composer's voice button", () => {
  it.each(["en", "vi"] as const)("is a microphone icon named by its label in %s", (locale) => {
    const button = voiceButton(composer(locale));
    const label = CATALOGS[locale]["composer.voice"];

    expect(button).toContain('type="button"');
    expect(button).toContain('class="cc-icon-btn"');
    expect(button).toContain(`aria-label="${label}"`);
    expect(button).toContain(`title="${label}"`);

    const icon = /<svg[^>]*>/u.exec(button)?.[0] ?? "";
    expect(icon).toContain('data-icon="microphone"');
    expect(icon).toContain('class="cc-icon"');
    expect(icon).toContain('aria-hidden="true"');
    expect(icon).toContain('stroke="currentColor"');
    // The same box as the header's line icons, so the row of composer buttons stays even.
    expect(icon).toContain('width="15"');
    expect(icon).toContain('height="15"');
    expect(icon).toContain('viewBox="0 0 24 24"');
    // Nothing but the icon inside: the name comes from the label, not from visible text a reader would hear twice.
    expect(button.replace(/<svg[\s\S]*<\/svg>/u, "").replace(/<[^>]+>/gu, "").trim()).toBe("");
  });

  it("no longer draws the old glyph anywhere in the composer", () => {
    expect(composer("en")).not.toContain("◉");
  });
});
