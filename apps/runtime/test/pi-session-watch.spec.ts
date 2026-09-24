import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPiSessionWatcher, parsePiSessionLine, type PiSessionEntry } from "../src/pi-session-watch.ts";

/**
 * Following a Pi session through its transcript file, the way Pi writes it: a JSONL header, then one line per
 * message, appended as the session runs.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-pi-watch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const header = JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-24T01:00:00.000Z", cwd: "/work/app" });
const user = (text: string) =>
  JSON.stringify({ type: "message", timestamp: "2026-09-24T01:00:01.000Z", message: { role: "user", content: [{ type: "text", text }] } });

describe("reading one transcript line", () => {
  it("splits an assistant message into what happened, in order", () => {
    const entries = parsePiSessionLine(
      JSON.stringify({
        type: "message",
        timestamp: "2026-09-24T01:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "check the tests" },
            { type: "text", text: "Running them." },
            { type: "toolCall", id: "t1", name: "bash", arguments: { command: "pnpm test" } },
          ],
        },
      }),
    );
    expect(entries.map((entry) => entry.kind)).toEqual(["thinking", "assistant", "tool-call"]);
    expect(entries[2]?.toolName).toBe("bash");
    expect(entries[2]?.text).toContain("pnpm test");
  });

  it("redacts a secret a tool printed before it leaves the node", () => {
    const [entry] = parsePiSessionLine(
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }] },
      }),
    );
    expect(entry?.kind).toBe("tool-result");
    expect(entry?.text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("yields nothing for a line it does not recognise", () => {
    expect(parsePiSessionLine("not json")).toEqual([]);
    expect(parsePiSessionLine(JSON.stringify({ type: "model_change" }))).toEqual([]);
  });
});

describe("watching a session", () => {
  it("lists sessions by their first question, and follows appended messages", async () => {
    const project = join(dir, "sessions", "--work-app--");
    mkdirSync(project, { recursive: true });
    const file = join(project, "2026-09-24_s1.jsonl");
    writeFileSync(file, `${header}\n${user("Sửa bài test đang lỗi")}\n`);

    const watcher = createPiSessionWatcher({ roots: () => [{ dir: join(dir, "sessions"), source: "pi", depth: 2 }] });
    const [summary] = watcher.list();
    expect(summary).toMatchObject({ title: "Sửa bài test đang lỗi", cwd: "/work/app", source: "pi", active: true });
    expect(summary?.ref).toMatch(/^[0-9a-f]{16}$/u);

    const batches: { entries: PiSessionEntry[]; initial: boolean }[] = [];
    const watched = watcher.watch(summary?.ref ?? "", (entries, initial) => batches.push({ entries, initial }));
    expect(watched.ok).toBe(true);
    expect(batches[0]?.initial).toBe(true);
    expect(batches[0]?.entries.map((entry) => entry.kind)).toEqual(["session", "user"]);

    // Half a line first: nothing is parsed until the line is whole.
    const next = user("Còn một lỗi nữa");
    appendFileSync(file, next.slice(0, 20));
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    appendFileSync(file, `${next.slice(20)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    if (watched.ok) watched.stop();

    const later = batches.slice(1).flatMap((batch) => batch.entries);
    expect(later.map((entry) => entry.text)).toEqual(["Còn một lỗi nữa"]);
  }, 10_000);

  it("refuses a reference it never listed", () => {
    const watcher = createPiSessionWatcher({ roots: () => [] });
    expect(watcher.watch("0123456789abcdef", () => undefined).ok).toBe(false);
  });
});
