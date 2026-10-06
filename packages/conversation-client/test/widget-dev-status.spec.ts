import { describe, expect, it } from "vitest";

import type { WidgetDevGeneration, WidgetDevSessionView } from "@clarkcant/contracts";

import { CATALOGS, type MessageKey } from "../src/i18n/messages.ts";
import { widgetDevDiagnosticText, widgetDevRefusalReason, widgetDevStatusLine } from "../src/widget-dev-status.tsx";

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

  it("says a refusal in the person's language, never the node's English inside a translated line", () => {
    for (const code of ["APPROVAL_DENIED", "APPROVAL_EXPIRED", "POLICY_REFUSED", "PACKAGE_LISTED", "PACKAGE_IN_OTHER_SESSION", "PACKAGE_INSTALLED_OTHERWISE"]) {
      const refused = view({ latest: generation(3), activation: { state: "refused", generation: 3, code, message: "English from the node." } });
      expect(widgetDevStatusLine(refused, vi).text, code).not.toContain("English from the node");
      expect(widgetDevStatusLine(refused, en).text, code).not.toContain("English from the node");
    }
    const unknown = view({ latest: generation(3), activation: { state: "refused", generation: 3, code: "SOMETHING_NEW", message: "English from the node." } });
    expect(widgetDevStatusLine(unknown, vi).text).toBe("Bản dựng 3 không được chạy: máy đã từ chối (SOMETHING_NEW). Đang hiện bản dựng 2.");
    expect(widgetDevRefusalReason("PACKAGE_IN_OTHER_SESSION", en)).toBe("another development session uses this package id.");
  });

  it("says why a session stopped watching when the person did not stop it", () => {
    const capacity = view({ status: "stopped", stopReason: "capacity" });
    expect(widgetDevStatusLine(capacity, en)).toEqual({
      text: "No longer watching the folder · build 2 keeps running. This machine already watches as many folders as it can; stop another session, then start this one again.",
      notice: true,
    });
    expect(widgetDevStatusLine(view({ status: "stopped", stopReason: "watch-failed" }), vi).text).toContain("Việc theo dõi thư mục bị lỗi");
    expect(widgetDevStatusLine(view({ status: "stopped", stopReason: "requested" }), en).notice).toBe(false);
    expect(widgetDevStatusLine(view({ status: "stopped", stopReason: "folder-gone", running: undefined, activation: { state: "none" } }), en).text).toBe(
      "No longer watching the folder · no build runs yet. The folder is gone.",
    );
  });

  it("says a problem the host found in the person's language and the package's own words as written", () => {
    expect(widgetDevDiagnosticText({ code: "FACET_LANE_UNSUPPORTED", message: "facet tools:x runs as service" }, vi)).toContain("ngoài khung widget");
    expect(widgetDevDiagnosticText({ code: "FILES_UNREADABLE", message: "EBUSY" }, en)).toBe("The files could not be read for this build; the next save builds again.");
    expect(widgetDevDiagnosticText({ message: "widget.json: not JSON" }, vi)).toBe("widget.json: not JSON");
  });
});
