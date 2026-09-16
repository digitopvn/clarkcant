import { type ReactElement } from "react";

import { describe, expect, it } from "vitest";

import { DevicePairingPanel } from "../src/DevicePairingPanel.tsx";
import { MenuBarPopover } from "../src/DesktopSurfaces.tsx";
import { VoiceSurface } from "../src/VoiceSurface.tsx";
import { findAll, textOf } from "./block-helpers.ts";

/**
 * The two gated surfaces and the menu bar popover.
 *
 * These are called as plain functions, because they hold no state — the renderers that do hold
 * state (`Modal`, `DesktopNotification`) cannot be called this way at all: a hook outside a React
 * renderer throws. That is a real limitation of this package's test setup, not something to work
 * around by asserting less: this package has no DOM renderer, so the parts of those two components
 * that depend on hooks and focus are verified in the browser instead. See
 * `plans/reports/evidence/app-11-settings.png` and the browser check in the session report.
 */

describe("a surface behind an external gate", () => {
  it("states the gate and what would open it, rather than offering a dead control", () => {
    const element = VoiceSurface({
      requires: "provider account with realtime access",
      unblockedBy: "đăng ký provider và đặt khoá",
    });
    const text = textOf(element);
    expect(text).toContain("provider account with realtime access");
    expect(text).toContain("đăng ký provider và đặt khoá");
    // No microphone button: it would be a control that cannot work.
    expect(findAll(element, "data-voice-blocked")).toHaveLength(1);
    expect((element as ReactElement<Record<string, unknown>>).props["data-state"]).toBe("blocked");
  });

  it("says why pairing is not possible instead of showing a code nobody can accept", () => {
    const element = DevicePairingPanel({
      nodeId: "node_a",
      nodeLabel: "dev",
      unblockedBy: "chạy node thứ hai rồi ghép",
    });
    const text = textOf(element);
    expect(text).toContain("hai máy chạy node độc lập");
    expect(text).toContain("chạy node thứ hai rồi ghép");
    expect((element as ReactElement<Record<string, unknown>>).props["data-paired-count"]).toBe(0);
  });

  it("lists already-paired nodes when there are any, instead of claiming it cannot pair", () => {
    const element = DevicePairingPanel({
      nodeId: "node_a",
      nodeLabel: "dev",
      unblockedBy: "—",
      pairedNodes: [{ nodeId: "node_b", label: "laptop", lastSeenAt: "2026-09-16T10:00:00.000Z" }],
    });
    expect((element as ReactElement<Record<string, unknown>>).props["data-paired-count"]).toBe(1);
    expect(findAll(element, "data-paired-node")[0]!.props["data-paired-node"]).toBe("node_b");
    expect(findAll(element, "data-pairing-blocked")).toHaveLength(0);
  });
});

describe("the desktop pieces", () => {
  it("uses the same connection wording as the app window", () => {
    // Two surfaces describing one node differently is how a user learns to trust neither.
    for (const [connection, expected] of [
      ["ready", "Ready"],
      ["connecting", "Đang kết nối"],
      ["offline", "Mất kết nối"],
    ] as const) {
      const element = MenuBarPopover({
        nodeLabel: "dev",
        connection,
        activeTaskCount: 0,
        onOpenApp: () => {},
      });
      expect(textOf(element), connection).toContain(expected);
      expect((element as ReactElement<Record<string, unknown>>).props["data-connection"]).toBe(connection);
    }
  });

  it("counts running tasks rather than showing a generic badge", () => {
    const none = MenuBarPopover({ nodeLabel: "dev", connection: "ready", activeTaskCount: 0, onOpenApp: () => {} });
    expect(textOf(none)).toContain("Không có việc nào đang chạy");

    const some = MenuBarPopover({ nodeLabel: "dev", connection: "ready", activeTaskCount: 3, onOpenApp: () => {} });
    expect(findAll(some, "data-menu-task-count")[0]!.props["data-menu-task-count"]).toBe(3);
  });
});
