import { beforeEach, describe, expect, it } from "vitest";

import { ORB_PROFILE_NAMES, PREFERENCE_KEYS, PREFERENCE_REGISTRY } from "@clarkcant/contracts";
import { MIGRATIONS, migrate, openDatabase } from "@clarkcant/storage";

import { listPreferences, setPreference } from "../src/preferences.ts";
import {
  describeValidationIssues,
  listRegisteredPreferences,
  readPersonalInstructions,
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

it("records recent theme choices through the registered writer, deduplicated and bounded", () => {
  for (let index = 0; index < 8; index += 1) writeRegisteredPreference(deps, {
    principalId: PRINCIPAL, key: "experience.themeRef", value: `package:com.example.theme-${String(index)}#main`,
  });
  writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.themeRef", value: "package:com.example.theme-4#main" });
  const recent = readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.recentThemes" })?.value;
  expect(recent).toEqual([4, 7, 6, 5, 3, 2].map((index) => `package:com.example.theme-${String(index)}#main`));
  expect(writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.themeRef", value: "not a reference" }).ok).toBe(false);
  expect(readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.recentThemes" })?.value).toEqual(recent);
});

it("rolls back the theme choice when its recent-history write fails", () => {
  deps.db.exec("CREATE TEMP TRIGGER refuse_recent BEFORE INSERT ON preferences WHEN NEW.key = 'experience.recentThemes' BEGIN SELECT RAISE(ABORT, 'history write failed'); END");
  expect(() => writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.themeRef", value: "package:com.example.theme#main" })).toThrow(/history write failed/);
  expect(readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.themeRef" })?.isDefault).toBe(true);
  expect(readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.recentThemes" })?.isDefault).toBe(true);
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

  it("stores every orb style the contract names, and refuses one it does not", () => {
    for (const name of ORB_PROFILE_NAMES) {
      const written = writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "orb.profile", value: name });
      expect(written.ok, name).toBe(true);
    }
    const refused = writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "orb.profile", value: "aurora" });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.code).toBe("PREFERENCE_INVALID");
    // The refusal leaves the last accepted style in place.
    const current = readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "orb.profile" });
    expect(current?.value).toBe(ORB_PROFILE_NAMES[ORB_PROFILE_NAMES.length - 1]);
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
      key: "experience.colorScheme",
      value: "dark",
    });
    const preference = readRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "experience.colorScheme",
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
      key: "experience.colorScheme",
      scope: "node",
      value: "dark",
      source: "user",
    });
    const preference = readRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "experience.colorScheme",
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
    writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.colorScheme", value: "dark" });
    writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.colorScheme", value: "light" });

    const outcome = undoRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "experience.colorScheme",
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

  it("can be undone twice, without writing an undefined value", () => {
    /*
     * The second undo is the case that broke. After the first one removed the row, writing the same key again
     * and undoing it took the restore branch with no previous value, which reached SQLite as an unbound
     * parameter and came back from the preferences route as a 500.
     *
     * This is the shape the e2e suite hits on every test: a preference is set, then reset, then reset again.
     */
    writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "orb.profile", value: "jelly" });
    const first = undoRegisteredPreference(deps, { principalId: PRINCIPAL, key: "orb.profile" });
    expect(first.ok).toBe(true);

    // A second undo with nothing written in between is a no-op rather than a crash.
    const second = undoRegisteredPreference(deps, { principalId: PRINCIPAL, key: "orb.profile" });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected a report");
    expect(second.undone).toBe(false);
    expect(second.preference.isDefault).toBe(true);

    // And the whole cycle works again afterwards, which is what a settings surface does repeatedly.
    writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "orb.profile", value: "calm" });
    const third = undoRegisteredPreference(deps, { principalId: PRINCIPAL, key: "orb.profile" });
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error("expected an undo");
    expect(third.preference.value).toBe("clark");
    expect(third.preference.isDefault).toBe(true);
  });

  it("removes the row rather than restoring undefined when the history is exhausted", () => {
    // The store's own view of it: an exhausted history is a row that no longer exists, not one holding a
    // value nobody chose.
    writeRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.colorScheme", value: "dark" });
    undoRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.colorScheme" });
    expect(storedKeys()).toEqual([]);
    expect(readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "experience.colorScheme" })?.isDefault).toBe(true);
  });
});

