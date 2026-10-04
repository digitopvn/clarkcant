import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALLOWED_DATA_CLASSES,
  allowedDataClassesFor,
  dataClassOfText,
  estimateTokens,
  intersectDataClasses,
  maxDataClass,
  userModelProfileSchema,
} from "../src/index.ts";

/**
 * Data classes decide what context a model may be sent.
 *
 * What has to hold: the class of a text comes from its shapes alone, so the same text is always the same class; a
 * credential is `secret` and personal data `confidential`, while the everyday material of a coding conversation stays
 * `internal`; and a profile's list and trust class only ever narrow each other.
 */

describe("the class of a text", () => {
  it("is secret for a credential shape", () => {
    expect(dataClassOfText("dùng khóa sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c")).toBe("secret");
    expect(dataClassOfText("Authorization: Bearer abcdefghijklmnop")).toBe("secret");
  });

  it("is confidential for an address, a phone number or a home folder", () => {
    expect(dataClassOfText("gửi cho duy@example.com")).toBe("confidential");
    expect(dataClassOfText("file ở C:\\Users\\duy\\notes.txt")).toBe("confidential");
  });

  it("is internal for everything else, including identifiers and digests", () => {
    expect(dataClassOfText("Dự án dùng SQLite.")).toBe("internal");
    expect(dataClassOfText("the key_value_store module and npm-registry-url")).toBe("internal");
    expect(dataClassOfText("commit 7048018c0ffee0ddba11deadbeef00112233445566")).toBe("internal");
  });

  it("is the same for the same text, every time", () => {
    const text = "duy@example.com và sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c";
    expect(new Set(Array.from({ length: 5 }, () => dataClassOfText(text)))).toEqual(new Set(["secret"]));
  });
});

describe("what a model profile may receive", () => {
  it("is everything but secret for a profile that says nothing", () => {
    expect(allowedDataClassesFor({})).toEqual(["public", "internal", "confidential"]);
    expect(DEFAULT_ALLOWED_DATA_CLASSES).not.toContain("secret");
  });

  it("follows the trust class, and a list never widens it", () => {
    expect(allowedDataClassesFor({ trustClass: "local" })).toContain("secret");
    expect(allowedDataClassesFor({ trustClass: "untrusted" })).toEqual(["public"]);
    expect(allowedDataClassesFor({ trustClass: "untrusted", allowedDataClasses: ["public", "secret"] })).toEqual(["public"]);
    expect(allowedDataClassesFor({ allowedDataClasses: ["internal", "public"] })).toEqual(["public", "internal"]);
  });

  it("is what every list permits when several profiles name one model", () => {
    expect(intersectDataClasses([["public", "internal", "confidential"], ["public", "internal"]])).toEqual(["public", "internal"]);
    expect(intersectDataClasses([])).toEqual(DEFAULT_ALLOWED_DATA_CLASSES);
  });

  it("is stored on a profile only as a known class and a bounded list", () => {
    const base = { modelProfileId: "p", alias: "a", provider: "x", modelId: "m", enabled: true, roles: ["background"], priority: 1 };
    expect(userModelProfileSchema.safeParse({ ...base, allowedDataClasses: ["public"], trustClass: "local" }).success).toBe(true);
    expect(userModelProfileSchema.safeParse({ ...base, allowedDataClasses: ["top-secret"] }).success).toBe(false);
    expect(userModelProfileSchema.safeParse({ ...base, trustClass: "friendly" }).success).toBe(false);
  });
});

describe("helpers", () => {
  it("takes the most sensitive class, and public for none", () => {
    expect(maxDataClass(["internal", "secret", "public"])).toBe("secret");
    expect(maxDataClass([])).toBe("public");
  });

  it("estimates four characters a token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
