import { describe, expect, it } from "vitest";

import { type AppIntentDecision, type SettingsTab } from "@clarkcant/contracts";

import { NOT_DESKTOP_SAY, runAppIntent, type AppIntentHost } from "../src/app-intents.ts";

/**
 * The one executor.
 *
 * The claim worth testing is that a decision is carried out by one function, so a clicked Settings and a
 * spoken one end in the same host call. The second claim is the honest one about limits: a browser cannot
 * move a window, and it says so instead of appearing to have done something.
 */

interface Recorded {
  settings: (SettingsTab | undefined)[];
  home: number;
  picker: number;
  endVoice: number;
  expand: number;
  minimise: number;
  minimal: boolean[];
  fullScreen: boolean[];
  quit: number;
}

function recordingHost(withDesktop = false): { host: AppIntentHost; calls: Recorded } {
  const calls: Recorded = {
    settings: [],
    home: 0,
    picker: 0,
    endVoice: 0,
    expand: 0,
    minimise: 0,
    minimal: [],
    fullScreen: [],
    quit: 0,
  };
  const host: AppIntentHost = {
    openSettings: (tab) => {
      calls.settings.push(tab);
    },
    goHome: () => {
      calls.home += 1;
    },
    openFilePicker: () => {
      calls.picker += 1;
    },
    endVoice: () => {
      calls.endVoice += 1;
    },
    ...(withDesktop
      ? {
          expandWindow: () => {
            calls.expand += 1;
          },
          minimiseWindow: () => {
            calls.minimise += 1;
          },
          setMinimal: (compact: boolean) => {
            calls.minimal.push(compact);
          },
          setFullScreen: (value: boolean) => {
            calls.fullScreen.push(value);
          },
          quit: () => {
            calls.quit += 1;
          },
        }
      : {}),
  };
  return { host, calls };
}

function executable(decision: Omit<AppIntentDecision & { kind: "intent" }, "requiresConfirmation">): AppIntentDecision {
  return { ...decision, requiresConfirmation: false } as AppIntentDecision;
}

describe("carrying out an intent", () => {
  it("sends every kind that needs no window to the host method that means it", async () => {
    const { host, calls } = recordingHost();

    expect((await runAppIntent(executable({ kind: "intent", intent: { kind: "settings.open" }, readBack: "mở" }), host)).ran).toBe(true);
    expect((await runAppIntent(executable({ kind: "intent", intent: { kind: "nav.home" }, readBack: "về" }), host)).ran).toBe(true);
    expect((await runAppIntent(executable({ kind: "intent", intent: { kind: "composer.attach" }, readBack: "tệp" }), host)).ran).toBe(
      true,
    );
    expect((await runAppIntent(executable({ kind: "intent", intent: { kind: "voice.end" }, readBack: "kết" }), host)).ran).toBe(true);

    expect(calls).toMatchObject({ settings: [undefined], home: 1, picker: 1, endVoice: 1 });
  });

  it("carries the tab, so opening Settings and changing tab are one host call", async () => {
    const { host, calls } = recordingHost();

    await runAppIntent(executable({ kind: "intent", intent: { kind: "settings.open" }, readBack: "mở" }), host);
    await runAppIntent(
      executable({ kind: "intent", intent: { kind: "settings.tab", tab: "extensions" }, readBack: "tab" }),
      host,
    );

    // The same method twice: there is no second path for a tab change to drift down.
    expect(calls.settings).toEqual([undefined, "extensions"]);
  });

  it("runs the window commands when the host has them", async () => {
    const { host, calls } = recordingHost(true);

    await runAppIntent(executable({ kind: "intent", intent: { kind: "window.minimal" }, readBack: "thu" }), host);
    await runAppIntent(executable({ kind: "intent", intent: { kind: "window.expand" }, readBack: "mở" }), host);
    await runAppIntent(executable({ kind: "intent", intent: { kind: "window.minimise" }, readBack: "nhỏ" }), host);
    await runAppIntent(executable({ kind: "intent", intent: { kind: "window.fullscreen" }, readBack: "to" }), host);
    await runAppIntent(executable({ kind: "intent", intent: { kind: "window.windowed" }, readBack: "thoát" }), host);

    expect(calls.fullScreen).toEqual([true, false]);
    expect(calls.minimal).toEqual([true]);
    expect(calls.expand).toBe(1);
    expect(calls.minimise).toBe(1);
  });

  it("says a window command needs the desktop app rather than appearing to work", async () => {
    const { host, calls } = recordingHost();

    for (const kind of [
      "window.expand",
      "window.minimise",
      "window.minimal",
      "window.fullscreen",
      "window.windowed",
      "app.quit",
    ] as const) {
      const run = await runAppIntent(executable({ kind: "intent", intent: { kind }, readBack: "ok" }), host);
      expect(run.ran, kind).toBe(false);
      expect(run.say, kind).toBe(NOT_DESKTOP_SAY);
    }

    // Nothing was attempted, so nothing can have half-happened.
    expect(calls).toMatchObject({ expand: 0, minimise: 0, minimal: [], fullScreen: [], quit: 0 });
  });
});

describe("stopping the reply being written", () => {
  it("reaches the same stop the button makes", async () => {
    let stops = 0;
    const host: AppIntentHost = {
      ...recordingHost().host,
      stopTurn: () => {
        stops += 1;
      },
    };

    const run = await runAppIntent(executable({ kind: "intent", intent: { kind: "turn.stop" }, readBack: "dừng" }), host);

    expect(run).toEqual({ ran: true, say: "dừng" });
    expect(stops).toBe(1);
  });

  it("says a host that cannot stop a reply did nothing, rather than reading back a stop", async () => {
    const run = await runAppIntent(
      executable({ kind: "intent", intent: { kind: "turn.stop" }, readBack: "dừng" }),
      recordingHost().host,
    );

    expect(run.ran).toBe(false);
    expect(run.say).not.toBe("dừng");
    expect(run.say).not.toBe(NOT_DESKTOP_SAY);
  });
});

