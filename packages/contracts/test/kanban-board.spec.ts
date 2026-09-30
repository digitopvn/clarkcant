import { describe, expect, it } from "vitest";

import {
  BOARD_LABEL_TONES,
  MAX_BOARD_CARDS,
  MAX_BOARD_COLUMNS,
  boardMoveProblems,
  boardProblems,
  boardSemantic,
  boardText,
  moveBoardCard,
  readBoard,
  readBoardState,
  settleBoardMove,
} from "../src/index.ts";

const BOARD = {
  title: "Delivery",
  columns: [{ id: "todo", title: "To do", limit: 3 }, { id: "doing", title: "Doing" }, { id: "done", title: "Done" }],
  cards: [
    { id: "a", columnId: "todo", title: "Build bridge", labels: [{ text: "P1", tone: "warning" }], assignee: "Lee" },
    { id: "b", columnId: "todo", title: "Review" },
    { id: "c", columnId: "doing", title: "Ship" },
  ],
};

describe("the bounded kanban board contract", () => {
  it("accepts a bounded board and rejects duplicate ids, unknown columns, excess items, limits, tones and hidden characters", () => {
    expect(boardProblems(BOARD)).toEqual([]);
    expect(boardProblems({ ...BOARD, cards: [...BOARD.cards, { id: "todo", columnId: "todo", title: "Collision" }] })).toContain("board id repeats: todo");
    expect(boardProblems({ ...BOARD, cards: [{ id: "a", columnId: "missing", title: "Orphan" }] })).toContain("card a names unknown column missing");
    expect(boardProblems({ ...BOARD, cards: Array.from({ length: MAX_BOARD_CARDS + 1 }, (_, i) => ({ id: `c${String(i)}`, columnId: "doing", title: "Card" })) })).toContain(`board has more than ${String(MAX_BOARD_CARDS)} cards`);
    expect(boardProblems({ ...BOARD, columns: Array.from({ length: MAX_BOARD_COLUMNS + 1 }, (_, i) => ({ id: `c${String(i)}`, title: "Column" })), cards: [] })).toContain(`board has more than ${String(MAX_BOARD_COLUMNS)} columns`);
    expect(boardProblems({ ...BOARD, cards: [...BOARD.cards, { id: "d", columnId: "todo", title: "At limit" }, { id: "e", columnId: "todo", title: "Over limit" }] })).toContain("column todo exceeds its limit of 3");
    expect(boardProblems({ ...BOARD, cards: [{ id: "a", columnId: "todo", title: "Bad label", labels: [{ text: "x", tone: "purple" }] }] })).not.toEqual([]);
    expect(boardProblems({ ...BOARD, cards: [{ id: "a", columnId: "todo", title: "A‮B" }] }).join(" ")).toMatch(/U\+202E/u);
    expect(BOARD_LABEL_TONES).toContain("warning");
  });

  it("ignores stale saved ids while preserving a bounded order and selection", () => {
    const board = readBoard(BOARD);
    if (board === undefined) throw new Error("valid board did not read");
    expect(readBoardState({ order: { todo: ["b", "stale"], doing: ["c"], done: [] }, selectedCardId: "missing" }, board)).toEqual({
      order: { todo: ["b", "a"], doing: ["c"], done: [] },
    });
  });

  it("checks moves against the current order and restores the previous position after refusal", () => {
    const board = readBoard(BOARD);
    if (board === undefined) throw new Error("valid board did not read");
    const state = readBoardState(undefined, board);
    const move = { cardId: "a", fromColumnId: "todo", toColumnId: "doing", position: 1, external: true };
    expect(boardMoveProblems(board, state, move)).toEqual([]);
    expect(boardMoveProblems(board, state, { ...move, fromColumnId: "done" })).toContain("fromColumnId does not match the board order");
    expect(boardMoveProblems(board, state, { ...move, toColumnId: "missing" }).join(" ")).toContain("toColumnId must name a column");
    const pending = moveBoardCard(board, state, move);
    expect(pending).toMatchObject({ order: { todo: ["b"], doing: ["c", "a"] }, selectedCardId: "a", pendingMove: { fromColumnId: "todo", fromPosition: 0 } });
    expect(boardMoveProblems(board, pending, { ...move, cardId: "b" }).join(" ")).toContain("previous board move is still pending or uncertain");
    expect(settleBoardMove(pending, "refused")).toMatchObject({ order: state.order, selectedCardId: "a" });
    expect(settleBoardMove(pending, "refused").pendingMove).toBeUndefined();
    expect(settleBoardMove(pending, "done")).toEqual({ ...pending, pendingMove: undefined });
    expect(settleBoardMove(pending, "uncertain").pendingMove?.outcome).toBe("uncertain");
  });

  it("accepts same-column positions after removing the moved card", () => {
    const board = readBoard(BOARD);
    if (board === undefined) throw new Error("valid board did not read");
    const state = readBoardState(undefined, board);

    const movedToEnd = { cardId: "a", fromColumnId: "todo", toColumnId: "todo", position: 1 };
    expect(boardMoveProblems(board, state, movedToEnd)).toEqual([]);
    expect(moveBoardCard(board, state, movedToEnd).order.todo).toEqual(["b", "a"]);

    const movedToStart = { cardId: "b", fromColumnId: "todo", toColumnId: "todo", position: 0 };
    expect(boardMoveProblems(board, state, movedToStart)).toEqual([]);
    expect(moveBoardCard(board, state, movedToStart).order.todo).toEqual(["b", "a"]);
  });

  it("exposes bounded counts and a headed text alternative", () => {
    const board = readBoard(BOARD);
    if (board === undefined) throw new Error("valid board did not read");
    const state = readBoardState(undefined, board);
    expect(boardSemantic(board, state)).toMatchObject({
      summary: expect.stringContaining("3 columns and 3 cards"),
      values: { columnCount: 3, cardCount: 3, cardCounts: ["To do: 2", "Doing: 1", "Done: 0"] },
      selectedIds: [],
    });
    expect(boardText(board, state)).toContain("To do:\n  - Build bridge — Lee\n  - Review");
    expect(boardText(board, state, 80).length).toBeLessThanOrEqual(80);
  });
});