describe("a theme choice stored before the theme and the colour scheme were separate", () => {
  /*
   * The whole path a person's old choice takes: a row written by the build that knew only `experience.theme`, the
   * storage upgrade, and then this build's registry reading it. The storage test proves the row is copied; this proves
   * the registry answers with it as the person's choice, and that Undo still returns them to what they had before.
   */
  function upgradedFrom(rows: { value: string; revision: number; previous: string | null }): typeof deps {
    const db = openDatabase({ path: ":memory:" });
    migrate(
      db,
      MIGRATIONS.filter((migration) => migration.version < 35),
    );
    db.prepare(
      `INSERT INTO preferences (principal_id, key, value, scope, source, revision, previous_value, created_at)
       VALUES (?, 'experience.theme', ?, 'global', 'user', ?, ?, '2026-09-01T08:00:00.000Z')`,
    ).run(PRINCIPAL, JSON.stringify(rows.value), rows.revision, rows.previous === null ? null : JSON.stringify(rows.previous));
    migrate(db);
    return { db, now: () => AT };
  }

  it("reads back as the person's colour-scheme choice, not as a default", () => {
    for (const value of ["system", "light", "dark"]) {
      const upgraded = upgradedFrom({ value, revision: 1, previous: null });
      const scheme = readRegisteredPreference(upgraded, { principalId: PRINCIPAL, key: "experience.colorScheme" });
      expect(scheme, value).toMatchObject({ value, isDefault: false, revision: 1, updatedAt: "2026-09-01T08:00:00.000Z" });
    }
  });

  it("leaves the theme at Clark Default, because nobody has chosen one yet", () => {
    const upgraded = upgradedFrom({ value: "light", revision: 1, previous: null });
    const theme = readRegisteredPreference(upgraded, { principalId: PRINCIPAL, key: "experience.themeRef" });
    expect(theme).toMatchObject({ value: "builtin:clark", isDefault: true });
  });

  it("answers a legacy value no build could draw with the default, not as a choice", () => {
    for (const value of ["blue", "Dark", ""]) {
      const upgraded = upgradedFrom({ value, revision: 1, previous: null });
      const scheme = readRegisteredPreference(upgraded, { principalId: PRINCIPAL, key: "experience.colorScheme" });
      expect(scheme, value).toMatchObject({ value: "system", isDefault: true, revision: 0 });
    }
  });

  it("keeps Undo: the choice before the upgrade is still one step back", () => {
    const upgraded = upgradedFrom({ value: "light", revision: 2, previous: "dark" });
    const outcome = undoRegisteredPreference(upgraded, { principalId: PRINCIPAL, key: "experience.colorScheme" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected an undo");
    expect(outcome.undone).toBe(true);
    expect(outcome.preference.value).toBe("dark");
  });
});

describe("a stored value the key cannot hold", () => {
  /*
   * Rows reach the store by other paths than a registry write — an older build, a migration, a hand edit — so a read
   * checks what it hands out. Written directly with `setPreference`, because the registry itself cannot store one.
   */
  function storeRaw(key: string, value: unknown): void {
    const definition = PREFERENCE_REGISTRY[key as keyof typeof PREFERENCE_REGISTRY];
    setPreference(deps, { principalId: PRINCIPAL, key, scope: definition.scope, value, source: "user" });
  }

  it("reads as the default, in a single read and in the list", () => {
    storeRaw("experience.colorScheme", "blue");
    storeRaw("experience.motion", 42);
    for (const [key, fallback] of [
      ["experience.colorScheme", "system"],
      ["experience.motion", "system"],
    ] as const) {
      expect(readRegisteredPreference(deps, { principalId: PRINCIPAL, key }), key).toMatchObject({
        value: fallback,
        isDefault: true,
        revision: 0,
        updatedAt: null,
      });
      expect(listRegisteredPreferences(deps, PRINCIPAL).find((preference) => preference.key === key)).toMatchObject({
        value: fallback,
        isDefault: true,
      });
    }
    // The row is not removed: nothing is lost, and the next write replaces it.
    expect(storedKeys()).toEqual(expect.arrayContaining(["experience.colorScheme", "experience.motion"]));
  });

  it("changes nothing for a valid stored value of any key", () => {
    for (const key of PREFERENCE_KEYS) storeRaw(key, PREFERENCE_REGISTRY[key].default);
    for (const preference of listRegisteredPreferences(deps, PRINCIPAL)) {
      expect(preference, preference.key).toMatchObject({
        value: PREFERENCE_REGISTRY[preference.key as keyof typeof PREFERENCE_REGISTRY].default,
        isDefault: false,
        revision: 1,
      });
    }
  });

  it("still hands the execution policy's row to its own reader, which parses it field by field", () => {
    const partial = { mode: "sometimes", prohibition: "no-external-effects" };
    storeRaw("execution.policy", partial);
    expect(readRegisteredPreference(deps, { principalId: PRINCIPAL, key: "execution.policy" })).toMatchObject({
      value: partial,
      isDefault: false,
    });
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

describe("the step from a stored preference to what the model is told", () => {
  /*
   * This is the seam between "what the user stored" and "what reaches the system prompt", and a mistake
   * here is invisible from both ends: the settings screen would show the text and the turn would simply not
   * have it. Every state that means "say nothing" is asserted, because each one is a way the feature could
   * quietly do nothing.
   */
  it("answers nothing when the toggle is off, however much text is stored", () => {
    writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "ai.personalInstructions",
      value: { enabled: false, text: "Prefer concise answers." },
    });
    // The text is kept — turning the toggle off must not discard what somebody typed — but it is not sent.
    expect(readPersonalInstructions(deps, PRINCIPAL)).toBeUndefined();
  });

  it("answers the trimmed text when it is on", () => {
    writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "ai.personalInstructions",
      value: { enabled: true, text: "  Use TypeScript.  " },
    });
    expect(readPersonalInstructions(deps, PRINCIPAL)).toBe("Use TypeScript.");
  });

  it("answers nothing for text that is only whitespace", () => {
    // An empty section is a heading the model will try to interpret, which is worse than no section.
    writeRegisteredPreference(deps, {
      principalId: PRINCIPAL,
      key: "ai.personalInstructions",
      value: { enabled: true, text: "   \n\t " },
    });
    expect(readPersonalInstructions(deps, PRINCIPAL)).toBeUndefined();
  });

  it("answers nothing before anybody has set it", () => {
    expect(readPersonalInstructions(deps, PRINCIPAL)).toBeUndefined();
  });

  it("answers nothing for a value of the wrong shape, rather than throwing", () => {
    // The value arrives from storage, so this is a boundary that parses. A malformed preference must not be
    // the reason a turn fails to start.
    for (const value of ["a string", 42, null, [], { enabled: "yes", text: "x" }, { enabled: true }]) {
      writeRegisteredPreference(deps, {
        principalId: PRINCIPAL,
        key: "ai.personalInstructions",
        value: { enabled: false, text: "" },
      });
      // Written through the registry it can only be the right shape, so the malformed case is written directly.
      setPreference(deps, {
        principalId: PRINCIPAL,
        key: "ai.personalInstructions",
        scope: "global",
        value,
        source: "user",
      });
      expect(readPersonalInstructions(deps, PRINCIPAL), JSON.stringify(value)).toBeUndefined();
    }
  });
});
