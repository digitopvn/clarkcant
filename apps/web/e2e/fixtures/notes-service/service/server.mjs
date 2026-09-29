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
    name: "list_notes",
    description: "List every note, oldest first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
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

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function handle(request) {
  const { id, method, params } = request;
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
    if (name === "list_notes") {
      const notes = readNotes();
      send({ jsonrpc: "2.0", id, result: text(notes.length === 0 ? "No notes yet." : notes.join(" | ")) });
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
