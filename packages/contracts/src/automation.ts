import { z } from "zod";

import { automationTargetIdSchema, instantSchema, observationIdSchema } from "./primitives.ts";

/**
 * Browser Use and Computer Use contracts.
 *
 * Core owns the control contract: target identity, leases, observation/action
 * correlation, consent and the stop path. Driver packs own the implementation —
 * Playwright, a macOS native driver, a Linux virtual desktop. Keeping the
 * contract here is what stops a driver pack from deciding on its own what it is
 * allowed to touch.
 *
 * The one invariant that matters most: an action must name the observation it
 * was planned against. A locator or coordinate sequence from a stale view is how
 * automation clicks the wrong thing, so the lease epoch and observation id are
 * mandatory and checked, never inferred.
 */

export const automationTargetKindSchema = z.enum([
  "browser-profile",
  "native-desktop",
  "virtual-desktop",
]);
export type AutomationTargetKind = z.infer<typeof automationTargetKindSchema>;

export const automationTargetSchema = z.strictObject({
  targetId: automationTargetIdSchema,
  nodeId: z.string().min(1).max(128),
  kind: automationTargetKindSchema,
  /** Bumped whenever the underlying target identity changes. */
  resourceVersion: z.string().min(1).max(120),
  sessionId: z.string().min(1).max(160),
  /**
   * What the OS or browser can actually enforce for this target. Recorded because
   * "app-only containment" is often not enforceable, and the honest thing is to
   * say so rather than imply a boundary that does not exist.
   */
  containment: z.enum(["profile-scoped", "app-scoped", "display-scoped", "unrestricted"]),
  /** Human-readable target name shown in the control indicator. */
  label: z.string().min(1).max(300),
});
export type AutomationTarget = z.infer<typeof automationTargetSchema>;

export const observationSchema = z.strictObject({
  observationId: observationIdSchema,
  targetId: automationTargetIdSchema,
  /**
   * Lease epoch at capture time. An action referencing an observation from an
   * older epoch is refused, which is what makes "local stop wins over a stale
   * remote command" enforceable (acceptance test T59).
   */
  leaseEpoch: z.int().nonnegative(),
  capturedAt: instantSchema,
  /** Structured accessibility snapshot, preferred over pixels when available. */
  accessibilityRef: z.string().min(1).max(300).optional(),
  screenshotRef: z.string().min(1).max(300).optional(),
  viewport: z
    .strictObject({
      width: z.int().positive(),
      height: z.int().positive(),
      scale: z.number().positive(),
    })
    .optional(),
  /** Foreground window at capture time, for native targets. */
  foregroundWindowRef: z.string().min(1).max(300).optional(),
  /** Element references the action may use. Anything else must re-observe. */
  elementRefs: z.array(z.string().min(1).max(300)).max(2000),
  /** True when sensitive input was on screen; capture must stop. */
  containsSensitiveInput: z.boolean(),
});
export type Observation = z.infer<typeof observationSchema>;

/**
 * Operations a driver may perform. Deliberately typed rather than a free-form
 * string, so a driver cannot be handed an operation the policy layer has no
 * opinion about.
 */
export const automationOperationSchema = z.enum([
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
  "launch-app",
  "focus-window",
  "type-text",
]);
export type AutomationOperation = z.infer<typeof automationOperationSchema>;

export const automationActionSchema = z.strictObject({
  actionId: z.string().min(1).max(128),
  targetId: automationTargetIdSchema,
  /** The observation this plan was derived from. Mandatory. */
  observationId: observationIdSchema,
  leaseEpoch: z.int().nonnegative(),
  operation: automationOperationSchema,
  arguments: z.record(z.string(), z.unknown()),
  expectedTargetVersion: z.string().min(1).max(120),
  /**
   * Whether this operation can leave a durable external effect. Submit buttons,
   * payments and sends are not "just a click".
   */
  consequential: z.boolean(),
});
export type AutomationAction = z.infer<typeof automationActionSchema>;

export type AutomationRefusal =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "TARGET_STALE"
        | "OBSERVATION_EXPIRED"
        | "TARGET_CHANGED"
        | "STALE_LEASE_EPOCH"
        | "SENSITIVE_INPUT_ACTIVE"
        | "HUMAN_TAKEOVER_ACTIVE"
        | "APPROVAL_REQUIRED";
      message: string;
    };

/**
 * Preflight for an automation action.
 *
 * Every check here is a way automation goes wrong in practice: acting on a
 * stale view, acting after the user took the keyboard, acting while a password
 * field is on screen, or acting after the local stop button was pressed.
 */
