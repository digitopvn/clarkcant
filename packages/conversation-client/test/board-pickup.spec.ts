import { describe, expect, it } from "vitest";

import type { BoardState, BoardView } from "@clarkcant/contracts";

import { boardPickupDrop, boardPickupPreview, rebaseBoardPickup, rebaseBoardPointerDrag, type BoardPickup } from "../src/board-pickup.ts";

/**
 * A card being moved while the node's view changes under it: the answer to the person's previous move, or another
 * device's move. The move continues on the newer view; a card the newer view no longer has ends it.
 */

const BOARD: BoardView = {
  columns: [{ id: "todo", title: "To do" }, { id: "doing", title: "Doing" }, { id: "done", title: "Done" }],
  cards: [
    { id: "schema", columnId: "todo", title: "Schema", labels: [] },
    { id: "review", columnId: "doing", title: "Review", labels: [] },
    { id: "docs", columnId: "doing", title: "Docs", labels: [] },
  ],
};

const view = (order: Record<string, string[]>): BoardState => ({ order });

describe("a keyboard pickup on a newer view", () => {
  it("keeps the card where the person moved it, on top of the answer to their previous move", () => {
    // Picked up from the optimistic view of the previous move; the node's answer then arrives.
    const picked: BoardPickup = { cardId: "schema", origin: view({ todo: [], doing: ["schema", "review", "docs"], done: [] }), target: { columnId: "doing", position: 1 } };
    const answer = view({ todo: [], doing: ["schema", "review", "docs"], done: [] });
    const rebased = rebaseBoardPickup(BOARD, picked, answer);
    expect(rebased?.origin).toBe(answer);
    expect(rebased && boardPickupPreview(BOARD, rebased).order.doing).toEqual(["review", "schema", "docs"]);
    expect(rebased && boardPickupDrop(BOARD, rebased)).toEqual({ cardId: "schema", fromColumnId: "doing", toColumnId: "doing", position: 1 });
  });

  it("moves from where another device put the card, not from where it was picked up", () => {
    const picked: BoardPickup = { cardId: "schema", origin: view({ todo: ["schema"], doing: ["review", "docs"], done: [] }), target: { columnId: "doing", position: 0 } };
    const elsewhere = view({ todo: [], doing: ["review", "docs"], done: ["schema"] });
    const rebased = rebaseBoardPickup(BOARD, picked, elsewhere);
    expect(rebased && boardPickupDrop(BOARD, rebased)).toEqual({ cardId: "schema", fromColumnId: "done", toColumnId: "doing", position: 0 });
  });

  it("ends the move when the card is no longer on the board", () => {
    const picked: BoardPickup = { cardId: "schema", origin: view({ todo: ["schema"], doing: ["review", "docs"], done: [] }) };
    const withoutCard: BoardView = { ...BOARD, cards: BOARD.cards.filter((card) => card.id !== "schema") };
    expect(rebaseBoardPickup(withoutCard, picked, view({ todo: [], doing: ["review", "docs"], done: [] }))).toBeUndefined();
  });

  it("drops a target whose column is gone, so the card shows where the newer view has it", () => {
    const picked: BoardPickup = { cardId: "schema", origin: view({ todo: ["schema"], doing: ["review", "docs"], done: [] }), target: { columnId: "done", position: 0 } };
    const withoutDone: BoardView = { ...BOARD, columns: BOARD.columns.filter((column) => column.id !== "done") };
    const newer = view({ todo: ["schema"], doing: ["review", "docs"] });
    const rebased = rebaseBoardPickup(withoutDone, picked, newer);
    expect(rebased?.target).toBeUndefined();
    expect(rebased && boardPickupPreview(withoutDone, rebased).order).toEqual(newer.order);
    // Dropping it there moves nothing.
    expect(rebased && boardPickupDrop(withoutDone, rebased)).toBeUndefined();
  });

  it("restores the newer view on Escape, not the one the card was picked up from", () => {
    const picked: BoardPickup = { cardId: "schema", origin: view({ todo: ["schema"], doing: ["review", "docs"], done: [] }), target: { columnId: "doing", position: 2 } };
    const newer = view({ todo: ["schema"], doing: ["docs", "review"], done: [] });
    // Escape puts back the pickup's origin.
    expect(rebaseBoardPickup(BOARD, picked, newer)?.origin).toBe(newer);
  });

  it("sends nothing for a drop where the card was picked up", () => {
    const origin = view({ todo: ["schema"], doing: ["review", "docs"], done: [] });
    expect(boardPickupDrop(BOARD, { cardId: "review", origin })).toBeUndefined();
    expect(boardPickupDrop(BOARD, { cardId: "review", origin, target: { columnId: "doing", position: 0 } })).toBeUndefined();
    expect(boardPickupDrop(BOARD, { cardId: "review", origin, target: { columnId: "doing", position: 1 } })).toEqual({ cardId: "review", fromColumnId: "doing", toColumnId: "doing", position: 1 });
  });
});

describe("a pointer drag on a newer view", () => {
  it("starts from where the newer view has the card, and keeps its target within the column", () => {
    const drag = { cardId: "schema", fromColumnId: "todo", fromPosition: 0, targetColumnId: "doing", position: 2 };
    const newer = view({ todo: [], doing: ["schema", "review"], done: ["docs"] });
    expect(rebaseBoardPointerDrag(BOARD, drag, newer)).toEqual({ cardId: "schema", fromColumnId: "doing", fromPosition: 0, targetColumnId: "doing", position: 1 });
  });

  it("falls back to where the card is when its target column is gone", () => {
    const drag = { cardId: "schema", fromColumnId: "todo", fromPosition: 0, targetColumnId: "done", position: 0 };
    const withoutDone: BoardView = { ...BOARD, columns: BOARD.columns.filter((column) => column.id !== "done") };
    expect(rebaseBoardPointerDrag(withoutDone, drag, view({ todo: ["schema"], doing: ["review", "docs"] }))).toEqual({
      cardId: "schema", fromColumnId: "todo", fromPosition: 0, targetColumnId: "todo", position: 0,
    });
  });

  it("ends the drag when the card is no longer on the board", () => {
    const drag = { cardId: "schema", fromColumnId: "todo", fromPosition: 0, targetColumnId: "doing", position: 0 };
    expect(rebaseBoardPointerDrag(BOARD, drag, view({ todo: [], doing: ["review", "docs"], done: [] }))).toBeUndefined();
  });
});
