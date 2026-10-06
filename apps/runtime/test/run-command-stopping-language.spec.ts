import { describe, expect, it } from "vitest";

import { refuseNewCommands, runCommand } from "../src/run-command.ts";

/**
 * A command refused because the node is stopping says so in the person's language.
 *
 * Its own file because refusing new commands is one-way for the process: every other command test would be refused
 * after it.
 */

describe("a command refused while the node stops", () => {
  it("says why in English when the person reads English, and in Vietnamese by default", async () => {
    refuseNewCommands();
    const english = await runCommand({ command: "echo hi", cwd: process.cwd() }, { language: "en" });
    expect(english).toMatchObject({ exitCode: null, stdout: "", timedOut: false });
    expect(english.stderr).toBe("the node is shutting down, so the command was not run; nothing was done");

    const vietnamese = await runCommand({ command: "echo hi", cwd: process.cwd() });
    expect(vietnamese.stderr).toBe("node đang tắt nên lệnh không được chạy; không có gì được thực hiện");
  });
});
