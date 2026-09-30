import { z } from "zod";

import { cardSchemaProblems, clipWithMarker, hiddenCharacterProblem, oneLineText } from "./text-rules.ts";
import { SEMANTIC_LIMITS, type SemanticValue } from "./widget-semantic.ts";
import { SNAPSHOT_TEXT_LIMIT } from "./widgets.ts";

export const BOARD_ID = "canvas.board@1";
export const BOARD_MOVE_OPERATION = "board.move";
export const BOARD_APPROVAL_OPERATION = "board.await";
export const BOARD_RESOLVE_OPERATION = "board.resolve";
export const BOARD_ACKNOWLEDGE_OPERATION = "board.acknowledge";
export const MAX_BOARD_COLUMNS = 12;
export const MAX_BOARD_CARDS = 120;
export const MAX_BOARD_ID = 64;
export const MAX_BOARD_TITLE = 160;
export const MAX_BOARD_DESCRIPTION = 500;
export const MAX_BOARD_ASSIGNEE = 100;
export const MAX_BOARD_LABELS = 8;
export const MAX_BOARD_LABEL = 60;
export const BOARD_LABEL_TONES = ["neutral", "accent", "success", "warning", "danger"] as const;
export type BoardLabelTone = (typeof BOARD_LABEL_TONES)[number];

function idSchema() {
  return z.string().min(1, "is empty").max(MAX_BOARD_ID, `is longer than ${String(MAX_BOARD_ID)} characters`).superRefine((value, ctx) => {
    const problem = hiddenCharacterProblem(value);
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
    else if (value.trim() === "") ctx.addIssue({ code: "custom", message: "is only spaces" });
  });
}

const labelSchema = z.strictObject({
  text: oneLineText(MAX_BOARD_LABEL, true),
  tone: z.enum(BOARD_LABEL_TONES).optional(),
});
const columnSchema = z.strictObject({
  id: idSchema(),
  title: oneLineText(MAX_BOARD_TITLE, true),
  limit: z.int().min(0).max(MAX_BOARD_CARDS).optional(),
});
const cardSchema = z.strictObject({
  id: idSchema(),
  columnId: idSchema(),
  title: oneLineText(MAX_BOARD_TITLE, true),
  description: z.string().max(MAX_BOARD_DESCRIPTION).optional().superRefine((value, ctx) => {
    if (value === undefined) return;
    const problem = hiddenCharacterProblem(value);
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
  }),
  labels: z.array(labelSchema).max(MAX_BOARD_LABELS).optional(),
  assignee: oneLineText(MAX_BOARD_ASSIGNEE, false).optional(),
});
const boardSchema = z.strictObject({
  title: oneLineText(MAX_BOARD_TITLE, false).optional(),
  columns: z.array(columnSchema).min(1).max(MAX_BOARD_COLUMNS),
  cards: z.array(cardSchema).max(MAX_BOARD_CARDS),
});

export interface BoardColumn { id: string; title: string; limit?: number }
export interface BoardLabel { text: string; tone?: BoardLabelTone }
export interface BoardCard { id: string; columnId: string; title: string; description?: string; labels: BoardLabel[]; assignee?: string }
export interface BoardView { title?: string; columns: BoardColumn[]; cards: BoardCard[] }
export interface BoardMove { cardId: string; fromColumnId: string; toColumnId: string; position: number; external?: boolean }
export interface BoardPendingMove { cardId: string; fromColumnId: string; toColumnId: string; fromPosition: number; position: number; approvalId?: string; outcome?: "uncertain" }
export interface BoardState { order: Record<string, string[]>; selectedCardId?: string; pendingMove?: BoardPendingMove }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A closed, bounded board contract. IDs share one namespace across columns and cards. */
export function boardProblems(input: unknown): string[] {
  if (!record(input)) return ["board props are an object"];
  if (Array.isArray(input.columns) && input.columns.length > MAX_BOARD_COLUMNS) return [`board has more than ${String(MAX_BOARD_COLUMNS)} columns`];
  if (Array.isArray(input.cards) && input.cards.length > MAX_BOARD_CARDS) return [`board has more than ${String(MAX_BOARD_CARDS)} cards`];
  const parsed = boardSchema.safeParse(input);
  if (!parsed.success) return cardSchemaProblems(parsed.error.issues);
  const columnIds = new Set<string>();
  const cardIds = new Set<string>();
  const allIds = new Set<string>();
  for (const column of parsed.data.columns) {
    if (allIds.has(column.id)) return [`board id repeats: ${column.id}`];
    allIds.add(column.id);
    columnIds.add(column.id);
  }
  const counts = new Map<string, number>();
  for (const card of parsed.data.cards) {
    if (allIds.has(card.id)) return [`board id repeats: ${card.id}`];
    allIds.add(card.id);
    cardIds.add(card.id);
    if (!columnIds.has(card.columnId)) return [`card ${card.id} names unknown column ${card.columnId}`];
    counts.set(card.columnId, (counts.get(card.columnId) ?? 0) + 1);
  }
  for (const column of parsed.data.columns) {
    if (column.limit !== undefined && (counts.get(column.id) ?? 0) > column.limit) return [`column ${column.id} exceeds its limit of ${String(column.limit)}`];
  }
  return cardIds.size <= MAX_BOARD_CARDS ? [] : [`board has more than ${String(MAX_BOARD_CARDS)} cards`];
}