export function checkAutomationAction(
  action: AutomationAction,
  context: {
    observation: Observation | undefined;
    currentLeaseEpoch: number;
    currentTargetVersion: string;
    humanTakeover: boolean;
    stopRequested: boolean;
    approvalGranted: boolean;
  },
): AutomationRefusal {
  if (context.stopRequested) {
    return {
      allowed: false,
      code: "STALE_LEASE_EPOCH",
      message: "a stop was requested on this target; the action is not sent",
    };
  }
  if (context.humanTakeover) {
    return {
      allowed: false,
      code: "HUMAN_TAKEOVER_ACTIVE",
      message: "the user has takeover of this target; agent input is paused",
    };
  }
  if (!context.observation) {
    return {
      allowed: false,
      code: "OBSERVATION_EXPIRED",
      message: `observation ${action.observationId} is no longer retained; observe again before acting`,
    };
  }
  if (context.observation.observationId !== action.observationId) {
    return {
      allowed: false,
      code: "OBSERVATION_EXPIRED",
      message: "the action references an observation that is not the current one",
    };
  }
  if (context.observation.targetId !== action.targetId) {
    return {
      allowed: false,
      code: "TARGET_CHANGED",
      message: "the observation belongs to a different target",
    };
  }
  if (action.leaseEpoch !== context.currentLeaseEpoch) {
    return {
      allowed: false,
      code: "STALE_LEASE_EPOCH",
      message: `action carries lease epoch ${action.leaseEpoch} but the current epoch is ${context.currentLeaseEpoch}`,
    };
  }
  if (action.expectedTargetVersion !== context.currentTargetVersion) {
    return {
      allowed: false,
      code: "TARGET_STALE",
      message: `action expects target version ${action.expectedTargetVersion} but the target is at ${context.currentTargetVersion}`,
    };
  }
  if (context.observation.containsSensitiveInput) {
    return {
      allowed: false,
      code: "SENSITIVE_INPUT_ACTIVE",
      message: "sensitive input is on screen; capture and agent input are suspended",
    };
  }
  if (action.consequential && !context.approvalGranted) {
    return {
      allowed: false,
      code: "APPROVAL_REQUIRED",
      message: "this operation can leave a durable external effect and needs explicit approval",
    };
  }
  return { allowed: true };
}

/**
 * Classify an operation as consequential.
 *
 * A click is not inherently harmless — it can send an email or place an order.
 * Operations with no durable external effect are free; everything that could
 * submit is not, and is treated conservatively when the driver cannot tell.
 */
export function isConsequential(
  operation: AutomationOperation,
  hints: { submitsForm?: boolean; triggersNavigation?: boolean },
): boolean {
  if (hints.submitsForm) return true;
  return (
    operation === "upload" ||
    operation === "download" ||
    operation === "key" ||
    operation === "type-text"
  );
}

/**
 * Outcome of an automation step.
 *
 * `unknown` after a submit is the important case: a timeout while submitting a
 * form must not become a second submit (acceptance test T55). The driver has to
 * say it does not know, and the supervisor reconciles by observing.
 */
export const automationActionResultSchema = z.strictObject({
  actionId: z.string().min(1).max(128),
  status: z.enum(["applied", "refused", "failed", "unknown"]),
  observedAfter: observationIdSchema.optional(),
  /** Evidence that the intended effect was seen, not merely that a click landed. */
  verification: z.enum(["observed-applied", "observed-absent", "not-observed", "not-applicable"]),
  message: z.string().min(1).max(2000),
  /** When true the supervisor must observe before any further action. */
  requiresReobservation: z.boolean(),
});
export type AutomationActionResult = z.infer<typeof automationActionResultSchema>;

/** Escalation order. Cheaper, more auditable options come first by design. */
export const ESCALATION_ORDER: readonly AutomationTargetKind[] = [
  "browser-profile",
  "native-desktop",
  "virtual-desktop",
];

/**
 * Whether an escalation is permitted.
 *
 * Moving up the ladder is never an automatic response to being blocked. An API
 * returning 403, a CAPTCHA, or a denied OAuth consent are answers, not obstacles
 * to route around; escalating past them needs a fresh, explicit grant.
 */
export function mayEscalate(input: {
  from: AutomationTargetKind;
  to: AutomationTargetKind;
  reason: "capability-missing" | "blocked-by-service" | "needs-native-app";
  freshConsent: boolean;
}): { allowed: boolean; message: string } {
  if (input.reason === "blocked-by-service") {
    return {
      allowed: false,
      message:
        "the service refused the operation (policy, CAPTCHA, or consent); escalating to a broader driver would work around that refusal",
    };
  }
  const fromIndex = ESCALATION_ORDER.indexOf(input.from);
  const toIndex = ESCALATION_ORDER.indexOf(input.to);
  if (toIndex <= fromIndex) {
    return { allowed: true, message: "already at or below the requested target kind" };
  }
  if (!input.freshConsent) {
    return {
      allowed: false,
      message: "a broader driver opens new permissions and requires fresh consent",
    };
  }
  return { allowed: true, message: "escalation permitted with recorded consent" };
}
