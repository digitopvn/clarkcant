import type { AutomationTarget } from "@clarkcant/contracts";

/**
 * macOS native driver pack.
 *
 * Computer Use has broad reach, so the design constraints are tighter than the browser
 * driver's: one foreground-input lease, an always-visible host indicator, and a local
 * stop that does not depend on the model or the network.
 *
 * The permission model is stated rather than implied. Accessibility and screen-capture
 * are two separate grants, and approving capture does not grant input.
 */

export const DRIVER_ID = "computer.macos";

/** Candidate native driver. Pin version and verify TCC behaviour before relying on it. */
export const DRIVER_CANDIDATE = "peekaboo";

export interface MacOsPermissionState {
  accessibility: "granted" | "denied" | "unknown";
  screenCapture: "granted" | "denied" | "unknown";
}

/**
 * Whether input may be delivered.
 *
 * Capture and input are checked separately on purpose. A user who granted screen
 * recording has not thereby agreed that this application can click things, and
 * treating the two as one permission would be a real overreach.
 */
export function inputAllowed(permissions: MacOsPermissionState): { allowed: true } | { allowed: false; reason: string } {
  if (permissions.accessibility === "granted") return { allowed: true };
  if (permissions.accessibility === "denied") {
    return {
      allowed: false,
      reason:
        "Accessibility permission was denied for this application. Open System Settings > Privacy & Security > Accessibility and enable it. The application cannot grant this for you.",
    };
  }
  return {
    allowed: false,
    reason:
      "Accessibility permission has not been requested yet; it is granted through a system prompt that only the user can accept",
  };
}

export function captureAllowed(permissions: MacOsPermissionState): { allowed: true } | { allowed: false; reason: string } {
  if (permissions.screenCapture === "granted") return { allowed: true };
  return {
    allowed: false,
    reason:
      permissions.screenCapture === "denied"
        ? "Screen Recording permission was denied; screenshots and observation are unavailable"
        : "Screen Recording permission has not been granted yet",
  };
}

/**
 * The containment this driver can actually promise.
 *
 * macOS does not offer per-application input containment to a third-party process, so
 * the honest label is `display-scoped`: input goes to whatever is focused, and the
 * application-selection in the UI is a targeting aid rather than an enforced boundary.
 * Saying "app-scoped" here would be a false security claim.
 */
export const CONTAINMENT = "display-scoped" as AutomationTarget["containment"];

/**
 * Target validation before input.
 *
 * Foreground window, display identity and scale are all checked because a DPI change or
 * a window switch between observation and action turns a correct plan into a click on
 * the wrong control (acceptance test T58).
 */
export function validateForegroundTarget(input: {
  observedWindowRef: string;
  observedScale: number;
  currentWindowRef: string;
  currentScale: number;
}): { valid: true } | { valid: false; reason: string } {
  if (input.observedWindowRef !== input.currentWindowRef) {
    return {
      valid: false,
      reason: `the foreground window changed from ${input.observedWindowRef} to ${input.currentWindowRef}; re-observe before sending input`,
    };
  }
  if (input.observedScale !== input.currentScale) {
    return {
      valid: false,
      reason: `display scale changed from ${input.observedScale} to ${input.currentScale}; coordinates from the previous observation are not valid`,
    };
  }
  return { valid: true };
}

/**
 * @implementation-status stub
 * TODO(P8): the native driver binding, including a signed and packaged launch context.
 * Permission gating, containment labelling, target validation and the lease/stop
 * contract are implemented and tested; delivering real input requires a signed bundle
 * with a stable identity, because an unsigned binary loses its TCC grant on every rebuild.
 */
export const NATIVE_BINDING_STATUS = "contract-implemented-signed-bundle-required";
