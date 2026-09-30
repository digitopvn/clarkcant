import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { type AppIntent, type AppIntentDecision, type ColorScheme } from "@clarkcant/contracts";

import { runAppIntent, type AppIntentHost } from "../src/app-intents.ts";
import { MESSAGES_VI } from "../src/i18n/messages.ts";

/**
 * The appearance intents, carried out.
 *
 * Text, voice and the agent's `control_app` all arrive here as the same decision and end in the same host call; the
 * theme picker's click and the host's `setTheme` then store through the same preference write. What is pinned: each
 * kind reaches the method that means it, a host without one refuses with a sentence instead of reporting success, and a
 * decision naming no theme changes nothing.
 */

interface Calls {
  themes: [string, string | undefined][];
  schemes: ColorScheme[];
  resets: number;
  galleries: number;
}

function appearanceHost(): { host: AppIntentHost; calls: Calls } {
  const calls: Calls = { themes: [], schemes: [], resets: 0, galleries: 0 };
  const host: AppIntentHost = {
    openSettings: () => undefined,
    goHome: () => undefined,
    openFilePicker: () => undefined,
    endVoice: () => undefined,
    setTheme: async (themeRef, themeName) => {
      calls.themes.push([themeRef, themeName]);
      return `now ${themeName ?? themeRef}`;
    },
    setColorScheme: (scheme) => {
      calls.schemes.push(scheme);
    },
    resetAppearance: () => {
      calls.resets += 1;
    },
    openThemeGallery: () => {
      calls.galleries += 1;
    },
  };
  return { host, calls };
}

function decided(intent: AppIntent, controlId?: string): AppIntentDecision {
  return { kind: "intent", intent, requiresConfirmation: false, readBack: "", ...(controlId === undefined ? {} : { controlId }) };
}

const NEO = "package:com.example.themes#neo";

describe("carrying out an appearance intent", () => {
  it("sends each kind to the host method that means it, and says what the host said", async () => {
    const { host, calls } = appearanceHost();
    const theme = await runAppIntent(decided({ kind: "appearance.set-theme", themeRef: NEO, themeName: "Neo" }), host);
    expect(theme).toEqual({ ran: true, say: "now Neo" });
    expect((await runAppIntent(decided({ kind: "appearance.set-color-scheme", colorScheme: "dark" }), host)).ran).toBe(true);
    expect((await runAppIntent(decided({ kind: "appearance.reset" }), host)).ran).toBe(true);
    expect((await runAppIntent(decided({ kind: "appearance.open-theme-gallery" }), host)).ran).toBe(true);
    expect(calls).toEqual({ themes: [[NEO, "Neo"]], schemes: ["dark"], resets: 1, galleries: 1 });
  });

  it("carries out a typed, spoken and agent-issued theme change through the one call", async () => {
    // Typed and spoken decisions are the same object by the time they reach the page; the agent's carries its id.
    const { host, calls } = appearanceHost();
    const intent: AppIntent = { kind: "appearance.set-theme", themeRef: NEO, themeName: "Neo" };
    const typed = await runAppIntent(decided(intent), host);
    const agent = await runAppIntent(decided(intent, "ctl_1"), host);
    expect(agent).toEqual(typed);
    expect(calls.themes).toEqual([[NEO, "Neo"], [NEO, "Neo"]]);
  });

  it("refuses with a sentence on a host that cannot change the appearance, rather than reporting it done", async () => {
    const host: AppIntentHost = { openSettings: () => undefined, goHome: () => undefined, openFilePicker: () => undefined, endVoice: () => undefined };
    for (const intent of [
      { kind: "appearance.set-theme", themeRef: NEO },
      { kind: "appearance.set-color-scheme", colorScheme: "light" },
      { kind: "appearance.reset" },
      { kind: "appearance.open-theme-gallery" },
    ] satisfies AppIntent[]) {
      expect(await runAppIntent(decided(intent), host), intent.kind).toEqual({ ran: false, say: MESSAGES_VI["shell.intent.notAppearance"] });
    }
  });

  it("changes nothing for a decision that names no theme or no scheme", async () => {
    const { host, calls } = appearanceHost();
    const theme = await runAppIntent(decided({ kind: "appearance.set-theme" }), host);
    const scheme = await runAppIntent(decided({ kind: "appearance.set-color-scheme" }), host);
    expect(theme).toEqual({ ran: false, say: MESSAGES_VI["shell.intent.themeMissing"] });
    expect(scheme.ran).toBe(false);
    expect(calls).toEqual({ themes: [], schemes: [], resets: 0, galleries: 0 });
  });

  it("reports a refused theme as not done, in the host's own sentence", async () => {
    const { host } = appearanceHost();
    host.setTheme = async () => Promise.reject(new Error("Neo would hide Stop."));
    expect(await runAppIntent(decided({ kind: "appearance.set-theme", themeRef: NEO }), host)).toEqual({
      ran: false,
      say: "Neo would hide Stop.",
    });
  });
});

describe("one write for every way of choosing a theme", () => {
  /*
   * Read from source because the two call sites are React components with a live node behind them. The claim is narrow
   * and exact: the picker's click and the intent host store the same preference key, so the node's audit and storage
   * run once, on one route (`PUT /preferences/experience.themeRef`), whichever way the person asked.
   */
  const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

  it("stores the picker's choice and the intent's choice under the same preference", () => {
    const picker = source("../src/settings/ThemeSettings.tsx");
    expect(picker).toMatch(/const choose = \(ref: string\): void =>\s*\{\s*prefs\.write\("experience\.themeRef", ref/);
    expect(picker).toMatch(/onChoose=\{\(\) => choose\(theme\.themeRef\)\}/);
    expect(picker).toMatch(/onClick=\{\(\) => choose\(previewRef\)\}/);
    const conversation = source("../src/Conversation.tsx");
    const writes = [...conversation.matchAll(/client\.writePreference\("experience\.themeRef", ref\)/g)];
    // `setTheme` and `resetAppearance`.
    expect(writes).toHaveLength(2);
    // Light and dark go through the same call the Settings control makes.
    expect(conversation).toMatch(/setColorScheme: applyThemeChoice/);
    expect(conversation).toMatch(/onThemeChoice=\{applyThemeChoice\}/);
  });
});
