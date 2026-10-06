import { z } from "zod";

import { dataClassSchema } from "./data-class.ts";
import { capabilityRefSchema } from "./grants.ts";
import {
  artifactIdSchema,
  instantSchema,
  nodeIdSchema,
  runIdSchema,
  runtimeIdSchema,
  runtimeSessionIdSchema,
  taskIdSchema,
} from "./primitives.ts";

/**
 * The agent runtimes Clark can run work through, described in Clark's own terms.
 *
 * A runtime is anything that runs an agent loop: the one this node ships with today, or a coding agent installed beside
 * it. They are not equal and are not made to look equal. Each describes itself with one fact per trait — `supported`,
 * `unsupported` or `unknown` — and a trait nobody could establish stays `unknown` rather than being rounded to either
 * answer, so a caller never acts on parity that was assumed rather than observed.
 *
 * Nothing here names a runtime, a vendor or a model. A runtime is an opaque `rt_` id with a display name that is data,
 * so the product semantics of a Clark Task and Run never change when one runtime is replaced by another. Describing a
 * runtime grants nothing: which runtime owns a run, and what that run may touch, stays with the host.
 */

/** The version of the runtime descriptor and the session synopsis. */
export const RUNTIME_FABRIC_VERSION = 1;

/** The traits a runtime may or may not have, each answered on its own. */
export const RUNTIME_FEATURE_NAMES = [
  /** Start a new session that Clark then owns. */
  "spawn",
  /** Join a session through a control protocol the runtime offers. */
  "attach",
  /** Read a session's bounded state without controlling it. */
  "observe",
  "resume",
  "fork",
  /** Add guidance to a session while it runs. */
  "steer",
  "stop",
  /** A structured stream of the runtime's own events, rather than text read off a terminal. */
  "event-stream",
  "session-history",
  "model-catalog",
  "model-switch",
  "usage",
  "provider-quota",
  "extension-inventory",
  "skill-inventory",
  "mcp-inventory",
  /** The runtime hands its approval questions to the host instead of asking on its own surface. */
  "host-approval-bridge",
] as const;
export const runtimeFeatureNameSchema = z.enum(RUNTIME_FEATURE_NAMES);
export type RuntimeFeatureName = z.infer<typeof runtimeFeatureNameSchema>;

export const featureSupportSchema = z.enum(["supported", "unsupported", "unknown"]);
export type FeatureSupport = z.infer<typeof featureSupportSchema>;

/** Every trait, answered. Exhaustive on purpose: a trait left out would be read as one of the answers by someone. */
export const runtimeFeaturesSchema = z.record(runtimeFeatureNameSchema, featureSupportSchema);
export type RuntimeFeatures = z.infer<typeof runtimeFeaturesSchema>;

/** A full feature record from the traits an adapter could establish; every other trait is `unknown`. */
export function runtimeFeatures(known: Partial<Record<RuntimeFeatureName, FeatureSupport>>): RuntimeFeatures {
  const features = {} as RuntimeFeatures;
  for (const name of RUNTIME_FEATURE_NAMES) features[name] = known[name] ?? "unknown";
  return features;
}

/** Whether a trait is supported. `unknown` is not support. */
export function supportsFeature(features: RuntimeFeatures, name: RuntimeFeatureName): boolean {
  return features[name] === "supported";
}

/**
 * How Clark talks to the runtime, most structured first. The order is the preference: a native SDK or protocol over a
 * structured command line, over reading the runtime's stored sessions, and reading a terminal only when nothing else
 * exists.
 */
export const RUNTIME_INTEGRATIONS = [
  "native-sdk",
  "native-protocol",
  "structured-cli",
  "session-store",
  "terminal",
] as const;
export const runtimeIntegrationSchema = z.enum(RUNTIME_INTEGRATIONS);
export type RuntimeIntegration = z.infer<typeof runtimeIntegrationSchema>;

export const runtimeDescriptorSchema = z.strictObject({
  version: z.literal(RUNTIME_FABRIC_VERSION),
  runtimeId: runtimeIdSchema,
  /** What a person would call it, shown only as technical detail they asked for. */
  displayName: z.string().min(1).max(80),
  /** The node the runtime is installed on. A runtime never spans nodes. */
  nodeId: nodeIdSchema,
  integration: runtimeIntegrationSchema,
  /** The runtime's own version, as it reports it, when it reports one. */
  runtimeVersion: z.string().min(1).max(80).optional(),
  features: runtimeFeaturesSchema,
});
export type RuntimeDescriptor = z.infer<typeof runtimeDescriptorSchema>;

/**
 * What a probe found. `unknown` when the probe could not tell, which is not `available`: a runtime that did not answer
 * is not one work can be handed to.
 */
export const runtimeStatusSchema = z.strictObject({
  state: z.enum(["available", "unavailable", "unknown"]),
  /** Why it is not available, in words a person reads. */
  reason: z.string().min(1).max(500).optional(),
  checkedAt: instantSchema,
});
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

