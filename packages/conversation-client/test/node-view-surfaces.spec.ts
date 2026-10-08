import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayClient } from "../src/api.ts";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { type InboxNoticeActions, useInboxNoticeActions } from "../src/inbox/use-inbox-notice-actions.ts";
import { widgetDevUnreachableText } from "../src/widget-dev-status.tsx";

/**
 * What the surfaces say when the node answered with something this app cannot read: the dev session's status line, and
 * the sentence a notice action resolves to. Neither claims the action happened: a value newer than the app may mean it
 * waits on something (an update waiting for an approval), so the words say the node answered and what to do next.
 */

const en = (key: MessageKey): string => CATALOGS.en[key];
const vi_ = (key: MessageKey): string => CATALOGS.vi[key];

function nodeAnswering(body: unknown, nodeVersion = "0.3.0"): GatewayClient {
  const fetchImpl = (async (input: string | URL | Request) =>
    new URL(String(input)).pathname === "/node" ? Response.json({ clarkVersion: nodeVersion }) : Response.json(body)) as typeof fetch;
  return new GatewayClient({ baseUrl: "http://127.0.0.1:8765", token: "tok", fetchImpl, appVersion: "0.2.1" });
}

/** The hook's actions, taken from one render; its callbacks only close over what they were given. */
function noticeActions(client: GatewayClient, t: (key: MessageKey) => string): InboxNoticeActions {
  let actions: InboxNoticeActions | undefined;
  function Probe() {
    actions = useInboxNoticeActions({
      client,
      busy: false,
      inboxOpen: true,
      closeInbox: () => undefined,
      send: async () => undefined,
      insertReference: () => "added",
      composerInput: { current: null },
      t,
      refreshTimeline: () => undefined,
      onInboxChanged: () => undefined,
      refreshInboxPanel: () => undefined,
      locale: "en",
    });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (actions === undefined) throw new Error("the probe did not render");
  return actions;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a notice action whose answer this app cannot read", () => {
  it("says the node answered, not that it carried the action out", async () => {
    const said = await noticeActions(nodeAnswering({ noticeId: "ntc_1", action: "dismiss", outcome: "deferred" }), en).actOnNotice("ntc_1", "dismiss", "chat");
    expect(said).toBe(
      "The node answered, but this app can't read what it did. The node runs Clark 0.3.0, which is newer than this app (Clark 0.2.1). Update the app to read it.",
    );
    expect(said).not.toMatch(/carried|done|dismissed/i);
  });

  it("points an update at the inbox, where an install that waits for approval shows", async () => {
    const said = await noticeActions(nodeAnswering({ noticeId: "ntc_1", action: "update", outcome: "queued" }), vi_).actOnNotice("ntc_1", "update", "voice");
    expect(said).toMatch(/^Node đã trả lời, nhưng ứng dụng này không đọc được node đã làm gì\. /);
    expect(said).toMatch(/Hãy xem hộp thư để biết bản cập nhật đã được cài hay đang chờ bạn phê duyệt\.$/);
  });

  it("still reports what the node did when it reads", async () => {
    const said = await noticeActions(nodeAnswering({ noticeId: "ntc_1", action: "dismiss", outcome: "done" }), en).actOnNotice("ntc_1", "dismiss", "chat");
    expect(said).toBe(en("inbox.dismissed"));
  });
});

describe("the widget dev status line when the status cannot be read", () => {
  it("names which Clark each side runs for a view this app does not read", async () => {
    const cause = await nodeAnswering({ sessionId: "wdev_1", status: "hibernating" })
      .widgetDevSession("wdev_1")
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(widgetDevUnreachableText(cause, en)).toBe(
      "This app can't read the development session's state; the widget keeps running what it shows. The node runs Clark 0.3.0, which is newer than this app (Clark 0.2.1). Update the app to read it.",
    );
  });

  it("says the node is not answering for any other failure", () => {
    expect(widgetDevUnreachableText(new Error("offline"), en)).toBe(en("shell.dev.unreachable"));
  });
});
