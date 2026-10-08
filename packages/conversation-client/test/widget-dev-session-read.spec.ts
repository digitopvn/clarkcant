import { describe, expect, it } from "vitest";

import { GatewayClient } from "../src/api.ts";
import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { developOutcomeMessage } from "../src/use-block-actions.ts";

/**
 * A desktop app older than the node it talks to (on another machine, updated separately) still reads a widget dev session
 * view that gained a field, and says the node sent more than it shows rather than losing the session or hiding the drop.
 */

const en = (key: MessageKey): string => CATALOGS.en[key];
const vi = (key: MessageKey): string => CATALOGS.vi[key];
const AT = "2026-10-08T10:00:00.000Z";
const view = {
  sessionId: "wdev_1",
  status: "live",
  root: "/home/me/timer",
  startedAt: AT,
  activation: { state: "none" },
  showingLastKnownGood: false,
};

function nodeAnswering(body: unknown): GatewayClient {
  const fetchImpl = (async () => Response.json(body)) as typeof fetch;
  return new GatewayClient({ baseUrl: "http://127.0.0.1:8765", token: "tok", fetchImpl });
}

describe("a widget dev session view from a newer node", () => {
  it("is read without the field this app does not know, and the drop is reported", async () => {
    const read = await nodeAnswering({ ...view, fooCode: "FOO_NEW" }).widgetDevSession("wdev_1");
    expect(read).toEqual({ ...view, unreadFields: { count: 1, names: ["fooCode"] } });
    const started = await nodeAnswering({ ...view, fooCode: "FOO_NEW" }).startWidgetDevSession({ root: view.root });
    expect(started.unreadFields?.count).toBe(1);
  });

  it("reports nothing when the node sent only what this app knows", async () => {
    const read = await nodeAnswering(view).widgetDevSession("wdev_1");
    expect(read).toEqual(view);
    expect(read).not.toHaveProperty("unreadFields");
  });

  it("is still refused when the new field is inside the activation state", async () => {
    await expect(nodeAnswering({ ...view, activation: { state: "none", grantedBy: "x" } }).widgetDevSession("wdev_1")).rejects.toThrow();
  });

  it("is said to be incomplete on the develop card", async () => {
    const read = await nodeAnswering({ ...view, fooCode: "FOO_NEW" }).widgetDevSession("wdev_1");
    expect(developOutcomeMessage(read, en)).toBe(`Watching /home/me/timer. ${en("shell.dev.nodeNewer")}`);
    expect(developOutcomeMessage(read, vi)).toContain("Hãy cập nhật ứng dụng");
    const complete = await nodeAnswering(view).widgetDevSession("wdev_1");
    expect(developOutcomeMessage(complete, en)).toBe("Watching /home/me/timer.");
  });
});
