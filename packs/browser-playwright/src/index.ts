import {
  type AutomationOperation,
  type AutomationTarget,
  type Observation,
  ESCALATION_ORDER,
  checkAutomationAction,
  isConsequential,
} from "@clarkcant/contracts";

/**
 * Browser Use pack (Playwright).
 *
 * The control contract lives in core, so this pack owns only the driver mechanics:
 * how a target is described, how an observation is captured, and the locator staleness
 * rule. That split is deliberate — a driver pack must not be able to decide on its own
 * what it is allowed to touch.
 *
 * The rule that matters most: a stale locator is re-observed, never retried blindly.
 * Clicking again at the same coordinates after the page moved is how automation
 * clicks the wrong control, and it is the failure acceptance test T53 exists for.
 */

export const DRIVER_ID = "browser.playwright";

export interface BrowserTargetDescriptor {
  /** Managed profile name. Never the user's own browser profile. */
  profileName: string;
  /** Node that owns the profile. Profiles are not shared between nodes. */
  nodeId: string;
  allowedOrigins: string[];
  /** Whether downloads are permitted, and into which approved root. */
  downloadRoot?: string;
}

/**
 * A managed profile is a separate identity, not a view onto the user's browser.
 *
 * Attaching to the user's Chrome would inherit every logged-in session, which is the
 * opposite of the least-privilege position the blueprint takes. Importing a native
 * profile is a future explicit workflow, not a default.
 */
export function managedProfileDescriptor(
  input: BrowserTargetDescriptor,
): AutomationTarget | { refused: string } {
  if (input.allowedOrigins.length === 0) {
    return {
      refused:
        "a managed browser profile with no allowed origins cannot navigate anywhere; declare the origins this task needs",
    };
  }
  return {
    targetId: `tgt_${input.profileName}` as AutomationTarget["targetId"],
    nodeId: input.nodeId as AutomationTarget["nodeId"],
    kind: "browser-profile",
    resourceVersion: "1",
    sessionId: `session_${input.profileName}`,
    containment: "profile-scoped",
    label: `managed browser profile "${input.profileName}"`,
  };
}

/* ------------------------------------------------------------------ *
 * Locator handling
 * ------------------------------------------------------------------ */

export type LocatorResolution =
  | { status: "resolved"; elementRef: string }
  | { status: "needs-reobservation"; reason: string };

/**
 * Resolve a locator against the current observation.
 *
 * Returning `needs-reobservation` rather than throwing is intentional: the caller has
 * a legitimate next step (observe again), and expressing that as a result rather than
 * an exception keeps the fallback path visible in the type.
 */
export function resolveLocator(
  observation: Observation,
  locator: { elementRef?: string; text?: string },
): LocatorResolution {
  if (locator.elementRef !== undefined) {
    return observation.elementRefs.includes(locator.elementRef)
      ? { status: "resolved", elementRef: locator.elementRef }
      : {
          status: "needs-reobservation",
          reason: `element reference ${locator.elementRef} is not present in observation ${observation.observationId}; the page changed and must be observed again rather than clicked by position`,
        };
  }
  if (locator.text !== undefined) {
    const match = observation.elementRefs.find((ref) => ref.includes(locator.text ?? ""));
    if (match) return { status: "resolved", elementRef: match };
    return {
      status: "needs-reobservation",
      reason: `no current element matches "${locator.text}"; observe again instead of retrying the same click`,
    };
  }
  return {
    status: "needs-reobservation",
    reason: "no locator was supplied; an action must name the element it intends to act on",
  };
}

/** Operations this driver implements. Anything absent must be escalated, not faked. */
export const SUPPORTED_OPERATIONS: readonly AutomationOperation[] = [
  "navigate",
  "read-dom",
  "read-accessibility",
  "screenshot",
  "click",
  "fill",
  "select",
  "scroll",
  "key",
  "hover",
  "wait-for",
  "upload",
  "download",
];

export function supportsOperation(operation: AutomationOperation): boolean {
  return SUPPORTED_OPERATIONS.includes(operation);
}

/**
 * Review a planned action.
 *
 * Delegates the safety decision to the shared contract so the browser driver and the
 * native drivers behave identically, and adds the driver-specific refusal for an
 * operation this pack does not implement.
 */
export function reviewAction(
  action: Parameters<typeof checkAutomationAction>[0],
  context: Parameters<typeof checkAutomationAction>[1],
): ReturnType<typeof checkAutomationAction> {
  if (!supportsOperation(action.operation)) {
    return {
      allowed: false,
      code: "TARGET_STALE",
      message: `the browser driver does not implement ${action.operation}; escalate to a driver that does instead of substituting a different operation`,
    };
  }
  return checkAutomationAction(action, context);
}

export { ESCALATION_ORDER, isConsequential };

/**
 * @implementation-status stub
 * TODO(P8): the Playwright binding itself. Target description, locator resolution,
 * operation support and the shared safety review are implemented and tested; driving a
 * real page needs a downloaded browser engine, which is not installed by default
 * because most users never need one.
 *
 * The engine version must be pinned together with the library version; a mismatched
 * pair is a common and confusing failure.
 */
export const PLAYWRIGHT_BINDING_STATUS = "contract-implemented-engine-not-installed";
