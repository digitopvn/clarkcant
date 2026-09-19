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
  it("sends every kind that needs no window to the host method that means it", () => {
    const { host, calls } = recordingHost();

    expect(runAppIntent(executable({ kind: "intent", intent: { kind: "settings.open" }, readBack: "mở" }), host).ran).toBe(true);
    expect(runAppIntent(executable({ kind: "intent", intent: { kind: "nav.home" }, readBack: "về" }), host).ran).toBe(true);
    expect(runAppIntent(executable({ kind: "intent", intent: { kind: "composer.attach" }, readBack: "tệp" }), host).ran).toBe(
      true,
    );
    expect(runAppIntent(executable({ kind: "intent", intent: { kind: "voice.end" }, readBack: "kết" }), host).ran).toBe(true);

    expect(calls).toMatchObject({ settings: [undefined], home: 1, picker: 1, endVoice: 1 });
  });

  it("carries the tab, so opening Settings and changing tab are one host call", () => {
    const { host, calls } = recordingHost();

    runAppIntent(executable({ kind: "intent", intent: { kind: "settings.open" }, readBack: "mở" }), host);
    runAppIntent(
      executable({ kind: "intent", intent: { kind: "settings.tab", tab: "tools" }, readBack: "tab" }),
      host,
    );

    // The same method twice: there is no second path for a tab change to drift down.
    expect(calls.settings).toEqual([undefined, "tools"]);
  });

  it("runs the window commands when the host has them", () => {
    const { host, calls } = recordingHost(true);

    runAppIntent(executable({ kind: "intent", intent: { kind: "window.minimal" }, readBack: "thu" }), host);
    runAppIntent(executable({ kind: "intent", intent: { kind: "window.expand" }, readBack: "mở" }), host);
    runAppIntent(executable({ kind: "intent", intent: { kind: "window.minimise" }, readBack: "nhỏ" }), host);

    expect(calls.minimal).toEqual([true]);
    expect(calls.expand).toBe(1);
    expect(calls.minimise).toBe(1);
  });

  it("says a window command needs the desktop app rather than appearing to work", () => {
    const { host, calls } = recordingHost();

    for (const kind of ["window.expand", "window.minimise", "window.minimal", "app.quit"] as const) {
      const run = runAppIntent(executable({ kind: "intent", intent: { kind }, readBack: "ok" }), host);
      expect(run.ran, kind).toBe(false);
      expect(run.say, kind).toBe(NOT_DESKTOP_SAY);
    }

    // Nothing was attempted, so nothing can have half-happened.
    expect(calls).toMatchObject({ expand: 0, minimise: 0, minimal: [], quit: 0 });
  });
});

describe("what the executor will not do", () => {
  it("does not act on a question, even for an intent it could otherwise run", () => {
    const { host, calls } = recordingHost(true);

    const run = runAppIntent(
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

  it("passes a refusal back as the sentence to say, and does nothing", () => {
    const { host, calls } = recordingHost();

    const run = runAppIntent({ kind: "refused", say: "Tôi chưa hiểu câu lệnh đó." }, host);

    expect(run.ran).toBe(false);
    expect(run.say).toBe("Tôi chưa hiểu câu lệnh đó.");
    expect(calls).toMatchObject({ settings: [], home: 0, picker: 0, endVoice: 0 });
  });

  it("uses the read-back it was given, so a node can word it differently", () => {
    const { host } = recordingHost();
    const run = runAppIntent(
      executable({ kind: "intent", intent: { kind: "settings.open" }, readBack: "Mở phần cài đặt nhé." }),
      host,
    );
    expect(run.say).toBe("Mở phần cài đặt nhé.");
  });
});
