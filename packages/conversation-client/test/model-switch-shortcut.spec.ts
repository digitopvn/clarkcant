import { describe, expect, it } from "vitest";

import { modelSwitchShortcut } from "../src/use-model-alias.ts";

describe("the model switch hint", () => {
  it("spells the hotkey with the Command key on Apple platforms", () => {
    expect(modelSwitchShortcut("MacIntel")).toBe("⌘]");
    expect(modelSwitchShortcut("iPad")).toBe("⌘]");
  });

  it("spells it with Ctrl everywhere else, including when the platform is unknown", () => {
    expect(modelSwitchShortcut("Win32")).toBe("Ctrl+]");
    expect(modelSwitchShortcut("Linux x86_64")).toBe("Ctrl+]");
    expect(modelSwitchShortcut(undefined)).toBe("Ctrl+]");
  });
});
