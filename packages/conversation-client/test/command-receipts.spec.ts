import { describe, expect, it } from "vitest";

import { echoesCommandReceipt } from "../src/command-receipts.ts";

const receipt = (command: string) => ({
  type: "tool-activity",
  name: "run_command",
  args: { command, cwd: "/repo", decision: "guarded" },
  result: "ok",
});
const call = (command: string) => ({ type: "tool-activity", name: "run_command", args: { command, why: "check" }, result: "ok" });
const evidence = { type: "evidence", kind: "exit-status", summary: "exit 0" };

describe("command receipts", () => {
  it("leaves out the model's record of a command the node already answered with a receipt", () => {
    const blocks = [receipt("ls"), evidence, call("ls")];
    expect(echoesCommandReceipt(blocks, 2)).toBe(true);
    expect(echoesCommandReceipt(blocks, 0)).toBe(false);
    expect(echoesCommandReceipt(blocks, 1)).toBe(false);
  });

  it("pairs each call only with the receipt directly before it", () => {
    const blocks = [receipt("ls"), evidence, call("ls"), receipt("pwd"), evidence, call("pwd")];
    expect(echoesCommandReceipt(blocks, 2)).toBe(true);
    expect(echoesCommandReceipt(blocks, 5)).toBe(true);
    // A second call of the same command with no receipt of its own (still waiting for approval) stays visible.
    expect(echoesCommandReceipt([receipt("ls"), call("ls"), call("ls")], 2)).toBe(false);
  });

  it("keeps a call whose command differs from the receipt, or that has no receipt at all", () => {
    expect(echoesCommandReceipt([receipt("ls"), call("pwd")], 1)).toBe(false);
    expect(echoesCommandReceipt([call("ls")], 0)).toBe(false);
    expect(echoesCommandReceipt([{ type: "text", text: "hi" }, call("ls")], 1)).toBe(false);
  });
});
