import { boardMoveProblems, moveBoardCard, type BoardMove, type BoardState, type BoardView } from "@clarkcant/contracts";

/**
 * A card being moved on a board, and how it follows the node's view while it moves.
 *
 * The node's view can change in the middle of a move: the answer to the person's previous move arrives, or another device
 * moves a card. The move then continues on top of the newer view rather than snapping back or saving a stale origin.
 */

/** A card picked up from the keyboard: the view it was picked up from, and where it has been moved to so far. */
export interface BoardPickup {
  cardId: string;
  origin: BoardState;
  target?: { columnId: string; position: number };
}

/** A card being dragged with a pointer: where it started, and the column and position under the pointer. */
export interface BoardPointerDrag {
  cardId: string;
  fromColumnId: string;
  fromPosition: number;
  targetColumnId: string;
  position: number;
}

/** The column a card is in, or "" when it is on no column. */
export function boardColumnForBoardState(state: { order: Record<string, string[]> }, cardId: string): string {
  return Object.entries(state.order).find(([, ids]) => ids.includes(cardId))?.[0] ?? "";
}

/** The board as the person sees it while a card is picked up: the origin, with the card where they moved it if it still fits there. */
export function boardPickupPreview(board: BoardView, pickup: BoardPickup): BoardState {
  const picked = { ...pickup.origin, selectedCardId: pickup.cardId };
  if (pickup.target === undefined) return picked;
  const move = { cardId: pickup.cardId, fromColumnId: boardColumnForBoardState(pickup.origin, pickup.cardId), toColumnId: pickup.target.columnId, position: pickup.target.position };
  return boardMoveProblems(board, pickup.origin, move).length > 0 ? picked : moveBoardCard(board, pickup.origin, move);
}

/**
 * The pickup on top of a newer view, or `undefined` when its card is no longer on the board. A target whose column is
 * gone is dropped, so the card shows where the newer view has it; Escape then restores the newer view.
 */
export function rebaseBoardPickup(board: BoardView, pickup: BoardPickup, view: BoardState): BoardPickup | undefined {
  if (boardColumnForBoardState(view, pickup.cardId) === "") return undefined;
  const target = pickup.target !== undefined && board.columns.some((column) => column.id === pickup.target?.columnId) ? pickup.target : undefined;
  return { cardId: pickup.cardId, origin: view, ...(target === undefined ? {} : { target }) };
}

/** The move a keyboard drop makes, or `undefined` when the card would land where it was picked up. */
export function boardPickupDrop(board: BoardView, pickup: BoardPickup): BoardMove | undefined {
  const fromColumnId = boardColumnForBoardState(pickup.origin, pickup.cardId);
  const preview = boardPickupPreview(board, pickup);
  const toColumnId = boardColumnForBoardState(preview, pickup.cardId);
  const position = (preview.order[toColumnId] ?? []).indexOf(pickup.cardId);
  const fromPosition = (pickup.origin.order[fromColumnId] ?? []).indexOf(pickup.cardId);
  if (fromColumnId === "" || (toColumnId === fromColumnId && position === fromPosition)) return undefined;
  return { cardId: pickup.cardId, fromColumnId, toColumnId, position };
}

/**
 * A pointer drag on top of a newer view, or `undefined` when its card is no longer on the board. It starts from where
 * the newer view has the card, and its target is kept where that column still exists, within the column's size.
 */
export function rebaseBoardPointerDrag(board: BoardView, drag: BoardPointerDrag, view: BoardState): BoardPointerDrag | undefined {
  const fromColumnId = boardColumnForBoardState(view, drag.cardId);
  if (fromColumnId === "") return undefined;
  const fromPosition = (view.order[fromColumnId] ?? []).indexOf(drag.cardId);
  const kept = board.columns.some((column) => column.id === drag.targetColumnId);
  const targetColumnId = kept ? drag.targetColumnId : fromColumnId;
  const room = (view.order[targetColumnId] ?? []).length - (targetColumnId === fromColumnId ? 1 : 0);
  const position = kept ? Math.min(drag.position, Math.max(0, room)) : fromPosition;
  return { cardId: drag.cardId, fromColumnId, fromPosition, targetColumnId, position };
}
