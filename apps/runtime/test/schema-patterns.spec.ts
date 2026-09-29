import { describe, expect, it } from "vitest";

import { validateArgs } from "../src/application/capability-invoke.ts";
import {
  describeUnsafePattern,
  MAX_PATTERN_INPUT_LENGTH,
  MAX_PATTERN_LENGTH,
  overlongPatternInput,
  unsafePatternReason,
  unsafeSchemaPattern,
} from "@clarkcant/contracts";

/**
 * Which patterns a package's schema may ask the node to run.
 *
 * The node checks every call against a service's input schema, and every widget's props against its props schema, on its
 * main thread, and the JavaScript engine backtracks, so a pattern that can backtrack without bound must never reach it.
 * The checker lives in `@clarkcant/contracts`; the tests of `validateArgs` in front of it stay beside the runtime.
 */

/** Long enough that a backtracking pattern would not finish, short enough to be a plausible argument. */
const EVIL_INPUT = `${"a".repeat(49)}!`;
/** Refusing an unsafe schema is a walk and a parse; this is far above that and far below a stall. */
const BUDGET_MS = 1000;

describe("a pattern that can backtrack without bound", () => {
  it.each([
    ["^(a+)+$", "more than one way"],
    ["(a*)*", "more than one way"],
    ["^(\\d+)*$", "more than one way"],
    ["^(\\w+\\s?)*$", "more than one way"],
    ["(a?a)+", "more than one way"],
    ["(.*a){20}", "more than one way"],
    ["(a{1,10}){1,10}", "more than one way"],
    ["(?:x|(a+))+", "more than one way"],
    ["(a|a)*", "can start with the same character"],
    ["^(a|ab)+$", "can start with the same character"],
    ["((a|a){3})+", "can start with the same character"],
    ["\\d+\\d+x", "two repetitions in a row"],
    [".*.*=.*", "two repetitions in a row"],
    ["\\w*\\s*\\w*!", "two repetitions in a row"],
    ["(a)\\1", "refers back"],
    ["(?<word>a)\\k<word>", "refers back"],
    ["^(?=a+)b$", "lookahead or lookbehind"],
    ["(?<!b*)c", "lookahead or lookbehind"],
    ["(a", "this node can read"],
    ["a{3,1}", "this node can read"],
    ["(?i:a)", "this node can read"],
  ])("refuses %s", (pattern, why) => {
    expect(unsafePatternReason(pattern)).toContain(why);
  });

  it("refuses one longer than the bound, even when it is plain", () => {
    expect(unsafePatternReason("a".repeat(MAX_PATTERN_LENGTH))).toBeUndefined();
    expect(unsafePatternReason("a".repeat(MAX_PATTERN_LENGTH + 1))).toContain(`longer than ${String(MAX_PATTERN_LENGTH)}`);
  });
});

describe("a pattern the check lets through", () => {
  it.each([
    "",
    "abc",
    "^[a-z0-9-]+$",
    "^\\d{4}-\\d{2}-\\d{2}$",
    "^[a-z0-9]+(-[a-z0-9]+)*$",
    "^([a-z0-9]+\\.)*[a-z0-9]+$",
    "^https?://\\S+$",
    "^\\d{1,3}(\\.\\d{1,3}){3}$",
    "^(\\d{1,3}\\.?){4}$",
    "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
    "^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$",
    "^#[0-9a-fA-F]{6}$",
    "^[A-Z][a-z]*( [A-Z][a-z]*)*$",
    "^(foo|bar)+$",
    "^\\s*\\S+\\s*$",
    "^.*\\.json$",
    "^(?:\\+?\\d{1,3})?[-. ]?\\d{3}$",
    "^[\\u0041-\\u005a]{2}$",
    "a{2,}}]",
    "^(?<year>\\d{4})$",
    "^(?!admin$)[a-z]+$",
  ])("allows %s", (pattern) => {
    expect(unsafePatternReason(pattern)).toBeUndefined();
    // Whatever it lets through is a pattern the node's engine reads.
    expect(() => new RegExp(pattern)).not.toThrow();
  });
});

describe("what a refusal tells the author to write instead", () => {
  it.each([
    ["^(a+)+$", "instead of (a+)+", ["a+", "\\w+(\\s\\w+)*"]],
    ["^(ab|ac)+$", "Factor the common start out", ["(ab?)+", "(a[bc])+"]],
    ["\\d+\\d+x", "Merge the two repetitions", ["\\d{2,}x"]],
    ["(a)\\1", "Spell the repeated part out", []],
    ["^(?=.*\\d)(?=.*[a-z]).{8,}$", "Split each lookahead into a separate check", ["\\d", "[a-z]", "^.{8,}$"]],
    ["(a", "regular expression syntax", []],
    ["a".repeat(MAX_PATTERN_LENGTH + 1), "Shorten it", []],
  ] as const)("says what to write for %s, and what it suggests is let through", (pattern, advice, suggested) => {
    const found = unsafeSchemaPattern({ pattern });
    if (found === undefined) throw new Error(`${pattern} was not refused`);
    expect(describeUnsafePattern(found)).toContain(advice);
    for (const each of suggested) expect(unsafePatternReason(each)).toBeUndefined();
  });

  it("says what to write for a pattern that is not text and a schema nested too deep", () => {
    expect(describeUnsafePattern({ at: "pattern", pattern: "1", why: "is not text" })).toContain("Make the pattern a string");
    let schema: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 100; depth += 1) schema = { items: schema };
    const deep = unsafeSchemaPattern(schema);
    if (deep === undefined) throw new Error("not refused");
    expect(describeUnsafePattern(deep)).toContain("Flatten the schema");
  });
});

