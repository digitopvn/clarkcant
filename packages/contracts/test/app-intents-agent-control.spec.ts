import { describe, expect, it } from "vitest";

import { appIntentSchema, appIntentSourceSchema, describeAppIntent } from "../src/app-intents.ts";
import { ORB_PROFILE_NAMES } from "../src/preferences.ts";

/**
 * The kinds and source values issue #129 adds so the main agent and the voice agent can reach the same
 * semantic app-control vocabulary a click and a typed command already reach.
 *
 * `model.select` is the interesting shape: it must carry a `modelAlias` and nothing else may, because
 * the whole point of the alias is that it names a *configured* profile rather than letting a caller pass
 * an arbitrary provider/model string through the contract.
 */

describe("agent-control app intent contract", () => {
  it("accepts the new navigation and voice kinds with no parameters", () => {
    for (const kind of ["voice.open", "nav.conversation", "model.cycle"] as const) {
      expect(appIntentSchema.safeParse({ kind }).success).toBe(true);
    }
  });

  it("accepts model.select naming a configured alias", () => {
    const parsed = appIntentSchema.safeParse({ kind: "model.select", modelAlias: "fast" });
    expect(parsed.success).toBe(true);
  });

  it("refuses model.select with no alias", () => {
    expect(appIntentSchema.safeParse({ kind: "model.select" }).success).toBe(false);
  });

  it("refuses a modelAlias on any other kind", () => {
    expect(appIntentSchema.safeParse({ kind: "model.cycle", modelAlias: "fast" }).success).toBe(false);
    expect(appIntentSchema.safeParse({ kind: "nav.home", modelAlias: "fast" }).success).toBe(false);
  });

  it("reads back a distinct sentence for every new kind, naming the alias for model.select", () => {
    const sentences = new Set<string>();
    for (const intent of [
      { kind: "voice.open" as const },
      { kind: "nav.conversation" as const },
      { kind: "model.cycle" as const },
      { kind: "model.select" as const, modelAlias: "fast" },
    ]) {
      const said = describeAppIntent(intent);
      expect(said.length).toBeGreaterThan(0);
      sentences.add(said);
    }
    expect(sentences.size).toBe(4);
    expect(describeAppIntent({ kind: "model.select", modelAlias: "fast" })).toContain("fast");
  });

  it("accepts orb.select naming a style the registry knows", () => {
    for (const orbProfile of ORB_PROFILE_NAMES) {
      expect(appIntentSchema.safeParse({ kind: "orb.select", orbProfile }).success, orbProfile).toBe(true);
    }
  });

  it("refuses orb.select with no style, or with a style the registry does not know", () => {
    expect(appIntentSchema.safeParse({ kind: "orb.select" }).success).toBe(false);
    expect(appIntentSchema.safeParse({ kind: "orb.select", orbProfile: "aurora" }).success).toBe(false);
    // A style is a closed name, never shader source or a colour smuggled in as one.
    expect(appIntentSchema.safeParse({ kind: "orb.select", orbProfile: "void main() {}" }).success).toBe(false);
  });

  it("refuses an orbProfile on any other kind", () => {
    expect(appIntentSchema.safeParse({ kind: "settings.open", orbProfile: "pearl" }).success).toBe(false);
    expect(appIntentSchema.safeParse({ kind: "model.select", modelAlias: "fast", orbProfile: "pearl" }).success).toBe(
      false,
    );
  });

  it("reads back orb.select naming the style, in both languages", () => {
    expect(describeAppIntent({ kind: "orb.select", orbProfile: "plasma" })).toContain("Plasma");
    expect(describeAppIntent({ kind: "orb.select", orbProfile: "plasma" }, "en")).toContain("Plasma");
    expect(describeAppIntent({ kind: "orb.select", orbProfile: "pearl" })).not.toBe(
      describeAppIntent({ kind: "orb.select", orbProfile: "plasma" }),
    );
  });

  it("accepts \"agent\" as a source, distinct from chat, click and voice", () => {
    expect(appIntentSourceSchema.safeParse("agent").success).toBe(true);
    expect(new Set(appIntentSourceSchema.options)).toEqual(new Set(["chat", "click", "voice", "agent", "voice-agent"]));
  });

  it("accepts \"voice-agent\", so the model answering a spoken sentence is never audited as the person who spoke", () => {
    expect(appIntentSourceSchema.safeParse("voice-agent").success).toBe(true);
    expect(appIntentSourceSchema.safeParse("voice-agent").data).not.toBe("voice");
  });
});
