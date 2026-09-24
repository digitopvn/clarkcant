import { describe, expect, it } from "vitest";

import {
  chooseShare,
  connectTerminalSocket,
  formatShare,
  renderPiEntry,
  terminalSocketUrl,
  type TerminalCommandView,
} from "../src/terminal-socket.ts";

/** The terminal card's rules that need no DOM: where the socket goes, what a share sends, how a transcript draws. */

const finished = (overrides: Partial<TerminalCommandView> = {}): TerminalCommandView => ({
  id: "cmd_1",
  command: "pnpm test",
  startedAt: "2026-09-24T01:00:00.000Z",
  endedAt: "2026-09-24T01:00:03.000Z",
  exitCode: 1,
  output: "1 failed",
  truncated: false,
  ...overrides,
});

describe("the socket address", () => {
  it("uses ws only to a loopback node and wss for https", () => {
    expect(terminalSocketUrl("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/terminal");
    expect(terminalSocketUrl("https://node.example")).toBe("wss://node.example/terminal");
    expect(() => terminalSocketUrl("http://192.168.1.4:8787")).toThrow(/https/u);
  });
});

describe("what the share button sends", () => {
  it("prefers a selection, then the last finished command, then the screen", () => {
    expect(chooseShare({ selection: "picked", commands: [finished()], screen: "s" }).kind).toBe("selection");
    expect(chooseShare({ selection: " ", commands: [finished()], screen: "s" }).kind).toBe("command");
    expect(chooseShare({ selection: "", commands: [], screen: "s" }).kind).toBe("screen");
    expect(chooseShare({ selection: "", commands: [], screen: "  " }).kind).toBe("nothing");
  });

  it("never shares a running command as a result", () => {
    const { endedAt: _endedAt, ...base } = finished({ id: "cmd_2", exitCode: null });
    const running: TerminalCommandView = base;
    const choice = chooseShare({ selection: "", commands: [finished(), running], screen: "" });
    expect(choice).toMatchObject({ kind: "command", record: { id: "cmd_1" } });
  });

  it("names the command, directory and exit code, and fences output so it cannot close the fence", () => {
    const message = formatShare(
      { kind: "command", record: finished({ output: "text ``` inside" }) },
      { title: "app", cwd: "/work/app" },
    );
    expect(message).toContain("/work/app");
    expect(message).toContain("$ pnpm test — exit 1");
    expect(message).toContain("````\ntext ``` inside\n````");
  });

  it("says when only the end was kept", () => {
    const message = formatShare({ kind: "screen", text: "x".repeat(20_000) }, { title: "t", cwd: "/" });
    expect(message).toContain("chỉ phần cuối");
    expect(message.length).toBeLessThan(12_200);
  });
});

describe("drawing a Pi transcript", () => {
  it("strips escape sequences from the transcript so they cannot drive the terminal", () => {
    const drawn = renderPiEntry({ at: "2026-09-24T01:02:03.000Z", kind: "tool-result", text: "ok\u001b]0;evil\u0007\u001b[2J" });
    expect(drawn).not.toContain("]0;evil\u0007");
    expect(drawn).not.toContain("\u001b[2J");
    expect(drawn).toContain("01:02:03");
    expect(drawn.endsWith("\r\n")).toBe(true);
  });
});

describe("connecting", () => {
  it("authenticates first and queues frames until the node is ready", () => {
    const sent: string[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const socket = {
      send: (data: string) => sent.push(data),
      close: () => undefined,
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    };
    const frames: string[] = [];
    const connection = connectTerminalSocket({
      url: "ws://127.0.0.1:1/terminal",
      token: "tok",
      onFrame: (frame) => frames.push(frame.type),
      onClose: () => undefined,
      createSocket: () => socket as unknown as WebSocket,
    });
    connection.send({ type: "attach", terminalId: "term_1", cols: 80, rows: 24 });
    listeners.get("open")?.({});
    expect(sent).toEqual([JSON.stringify({ type: "auth", token: "tok" })]);
    listeners.get("message")?.({ data: JSON.stringify({ type: "ready" }) });
    expect(sent[1]).toBe(JSON.stringify({ type: "attach", terminalId: "term_1", cols: 80, rows: 24 }));
    expect(frames).toEqual(["ready"]);
  });
});
