import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MESSAGES_EN, MESSAGES_VI } from "../src/i18n/messages.ts";
import { RENDERER_IDS } from "../src/renderers.tsx";

/**
 * The action button knows what to show and nothing about what it does.
 *
 * The repo has no DOM test environment, so what a press does is asserted in the browser journey. What is asserted here
 * is structural and is the part a later edit could quietly break: neither the renderer nor the hook that wires it reads
 * the kind of action behind a button. A branch on kind in either would make a button's look or behaviour depend on
 * something the host is meant to decide alone.
 */

const SOURCE = join(import.meta.dirname, "..", "src");

/** The body of one top-level function, from its declaration to the next top-level declaration or comment block. */
function functionBody(file: string, name: string): string {
  const text = readFileSync(join(SOURCE, file), "utf8");
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is not in ${file}`);
  const rest = text.slice(start);
  const end = rest.search(/\n(?:\/\*|function |export |const [A-Z_]+ =)/u);
  return end < 0 ? rest : rest.slice(0, end);
}

const KIND_WORDS = /\bkind\b|"invoke"|"agent"|"workflow"|"view\.save"|capabilityRef|proposal/u;

describe("the action button", () => {
  it("is in the catalog, beside the call to action that history still renders", () => {
    expect(RENDERER_IDS).toContain("canvas.action@1");
    expect(RENDERER_IDS).toContain("canvas.cta@1");
  });

  it("has no branch on the kind of action it is bound to", () => {
    const renderer = functionBody("renderers.tsx", "ActionButton");
    expect(renderer).toContain('onAction?.("activate", {})');
    expect(renderer).not.toMatch(KIND_WORDS);
  });

  it("is wired to its binding without the hook reading the binding's kind either", () => {
    const hook = readFileSync(join(SOURCE, "use-surface-renderer.tsx"), "utf8");
    const wiring = hook.slice(hook.indexOf("const [actionRuns, setActionRuns]"), hook.indexOf("return useCallback("));
    expect(wiring).toContain("client\n        .invokeAction(");
    expect(wiring).not.toMatch(KIND_WORDS);
  });

  it("says every reason a button can be unavailable in both languages", () => {
    const keys = Object.keys(MESSAGES_VI).filter((key) => key.startsWith("widgets.action."));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(MESSAGES_EN[key as keyof typeof MESSAGES_EN], key).toBeTruthy();
    }
    expect(keys).toContain("widgets.action.unavailable.WORKFLOW_UNSUPPORTED");
    expect(keys).toContain("widgets.action.unavailable.BINDING_STALE");
  });
});