export function readBoard(input: unknown): BoardView | undefined {
  if (boardProblems(input).length > 0) return undefined;
  const parsed = boardSchema.parse(input);
  return {
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    columns: parsed.columns.map((column) => ({ id: column.id, title: column.title, ...(column.limit === undefined ? {} : { limit: column.limit }) })),
    cards: parsed.cards.map((card) => ({ id: card.id, columnId: card.columnId, title: card.title, ...(card.description === undefined ? {} : { description: card.description }), labels: (card.labels ?? []).map((label) => ({ text: label.text, ...(label.tone === undefined ? {} : { tone: label.tone }) })), ...(card.assignee === undefined ? {} : { assignee: card.assignee }) })),
  };
}

function initialOrder(board: BoardView): Record<string, string[]> {
  return Object.fromEntries(board.columns.map((column) => [column.id, board.cards.filter((card) => card.columnId === column.id).map((card) => card.id)]));
}

/** Leniently reads old view state: stale ids disappear and new cards join their source column. */
export function readBoardState(input: unknown, board: BoardView): BoardState {
  const base = initialOrder(board);
  const known = new Set(board.cards.map((card) => card.id));
  const seen = new Set<string>();
  const order: Record<string, string[]> = {};
  const candidate = record(input) && record(input.order) ? input.order : {};
  for (const column of board.columns) {
    const entries = candidate[column.id];
    const kept = Array.isArray(entries) ? entries.filter((id): id is string => typeof id === "string" && known.has(id) && !seen.has(id)) : [];
    for (const id of kept) seen.add(id);
    order[column.id] = kept;
  }
  for (const [columnId, ids] of Object.entries(base)) {
    for (const id of ids ?? []) if (!seen.has(id)) { order[columnId]?.push(id); seen.add(id); }
  }
  const ids = new Set(board.cards.map((card) => card.id));
  const selected = record(input) && typeof input.selectedCardId === "string" && ids.has(input.selectedCardId) ? input.selectedCardId : undefined;
  const pending = record(input) && record(input.pendingMove) ? input.pendingMove : undefined;
  const cardIds = new Set(board.cards.map((card) => card.id));
  const columnIds = new Set(board.columns.map((column) => column.id));
  let pendingMove: BoardPendingMove | undefined;
  if (pending !== undefined && typeof pending.cardId === "string" && cardIds.has(pending.cardId) &&
      typeof pending.fromColumnId === "string" && columnIds.has(pending.fromColumnId) &&
      typeof pending.toColumnId === "string" && columnIds.has(pending.toColumnId) &&
      Number.isInteger(pending.fromPosition) && (pending.fromPosition as number) >= 0 &&
      Number.isInteger(pending.position) && (pending.position as number) >= 0 && (pending.position as number) <= MAX_BOARD_CARDS &&
      (pending.approvalId === undefined || (typeof pending.approvalId === "string" && pending.approvalId.length > 0 && pending.approvalId.length <= 128)) &&
      (pending.outcome === undefined || pending.outcome === "uncertain") &&
      Object.keys(pending).every((key) => ["cardId", "fromColumnId", "toColumnId", "fromPosition", "position", "approvalId", "outcome"].includes(key)) &&
      order[pending.toColumnId]?.[pending.position as number] === pending.cardId) {
    pendingMove = {
      cardId: pending.cardId, fromColumnId: pending.fromColumnId, toColumnId: pending.toColumnId,
      fromPosition: pending.fromPosition as number, position: pending.position as number,
      ...(typeof pending.approvalId === "string" ? { approvalId: pending.approvalId } : {}),
      ...(pending.outcome === "uncertain" ? { outcome: "uncertain" as const } : {}),
    };
  }
  return { order, ...(selected === undefined ? {} : { selectedCardId: selected }), ...(pendingMove === undefined ? {} : { pendingMove }) };
}

