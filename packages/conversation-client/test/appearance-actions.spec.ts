import { describe, expect, it, vi } from "vitest";

import { type AppearanceFallbackCode, type AppearanceResponse, BUILTIN_CLARK_THEME_REF } from "@clarkcant/contracts";

import { GatewayError } from "../src/api.ts";
import { appearanceFallbackKey, chooseThemeShown, resetAppearanceShown, type ThemeSelection } from "../src/appearance-actions.ts";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";
import type { AppearanceRead } from "../src/use-appearance.ts";

/**
 * Choosing a theme from a sentence, a voice command or the agent.
 *
 * The claim is that the person is told what the screen shows: "done" only once the redraw draws the theme they asked
 * for, a refusal said as a refusal, and a theme that was stored but not drawn said as that, with the reason.
 */

const NEO = "package:com.example.themes#neo";
const en = (key: MessageKey): string => MESSAGES_EN[key];
const vn = (key: MessageKey): string => MESSAGES_VI[key];

function drawn(appliedRef: string, fallback?: AppearanceFallbackCode): AppearanceRead {
  const appearance: AppearanceResponse = {
    selectedRef: NEO,
    appliedRef,
    theme: null,
    provider: { kind: "builtin" },
    fallback: fallback === undefined ? null : { code: fallback, message: "for logs" },
  };
  return { appearance, localProblem: undefined };
}

function selection(overrides: Partial<ThemeSelection> = {}): ThemeSelection {
  return {
    write: vi.fn(async () => ({})),
    refresh: vi.fn(async () => drawn(NEO)),
    t: en,
    ...overrides,
  };
}

async function refusal(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the action to be refused");
}

describe("choosing a theme", () => {
  it("stores the theme, redraws, and says so only once it is drawn", async () => {
    const actions = selection();
    await expect(chooseThemeShown(NEO, "Neo", actions)).resolves.toBe("The appearance is now Neo.");
    expect(actions.write).toHaveBeenCalledWith(NEO);
    expect(actions.refresh).toHaveBeenCalledTimes(1);
    // In the reader's language, named by its reference when no name came with it.
    await expect(chooseThemeShown(NEO, undefined, selection({ t: vn }))).resolves.toBe(`Đã đổi giao diện sang ${NEO}.`);
  });

  it("says a theme the node refused to store as unsafe is refused, and does not redraw", async () => {
    for (const code of ["THEME_PROTECTED", "THEME_LOW_CONTRAST"]) {
      const actions = selection({ write: vi.fn(async () => Promise.reject(new GatewayError(409, code, "hidden approval"))) });
      const message = await refusal(chooseThemeShown(NEO, "Neo", actions));
      expect(message, code).toContain("Neo");
      expect(message).not.toContain(code);
      expect(message).not.toContain("{");
      expect(actions.refresh).not.toHaveBeenCalled();
    }
  });

  it("says a write that failed for any other reason in the node's own sentence, without its code", async () => {
    const actions = selection({ write: vi.fn(async () => Promise.reject(new GatewayError(503, "NODE_BUSY", "the node is restarting"))) });
    const message = await refusal(chooseThemeShown(NEO, "Neo", actions));
    expect(message).toContain("the node is restarting");
    expect(message).not.toContain("NODE_BUSY");
  });

  it("says a theme the node would not store in the reader's language, not in the node's English", async () => {
    for (const code of ["THEME_NOT_INSTALLED", "THEME_INVALID", "THEME_UNAVAILABLE", "THEME_UNKNOWN"]) {
      const english = `that theme cannot be drawn here, so it was not chosen: no installed package provides ${NEO}`;
      const actions = selection({ t: vn, write: vi.fn(async () => Promise.reject(new GatewayError(409, code, english))) });
      const message = await refusal(chooseThemeShown(NEO, "Neo", actions));
      expect(message, code).toContain("Neo");
      expect(message, code).not.toContain("cannot be drawn");
      expect(message, code).not.toContain(NEO);
      expect(message, code).not.toContain(code);
      expect(message, code).not.toContain("{");
    }
  });

  it("says a fallback this build does not know in a generic sentence, not a missing message", async () => {
    // A newer node's code, which this page's contract does not list.
    const unknown: AppearanceRead = {
      appearance: { ...drawn(BUILTIN_CLARK_THEME_REF).appearance, fallback: { code: "THEME_FROM_THE_FUTURE" as AppearanceFallbackCode, message: "for logs" } },
      localProblem: undefined,
    };
    const message = await refusal(chooseThemeShown(NEO, "Neo", selection({ t: vn, refresh: vi.fn(async () => unknown) })));
    expect(message).toContain(MESSAGES_VI["settings.experience.themePicker.fallback.other"]);
    expect(appearanceFallbackKey("THEME_FROM_THE_FUTURE")).toBe("settings.experience.themePicker.fallback.other");
    expect(appearanceFallbackKey("toString")).toBe("settings.experience.themePicker.fallback.other");
    expect(appearanceFallbackKey("THEME_PROTECTED")).toBe("settings.experience.themePicker.fallback.protected");
  });

  it("says a theme that was stored but could not be redrawn is stored, not shown", async () => {
    const message = await refusal(chooseThemeShown(NEO, "Neo", selection({ refresh: vi.fn(async () => undefined) })));
    expect(message).toContain("Neo");
    expect(message).not.toBe(MESSAGES_EN["shell.intent.themeChanged"].replace("{name}", "Neo"));
  });

  it("says why Clark Default is drawn instead, in the theme picker's own sentence", async () => {
    const message = await refusal(chooseThemeShown(NEO, "Neo", selection({ refresh: vi.fn(async () => drawn(BUILTIN_CLARK_THEME_REF, "THEME_PROTECTED")) })));
    expect(message).toContain(MESSAGES_EN["settings.experience.themePicker.fallback.protected"]);
    expect(message).toContain("Neo");
  });

  it("says a theme this page refused to draw is not shown, even when the node drew it", async () => {
    const read: AppearanceRead = { ...drawn(NEO), localProblem: { message: "contrast" } };
    const message = await refusal(chooseThemeShown(NEO, "Neo", selection({ refresh: vi.fn(async () => read) })));
    expect(message).toContain(MESSAGES_EN["shell.intent.themeLocalRefused"]);
  });
});

describe("resetting the appearance", () => {
  it("stores Clark Default first, then follows the system for light and dark", async () => {
    const order: string[] = [];
    await resetAppearanceShown({
      write: vi.fn(async (ref: string) => {
        order.push(`write ${ref}`);
      }),
      refresh: vi.fn(async () => {
        order.push("refresh");
        return drawn(BUILTIN_CLARK_THEME_REF);
      }),
      applyColorScheme: (scheme) => order.push(`scheme ${scheme}`),
      t: en,
    });
    expect(order).toEqual([`write ${BUILTIN_CLARK_THEME_REF}`, "refresh", "scheme system"]);
  });

  it("leaves light and dark alone when Clark Default could not be stored", async () => {
    const applyColorScheme = vi.fn();
    await expect(
      resetAppearanceShown({
        write: vi.fn(async () => Promise.reject(new GatewayError(503, "NODE_BUSY", "down"))),
        refresh: vi.fn(async () => drawn(BUILTIN_CLARK_THEME_REF)),
        applyColorScheme,
        t: en,
      }),
    ).rejects.toThrow();
    expect(applyColorScheme).not.toHaveBeenCalled();
  });
});
