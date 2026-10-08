import { describe, expect, it } from "vitest";

import type { Instant, WidgetDevSessionView } from "@clarkcant/contracts";

import { developFolderCard } from "../src/application/widget-dev-card.ts";
import { describeDevSession } from "../src/develop-widget-tool.ts";

/**
 * A session the node stopped at a restart because its folder failed the start check is listed on the `develop` card, and
 * described to Clark, with what helps, which depends on the check that refused it: choosing the folder again, or copying
 * the project elsewhere.
 */

const AT = "2026-10-08T10:00:00.000Z" as Instant;

function refusedSession(stopCode: string | undefined): WidgetDevSessionView {
  return {
    sessionId: "wdev_1",
    status: "stopped",
    stopReason: "root-refused",
    ...(stopCode === undefined ? {} : { stopCode }),
    root: "/home/me/timer",
    startedAt: AT,
    activation: { state: "none" },
    showingLastKnownGood: false,
  };
}

function refusedRow(stopCode: string | undefined, locale: "en" | "vi") {
  const card = developFolderCard({ cardId: "card_1", at: AT, locale, chosen: [], sessions: [refusedSession(stopCode)] });
  const row = card.rows.find((candidate) => candidate.rowId === "session:wdev_1");
  expect(row).toBeDefined();
  return { note: row?.note ?? "", actions: row?.actions ?? [] };
}

describe("the develop card's row for a session refused at a restart", () => {
  it("offers to choose the folder again when Clark is no longer allowed to watch it on its own", () => {
    const en = refusedRow("ROOT_NOT_OWNED", "en");
    expect(en.note).toContain("Clark is no longer allowed to watch this folder on its own");
    expect(en.note).toContain("what it built keeps running");
    expect(en.note).toContain("Press Develop again to choose the folder again");
    expect(en.note).not.toContain("may no longer");
    expect(en.actions).toMatchObject([{ action: { kind: "develop-folder", root: "/home/me/timer" } }]);
    expect(refusedRow("ROOT_NOT_OWNED", "vi").note).toContain("Bấm Phát triển lại để chọn lại thư mục");
  });

  it("says to copy the project, with no button, when the folder now leads to a network share or into the data folder", () => {
    for (const [code, where, whereVi] of [
      ["ROOT_NOT_LOCAL", "network share or device path", "thư mục chia sẻ qua mạng"],
      ["ROOT_IN_DATA_FOLDER", "Clark's data folder", "thư mục dữ liệu của Clark"],
    ] as const) {
      const en = refusedRow(code, "en");
      expect(en.note, code).toContain(where);
      expect(en.note, code).toContain("choosing it again is refused too");
      expect(en.note, code).toContain("what it built keeps running");
      expect(en.note, code).toContain("Copy the project into Clark's widget workspace");
      expect(en.note, code).not.toContain("Press Develop again");
      // Choosing it again would only be refused, so nothing is offered to press.
      expect(en.actions, code).toEqual([]);
      const vi = refusedRow(code, "vi");
      expect(vi.note, code).toContain(whereVi);
      expect(vi.note, code).toContain("chọn lại nó cũng bị từ chối");
      expect(vi.actions, code).toEqual([]);
    }
  });

  it("says what holds for every case when the stop names no code it knows", () => {
    for (const code of [undefined, "ROOT_SOMETHING_NEW"]) {
      const en = refusedRow(code, "en");
      expect(en.note).toContain("failed the check a start makes");
      expect(en.note).toContain("if that is refused, copy the project into Clark's widget workspace");
      expect(en.actions).toMatchObject([{ action: { kind: "develop-folder" } }]);
      expect(refusedRow(code, "vi").note).toContain("không qua được bước kiểm");
    }
  });
});

describe("what Clark is told about a session refused at a restart", () => {
  it("asks the person to choose the folder again only when that helps", () => {
    expect(describeDevSession(refusedSession("ROOT_NOT_OWNED"))).toContain("ask the person to choose its folder themselves");
    for (const code of ["ROOT_NOT_LOCAL", "ROOT_IN_DATA_FOLDER"]) {
      const said = describeDevSession(refusedSession(code));
      expect(said, code).toContain("choosing it again is refused too");
      expect(said, code).toContain("copy the project into the widget workspace");
      expect(said, code).not.toContain("choose its folder themselves");
    }
    expect(describeDevSession(refusedSession("ROOT_NOT_LOCAL"))).toContain("network share");
    expect(describeDevSession(refusedSession("ROOT_IN_DATA_FOLDER"))).toContain("data folder");
  });
});