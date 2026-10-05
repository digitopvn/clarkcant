import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TimelineMessageRow } from "../src/TimelineMessageRow.tsx";
import type { BlockActions } from "../src/blocks.tsx";
import { LocaleProvider } from "../src/i18n/locale-context.tsx";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import type { GatewayClient, TimelineMessage } from "../src/api.ts";

/**
 * A message the host wrote so a turn could run — the continuation after an approved command — is drawn as a quiet line
 * from the host in the reader's language, and never as the person's bubble with words they did not type.
 */

const HOST_SENTENCE = "Lệnh đã được duyệt và đã chạy xong.";

function inLocale(locale: "vi" | "en", element: ReactElement): string {
  const t = (key: MessageKey) => CATALOGS[locale][key];
  return renderToStaticMarkup(createElement(LocaleProvider, { value: { locale, setLocale: () => undefined, t }, children: element }));
}

function row(message: TimelineMessage): ReactElement {
  return createElement(TimelineMessageRow, {
    message,
    index: 0,
    renderSurface: () => createElement("div"),
    blockActions: {} as BlockActions,
    client: {} as GatewayClient,
    settled: true,
  });
}

function userMessage(extra: Partial<TimelineMessage> = {}): TimelineMessage {
  return {
    messageId: "msg_1",
    role: "user",
    blocks: [{ type: "text", format: "markdown", content: HOST_SENTENCE, streaming: false }],
    createdAt: "2026-10-05T02:00:00.000Z",
    ...extra,
  };
}

describe("a host-written continuation", () => {
  it("is a centred host line in either language, not a user bubble", () => {
    const continuation = userMessage({ hostWritten: { kind: "host-continuation", version: 1 } });

    const vi = inLocale("vi", row(continuation));
    expect(vi).toContain('data-host-written="host-continuation"');
    expect(vi).toContain("Đã duyệt — Clark tiếp tục");
    expect(vi).not.toContain('data-bubble="user"');
    expect(vi).not.toContain('data-role="user"');
    // The sentence is for the model; the reader never sees it.
    expect(vi).not.toContain(HOST_SENTENCE);

    const en = inLocale("en", row(continuation));
    expect(en).toContain("Approved — Clark carries on");
    expect(en).not.toContain(HOST_SENTENCE);
  });

  it("still reads as the host for a kind or version this build does not know", () => {
    const html = inLocale("en", row(userMessage({ hostWritten: { kind: "host-something-newer", version: 2 } })));
    expect(html).toContain("Clark carries on");
    expect(html).not.toContain('data-bubble="user"');
    expect(html).not.toContain(HOST_SENTENCE);
  });

  it("leaves the person's own message as their bubble", () => {
    const html = inLocale("vi", row(userMessage()));
    expect(html).toContain('data-bubble="user"');
    expect(html).not.toContain("data-host-written");
  });
});