describe("where in a schema a pattern is looked for", () => {
  const evil = "^(a+)+$";
  it.each([
    [{ type: "string", pattern: evil }, "pattern"],
    [{ properties: { name: { type: "string", pattern: evil } } }, "properties.name.pattern"],
    [{ properties: { tags: { items: { pattern: evil } } } }, "properties.tags.items.pattern"],
    [{ items: [{ type: "number" }, { pattern: evil }] }, "items[1].pattern"],
    [{ prefixItems: [{ pattern: evil }] }, "prefixItems[0].pattern"],
    [{ patternProperties: { [evil]: { type: "string" } } }, `patternProperties[${JSON.stringify(evil)}]`],
    [{ patternProperties: { "^x-": { pattern: evil } } }, `patternProperties[${JSON.stringify("^x-")}].pattern`],
    [{ propertyNames: { pattern: evil } }, "propertyNames.pattern"],
    [{ $defs: { word: { pattern: evil } } }, "$defs.word.pattern"],
    [{ definitions: { word: { pattern: evil } } }, "definitions.word.pattern"],
    [{ additionalProperties: { pattern: evil } }, "additionalProperties.pattern"],
    [{ anyOf: [{ type: "number" }, { pattern: evil }] }, "anyOf[1].pattern"],
    [{ allOf: [{ not: { pattern: evil } }] }, "allOf[0].not.pattern"],
    [{ oneOf: [{ contains: { pattern: evil } }] }, "oneOf[0].contains.pattern"],
  ])("finds it in %j", (schema, at) => {
    expect(unsafeSchemaPattern(schema)).toMatchObject({ at, pattern: evil });
  });

  it("does not read data as schema, and refuses a pattern that is not text", () => {
    expect(unsafeSchemaPattern({ type: "object", default: { pattern: evil }, examples: [{ pattern: evil }] })).toBeUndefined();
    expect(unsafeSchemaPattern({ properties: { pattern: { type: "string" } } })).toBeUndefined();
    // The validator would turn the list into the text "^(a+)+$".
    expect(unsafeSchemaPattern({ pattern: [evil] })).toMatchObject({ at: "pattern", why: "is not text" });
  });

  it("refuses a schema nested deeper than it walks", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 100; depth += 1) schema = { items: schema };
    expect(unsafeSchemaPattern(schema)?.why).toContain("nested more than");
  });
});

describe("the check in front of every call", () => {
  it("refuses an unsafe schema within a fixed time, whatever the input", () => {
    for (const schema of [
      { type: "object", properties: { text: { type: "string", pattern: "^(a+)+$" } } },
      { type: "object", patternProperties: { "^(a+)+$": { type: "string" } } },
      { type: "object", propertyNames: { $ref: "#/$defs/name" }, $defs: { name: { pattern: "^(a|aa)+$" } } },
    ]) {
      const started = performance.now();
      const checked = validateArgs(schema, { text: EVIL_INPUT, [EVIL_INPUT]: "x" });
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
      expect(checked).toMatchObject({ ok: false });
      if (checked.ok) throw new Error("unreachable");
      expect(checked.message).toContain("input schema was refused");
    }
  });

  it("still checks a safe pattern", () => {
    const schema = { type: "object", properties: { id: { type: "string", pattern: "^[a-z]+$" } } };
    expect(validateArgs(schema, { id: "abc" })).toEqual({ ok: true });
    expect(validateArgs(schema, { id: "ABC" })).toMatchObject({ ok: false });
  });

  it("refuses a value or key longer than the bound only where a pattern would run on it", () => {
    const long = "a".repeat(MAX_PATTERN_INPUT_LENGTH + 1);
    const schema = {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^[a-z]+$" },
        body: { type: "string" },
        tags: { type: "array", items: { $ref: "#/$defs/tag" } },
        extra: { type: "object", patternProperties: { "^[a-z]+$": { type: "string" } } },
        named: { type: "object", propertyNames: { pattern: "^[a-z]+$" } },
      },
      $defs: { tag: { type: "string", pattern: "^[a-z]+$" } },
    };
    expect(overlongPatternInput(schema, { body: long })).toBeUndefined();
    expect(validateArgs(schema, { body: long })).toEqual({ ok: true });
    expect(overlongPatternInput(schema, { id: "a".repeat(MAX_PATTERN_INPUT_LENGTH) })).toBeUndefined();
    expect(overlongPatternInput(schema, { id: long })).toBe("id");
    expect(overlongPatternInput(schema, { tags: ["ok", long] })).toBe("tags[1]");
    expect(overlongPatternInput(schema, { extra: { [long]: "x" } })).toContain("(its name)");
    expect(overlongPatternInput(schema, { named: { [long]: 1 } })).toContain("(its name)");
    const refused = validateArgs(schema, { id: long });
    expect(refused).toMatchObject({ ok: false });
    if (refused.ok) throw new Error("unreachable");
    expect(refused.message).toContain(`longer than the ${String(MAX_PATTERN_INPUT_LENGTH)} characters`);
  });
});
