import { describe, expect, it } from "vitest";

import {
  PERSONAL_INSTRUCTIONS_HEADING,
  PERSONAL_INSTRUCTIONS_MAX_CHARS,
  composePersonalInstructions,
  hasPersonalInstructions,
} from "../src/personal-instructions.ts";

/**
 * The user's instructions as a section inside the system prompt.
 *
 * The claim under test is precedence, and it is a claim about what is *still there* rather than about
 * what was added: the product's invariants, the tool instructions and the security rules are all
 * present, and the user's text follows them. That is the whole safety story of the feature, so the
 * assertions below are mostly about the base surviving.
 *
 * The other half is that this composes rather than replaces. An empty preference must leave the prompt
 * byte-for-byte as it was, because a heading with nothing under it is something the model will try to
 * interpret, and two sections from two turns is the same bug arriving twice.
 */

/** A stand-in for the prompt the SDK assembles: product rules, then tool and security instructions. */
const BASE = [
  "You are ClarkCant.",
  "",
  "## Product invariants",
  "",
  "Conversation is the primary surface. The orb is the signature.",
  "",
  "## Tools",
  "",
  "read, search_files. Do not invent tools.",
  "",
  "## Security",
  "",
  "Never print a credential. Never bypass an OS permission prompt.",
].join("\n");

describe("the user's instructions are appended, never substituted", () => {
  it("keeps every instruction that came before, in order", () => {
    const composed = composePersonalInstructions({ base: BASE, text: "Prefer concise answers." });

    // The product, tool and security sections are all still there, and still in their original order.
    const productAt = composed.indexOf("## Product invariants");
    const toolsAt = composed.indexOf("## Tools");
    const securityAt = composed.indexOf("## Security");
    const personalAt = composed.indexOf(PERSONAL_INSTRUCTIONS_HEADING);
    expect(productAt).toBeGreaterThanOrEqual(0);
    expect(toolsAt).toBeGreaterThan(productAt);
    expect(securityAt).toBeGreaterThan(toolsAt);
    // And the user's section comes after all of them, which is the precedence the plan specifies.
    expect(personalAt).toBeGreaterThan(securityAt);
  });

  it("keeps the base text verbatim, so nothing was rewritten on the way through", () => {
    const composed = composePersonalInstructions({ base: BASE, text: "Use TypeScript." });
    expect(composed.startsWith(BASE)).toBe(true);
  });

  it("says plainly that it does not override what precedes it", () => {
    // A model given bare text under a heading may read it as operating instructions. The preamble is
    // what makes it a preference rather than a directive, and it names both limits: it does not
    // override, and it cannot grant permission.
    const composed = composePersonalInstructions({ base: BASE, text: "Always answer in Vietnamese." });
    expect(composed).toContain("do not override the instructions above");
    expect(composed).toContain("cannot grant permissions");
  });
});

describe("nothing to say means no change at all", () => {
  it("returns the base unchanged for an empty preference", () => {
    for (const text of [undefined, "", "   ", "\n\t "]) {
      expect(composePersonalInstructions({ base: BASE, text }), JSON.stringify(text)).toBe(BASE);
    }
  });

  it("does not add a heading for whitespace alone", () => {
    // An empty section is a section the model will try to interpret, which is worse than no section.
    expect(hasPersonalInstructions(composePersonalInstructions({ base: BASE, text: "  \n " }))).toBe(false);
  });

  it("is total, so a malformed preference cannot stop a turn from starting", () => {
    // The value arrives from a preference API as unvalidated data; this is a boundary that parses.
    for (const text of [null, 42, {}, [], true]) {
      expect(composePersonalInstructions({ base: BASE, text: text as never })).toBe(BASE);
    }
  });
});

describe("there is exactly one section, however many times it composes", () => {
  it("replaces its own previous section instead of stacking a second one", () => {
    const once = composePersonalInstructions({ base: BASE, text: "First version." });
    const twice = composePersonalInstructions({ base: once, text: "Second version." });

    const headings = twice.split(PERSONAL_INSTRUCTIONS_HEADING).length - 1;
    expect(headings).toBe(1);
    expect(twice).toContain("Second version.");
    expect(twice).not.toContain("First version.");
  });

  it("can be removed again by composing with nothing", () => {
    const withSection = composePersonalInstructions({ base: BASE, text: "Something." });
    expect(hasPersonalInstructions(withSection)).toBe(true);
    // Turning the toggle off has to give back the original prompt rather than leaving the section behind.
    expect(composePersonalInstructions({ base: withSection, text: undefined })).toBe(BASE);
  });

  it("survives ten composes without growing", () => {
    let prompt = BASE;
    for (let turn = 0; turn < 10; turn += 1) {
      prompt = composePersonalInstructions({ base: prompt, text: `Turn ${turn}.` });
    }
    expect(prompt.split(PERSONAL_INSTRUCTIONS_HEADING).length - 1).toBe(1);
    expect(prompt).toContain("Turn 9.");
  });
});

describe("the section is bounded at the boundary", () => {
  it("truncates text longer than the cap rather than refusing it", () => {
    // The registry refuses an over-long value on write; this is the second cap, at the boundary that
    // turns a value into prompt text, so a caller that did not come through the registry is bounded too.
    const composed = composePersonalInstructions({ base: BASE, text: "x".repeat(5_000) });
    const section = composed.slice(composed.indexOf(PERSONAL_INSTRUCTIONS_HEADING));
    expect(section.length).toBeLessThan(PERSONAL_INSTRUCTIONS_MAX_CHARS + 600);
    expect(composed.startsWith(BASE)).toBe(true);
  });

  it("keeps a value exactly at the cap", () => {
    const exact = "y".repeat(PERSONAL_INSTRUCTIONS_MAX_CHARS);
    expect(composePersonalInstructions({ base: BASE, text: exact })).toContain(exact);
  });
});

describe("the marker is one string, so the strip and the append cannot disagree", () => {
  it("detects what it writes", () => {
    const composed = composePersonalInstructions({ base: BASE, text: "anything" });
    expect(hasPersonalInstructions(composed)).toBe(true);
    expect(hasPersonalInstructions(BASE)).toBe(false);
  });
});
