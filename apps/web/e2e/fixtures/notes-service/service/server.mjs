/*
 * The package's service: a Model Context Protocol server over standard streams.
 *
 * It keeps notes in one JSON file in its private folder, which is `/data` inside the container the node runs it in.
 * `--data <dir>` names another folder, which is how a test runs the same file as a plain process.
 *
 * No dependencies on purpose: the container mounts the package read-only and has no network, so what runs is exactly
 * what is in this folder.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const flag = process.argv.indexOf("--data");
const DATA_DIR = flag >= 0 && process.argv[flag + 1] !== undefined ? process.argv[flag + 1] : "/data";
const STORE = join(DATA_DIR, "notes.json");
const BOARD_STORE = join(DATA_DIR, "board.json");
const INITIAL_BOARD = { todo: ["schema"], doing: ["review"], done: [] };

function initialBoard() {
  return { todo: ["schema"], doing: ["review"], done: [] };
}

const TOOLS = [
  {
    name: "add_note",
    description: "Add a note.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "add_note_slowly",
    description: "Add a note after a wait, unless the request is cancelled first.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 500 },
        seconds: { type: "integer", minimum: 1, maximum: 120 },
      },
      required: ["text", "seconds"],
      additionalProperties: false,
    },
  },
  {
    name: "list_notes",
    description: "List every note, oldest first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "move_board_card",
    description: "Record a board card move.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", minLength: 1, maxLength: 64 },
        fromColumnId: { type: "string", minLength: 1, maxLength: 64 },
        toColumnId: { type: "string", minLength: 1, maxLength: 64 },
        position: { type: "integer", minimum: 0, maximum: 120 },
      },
      required: ["cardId", "fromColumnId", "toColumnId", "position"],
      additionalProperties: false,
    },
  },
];

function readNotes() {
  if (!existsSync(STORE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(STORE, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((note) => typeof note === "string") : [];
  } catch {
    return [];
  }
}

function writeNotes(notes) {
  mkdirSync(DATA_DIR, { recursive: true });
  const next = `${STORE}.next`;
  writeFileSync(next, JSON.stringify(notes));
  renameSync(next, STORE);
}

function readBoard() {
  if (!existsSync(BOARD_STORE)) return initialBoard();
  try {
    const parsed = JSON.parse(readFileSync(BOARD_STORE, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return initialBoard();
    return Object.fromEntries(Object.entries(INITIAL_BOARD).map(([columnId, initial]) => [
      columnId,
      Array.isArray(parsed[columnId]) && parsed[columnId].every((cardId) => typeof cardId === "string") ? parsed[columnId] : [...initial],
    ]));
  } catch {
    return initialBoard();
  }
}

function writeBoard(board) {
  mkdirSync(DATA_DIR, { recursive: true });
  const next = `${BOARD_STORE}.next`;
  writeFileSync(next, JSON.stringify(board));
  renameSync(next, BOARD_STORE);
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

/** Slow adds still waiting, by request id, so a `notifications/cancelled` for one can drop it before it writes. */
const waiting = new Map();

function handle(request) {
  const { id, method, params } = request;
  if (method === "notifications/cancelled") {
    const timer = waiting.get(params?.requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      waiting.delete(params.requestId);
    }
    return;
  }
  if (id === undefined) return;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "com.example.notes", version: "1.0.0" },
        capabilities: { tools: { listChanged: false } },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (name === "add_note") {
      const note = String(params?.arguments?.text ?? "").trim();
      if (note === "") {
        send({ jsonrpc: "2.0", id, result: text("a note needs some text", true) });
        return;
      }
      const notes = [...readNotes(), note];
      writeNotes(notes);
      send({ jsonrpc: "2.0", id, result: text(`Saved. ${String(notes.length)} note(s): ${notes.join(" | ")}`) });
      return;
    }
    if (name === "add_note_slowly") {
      const note = String(params?.arguments?.text ?? "").trim();
      const seconds = Number(params?.arguments?.seconds ?? 1);
      // Written only once the wait is over: a request cancelled before then leaves the notes as they were, and the
      // protocol says a cancelled request is not answered.
      waiting.set(
        id,
        setTimeout(() => {
          waiting.delete(id);
          const notes = [...readNotes(), note];
          writeNotes(notes);
          send({ jsonrpc: "2.0", id, result: text(`Saved. ${String(notes.length)} note(s): ${notes.join(" | ")}`) });
        }, seconds * 1000),
      );
      return;
    }
    if (name === "list_notes") {
      // Newest first: a reader that keeps only the start of a long answer, like a spoken one, still hears the latest note.
      const notes = readNotes().reverse();
      send({ jsonrpc: "2.0", id, result: text(notes.length === 0 ? "No notes yet." : notes.join(" | ")) });
      return;
    }
    if (name === "move_board_card") {
      const { cardId, fromColumnId, toColumnId, position } = params?.arguments ?? {};
      if (typeof cardId !== "string" || typeof fromColumnId !== "string" || typeof toColumnId !== "string" || !Number.isInteger(position)) {
        send({ jsonrpc: "2.0", id, result: text("A board move needs a card, two columns and a position.", true) });
        return;
      }
      const board = readBoard();
      const source = board[fromColumnId];
      const target = board[toColumnId];
      const sourceIndex = source?.indexOf(cardId) ?? -1;
      const targetLength = target === undefined ? -1 : target.length - Number(fromColumnId === toColumnId);
      if (source === undefined || target === undefined || sourceIndex < 0 || !Number.isInteger(position) || position < 0 || position > targetLength) {
        send({ jsonrpc: "2.0", id, result: text("The board no longer has that card position; no move was saved.", true) });
        return;
      }
      source.splice(sourceIndex, 1);
      target.splice(position, 0, cardId);
      writeBoard(board);
      send({ jsonrpc: "2.0", id, result: text(`Moved ${cardId}. Board order: ${JSON.stringify(board)}.`) });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${String(name)}` } });
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${String(method)}` } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line));
      } catch {
        // A malformed request is dropped rather than ending the service.
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
