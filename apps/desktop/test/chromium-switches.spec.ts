import { describe, expect, it } from "vitest";

import { applyChromiumSwitches, disabledFeaturesValue } from "../src/chromium-switches.mjs";

/**
 * The shell turns Chromium's Windows port randomization off without dropping any feature someone else disabled.
 *
 * Chromium keeps only the last `--disable-features` value, so a second switch that named only this feature would
 * silently re-enable everything the first one turned off.
 */
describe("the desktop shell's Chromium switches", () => {
  it("disables port randomization on Windows when nothing else is disabled", () => {
    expect(disabledFeaturesValue("", "win32")).toBe("TcpPortRandomizationWin");
  });

  it("keeps the features already on the command line and adds port randomization last", () => {
    expect(disabledFeaturesValue("PaintHolding,HttpsUpgrades", "win32")).toBe("PaintHolding,HttpsUpgrades,TcpPortRandomizationWin");
  });

  it("drops empty and padded entries from the list it extends", () => {
    expect(disabledFeaturesValue(" PaintHolding,,HttpsUpgrades, ", "win32")).toBe("PaintHolding,HttpsUpgrades,TcpPortRandomizationWin");
  });

  it("changes nothing when the feature is already disabled", () => {
    expect(disabledFeaturesValue("PaintHolding,TcpPortRandomizationWin", "win32")).toBeUndefined();
  });

  it.each(["darwin", "linux"])("changes nothing on %s, where the feature does not exist", (platform) => {
    expect(disabledFeaturesValue("PaintHolding", platform)).toBeUndefined();
  });

  it("appends one merged switch to Electron's command line", () => {
    const appended: [string, string | undefined][] = [];
    const commandLine = {
      getSwitchValue: (name: string): string => (name === "disable-features" ? "PaintHolding" : ""),
      appendSwitch: (name: string, value?: string): void => {
        appended.push([name, value]);
      },
    };
    applyChromiumSwitches(commandLine, "win32");
    expect(appended).toEqual([["disable-features", "PaintHolding,TcpPortRandomizationWin"]]);
  });

  it("appends nothing off Windows", () => {
    const appended: string[] = [];
    applyChromiumSwitches({ getSwitchValue: () => "", appendSwitch: (name: string) => void appended.push(name) }, "linux");
    expect(appended).toEqual([]);
  });
});
