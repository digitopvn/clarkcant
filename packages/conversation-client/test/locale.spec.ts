import { describe, expect, it } from "vitest";

import {
  applyDocumentLocale,
  DEFAULT_LOCALE,
  isLocaleChoice,
  LOCALE_CHOICES,
  LOCALE_STORAGE_KEY,
  notifyLocaleChange,
  readStoredLocale,
  storeLocale,
  subscribeLocaleChange,
} from "../src/i18n/locale.ts";
import { CATALOGS, MESSAGES_EN, MESSAGES_VI, type MessageKey } from "../src/i18n/messages.ts";

/**
 * The locale choice.
 *
 * Mirrors `theme.spec.ts`: a fake storage and a fake document, so nothing here depends on the
 * vitest environment having a real DOM (it does not — `apps/*` e2e is where React actually renders).
 */

function fakeStorage(initial: Record<string, string> = {}): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  read: () => Record<string, string>;
} {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    read: () => data,
  };
}

describe("message catalog completeness", () => {
  it("declares the same key set for every locale", () => {
    const viKeys = Object.keys(MESSAGES_VI).sort();
    const enKeys = Object.keys(MESSAGES_EN).sort();
    expect(enKeys).toEqual(viKeys);
  });

  it("has no empty translation in either language", () => {
    for (const key of Object.keys(MESSAGES_VI) as MessageKey[]) {
      expect(MESSAGES_VI[key].trim(), `vi:${key}`).not.toEqual("");
      expect(MESSAGES_EN[key].trim(), `en:${key}`).not.toEqual("");
    }
  });

  it("exposes a catalog for every declared locale choice", () => {
    for (const locale of LOCALE_CHOICES) {
      expect(CATALOGS[locale]).toBeDefined();
    }
  });
});

describe("isLocaleChoice", () => {
  it("accepts only the two declared choices", () => {
    expect(isLocaleChoice("vi")).toBe(true);
    expect(isLocaleChoice("en")).toBe(true);
    for (const value of ["fr", "", null, undefined, 0, {}, ["vi"]]) {
      expect(isLocaleChoice(value), String(value)).toBe(false);
    }
  });
});

describe("reading and storing the locale choice", () => {
  it("defaults to Vietnamese when nothing is stored", () => {
    expect(DEFAULT_LOCALE).toBe("vi");
    expect(readStoredLocale(fakeStorage())).toBe("vi");
  });

  it("returns the stored choice when there is one", () => {
    expect(readStoredLocale(fakeStorage({ [LOCALE_STORAGE_KEY]: "en" }))).toBe("en");
  });

  it("falls back rather than trusting a stored value it did not write", () => {
    expect(readStoredLocale(fakeStorage({ [LOCALE_STORAGE_KEY]: "fr" }))).toBe(DEFAULT_LOCALE);
  });

  it("survives storage that throws on read", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => readStoredLocale(throwing)).not.toThrow();
    expect(readStoredLocale(throwing)).toBe(DEFAULT_LOCALE);
  });

  it("stores the choice", () => {
    const storage = fakeStorage();
    storeLocale("en", storage);
    expect(storage.read()[LOCALE_STORAGE_KEY]).toBe("en");
  });

  it("survives storage that throws on write", () => {
    const throwing = {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => storeLocale("en", throwing)).not.toThrow();
  });
});

describe("applying the locale to the document", () => {
  interface FakeDocument {
    documentElement: { lang: string };
  }

  function withDocument(run: (doc: FakeDocument) => void): void {
    const original = (globalThis as { document?: unknown }).document;
    const doc: FakeDocument = { documentElement: { lang: "" } };
    (globalThis as { document?: unknown }).document = doc;
    try {
      run(doc);
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  }

  it("writes the chosen language onto <html lang>", () => {
    withDocument((doc) => {
      applyDocumentLocale("en");
      expect(doc.documentElement.lang).toBe("en");
      applyDocumentLocale("vi");
      expect(doc.documentElement.lang).toBe("vi");
    });
  });

  it("is a no-op rather than a throw when there is no document", () => {
    const original = (globalThis as { document?: unknown }).document;
    delete (globalThis as { document?: unknown }).document;
    try {
      expect(() => applyDocumentLocale("en")).not.toThrow();
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  });
});

describe("cross-instance locale change notification", () => {
  // apps/web/src/App.tsx and packages/conversation-client/src/Conversation.tsx each call
  // useLocale() independently. A change written through one instance must reach every other
  // subscribed instance so both render the same language, without either polling or a
  // same-tab `storage` event (which never fires for the tab that made the write).

  it("delivers a change to every subscriber", () => {
    const seenByA: string[] = [];
    const seenByB: string[] = [];
    const unsubA = subscribeLocaleChange((choice) => seenByA.push(choice));
    const unsubB = subscribeLocaleChange((choice) => seenByB.push(choice));
    try {
      notifyLocaleChange("en");
      expect(seenByA).toEqual(["en"]);
      expect(seenByB).toEqual(["en"]);
    } finally {
      unsubA();
      unsubB();
    }
  });

  it("stops delivering after unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeLocaleChange((choice) => seen.push(choice));
    unsubscribe();
    notifyLocaleChange("en");
    expect(seen).toEqual([]);
  });

  it("does not throw when nothing is subscribed", () => {
    expect(() => notifyLocaleChange("vi")).not.toThrow();
  });
});