export function boardStateProblems(board: BoardView, input: unknown): string[] {
  if (!record(input)) return ["board state is an object"];
  const extra = Object.keys(input).filter((key) => !["order", "selectedCardId", "pendingMove"].includes(key));
  if (extra.length > 0) return [`board state carries unknown fields: ${extra.slice(0, 5).join(", ")}`];
  if (input.order !== undefined) {
    if (!record(input.order)) return ["board order is a column-to-card-list object"];
    const columns = new Set(board.columns.map((column) => column.id));
    if (Object.keys(input.order).some((key) => !columns.has(key))) return ["board order names an unknown column"];
    const all = new Set<string>();
    for (const column of board.columns) {
      const ids = input.order[column.id];
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !board.cards.some((card) => card.id === id))) return [`board order for ${column.id} contains an unknown card`];
      for (const id of ids as string[]) { if (all.has(id)) return [`board order repeats card ${id}`]; all.add(id); }
    }
    if (all.size !== board.cards.length) return ["board order must place every card exactly once"];
  }
  if (input.selectedCardId !== undefined && input.selectedCardId !== "" && !board.cards.some((card) => card.id === input.selectedCardId)) return ["selectedCardId must name a card on this board"];
  if (input.pendingMove !== undefined) {
    const pending = input.pendingMove;
    if (!record(pending) || !board.cards.some((card) => card.id === pending.cardId) ||
        !board.columns.some((column) => column.id === pending.fromColumnId) || !board.columns.some((column) => column.id === pending.toColumnId) ||
        !Number.isInteger(pending.fromPosition) || (pending.fromPosition as number) < 0 ||
        !Number.isInteger(pending.position) || (pending.position as number) < 0 || (pending.position as number) > MAX_BOARD_CARDS ||
        (pending.approvalId !== undefined && (typeof pending.approvalId !== "string" || pending.approvalId.length < 1 || pending.approvalId.length > 128)) ||
        Object.keys(pending).some((key) => !["cardId", "fromColumnId", "toColumnId", "fromPosition", "position", "approvalId", "outcome"].includes(key)) ||
        (pending.outcome !== undefined && pending.outcome !== "uncertain")) return ["pendingMove is not a bounded move on this board"];
  }
  return [];
}

export function boardMoveProblems(board: BoardView, state: BoardState, input: unknown): string[] {
  if (!record(input)) return ["a board move is an object"];
  const extra = Object.keys(input).filter((key) => !["cardId", "fromColumnId", "toColumnId", "position", "external"].includes(key));
  if (extra.length > 0) return [`a board move carries unknown fields: ${extra.slice(0, 5).join(", ")}`];
  if (state.pendingMove !== undefined) return ["the previous board move is still pending or uncertain"];
  const cardId = input.cardId;
  const toColumnId = input.toColumnId;
  const position = input.position;
  if (typeof cardId !== "string" || !board.cards.some((card) => card.id === cardId)) return ["cardId must name a card on this board"];
  if (typeof toColumnId !== "string" || !board.columns.some((column) => column.id === toColumnId)) return ["toColumnId must name a column on this board"];
  if (!Number.isInteger(position) || (position as number) < 0 || (position as number) > MAX_BOARD_CARDS) return ["position is a bounded card index"];
  if (input.external !== undefined && typeof input.external !== "boolean") return ["external is a boolean"];
  const fromColumnId = boardColumnForCard(state.order, cardId);
  if (fromColumnId === undefined || (input.fromColumnId !== undefined && input.fromColumnId !== fromColumnId)) return ["fromColumnId does not match the board order"];
  const order = { ...state.order, [fromColumnId]: [...(state.order[fromColumnId] ?? [])] };
  if (fromColumnId !== toColumnId) order[toColumnId as string] = [...(state.order[toColumnId as string] ?? [])];
  const source = order[fromColumnId] ?? [];
  const sourceIndex = source.indexOf(cardId);
  source.splice(sourceIndex, 1);
  const target = order[toColumnId as string] ?? [];
  const targetPosition = Math.min(position as number, target.length);
  if (targetPosition !== position) return ["position exceeds the destination column size"];
  if (targetPosition > target.length) return ["position exceeds the destination column size"];
  const column = board.columns.find((entry) => entry.id === toColumnId);
  if (fromColumnId !== toColumnId && column?.limit !== undefined && target.length >= column.limit) return [`column ${toColumnId} is at its limit of ${String(column.limit)}`];
  return [];
}

