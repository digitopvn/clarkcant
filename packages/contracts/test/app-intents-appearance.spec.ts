import { describe, expect, it } from "vitest";

import { CONFIRMATION_REQUIRED_KINDS, appIntentSchema, describeAppIntent } from "../src/app-intents.ts";

/**
 * The appearance kinds, as a contract.
 *
 * What is pinned is the parameter space: a theme is named by a theme reference and nothing else, a colour scheme by one
 * of three words, and neither parameter rides on another kind. None of them asks first — an appearance change is undone
 * by making it again — and each reads back what it will do.
 */

describe("appearance app intent contract", () => {
  it("accepts each kind with exactly its own parameter", () => {
    for (const intent of [
      { kind: "appearance.set-theme", themeRef: "builtin:clark" },
      { kind: "appearance.set-theme", themeRef: "package:com.example.themes#neo", themeName: "Neo" },
      { kind: "appearance.set-color-scheme", colorScheme: "dark" },
      { kind: "appearance.set-color-scheme", colorScheme: "system" },
      { kind: "appearance.reset" },
      { kind: "appearance.open-theme-gallery" },
    ]) {
      expect(appIntentSchema.safeParse(intent).success, JSON.stringify(intent)).toBe(true);
    }
  });

  it("refuses a theme that is not a theme reference", () => {
    for (const themeRef of ["neo", "https://x.test/theme.json", "package:com.example#neo; } *{", "", "builtin:Clark"]) {
      expect(appIntentSchema.safeParse({ kind: "appearance.set-theme", themeRef }).success, themeRef).toBe(false);
    }
    expect(appIntentSchema.safeParse({ kind: "appearance.set-theme" }).success).toBe(false);
    expect(
      appIntentSchema.safeParse({ kind: "appearance.set-theme", themeRef: "builtin:clark", themeName: "x".repeat(81) }).success,
    ).toBe(false);
  });

  it("refuses a colour scheme outside the three, or none", () => {
    for (const colorScheme of ["dim", "Dark", "high-contrast", ""]) {
      expect(appIntentSchema.safeParse({ kind: "appearance.set-color-scheme", colorScheme }).success, colorScheme).toBe(false);
    }
    expect(appIntentSchema.safeParse({ kind: "appearance.set-color-scheme" }).success).toBe(false);
  });

  it("refuses a parameter carried by a kind it does not belong to", () => {
    for (const intent of [
      { kind: "appearance.reset", themeRef: "builtin:clark" },
      { kind: "appearance.open-theme-gallery", colorScheme: "dark" },
      { kind: "appearance.set-theme", themeRef: "builtin:clark", colorScheme: "dark" },
      { kind: "appearance.set-color-scheme", colorScheme: "dark", themeRef: "builtin:clark" },
      { kind: "appearance.set-color-scheme", colorScheme: "dark", themeName: "Neo" },
      { kind: "settings.open", themeRef: "builtin:clark" },
      { kind: "orb.select", orbProfile: "calm", colorScheme: "light" },
    ]) {
      expect(appIntentSchema.safeParse(intent).success, JSON.stringify(intent)).toBe(false);
    }
  });

  it("never asks first, and reads back what it will do in both languages", () => {
    for (const kind of ["appearance.set-theme", "appearance.set-color-scheme", "appearance.reset", "appearance.open-theme-gallery"] as const) {
      expect(CONFIRMATION_REQUIRED_KINDS.includes(kind), kind).toBe(false);
    }
    expect(describeAppIntent({ kind: "appearance.set-theme", themeRef: "package:x#neo", themeName: "Neo" })).toContain("Neo");
    expect(describeAppIntent({ kind: "appearance.set-theme", themeRef: "package:x#neo", themeName: "Neo" }, "en")).toContain("Neo");
    // Named by its reference when the node has not filled in a name.
    expect(describeAppIntent({ kind: "appearance.set-theme", themeRef: "package:x#neo" }, "en")).toContain("package:x#neo");
    expect(describeAppIntent({ kind: "appearance.set-color-scheme", colorScheme: "dark" })).toContain("tối");
    expect(describeAppIntent({ kind: "appearance.set-color-scheme", colorScheme: "light" }, "en")).toContain("light");
    expect(describeAppIntent({ kind: "appearance.reset" }, "en")).toContain("Clark Default");
  });
});
