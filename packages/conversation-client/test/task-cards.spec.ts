import { type ReactElement } from "react";

import { describe, expect, it } from "vitest";

import {
  TaskOverviewCardBlock,
  TaskProgressCardBlock,
  TaskSummaryCardBlock,
  renderBlock,
} from "../src/blocks.tsx";
import { findAll, nonHost } from "./block-helpers.ts";

/**
 * The task cards.
 *
 * These are host-owned, so the first thing each test proves is the refusal: a block claiming to
 * be a task card without host ownership must produce nothing at all. The rest checks that the
 * signals a user relies on to tell "finished" from "succeeded" are actually present.
 *
 * This file lives under `tsconfig.web.json` and is excluded from `tsconfig.json`. It imports a
 * `.tsx` module, and the node project carries no `jsx` setting because nothing else in it renders
 * JSX, so leaving it in both projects made it fail to resolve the component it tests.
 */

const PROGRESS = {
  type: "task-progress-card",
  owner: "host",
  cardId: "card_1",
  taskId: "task_1",
  goal: "Sửa lỗi đăng nhập",
  status: "working",
  steps: [
    { label: "Đọc mã nguồn", status: "done" },
    { label: "Sửa lỗi", status: "active", detail: "đang chạy test" },
    { label: "Kiểm chứng", status: "pending" },
  ],
  startedAt: "2026-09-16T10:00:00.000Z",
  updatedAt: "2026-09-16T10:01:00.000Z",
  cancellable: true,
};

const SUMMARY = {
  type: "task-summary-card",
  owner: "host",
  cardId: "card_2",
  taskId: "task_1",
  goal: "Sửa lỗi đăng nhập",
  outcome: "succeeded",
  evidence: "verified",
  durationMs: 12_500,
  changes: [{ target: "src/auth.ts", kind: "modified" }],
  summary: "Đã sửa và test lại.",
  updatedAt: "2026-09-16T10:02:00.000Z",
};

const OVERVIEW = {
  type: "task-overview-card",
  owner: "host",
  cardId: "card_3",
  conversationId: "conv_1",
  tasks: [
    { taskId: "task_1", goal: "Sửa lỗi đăng nhập", status: "working", updatedAt: "2026-09-16T10:00:00.000Z" },
    { taskId: "task_2", goal: "Viết tài liệu", status: "done", updatedAt: "2026-09-16T09:00:00.000Z" },
  ],
  updatedAt: "2026-09-16T10:02:00.000Z",
};

describe("a task card cannot be forged", () => {
  it("refuses every card whose owner is not the host", () => {
    expect(TaskProgressCardBlock({ block: nonHost(PROGRESS) })).toBeNull();
    expect(TaskSummaryCardBlock({ block: nonHost(SUMMARY) })).toBeNull();
    expect(TaskOverviewCardBlock({ block: nonHost(OVERVIEW) })).toBeNull();
  });

  it("stamps host ownership and the card kind on what it does draw", () => {
    const progress = TaskProgressCardBlock({ block: PROGRESS }) as ReactElement<Record<string, unknown>>;
    expect(progress.props["data-owner"]).toBe("host");
    expect(progress.props["data-host-card"]).toBe("task-progress");
  });
});

describe("a task in flight", () => {
  it("shows each step with its own status, so progress is not a single number", () => {
    const element = TaskProgressCardBlock({ block: PROGRESS }) as ReactElement<Record<string, unknown>>;
    const steps = findAll(element, "data-step-status");
    expect(steps.map((step) => step.props["data-step-status"])).toEqual(["done", "active", "pending"]);
  });

  it("states whether the user can stop it", () => {
    const element = TaskProgressCardBlock({ block: PROGRESS }) as ReactElement<Record<string, unknown>>;
    // A card that says a task is running without saying whether it can be stopped is a dead end.
    expect(JSON.stringify(element)).toContain("có");
  });

  it("survives a block with no steps rather than crashing", () => {
    const element = TaskProgressCardBlock({ block: { ...PROGRESS, steps: [] } });
    expect(element).not.toBeNull();
    expect(findAll(element, "data-step-status")).toEqual([]);
  });
});

describe("a finished task", () => {
  it("reports outcome and evidence as two separate signals", () => {
    const element = TaskSummaryCardBlock({ block: SUMMARY }) as ReactElement<Record<string, unknown>>;
    expect(element.props["data-outcome"]).toBe("succeeded");
    // `evidence` is on its own element precisely so this can be checked: collapsing the two into
    // one badge is how a task that stopped without evidence comes to read as a success.
    const evidence = findAll(element, "data-verdict");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.props["data-verdict"]).toBe("verified");
  });

  it("shows what the task touched", () => {
    const element = TaskSummaryCardBlock({ block: SUMMARY }) as ReactElement<Record<string, unknown>>;
    const changes = findAll(element, "data-change-kind");
    expect(changes.map((change) => change.props["data-change-kind"])).toEqual(["modified"]);
  });

  it("can say a run finished without achieving anything", () => {
    // The honest combination: the task ran, and there is no evidence it succeeded.
    const element = TaskSummaryCardBlock({
      block: { ...SUMMARY, outcome: "not-verified", evidence: "not-verified" },
    }) as ReactElement<Record<string, unknown>>;
    expect(element.props["data-outcome"]).toBe("not-verified");
    expect(findAll(element, "data-verdict")[0]!.props["data-verdict"]).toBe("not-verified");
  });
});

describe("an overview of a conversation", () => {
  it("counts what is still unfinished, in words", () => {
    const element = TaskOverviewCardBlock({ block: OVERVIEW }) as ReactElement<Record<string, unknown>>;
    const counter = findAll(element, "data-unfinished-count");
    expect(counter).toHaveLength(1);
    // One of the two tasks is still working.
    expect(counter[0]!.props["data-unfinished-count"]).toBe(1);
    expect(JSON.stringify(element)).toContain("1 việc còn dở");
  });

  it("says so plainly when nothing is running", () => {
    const element = TaskOverviewCardBlock({
      block: { ...OVERVIEW, tasks: [OVERVIEW.tasks[1]] },
    });
    expect(JSON.stringify(element)).toContain("Không còn việc nào đang chạy");
  });
});

describe("the dispatcher", () => {
  it("routes each task card to its own renderer", () => {
    for (const block of [PROGRESS, SUMMARY, OVERVIEW]) {
      const rendered = renderBlock(block, 0, () => null as unknown as ReactElement);
      expect(rendered, String(block.type)).not.toBeNull();
    }
  });

  it("still drops a block type it does not know", () => {
    expect(renderBlock({ type: "something-new" }, 0, () => null as unknown as ReactElement)).toBeNull();
  });
});
