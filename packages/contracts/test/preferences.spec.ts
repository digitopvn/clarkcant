import { describe, expect, it } from "vitest";

import {
  DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE,
  ORB_PALETTE_CHANNELS,
  PREFERENCE_KEYS,
  PREFERENCE_REGISTRY,
  executionModeSchema,
  executionRulesPreferenceSchema,
  orbCustomPreferenceSchema,
  parseInboxNotificationsPreference,
  preferenceDefinition,
} from "../src/preferences.ts";

/**
 * The preference registry (V17).
 *
 * The registry is only useful if it is total: every key it declares must have a definition that
 * accepts its own default, every definition must agree about which key it describes, and nothing
 * credential-shaped may appear in the list the settings API answers for. These are the properties a
 * later phase would otherwise discover at runtime, on a user's machine, as a setting that does
 * nothing or a slider that silently clamps.
 */

describe("the registry describes itself consistently", () => {
  it("declares a definition under its own key", () => {
    for (const [key, definition] of Object.entries(PREFERENCE_REGISTRY)) {
      expect(definition.key, key).toBe(key);
    }
  });

  it("accepts every declared default", () => {
    for (const definition of Object.values(PREFERENCE_REGISTRY)) {
      const parsed = definition.schema.safeParse(definition.default);
      expect(parsed.success, definition.key).toBe(true);
    }
  });

  it("lists keys in declaration order so the surface can group them", () => {
    expect(PREFERENCE_KEYS).toEqual(Object.keys(PREFERENCE_REGISTRY));
  });

  it("answers nothing for a key it does not have", () => {
    expect(preferenceDefinition("experience.theme")).toBeDefined();
    expect(preferenceDefinition("experience.colorway")).toBeUndefined();
  });

  it("declares no key that sounds like credential material", () => {
    // The settings API returns exactly the registered keys, so this list is the whole surface a
    // secret could leak through. A key named like a credential is a registry bug, not a preference.
    const secretish = /(secret|token|password|passphrase|credential|api[-_.]?key|private[-_.]?key)/i;
    expect(PREFERENCE_KEYS.filter((key) => secretish.test(key))).toEqual([]);
  });
});

describe("the orb's personalization is bounded", () => {
  it("refuses physics outside the declared clamps", () => {
    expect(orbCustomPreferenceSchema.safeParse({ physics: { stiffness: 180 } }).success).toBe(true);
    expect(orbCustomPreferenceSchema.safeParse({ physics: { stiffness: 181 } }).success).toBe(false);
    expect(orbCustomPreferenceSchema.safeParse({ physics: { damping: 24 } }).success).toBe(true);
    expect(orbCustomPreferenceSchema.safeParse({ physics: { damping: 3.9 } }).success).toBe(false);
    expect(orbCustomPreferenceSchema.safeParse({ physics: { wobbleGain: 1.5 } }).success).toBe(false);
    expect(orbCustomPreferenceSchema.safeParse({ physics: { pointerResponse: 1.6 } }).success).toBe(false);
  });

  it("refuses optics outside the declared clamps", () => {
    expect(orbCustomPreferenceSchema.safeParse({ optical: { exposure: 6 } }).success).toBe(true);
    expect(orbCustomPreferenceSchema.safeParse({ optical: { exposure: 6.1 } }).success).toBe(false);
    expect(orbCustomPreferenceSchema.safeParse({ motion: { speed: 3 } }).success).toBe(true);
    expect(orbCustomPreferenceSchema.safeParse({ motion: { speed: -0.1 } }).success).toBe(false);
  });

  it("accepts a colour on a named channel and nothing else", () => {
    expect(orbCustomPreferenceSchema.safeParse({ palette: { colorA: [1, 0.5, 0] } }).success).toBe(true);
    expect(orbCustomPreferenceSchema.safeParse({ palette: { colorA: [1, 0.5] } }).success).toBe(false);
    expect(orbCustomPreferenceSchema.safeParse({ palette: { colorA: [2, 0, 0] } }).success).toBe(false);
    expect(orbCustomPreferenceSchema.safeParse({ palette: { shellSparkle: [1, 1, 1] } }).success).toBe(false);
  });

  it("carries no way to store shader source", () => {
    // A personalization that can accept code is a shader-injection surface with a slider next to it.
    const payload = { fragmentShader: "void main() { gl_FragColor = vec4(1.0); }" };
    expect(orbCustomPreferenceSchema.safeParse(payload).success).toBe(false);
    expect(orbCustomPreferenceSchema.safeParse({ optical: payload }).success).toBe(false);
  });

  it("names the channels the shader is expected to have", () => {
    // The renderer asserts the same list against its own palette; this is the contract half of that
    // check, so a channel cannot be dropped here without the orb tests noticing.
    expect([...ORB_PALETTE_CHANNELS]).toContain("canvas");
    expect([...ORB_PALETTE_CHANNELS]).toContain("shellEdge");
  });
});

describe("execution policy preferences stay inside the closed vocabularies", () => {
  it("offers exactly the three modes", () => {
    expect([...executionModeSchema.options]).toEqual(["autonomous", "guarded", "ask"]);
  });

  it("refuses an effect category the taxonomy does not have", () => {
    const parsed = executionRulesPreferenceSchema.safeParse([
      { effectCategory: "telepathy", decision: "execute" },
    ]);
    expect(parsed.success).toBe(false);
  });

  it("refuses a decision that is not one of the three outcomes", () => {
    const parsed = executionRulesPreferenceSchema.safeParse([
      { effectCategory: "read", decision: "maybe" },
    ]);
    expect(parsed.success).toBe(false);
  });

  it("accepts a rule over a real category", () => {
    const parsed = executionRulesPreferenceSchema.safeParse([
      { effectCategory: "destructive", decision: "ask" },
    ]);
    expect(parsed.success).toBe(true);
  });
});

describe("parseInboxNotificationsPreference merges a partial stored value over the defaults", () => {
  it("falls back to every default when nothing is stored", () => {
    expect(parseInboxNotificationsPreference(undefined)).toEqual(DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE);
    expect(parseInboxNotificationsPreference(null)).toEqual(DEFAULT_INBOX_NOTIFICATIONS_PREFERENCE);
  });

  it("keeps a stored document's real choices, even one written before a group existed", () => {
    // The document a node wrote before `otherDevices` shipped: it has no `otherDevices` key at all, and this
    // must not reset `waitingApprovals` or `os` back to their defaults alongside the one it never wrote.
    const stored = {
      groups: { waitingApprovals: false, backgroundResults: true, updates: false },
      os: false,
      web: true,
      quietHours: { enabled: true, start: "23:00", end: "06:30" },
    };
    expect(parseInboxNotificationsPreference(stored)).toEqual({
      groups: { waitingApprovals: false, backgroundResults: true, updates: false, otherDevices: true },
      os: false,
      web: true,
      quietHours: { enabled: true, start: "23:00", end: "06:30" },
    });
  });

  it("falls back to just one field's own default when only that field is the wrong shape", () => {
    const stored = {
      groups: { waitingApprovals: "yes", backgroundResults: true },
      os: true,
      web: false,
      quietHours: { enabled: true, start: "not-a-time", end: "06:30" },
    };
    expect(parseInboxNotificationsPreference(stored)).toEqual({
      groups: { waitingApprovals: true, backgroundResults: true, updates: true, otherDevices: true },
      os: true,
      web: false,
      quietHours: { enabled: true, start: "22:00", end: "06:30" },
    });
  });
});
