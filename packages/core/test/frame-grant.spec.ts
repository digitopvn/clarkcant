import { describe, expect, it } from "vitest";

import { mintFrameGrant, verifyFrameGrant } from "../src/frame-grant.ts";

/**
 * The grant that lets a frame fetch its own document.
 *
 * A widget's document is loaded by the browser as a navigation, and a navigation cannot carry an `Authorization`
 * header — so the credential has to travel in the URL, which means it has to be worth nothing to whoever finds it.
 * These are the properties that make that true: it names one package, it expires, and it cannot be edited.
 */

const SECRET = "a-node-secret";
const NOW = Date.parse("2026-09-20T06:00:00.000Z");

function mint(overrides: { expiresAtMs?: number; packageId?: string } = {}): string {
  return mintFrameGrant({
    instanceId: "winst_1",
    packageId: overrides.packageId ?? "com.example.widget",
    version: "1.0.0",
    secret: SECRET,
    expiresAtMs: overrides.expiresAtMs ?? NOW + 60_000,
  });
}

describe("a frame grant", () => {
  it("carries the instance and the one package it is for", () => {
    const checked = verifyFrameGrant({ grant: mint(), secret: SECRET, nowMs: NOW });

    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.instanceId).toBe("winst_1");
    // The package is in the grant rather than looked up at verification time: "may this URL read these bytes" is the
    // question, and an instance's package can change.
    expect(checked.packageId).toBe("com.example.widget");
    expect(checked.version).toBe("1.0.0");
  });

  it("refuses a grant whose payload was edited", () => {
    const grant = mint();
    const [payload, signature] = grant.split(".");
    const forged = Buffer.from(
      JSON.stringify({ instanceId: "winst_1", packageId: "com.example.other", version: "1.0.0", exp: NOW + 60_000 }),
      "utf8",
    ).toString("base64url");

    const checked = verifyFrameGrant({ grant: `${forged}.${signature ?? ""}`, secret: SECRET, nowMs: NOW });

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.code).toBe("GRANT_TAMPERED");
    // The signature is over the payload, so changing which package it names invalidates it.
    expect(forged).not.toBe(payload);
  });

  it("refuses a grant signed by somebody else", () => {
    const checked = verifyFrameGrant({ grant: mint(), secret: "another-node", nowMs: NOW });

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.code).toBe("GRANT_TAMPERED");
  });

  it("refuses a grant that has expired, and says so", () => {
    // Named, because it is the one refusal a person can act on: reload the view and it works again.
    const checked = verifyFrameGrant({ grant: mint({ expiresAtMs: NOW - 1 }), secret: SECRET, nowMs: NOW });

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.code).toBe("GRANT_EXPIRED");
  });

  it("refuses anything that is not a grant at all", () => {
    for (const grant of ["", "no-dot", "a.b.c", "."]) {
      const checked = verifyFrameGrant({ grant, secret: SECRET, nowMs: NOW });
      expect(checked.ok, grant).toBe(false);
    }
  });
});
