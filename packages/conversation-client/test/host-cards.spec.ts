import { type ReactElement } from "react";

import { describe, expect, it } from "vitest";

import {
  CodeDiffCardBlock,
  ProjectPickerCardBlock,
  ReconnectCardBlock,
  SystemCardBlock,
  renderBlock,
} from "../src/blocks.tsx";
import { findAll, nonHost, textOf } from "./block-helpers.ts";

/**
 * The diff, project-picker and reconnect cards.
 *
 * Same trust rule as the task cards: a block claiming to be one of these without host ownership
 * draws nothing. The rest is about the three places these cards could quietly overstate — a diff
 * cut for size presented as complete, a project root that has not been approved presented as
 * available, and a connection failure with no indication of how long it has been failing.
 */

const DIFF = {
  type: "code-diff-card",
  owner: "host",
  cardId: "card_d",
  summary: "Sửa cách tính thuế",
  files: [
    {
      path: "src/tax.ts",
      additions: 2,
      deletions: 1,
      hunks: [
        {
          header: "@@ -12,3 +12,4 @@",
          lines: [
            { kind: "context", text: "const rate = 0.1;" },
            { kind: "remove", text: "return amount * rate;" },
            { kind: "add", text: "const base = amount - allowance;" },
            { kind: "add", text: "return Math.max(0, base * rate);" },
          ],
        },
      ],
    },
  ],
  truncated: false,
  updatedAt: "2026-09-16T10:00:00.000Z",
};

const PICKER = {
  type: "project-picker-card",
  owner: "host",
  cardId: "card_p",
  prompt: "Chọn project để tui làm việc trong đó.",
  roots: [
    { rootId: "root_1", label: "clarkcant", path: "/Volumes/GOON/www/digitop/clarkcant", readOnly: false },
    { rootId: "root_2", label: "Tài liệu", path: "/Users/duynguyen/Documents", readOnly: true },
  ],
  allowManualEntry: false,
  updatedAt: "2026-09-16T10:00:00.000Z",
};

const RECONNECT = {
  type: "reconnect-card",
  owner: "host",
  cardId: "card_r",
  nodeId: "node_abc",
  nodeLabel: "dev",
  status: "reconnecting",
  attempt: 3,
  lastSeenAt: "2026-09-16T09:55:00.000Z",
  reason: "connection reset by peer",
};

describe("these cards cannot be forged either", () => {
  it("refuses a block whose owner is not the host", () => {
    expect(CodeDiffCardBlock({ block: nonHost(DIFF) })).toBeNull();
    expect(ProjectPickerCardBlock({ block: nonHost(PICKER) })).toBeNull();
    expect(ReconnectCardBlock({ block: nonHost(RECONNECT) })).toBeNull();
  });

  it("is routed by the dispatcher", () => {
    for (const block of [DIFF, PICKER, RECONNECT]) {
      expect(renderBlock(block, 0, () => null as unknown as ReactElement), block.type).not.toBeNull();
    }
  });
});

describe("a diff", () => {
  it("renders each line with its own kind, so add and remove survive without colour", () => {
    const element = CodeDiffCardBlock({ block: DIFF }) as ReactElement<Record<string, unknown>>;
    const kinds = findAll(element, "data-line-kind").map((line) => line.props["data-line-kind"]);
    expect(kinds).toEqual(["context", "remove", "add", "add"]);
  });

  it("carries the file path and its counts", () => {
    const element = CodeDiffCardBlock({ block: DIFF }) as ReactElement<Record<string, unknown>>;
    expect(findAll(element, "data-diff-path")[0]!.props["data-diff-path"]).toBe("src/tax.ts");
    expect(findAll(element, "data-diff-additions")[0]!.props["data-diff-additions"]).toBe(2);
    expect(findAll(element, "data-diff-deletions")[0]!.props["data-diff-deletions"]).toBe(1);
  });

  it("says so when the diff was cut for size", () => {
    // An unmarked truncation reads as the whole change, which is the overstatement to avoid.
    const cut = CodeDiffCardBlock({
      block: { ...DIFF, truncated: true },
    }) as ReactElement<Record<string, unknown>>;
    expect(cut.props["data-truncated"]).toBe(true);
    expect(findAll(cut, "data-diff-truncated")).toHaveLength(1);
    expect(textOf(cut)).toContain("rút gọn");

    const whole = CodeDiffCardBlock({ block: DIFF }) as ReactElement<Record<string, unknown>>;
    expect(findAll(whole, "data-diff-truncated")).toHaveLength(0);
  });
});

describe("a project picker", () => {
  it("lists only the roots and marks which are read-only", () => {
    const element = ProjectPickerCardBlock({ block: PICKER }) as ReactElement<Record<string, unknown>>;
    const roots = findAll(element, "data-root-id");
    expect(roots.map((root) => root.props["data-root-id"])).toEqual(["root_1", "root_2"]);
    expect(roots[1]!.props["data-read-only"]).toBe(true);
    expect(textOf(element)).toContain("chỉ đọc");
  });

  it("says plainly when the node has approved no root", () => {
    const element = ProjectPickerCardBlock({ block: { ...PICKER, roots: [] } });
    expect(textOf(element)).toContain("chưa được cấp project root nào");
  });

  it("does not offer to widen the workspace from the card", () => {
    // A picker that took an arbitrary path would be a way to add a root without an approval.
    const element = ProjectPickerCardBlock({ block: PICKER });
    expect(findAll(element, "input")).toHaveLength(0);
  });
});

