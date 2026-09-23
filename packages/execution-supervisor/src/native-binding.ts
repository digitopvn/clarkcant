import type { ExecutionProfile } from "./index.ts";

/**
 * The native binding seam.
 *
 * Computer Use needs a native binding: something that can move a pointer and read a screen. That binding is not in
 * this repository and cannot be — it needs a signed bundle, and it needs a container engine to run inside. So the
 * seam is built and the resource behind it is not, which is the honest shape rather than a gap: the host asks the
 * seam, the seam answers with a **named** missing resource, and the permission gate runs over that answer instead of
 * over an assumption that the binding is there.
 *
 * The ordering in `admitNativeAction` is the part that matters. A binding that cannot load is refused as
 * `BINDING_UNAVAILABLE` **before** permission is consulted, because reporting "permission not granted" for something
 * that could not have run anyway sends the person to a settings screen that will not help them.
 */

export const NATIVE_BINDING_STATUS = "seam-implemented-binding-absent";

/**
 * Whether a native binding could run.
 *
 * `containment` travels with the answer rather than being decided later: what a binding runs inside is a property of
 * the binding that was loaded, and a caller that assumed `container` would label a process-only run as contained.
 */
export type NativeBindingAvailability =
  | { available: true; bundleDigest: string; containment: "container" | "vm" }
  | { available: false; reason: "requires-signed-bundle" | "requires-container-engine"; detail: string };

export interface NativeBindingProbeInput {
  /** The digest of the bundle that was found, when one was. */
  bundleDigest: string | undefined;
  /**
   * Whether the bundle's signature verified. A signature that did not verify is treated exactly as no bundle: both
   * mean this node has nothing it is willing to run.
   */
  signatureVerified: boolean;
  /** What the container engine probe said, including the detail of what it tried. */
  engine: { available: boolean; detail: string };
}

/**
 * Ask what is missing, in the order that decides what the person should be told first.
 *
 * The bundle is checked before the engine because a signature problem is a problem with the thing this node was
 * given, while a missing engine is a problem with this machine — and the fix is different for each.
 */
export function probeNativeBinding(input: NativeBindingProbeInput): NativeBindingAvailability {
  if (input.bundleDigest === undefined) {
    return {
      available: false,
      reason: "requires-signed-bundle",
      detail: "no signed native bundle is present on this node",
    };
  }
  if (!input.signatureVerified) {
    return {
      available: false,
      reason: "requires-signed-bundle",
      detail: "the native bundle present on this node did not verify against a signature this node trusts",
    };
  }
  if (!input.engine.available) {
    return { available: false, reason: "requires-container-engine", detail: input.engine.detail };
  }
  return { available: true, bundleDigest: input.bundleDigest, containment: "container" };
}

export type NativeActionDecision =
  | { allowed: true; containment: "container" | "vm" }
  | {
      allowed: false;
      code: "BINDING_UNAVAILABLE" | "PERMISSION_NOT_GRANTED" | "PROFILE_FORBIDS_UNTRUSTED";
      reason: string;
    };

export interface NativeActionInput {
  /** What the seam answered. The gate reads this rather than probing for itself, so there is one answer. */
  availability: NativeBindingAvailability;
  /** Whether the person granted the screen/input permission this action needs. */
  permission: "granted" | "not-granted";
  /** The profile the action would run under. */
  profile: ExecutionProfile;
  /** Whether the code behind the action is untrusted. */
  untrustedCode: boolean;
}

/** Decide whether a native action may run. */
export function admitNativeAction(input: NativeActionInput): NativeActionDecision {
  if (!input.availability.available) {
    return {
      allowed: false,
      code: "BINDING_UNAVAILABLE",
      // The seam's own reason travels: "requires-container-engine" and "requires-signed-bundle" need different
      // things done about them, and flattening both into "unavailable" throws that away.
      reason: `${input.availability.reason}: ${input.availability.detail}`,
    };
  }
  if (input.untrustedCode && !input.profile.acceptsUntrustedCode) {
    return {
      allowed: false,
      code: "PROFILE_FORBIDS_UNTRUSTED",
      reason: `profile ${input.profile.name} does not accept untrusted code`,
    };
  }
  if (input.permission !== "granted") {
    return {
      allowed: false,
      code: "PERMISSION_NOT_GRANTED",
      reason: "the screen and input permission for this session has not been granted",
    };
  }
  return { allowed: true, containment: input.availability.containment };
}