/**
 * The shape every runtime adapter has. An adapter describes and probes; it does not own a run's lifecycle, schedule
 * work or decide what a run may touch — one execution backend owns each run, and the host owns its authority.
 */
export interface AgentRuntimeAdapter {
  descriptor(): RuntimeDescriptor;
  probe(): Promise<RuntimeStatus>;
  features(): RuntimeFeatures;
}

/**
 * What Clark may do with a session.
 *
 * `managed`: Clark started it and owns it. `attached`: Clark joined it through a control protocol the runtime offers.
 * `observed`: Clark may read bounded state and nothing more — finding a session does not make it Clark's to steer.
 */
export const sessionAuthoritySchema = z.enum(["managed", "attached", "observed"]);
export type SessionAuthority = z.infer<typeof sessionAuthoritySchema>;

export const sessionActionSchema = z.enum(["observe", "steer", "stop", "resume", "fork"]);
export type SessionAction = z.infer<typeof sessionActionSchema>;

/**
 * Whether Clark may take an action on a session: its authority has to allow the action, and the runtime has to support
 * it. An observed session is only ever observed, and a trait that is `unknown` is not used.
 *
 * This answers what can be asked of the runtime itself. The host's own Stop — the execution backend ending work it
 * owns — does not depend on it and is never refused here.
 */
export function maySessionAct(input: {
  authority: SessionAuthority;
  features: RuntimeFeatures;
  action: SessionAction;
}): boolean {
  if (input.authority === "observed" && input.action !== "observe") return false;
  return supportsFeature(input.features, input.action);
}

/**
 * Where a session's state was read from. Only the runtime's own protocol or the host's supervision of a process it
 * started is evidence the session is alive; a recently written session file is history, not liveness.
 */
export const sessionStateSourceSchema = z.enum(["live-protocol", "process-supervision", "stored-history"]);
export type SessionStateSource = z.infer<typeof sessionStateSourceSchema>;

export const runtimeSessionStateSchema = z.enum(["running", "waiting-input", "idle", "completed", "failed", "stopped", "unknown"]);
export type RuntimeSessionState = z.infer<typeof runtimeSessionStateSchema>;

/** The states that claim a session is alive right now. */
const LIVE_SESSION_STATES: readonly RuntimeSessionState[] = ["running", "waiting-input"];

/** The most capability refs or artifact refs one synopsis lists. A synopsis is a summary, not an inventory. */
export const RUNTIME_SESSION_SYNOPSIS_LIST_MAX = 16;

/**
 * One runtime session in a few bounded fields, which is all Main Clark carries about it by default. The transcript
 * stays where it is and is read lazily, redacted and with provenance, only when the context planner decides it matters.
 */
export const runtimeSessionSynopsisSchema = z
  .strictObject({
    version: z.literal(RUNTIME_FABRIC_VERSION),
    runtimeId: runtimeIdSchema,
    sessionId: runtimeSessionIdSchema,
    authority: sessionAuthoritySchema,
    state: runtimeSessionStateSchema,
    stateSource: sessionStateSourceSchema,
    /** What the session is for, in a sentence. */
    goal: z.string().min(1).max(300).optional(),
    /** The project the session works in, by the host's own name for it. */
    projectRef: z.string().min(1).max(200).optional(),
    /** The Clark Task and Run the session serves, when it serves one. */
    taskId: taskIdSchema.optional(),
    runId: runIdSchema.optional(),
    /** Technical detail, shown only when asked for. Data, not part of any type. */
    provider: z.string().min(1).max(80).optional(),
    model: z.string().min(1).max(120).optional(),
    usage: z
      .strictObject({
        inputTokens: z.int().nonnegative().optional(),
        outputTokens: z.int().nonnegative().optional(),
        costUsd: z.number().nonnegative().optional(),
      })
      .optional(),
    quota: z
      .strictObject({
        state: z.enum(["ok", "constrained", "exhausted", "unknown"]),
        resetsAt: instantSchema.optional(),
      })
      .optional(),
    activeCapabilities: z.array(capabilityRefSchema).max(RUNTIME_SESSION_SYNOPSIS_LIST_MAX).optional(),
    /** The latest outcome, in a sentence. */
    recentOutcome: z.string().min(1).max(500).optional(),
    artifactRefs: z.array(artifactIdSchema).max(RUNTIME_SESSION_SYNOPSIS_LIST_MAX).optional(),
    /** How sensitive this synopsis is, so it crosses the same data boundaries as anything else put before a model. */
    dataClass: dataClassSchema,
    observedAt: instantSchema,
  })
  .superRefine((synopsis, ctx) => {
    if (LIVE_SESSION_STATES.includes(synopsis.state) && synopsis.stateSource === "stored-history") {
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message: `a session read from stored history cannot be said to be ${synopsis.state}; say unknown`,
      });
    }
  });
export type RuntimeSessionSynopsis = z.infer<typeof runtimeSessionSynopsisSchema>;
