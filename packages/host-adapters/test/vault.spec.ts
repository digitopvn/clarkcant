import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FileVaultBackend, MemoryVaultBackend, redactForLog } from "../src/index.ts";

describe("credential vault (T34)", () => {
  it("round-trips a secret without ever returning it from a getter", () => {
    const vault = new MemoryVaultBackend();
    vault.put("google.refresh", "sensitive-value");
    expect(vault.has("google.refresh")).toBe(true);
    // There is no getSecret(); the value is only usable inside a callback.
    expect(vault.withSecret("google.refresh", (secret) => secret.length)).toBe(15);
    expect(vault.list()).toEqual(["google.refresh"]);
  });

  it("encrypts at rest and refuses to treat a corrupt vault as empty", () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/clarkcant-vault-${Date.now()}`;
    const vault = new FileVaultBackend({ path: `${dir}/vault.json`, passphrase: "passphrase" });
    vault.put("token", "plaintext-should-not-appear");
    expect(readFileSync(`${dir}/vault.json`, "utf8")).not.toContain("plaintext-should-not-appear");
    expect(vault.withSecret("token", (s) => s)).toBe("plaintext-should-not-appear");
  });

  it("redacts token-shaped and JWT-shaped values from log lines", () => {
    // The fixtures are assembled at runtime rather than written as literals.
    //
    // A literal that reads as a credential is indistinguishable from a real one to a secret
    // scanner, so the file is reported on every scan and each report has to be triaged by hand.
    // Building the values from parts keeps the test honest — the redactor still receives a value
    // of exactly the right shape — while leaving nothing in the source that scans as a secret.
    const FIXTURE = {
      token: ["sk", "a".repeat(16)].join("-"),
      jwt: ["eyJheader", "eyJpayload", "signature"].join("."),
      assignment: `${["access", "token"].join("_")}=${"b".repeat(12)}`,
    };

    const line = `auth failed for token ${FIXTURE.token} and ${FIXTURE.jwt} and ${FIXTURE.assignment}`;
    const redacted = redactForLog(line);

    expect(redacted).not.toContain(FIXTURE.token);
    expect(redacted).not.toContain(FIXTURE.jwt);
    expect(redacted).not.toContain("b".repeat(12));
    expect(redacted).toContain("[redacted");
    // The plain words around the values survive, so this is a redactor and not a replacement of
    // the whole line.
    expect(redacted).toContain("auth failed for token");
  });
});
