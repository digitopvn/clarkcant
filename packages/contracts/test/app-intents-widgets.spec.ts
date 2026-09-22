import { describe, expect, it } from "vitest";

import { appIntentSchema, describeAppIntent } from "../src/app-intents.ts";

/**
 * The widget kinds, as a contract.
 *
 * The parameter space is the thing worth pinning down: a target is either a capability-shaped
 * definition reference or a bare catalog family word, and neither is allowed on `widgets.open`. That
 * is what keeps "open the library" and "show this widget" from quietly becoming a scripting surface.
 */

describe("widget app intent contract", () => {
  it("accepts widgets.open with no target", () => {
    expect(appIntentSchema.safeParse({ kind: "widgets.open" }).success).toBe(true);
  });

  it("accepts widgets.show naming a definition", () => {
    expect(appIntentSchema.safeParse({ kind: "widgets.show", definitionId: "canvas.calendar@1" }).success).toBe(
      true,
    );
  });

  it("accepts widgets.show naming a family", () => {
    expect(appIntentSchema.safeParse({ kind: "widgets.show", family: "media" }).success).toBe(true);
  });

  it("refuses a target on widgets.open", () => {
    expect(appIntentSchema.safeParse({ kind: "widgets.open", definitionId: "canvas.calendar@1" }).success).toBe(
      false,
    );
    expect(appIntentSchema.safeParse({ kind: "widgets.open", family: "media" }).success).toBe(false);
  });

  it("refuses a definition id that is not capability-shaped", () => {
    expect(appIntentSchema.safeParse({ kind: "widgets.show", definitionId: "calendar" }).success).toBe(false);
    expect(appIntentSchema.safeParse({ kind: "widgets.show", definitionId: "canvas.calendar" }).success).toBe(false);
  });

  it("refuses a family that is not a catalog family word", () => {
    expect(appIntentSchema.safeParse({ kind: "widgets.show", family: "Media!" }).success).toBe(false);
    expect(appIntentSchema.safeParse({ kind: "widgets.show", family: "a" }).success).toBe(false);
  });

  it("still refuses a tab change that names no tab", () => {
    expect(appIntentSchema.safeParse({ kind: "settings.tab" }).success).toBe(false);
  });

  it("reads back a sentence for both kinds", () => {
    expect(describeAppIntent({ kind: "widgets.open" })).toContain("thư viện widget");
    expect(describeAppIntent({ kind: "widgets.show", definitionId: "canvas.calendar@1" })).toContain(
      "canvas.calendar@1",
    );
    expect(describeAppIntent({ kind: "widgets.show", family: "media" })).toContain("media");
  });
});