export function boardColumnForCard(order: Record<string, string[]>, cardId: string): string | undefined {
  return Object.entries(order).find(([, ids]) => ids.includes(cardId))?.[0];
}

export function moveBoardCard(board: BoardView, state: BoardState, input: BoardMove): BoardState {
  const fromColumnId = boardColumnForCard(state.order, input.cardId);
  if (fromColumnId === undefined) return state;
  const order = Object.fromEntries(Object.entries(state.order).map(([id, cards]) => [id, [...cards]]));
  const source = order[fromColumnId] ?? [];
  const fromPosition = source.indexOf(input.cardId);
  source.splice(fromPosition, 1);
  const target = order[input.toColumnId] ?? [];
  target.splice(input.position, 0, input.cardId);
  order[input.toColumnId] = target;
  return { order, selectedCardId: input.cardId, ...(input.external === true ? { pendingMove: { cardId: input.cardId, fromColumnId, toColumnId: input.toColumnId, fromPosition, position: input.position } } : {}) };
}

export function boardApprovalState(state: BoardState, approvalId: string): BoardState {
  return state.pendingMove === undefined ? state : { ...state, pendingMove: { ...state.pendingMove, approvalId } };
}

export function settleBoardMove(state: BoardState, outcome: "done" | "refused" | "uncertain"): BoardState {
  const pending = state.pendingMove;
  if (pending === undefined) return state;
  if (outcome === "done") {
    const { pendingMove: _pending, ...settled } = state;
    return settled;
  }
  if (outcome === "uncertain") return { ...state, pendingMove: { ...pending, outcome: "uncertain" } };
  const order = Object.fromEntries(Object.entries(state.order).map(([id, cards]) => [id, [...cards]]));
  const target = order[pending.toColumnId] ?? [];
  const index = target.indexOf(pending.cardId);
  if (index >= 0) target.splice(index, 1);
  const source = order[pending.fromColumnId] ?? [];
  source.splice(Math.min(pending.fromPosition, source.length), 0, pending.cardId);
  order[pending.fromColumnId] = source;
  return { order, ...(state.selectedCardId === undefined ? {} : { selectedCardId: state.selectedCardId }) };
}

export function boardSemantic(board: BoardView, state: BoardState): { title?: string; summary: string; values: Record<string, SemanticValue>; selectedIds: string[] } {
  const selected = board.cards.find((card) => card.id === state.selectedCardId);
  const counts = board.columns.map((column) => `${column.title}: ${(state.order[column.id] ?? []).length}`);
  const pending = state.pendingMove;
  const status = pending?.outcome === "uncertain" ? "move outcome uncertain" : pending === undefined ? "" : pending.approvalId === undefined ? "move pending" : "move awaiting approval";
  const summary = clipWithMarker([`${board.title ?? "Board"}: ${String(board.columns.length)} columns and ${String(board.cards.length)} cards`, ...counts, ...(selected === undefined ? [] : [`selected ${selected.title}`]), ...(status === "" ? [] : [status])].join("; "), SEMANTIC_LIMITS.summary);
  const values: Record<string, SemanticValue> = { columnCount: board.columns.length, cardCount: board.cards.length, cardCounts: counts.slice(0, 12) };
  if (selected !== undefined) { values.selectedCardId = selected.id; values.selectedCardTitle = selected.title; }
  if (pending !== undefined) { values.pendingMove = `${pending.cardId}: ${pending.fromColumnId} → ${pending.toColumnId}`; values.pendingMoveStatus = pending.outcome === "uncertain" ? "uncertain" : pending.approvalId === undefined ? "pending" : "awaiting-approval"; }
  return { ...(board.title === undefined ? {} : { title: board.title }), summary, values, selectedIds: selected === undefined ? [] : [selected.id] };
}

export function boardText(board: BoardView, state: BoardState, limit = SNAPSHOT_TEXT_LIMIT): string {
  const lines = [board.title ?? "Board"];
  for (const column of board.columns) {
    lines.push(`${column.title}:`);
    for (const id of state.order[column.id] ?? []) {
      const card = board.cards.find((entry) => entry.id === id);
      if (card !== undefined) lines.push(`  - ${card.title}${card.assignee === undefined ? "" : ` — ${card.assignee}`}`);
    }
  }
  if (state.pendingMove !== undefined) lines.push(state.pendingMove.outcome === "uncertain" ? "Move outcome uncertain; the external view may differ." : "Move pending.");
  return clipWithMarker(lines.join("\n"), limit);
}
