import { beforeEach, describe, expect, it } from "vitest";

import { PREFERENCE_KEYS } from "@clarkcant/contracts";
import { migrate, openDatabase } from "@clarkcant/storage";

import { listPreferences, setPreference } from "../src/preferences.ts";
import {
  describeValidationIssues,
  listRegisteredPreferences,
  readRegisteredPreference,
  undoRegisteredPreference,
  writeRegisteredPreference,
} from "../src/preference-registry.ts";

/**
 * The preference registry applied to the store (V17).
 *
 * Two claims carry the weight here. A write to a key nothing declares is refused rather than
 * stored, because a stored value nothing reads is a setting that silently does nothing. And a read
 * answers for every registered key, marking the ones nobody has set as defaults, so a surface cannot
 * present a default as a choice the user made.
 */

const AT = "2026-09-16T06:00:00.000Z" as never;
const PRINCIPAL = "prin_owner";

function makeDeps() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  return { db, now: () => AT };
}

let deps: ReturnType<typeof makeDeps>;
beforeEach(() => {
  deps = makeDeps();
});

function storedKeys(): string[] {
  return listPreferences(deps, PRINCIPAL).map((record) => record.key);
}

describe("an unregistered key is refused, not stored", () => {
  it("names the key and writes nothing", () => {
    const outcome = writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "experience.colorway",
      value: "vaporwave",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.code).toBe("PREFERENCE_UNKNOWN");
    expect(outcome.message).toContain("experience.colorway");
    expect(storedKeys()).toEqual([]);
  });

  it("refuses to read one too", () => {
    expect(readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "nope" })).toBeUndefined();
  });

  it("refuses to undo one", () => {
    const outcome = undoRegisteredPreference(deps, { principalId: PRINCIPAL, key: "nope" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.code).toBe("PREFERENCE_UNKNOWN");
  });
});

describe("an invalid value leaves the previous one alone", () => {
  it("refuses an out-of-range clamp and does not overwrite", () => {
    const first = writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "orb.custom",
      value: { physics: { stiffness: 120 } },
    });
    expect(first.ok).toBe(true);

    const refused = writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "orb.custom",
      value: { physics: { stiffness: 4000 } },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.code).toBe("PREFERENCE_INVALID");
    // The report names the field, which is what the surface shows beside the control that was wrong.
    expect(refused.message).toContain("stiffness");

    const current = readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "orb.custom" });
    expect(current?.value).toEqual({ physics: { stiffness: 120 } });
    expect(current?.revision).toBe(1);
  });

  it("refuses a value whose type is wrong", () => {
    const refused = writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "desktop.rememberBounds",
      value: "yes please",
    });
    expect(refused.ok).toBe(false);
    expect(storedKeys()).toEqual([]);
  });

  it("refuses a decision outside the closed vocabulary", () => {
    const refused = writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "execution.mode",
      value: "yolo",
    });
    expect(refused.ok).toBe(false);
  });
});

