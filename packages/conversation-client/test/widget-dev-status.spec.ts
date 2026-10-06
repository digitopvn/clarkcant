import { describe, expect, it } from "vitest";

import type { WidgetDevGeneration, WidgetDevSessionView } from "@clarkcant/contracts";

import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { widgetDevStatusLine } from "../src/widget-dev-status.tsx";

/**
 * What the host says beside a widget dev session's frame. "Last successful build" is said exactly when the node says the
 * conversation shows older code than the folder holds, with the reason it does.
 */

const en = (key: MessageKey): string => CATALOGS.en[key];
const vi = (key: MessageKey): string => CATALOGS.vi[key];
const AT = "2026-10-06T10:00:00.000Z";

function generation(number: number, verdict: WidgetDevGeneration["delta"]["verdict"] = "unchanged"): WidgetDevGeneration {
  const empty = { added: [], removed: [] };
  return {
    generation: number,
    packageId: "com.example.timer",
    version: "0.1.0",
    digest: `sha256:${String(number).padStart(64, "0")}`,
    builtAt: AT,
    trigger: "change",
    widgetIds: ["com.example.timer.main@1"],
    delta: { verdict, capabilities: empty, frameOrigins: empty, permissions: empty, facets: empty },
    warnings: [],
  };
}

function view(overrides: Partial<WidgetDevSessionView>): WidgetDevSessionView {
  return {
    sessionId: "wdev_1",
    status: "live",
    root: "/home/me/timer",
    startedAt: AT,
    activation: { state: "active", generation: 2, generationId: "gen_2" },
    showingLastKnownGood: false,
    latest: generation(2),
    running: generation(2),
    lastBuild: { ok: true, at: AT, trigger: "change", generation: 2, diagnostics: [] },
    ...overrides,
  };
}

describe("the widget dev status line", () => {
  it("names the running build when it is the newest", () => {
    expect(widgetDevStatusLine(view({}), en)).toEqual({ text: "Developing · build 2", notice: false });
    expect(widgetDevStatusLine(view({}), vi).text).toBe("Đang phát triển · bản dựng 2");
  });

  it("says the last successful build is shown when the newest build failed", () => {
    const failed = view({
      showingLastKnownGood: true,
      lastBuild: { ok: false, at: AT, trigger: "change", diagnostics: [{ severity: "error", path: "clarkcant.json", message: "not JSON" }] },
    });
    expect(widgetDevStatusLine(failed, en)).toEqual({ text: "The new build failed — showing the last successful build (2).", notice: true });
    expect(widgetDevStatusLine(failed, vi).text).toContain("đang hiện bản dựng thành công gần nhất (2)");
  });

  it("says which build waits for the person and which one is shown meanwhile", () => {
    const waiting = view({ latest: generation(3, "wider"), activation: { state: "awaiting-approval", generation: 3, approvalId: "appr_1" }, showingLastKnownGood: true });
    expect(widgetDevStatusLine(waiting, en)).toEqual({ text: "Build 3 is waiting for your approval in the inbox — showing build 2.", notice: true });
  });

  it("gives the node's reason for a refused build", () => {
    const refused = view({
      latest: generation(3),
      activation: { state: "refused", generation: 3, code: "APPROVAL_DENIED", message: "you declined to run this build." },
      showingLastKnownGood: true,
    });
    expect(widgetDevStatusLine(refused, en).text).toBe("Build 3 was not run: you declined to run this build. Showing build 2.");
  });

  it("says nothing runs yet when the first build failed, and that a stopped session keeps its build running", () => {
    const nothing = view({
      running: undefined,
      latest: undefined,
      activation: { state: "none" },
      lastBuild: { ok: false, at: AT, trigger: "start", diagnostics: [{ severity: "error", message: "no widget facet" }] },
    });
    expect(widgetDevStatusLine(nothing, en)).toEqual({ text: "The build failed — nothing has run yet.", notice: true });
    expect(widgetDevStatusLine(view({ status: "stopped" }), en).text).toBe("No longer watching the folder · build 2 keeps running.");
  });
});