describe("asking Clark about the latest notice", () => {
  it("reaches the inbox's own Ask Clark, and says why when there is nothing to ask about", async () => {
    let asked = 0;
    const host: AppIntentHost = {
      ...recordingHost().host,
      askAboutLatestNotice: async () => {
        asked += 1;
        if (asked > 1) throw new Error("Hộp thư chưa có thông báo nào để hỏi.");
      },
    };
    const decision = executable({ kind: "intent", intent: { kind: "inbox.ask" }, readBack: "hỏi" });

    expect(await runAppIntent(decision, host)).toEqual({ ran: true, say: "hỏi" });
    expect(await runAppIntent(decision, host)).toEqual({ ran: false, say: "Hộp thư chưa có thông báo nào để hỏi." });
  });

  it("is refused by a host with no inbox", async () => {
    const run = await runAppIntent(executable({ kind: "intent", intent: { kind: "inbox.ask" }, readBack: "hỏi" }), recordingHost().host);
    expect(run.ran).toBe(false);
    expect(run.say).not.toBe("hỏi");
  });
});

describe("saying whether a waiting action took effect", () => {
  function answeringHost(): { host: AppIntentHost; answers: string[] } {
    const answers: string[] = [];
    return {
      answers,
      host: {
        ...recordingHost().host,
        recordEffectOutcome: async (effectId, outcome) => {
          answers.push(`${effectId}:${outcome}`);
        },
      },
    };
  }

  it("records the effect the node named, through the same host path the inbox buttons use", async () => {
    const { host, answers } = answeringHost();

    const confirmed = await runAppIntent(
      executable({ kind: "intent", intent: { kind: "effect.confirmed", effectId: "eff_1" }, readBack: "ghi nhận" }),
      host,
    );
    const failed = await runAppIntent(executable({ kind: "intent", intent: { kind: "effect.failed", effectId: "eff_2" }, readBack: "ghi nhận" }), host);

    expect(confirmed).toEqual({ ran: true, say: "ghi nhận" });
    expect(failed).toEqual({ ran: true, say: "ghi nhận" });
    expect(answers).toEqual(["eff_1:confirmed", "eff_2:failed"]);
  });

  it("says what failed when the node would not record it, instead of reading the answer back", async () => {
    const host: AppIntentHost = {
      ...recordingHost().host,
      recordEffectOutcome: async () => {
        throw new Error("Việc đó đã được ghi nhận rồi.");
      },
    };

    const run = await runAppIntent(executable({ kind: "intent", intent: { kind: "effect.confirmed", effectId: "eff_1" }, readBack: "ghi nhận" }), host);

    expect(run).toEqual({ ran: false, say: "Việc đó đã được ghi nhận rồi." });
  });

  it("refuses an answer that arrived as an agent's control, or names no effect", async () => {
    const { host, answers } = answeringHost();

    const fromAgent = await runAppIntent(
      { ...executable({ kind: "intent", intent: { kind: "effect.confirmed", effectId: "eff_1" }, readBack: "ghi nhận" }), controlId: "ctl_1" } as AppIntentDecision,
      host,
    );
    const unnamed = await runAppIntent(executable({ kind: "intent", intent: { kind: "effect.failed" }, readBack: "ghi nhận" }), host);

    expect(fromAgent.ran).toBe(false);
    expect(unnamed.ran).toBe(false);
    expect(answers).toEqual([]);
  });

  it("is refused by a host with no inbox", async () => {
    const run = await runAppIntent(
      executable({ kind: "intent", intent: { kind: "effect.confirmed", effectId: "eff_1" }, readBack: "ghi nhận" }),
      recordingHost().host,
    );
    expect(run.ran).toBe(false);
  });
});

describe("what the executor will not do", () => {
  it("does not act on a question, even for an intent it could otherwise run", async () => {
    const { host, calls } = recordingHost(true);

    const run = await runAppIntent(
      {
        kind: "needs-confirmation",
        intent: { kind: "app.quit" },
        readBack: "Bạn xác nhận chứ?",
        confirmationToken: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      },
      host,
    );

    // This is the property that stops one spoken sentence from closing the application: the page is handed a
    // question, and a question is not permission, whatever the page does with it.
    expect(run.ran).toBe(false);
    expect(run.say).toBe("Bạn xác nhận chứ?");
    expect(calls.quit).toBe(0);
  });

  it("passes a refusal back as the sentence to say, and does nothing", async () => {
    const { host, calls } = recordingHost();

    const run = await runAppIntent({ kind: "refused", say: "Tôi chưa hiểu câu lệnh đó." }, host);

    expect(run.ran).toBe(false);
    expect(run.say).toBe("Tôi chưa hiểu câu lệnh đó.");
    expect(calls).toMatchObject({ settings: [], home: 0, picker: 0, endVoice: 0 });
  });

  it("uses the read-back it was given, so a node can word it differently", async () => {
    const { host } = recordingHost();
    const run = await runAppIntent(
      executable({ kind: "intent", intent: { kind: "settings.open" }, readBack: "Mở phần cài đặt nhé." }),
      host,
    );
    expect(run.say).toBe("Mở phần cài đặt nhé.");
  });
});