describe("normalization happens once, at the boundary", () => {
  it("trims personal instructions", () => {
    const outcome = writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "ai.personalInstructions",
      value: { enabled: true, text: "  Prefer concise answers.  " },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a write");
    expect(outcome.preference.value).toEqual({ enabled: true, text: "Prefer concise answers." });
  });

  it("trims and de-duplicates favourites, keeping the user's order", () => {
    const outcome = writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "ai.modelFavorites",
      value: [" anthropic/claude ", "openai/gpt", "anthropic/claude"],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a write");
    expect(outcome.preference.value).toEqual(["anthropic/claude", "openai/gpt"]);
  });

  it("does not repair a value it cannot recognize, so the schema reports it", () => {
    const outcome = writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "ai.modelFavorites",
      value: ["anthropic/claude", ""],
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("a read answers for every registered key", () => {
  it("reports the declared defaults as defaults", () => {
    const preferences = listRegisteredPreferences(deps, PRINCIPAL);
    expect(preferences.map((preference) => preference.key)).toEqual([...PREFERENCE_KEYS]);
    for (const preference of preferences) {
      expect(preference.isDefault, preference.key).toBe(true);
      expect(preference.revision, preference.key).toBe(0);
      expect(preference.updatedAt, preference.key).toBeNull();
    }
    expect(preferences.find((entry) => entry.key === "execution.mode")?.value).toBe("autonomous");
  });

  it("reports a stored value as a choice, with the revision that wrote it", () => {
    writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "experience.theme",
      value: "dark",
    });
    const preference = readRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "experience.theme",
    });
    expect(preference?.value).toBe("dark");
    expect(preference?.isDefault).toBe(false);
    expect(preference?.revision).toBe(1);
    expect(preference?.applies).toBe("immediate");
    expect(preference?.updatedAt).toBe(AT);
  });

  it("does not return a value stored under a scope the key does not use", () => {
    // Scope belongs to the key. A row written by some other path into the wrong scope is not this
    // key's current value, and reporting it as one would be a prefrence read from nowhere.
    setPreference(deps, {
      principalId: PRINCIPAL,
      key: "experience.theme",
      scope: "node",
      value: "dark",
      source: "user",
    });
    const preference = readRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "experience.theme",
    });
    expect(preference?.value).toBe("system");
    expect(preference?.isDefault).toBe(true);
    expect(preference?.scope).toBe("global");
  });

  it("never reports the value of an unregistered key", () => {
    setPreference(deps, {
      principalId: PRINCIPAL,
      key: "some.internal.thing",
      scope: "global",
      value: "not a preference this node declares",
      source: "user",
    });
    const keys = listRegisteredPreferences(deps, PRINCIPAL).map((entry) => entry.key);
    expect(keys).not.toContain("some.internal.thing");
    expect(JSON.stringify(listRegisteredPreferences(deps, PRINCIPAL))).not.toContain("internal");
  });

  it("writes a node-scoped key in the node's own scope", () => {
    writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "voice.provider",
      value: "gemini-live",
    });
    const rows = listPreferences(deps, PRINCIPAL);
    expect(rows.map((row) => `${row.key}:${row.scope}`)).toEqual(["voice.provider:node"]);
  });
});

describe("undo returns to what was there, or says there was nothing", () => {
  it("restores the previous value", () => {
    writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.theme", value: "dark" });
    writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.theme", value: "light" });

    const outcome = undoRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "experience.theme",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected an undo");
    expect(outcome.undone).toBe(true);
    expect(outcome.preference.value).toBe("dark");
    expect(outcome.preference.isDefault).toBe(false);
  });

  it("removes a key that was only ever written once and reports it as a default again", () => {
    writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.density", value: "compact" });
    const outcome = undoRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "experience.density",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected an undo");
    expect(outcome.undone).toBe(true);
    expect(outcome.preference.isDefault).toBe(true);
    expect(outcome.preference.value).toBe("comfortable");
  });

  it("says nothing was undone when nothing was ever set", () => {
    const outcome = undoRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "experience.density",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected a report");
    expect(outcome.undone).toBe(false);
    if (outcome.undone) throw new Error("expected no undo");
    expect(outcome.reason).toContain("never been set");
    expect(outcome.preference.isDefault).toBe(true);
  });
});

describe("a refusal describes the field, not the value", () => {
  it("keeps a credential-shaped value out of the message", () => {
    const described = describeValidationIssues({
      issues: [{ path: ["text"], message: "Too big: expected string to have <=2000 characters" }],
    });
    expect(described).toContain("text");
    expect(described).toContain("Too big");

    const refused = writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "ai.personalInstructions",
      value: { enabled: true, text: "x".repeat(2001), apiKey: "sk-live-do-not-echo" },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.message).not.toContain("sk-live-do-not-echo");
  });
});
