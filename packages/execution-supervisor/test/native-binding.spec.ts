import { describe, expect, it } from "vitest";

import { BUILTIN_PROFILES } from "../src/index.ts";
import { admitNativeAction, probeNativeBinding } from "../src/native-binding.ts";

/**
 * The native binding seam (V15).
 *
 * The binding itself is not here and cannot be: it needs a signed bundle and a container engine. What is tested is
 * that the seam answers with a **named** missing resource, and that the permission gate runs over that answer — so
 * a person is never sent to a settings screen to fix a permission problem that was really a missing engine.
 *
 * The engine half is probed for real elsewhere (`apps/runtime/src/container-engine.ts`, V02); here it is an input, so
 * these tests decide what the seam does with each answer rather than whether a machine has Docker.
 */

const PROFILE = BUILTIN_PROFILES["virtual-desktop"] ?? BUILTIN_PROFILES["build"];
if (PROFILE === undefined) throw new Error("the supervisor ships no usable profile");

const ENGINE_PRESENT = { available: true, detail: "docker 27.0.0" };
const ENGINE_MISSING = {
  available: false,
  detail: "no container engine answered: docker version --format {{.Server.Version}} failed, podman version --format {{.Version}} failed",
};

describe("probing for the native binding", () => {
  it("names the signed bundle as what is missing when there is none", () => {
    const availability = probeNativeBinding({ bundleDigest: undefined, signatureVerified: false, engine: ENGINE_PRESENT });
    expect(availability.available).toBe(false);
    expect(availability.available ? "" : availability.reason).toBe("requires-signed-bundle");
  });

  it("treats a signature that did not verify as no bundle at all", () => {
    const availability = probeNativeBinding({
      bundleDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      signatureVerified: false,
      engine: ENGINE_PRESENT,
    });

    expect(availability.available ? "" : availability.reason).toBe("requires-signed-bundle");
    expect(availability.available ? "" : availability.detail).toContain("did not verify");
  });

  it("names the container engine when the bundle is fine and the engine is not", () => {
    const availability = probeNativeBinding({
      bundleDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      signatureVerified: true,
      engine: ENGINE_MISSING,
    });

    expect(availability.available ? "" : availability.reason).toBe("requires-container-engine");
    // The engine probe's own detail travels, including both attempts it made: "no engine" and "an engine that did
    // not answer" need different fixes.
    expect(availability.available ? "" : availability.detail).toContain("podman");
  });

  it("reports the containment it actually got, not the one that was hoped for", () => {
    const availability = probeNativeBinding({
      bundleDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      signatureVerified: true,
      engine: ENGINE_PRESENT,
    });

    expect(availability.available).toBe(true);
    expect(availability.available ? availability.containment : "").toBe("container");
  });
});

describe("admitting a native action", () => {
  const unavailable = probeNativeBinding({ bundleDigest: undefined, signatureVerified: false, engine: ENGINE_PRESENT });
  const available = probeNativeBinding({
    bundleDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    signatureVerified: true,
    engine: ENGINE_PRESENT,
  });

  it("refuses on the missing resource before it ever consults permission", () => {
    /*
     * The ordering this row exists for. Reporting "permission not granted" for something that could not have run
     * anyway sends the person to a settings screen that will not help them, and hides the real reason.
     */
    const decision = admitNativeAction({ availability: unavailable, permission: "not-granted", profile: PROFILE, untrustedCode: false });

    expect(decision.allowed).toBe(false);
    expect(decision.allowed ? "" : decision.code).toBe("BINDING_UNAVAILABLE");
    expect(decision.allowed ? "" : decision.reason).toContain("requires-signed-bundle");
  });

  it("refuses when the permission was not granted, and says which permission", () => {
    const decision = admitNativeAction({ availability: available, permission: "not-granted", profile: PROFILE, untrustedCode: false });

    expect(decision.allowed ? "" : decision.code).toBe("PERMISSION_NOT_GRANTED");
    expect(decision.allowed ? "" : decision.reason).toContain("screen and input");
  });

  it("refuses untrusted code under a profile that does not accept it", () => {
    const decision = admitNativeAction({ availability: available, permission: "granted", profile: PROFILE, untrustedCode: true });

    // Only when the profile really does not accept it: the assertion is about the profile's own declaration.
    if (PROFILE.acceptsUntrustedCode) {
      expect(decision.allowed).toBe(true);
    } else {
      expect(decision.allowed ? "" : decision.code).toBe("PROFILE_FORBIDS_UNTRUSTED");
    }
  });

  it("allows an action the seam can run, with the containment the seam reported", () => {
    const decision = admitNativeAction({ availability: available, permission: "granted", profile: PROFILE, untrustedCode: false });

    expect(decision.allowed).toBe(true);
    expect(decision.allowed ? decision.containment : "").toBe("container");
  });
});