describe("a reconnect card", () => {
  it("answers since when, and whether it is still trying", () => {
    const element = ReconnectCardBlock({ block: RECONNECT }) as ReactElement<Record<string, unknown>>;
    const attempts = findAll(element, "data-reconnect-attempts");
    expect(attempts[0]!.props["data-reconnect-attempts"]).toBe(3);
    expect(textOf(element)).toContain("2026-09-16T09:55:00.000Z");
    expect(textOf(element)).toContain("reconnecting");
  });

  it("shows the reason when there is one", () => {
    const element = ReconnectCardBlock({ block: RECONNECT });
    expect(textOf(element)).toContain("connection reset by peer");
  });

  it("marks a failed attempt differently from one still trying", () => {
    const failed = ReconnectCardBlock({
      block: { ...RECONNECT, status: "failed", attempt: 9 },
    }) as ReactElement<Record<string, unknown>>;
    expect(failed.props["data-status"]).toBe("failed");
  });
});

/**
 * A card's actions.
 *
 * The rule this checks is the one the codebase applies everywhere: a control that cannot work is
 * disabled *and* says why. A disabled button alone reads as a bug, and an enabled one that does
 * nothing is worse, because the user concludes the feature is broken rather than unconfigured.
 */
describe("a card's actions", () => {
  const diff = (): Record<string, unknown> => ({
    type: "code-diff-card",
    owner: "host",
    summary: "Đổi theme",
    files: [
      { path: "src/a.ts", additions: 2, deletions: 1, hunks: [{ header: "@@ -1 +1 @@", lines: [{ kind: "add", text: "+x" }] }] },
      { path: "src/b.ts", additions: 0, deletions: 0, hunks: [] },
    ],
    truncated: false,
  });

  it("renders every file rather than paginating behind a control", () => {
    const element = CodeDiffCardBlock({ block: diff() });
    // Both files are on screen. A "next file" button would step through content that is already
    // visible, which is a control with nothing to control.
    expect(findAll(element, "data-diff-path")).toHaveLength(2);
    expect(findAll(element, "data-action='next-file'")).toHaveLength(0);
  });

  it("disables the action it cannot perform and states the reason next to it", () => {
    const element = CodeDiffCardBlock({ block: diff() });
    const actions = findAll(element, "data-card-actions");
    expect(actions).toHaveLength(1);

    const reasons = findAll(element, "data-action-blocked-reason");
    expect(reasons).toHaveLength(1);
    // A limitation the user cannot read is a limitation they will report as a bug.
    expect(textOf(reasons[0]!)).toContain("chưa nối được");
  });
});

/**
 * The record of which model answered.
 *
 * It used to be a full card at the top of the reply — the largest thing on screen and the first thing
 * read, which put bookkeeping in front of the answer. It is now one muted line at the end, and the two
 * assertions that matter are that it is small by default and that its facts are still reachable.
 */
describe("the model answer note", () => {
  const note = {
    type: "system-card",
    owner: "host",
    cardId: "card_1",
    subject: "connection",
    title: "Trả lời bằng model",
    status: "done",
    detail: "Câu trả lời này do model sinh ra.",
    fields: [
      { label: "Provider", value: "deepseek" },
      { label: "Model", value: "deepseek-v4-flash" },
      { label: "Thời gian", value: "1042 ms" },
    ],
    cancellable: false,
    updatedAt: "2026-09-18T00:00:00.000Z",
  };

  it("is a single collapsed line carrying the facts that identify the turn", () => {
    const element = SystemCardBlock({ block: note });
    expect(element?.type).toBe("details");
    expect(element?.props as Record<string, unknown>).toMatchObject({ "data-model-note": "true" });
    // Collapsed by default: the disclosure is closed until it is asked for, which is the whole point of
    // moving this from a card at the top of the reply to a line at the bottom.
    expect((element?.props as { open?: boolean }).open).toBeUndefined();

    // The visible line, not the whole widget: the explanation lives inside the disclosure, so a reader
    // who never opens it never reads it.
    const summary = findAll(element, "className").find((node) => node.type === "summary");
    const line = textOf(summary);
    expect(line).toContain("Trả lời bằng model");
    expect(line).toContain("deepseek");
    expect(line).toContain("1042 ms");
    expect(line).not.toContain("Câu trả lời này do model sinh ra.");
    // And it is reachable once opened.
    expect(textOf(element)).toContain("Câu trả lời này do model sinh ra.");
  });

  it("still says a turn failed, at full size", () => {
    // A failure is not bookkeeping: the reason is the message, and it is not hidden behind a click.
    const failed = { ...note, status: "blocked", title: "Không gọi được model", detail: "provider exploded" };
    const element = SystemCardBlock({ block: failed });
    expect(element?.type).toBe("section");
    expect(textOf(element)).toContain("provider exploded");
  });
});

/**
 * The diff card without a pointer.
 *
 * The journey proves a keyboard user can reach it; these assertions pin the reason that is possible, so a later
 * refactor that drops the tab stop fails here with a name for the defect rather than only in the browser.
 */
describe("the diff card and the keyboard", () => {
  it("sits in the tab order, is announced as a group, and carries a name", () => {
    const card = CodeDiffCardBlock({ block: DIFF });
    // Stated as a record rather than read off the element, whose props are `unknown` by default — the
    // alternative is a cast per assertion, which reads as if the shape were already known.
    const props = (card === null ? {} : (card.props as Record<string, unknown>)) ?? {};

    expect(props.tabIndex).toBe(0);
    expect(props.role).toBe("group");
    expect(props["data-diff-keyboard"]).toBe("true");
    // A focusable region with no accessible name announces only that the cursor moved.
    expect(String(props["aria-label"])).toContain("Diff:");
  });
});
