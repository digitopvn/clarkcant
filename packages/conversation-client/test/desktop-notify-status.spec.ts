import { describe, expect, it } from "vitest";

import {
  classifyDesktopNotifyResult,
  desktopNotifyStatus,
  desktopNotifyStatusMessageKey,
  recordDesktopNotifyStatus,
  subscribeDesktopNotifyStatus,
} from "../src/inbox/desktop-notify-status.ts";

describe("desktop notify status", () => {
  it("reads each answer the main process gives", () => {
    expect(classifyDesktopNotifyResult({ ok: true, shown: { title: "x", body: "" } })).toEqual({ kind: "delivered" });
    expect(classifyDesktopNotifyResult({ ok: false, reason: "unsupported", refused: "…" })).toEqual({ kind: "unsupported" });
    expect(classifyDesktopNotifyResult({ ok: false, reason: "no-window", refused: "…" })).toEqual({ kind: "no-window" });
    // A shell older than the reason code, or an unknown reason, is still a failure rather than silence.
    expect(classifyDesktopNotifyResult({ ok: false, refused: "…" })).toEqual({ kind: "failed" });
    expect(classifyDesktopNotifyResult(undefined)).toEqual({ kind: "failed" });
  });

  it("reports nothing while delivery works and a reason once it stops", () => {
    expect(desktopNotifyStatusMessageKey({ kind: "none" })).toBeUndefined();
    expect(desktopNotifyStatusMessageKey({ kind: "delivered" })).toBeUndefined();
    expect(desktopNotifyStatusMessageKey({ kind: "unsupported" })).toBe("settings.control.notifications.os.status.unsupported");
    expect(desktopNotifyStatusMessageKey({ kind: "no-window" })).toBe("settings.control.notifications.os.status.noWindow");
    expect(desktopNotifyStatusMessageKey({ kind: "failed" })).toBe("settings.control.notifications.os.status.failed");
  });

  it("tells subscribers only when the outcome changes, and clears once a delivery succeeds", () => {
    let calls = 0;
    const off = subscribeDesktopNotifyStatus(() => (calls += 1));
    recordDesktopNotifyStatus({ kind: "failed" });
    recordDesktopNotifyStatus({ kind: "failed" });
    expect(calls).toBe(1);
    expect(desktopNotifyStatus()).toEqual({ kind: "failed" });
    recordDesktopNotifyStatus({ kind: "delivered" });
    expect(calls).toBe(2);
    expect(desktopNotifyStatusMessageKey(desktopNotifyStatus())).toBeUndefined();
    off();
    recordDesktopNotifyStatus({ kind: "failed" });
    expect(calls).toBe(2);
  });
});
