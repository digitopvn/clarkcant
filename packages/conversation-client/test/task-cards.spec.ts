import { type ReactElement } from "react";

import { describe, expect, it } from "vitest";

import {
  TaskOverviewCardBlock,
  TaskProgressCardBlock,
  TaskSummaryCardBlock,
  renderBlock,
} from "../src/blocks.tsx";
import { type BlockActions } from "../src/blocks.tsx";
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

/**
 * Stopping a task.
 *
 * The card used to say a task could be stopped and offer nothing that stopped it. These tests are
 * about the two ways that can go wrong again: a control that appears when the block does not claim
 * cancellability, and a control whose wording claims an outcome the node has not confirmed.
 */
describe("stopping a task", () => {
  const withStop = { onTaskStop: () => {} } satisfies BlockActions;

  it("offers the control only when the block itself says the task can be stopped", () => {
    const offered = findAll(
      TaskProgressCardBlock({ block: { ...PROGRESS, cancellable: true }, actions: withStop }),
      "data-task-stop",
    );
    expect(offered).toHaveLength(1);

    // The claim and the affordance come from the same field, so they cannot drift apart.
    const withheld = findAll(
      TaskProgressCardBlock({ block: { ...PROGRESS, cancellable: false }, actions: withStop }),
      "data-task-stop",
    );
    expect(withheld).toHaveLength(0);
  });

  it("reports that a task can be stopped without pressing anything when no handler is wired", () => {
    // A control that looks usable before its action exists is worse than no control: the fact is
    // still reported, and nothing pretend-interactive is drawn.
    const bare = TaskProgressCardBlock({ block: { ...PROGRESS, cancellable: true } });

    expect(findAll(bare, "data-task-cancellable")).toHaveLength(1);
    expect(findAll(bare, "data-task-stop")).toHaveLength(0);
  });

  it("does not claim a task stopped while the executor has not confirmed", () => {
    const pending = TaskProgressCardBlock({
      block: { ...PROGRESS, cancellable: true },
      actions: {
        ...withStop,
        taskStop: { task_1: { status: "requested", state: "cancel_requested", confirmed: false } },
      },
    });
    const outcome = findAll(pending, "data-task-stop-outcome")[0];

    expect(outcome?.props["data-task-stop-confirmed"]).toBe("false");
    // The wording matters as much as the flag: a task whose process is still finishing is "stopping",
    // and reading "đã dừng" here is how a user comes to believe an effect was prevented.
    expect(String(outcome?.props.children)).toContain("chưa phải đã dừng");
  });

  it("says a task has stopped only when the node confirmed it", () => {
    const done = TaskProgressCardBlock({
      block: { ...PROGRESS, cancellable: true },
      actions: {
        ...withStop,
        taskStop: { task_1: { status: "requested", state: "cancelled", confirmed: true } },
      },
    });
    const outcome = findAll(done, "data-task-stop-outcome")[0];

    expect(outcome?.props["data-task-stop-confirmed"]).toBe("true");
    expect(String(outcome?.props.children)).toContain("Đã dừng.");
  });

  it("shows the failure beside the control instead of leaving the request looking sent", () => {
    const failed = TaskProgressCardBlock({
      block: { ...PROGRESS, cancellable: true },
      actions: { ...withStop, taskStop: { task_1: { status: "failed", message: "Không gửi được yêu cầu dừng task." } } },
    });

    expect(findAll(failed, "data-task-stop-error")).toHaveLength(1);
    // No outcome is claimed, because nothing came back to claim it from.
    expect(findAll(failed, "data-task-stop-outcome")).toHaveLength(0);
  });
});
