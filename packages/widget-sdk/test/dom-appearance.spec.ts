import { describe, expect, it } from "vitest";
import { compileAppearance, appearanceDeclarations } from "@clarkcant/design-tokens";
import { applyAppearanceToElement, type AppearanceElement } from "../src/dom.ts";

describe("the optional appearance DOM adapter", () => {
  it("uses the compiler's closed variables, clears old identity and refuses arbitrary styling before writing", () => {
    const values = new Map<string, string>();
    const attributes = new Map<string, string>();
    const element: AppearanceElement = { style: {
      setProperty: (name, value) => { values.set(name, value); },
      removeProperty: (name) => { const previous = values.get(name) ?? ""; values.delete(name); return previous; },
    }, setAttribute: (name, value) => { attributes.set(name, value); } };
    const dark = compileAppearance({ scheme: "dark" });
    values.set("--cc-button-press", "translate(20px)");
    values.set("--author-kept", "kept");
    applyAppearanceToElement(element, dark);
    for (const [name, value] of Object.entries(appearanceDeclarations(dark))) expect(values.get(name), name).toBe(value);
    expect(values.get("--author-kept")).toBe("kept");
    expect(attributes.get("data-cc-theme")).toBe("dark");
    expect(attributes.get("data-cc-appearance")).toBe(dark.revision);
    const previous = [...values];
    expect(() => applyAppearanceToElement(element, { ...dark, tokens: { ...dark.tokens, color: { ...dark.tokens.color, canvas: "url(https://bad.test)" } } })).toThrow();
    expect([...values]).toEqual(previous);
    const reduced = compileAppearance({ scheme: "light", reducedMotion: true });
    applyAppearanceToElement(element, reduced);
    expect(values.get("--cc-motion-micro")).toBe("0ms");
    expect(reduced.tokens.motion.micro).toBe(reduced.tokens.motionReduced.micro);
    expect(reduced.revision).not.toBe(compileAppearance({ scheme: "light" }).revision);
  });
});
