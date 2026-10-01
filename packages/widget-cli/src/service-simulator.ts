import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  capabilityReadinessSchema,
  capabilityRefSchema,
  isUsable,
  type CapabilityReadiness,
} from "@clarkcant/contracts";
import { hostToWidgetSchema } from "@clarkcant/widget-sdk";
import { z } from "zod";

import { devJobFixtureSchema, type DevJobFixture } from "./dev-jobs.ts";

export type ServiceStatus = "loading" | "ready" | "blocked" | "unhealthy";
export type ServiceReadiness = CapabilityReadiness;

export interface ServiceBinding {
  actionBindingId: string;
  capabilityRef: string;
  outcome: unknown;
  /** Present when the capability runs as a job: the press answers with a simulated JobRef instead of `outcome`. */
  job?: DevJobFixture | undefined;
}

const simulatorFile = "fixtures/dev-host-services.json";
const simulatorLimit = 32 * 1024;
const fixtureSchema = z.strictObject({
  bindings: z.array(z.strictObject({
    actionBindingId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
    capabilityRef: capabilityRefSchema,
    // Absent only for a job binding, whose press is answered with its simulated JobRef.
    outcome: z.unknown().optional(),
    job: devJobFixtureSchema.optional(),
  })).max(64),
});

/** Read only bounded JSON data. The dev host never imports or executes a service fixture. */
export function readServiceSimulator(
  root: string,
  declaredCapabilities: readonly string[],
  /** Capabilities the manifest declares with `execution: { kind: "job" }`, whose press a node answers with a JobRef. */
  jobCapabilities: readonly string[] = [],
): {
  capabilities: readonly string[];
  bindings: readonly ServiceBinding[];
} {
  const path = join(root, simulatorFile);
  if (!existsSync(path)) return { capabilities: [...declaredCapabilities], bindings: [] };
  const size = statSync(path).size;
  if (size > simulatorLimit) throw new Error(`${simulatorFile} exceeds the ${simulatorLimit}-byte limit`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${simulatorFile} must contain valid JSON`);
  }
  const parsed = fixtureSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${simulatorFile} is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);

  const declared = new Set(declaredCapabilities);
  const seen = new Set<string>();
  for (const binding of parsed.data.bindings) {
    if (!declared.has(binding.capabilityRef)) {
      throw new Error(`${simulatorFile} binding ${binding.actionBindingId} refers to undeclared capability ${binding.capabilityRef}`);
    }
    if (seen.has(binding.actionBindingId)) throw new Error(`${simulatorFile} repeats action binding ${binding.actionBindingId}`);
    // Both ways, so the simulation answers a press the way a node would: a job capability with a JobRef, and only it.
    const runsAsJob = jobCapabilities.includes(binding.capabilityRef);
    if (runsAsJob && binding.job === undefined) {
      throw new Error(`${simulatorFile} binding ${binding.actionBindingId} calls job capability ${binding.capabilityRef} and needs a "job" fixture`);
    }
    if (!runsAsJob && binding.job !== undefined) {
      throw new Error(`${simulatorFile} binding ${binding.actionBindingId} has a "job" fixture, but ${binding.capabilityRef} is not declared with execution kind "job"`);
    }
    seen.add(binding.actionBindingId);
  }
  return { capabilities: [...declaredCapabilities], bindings: parsed.data.bindings };
}

export function readinessForStatus(status: ServiceStatus, reason?: string): CapabilityReadiness {
  const base = { installed: true, loaded: status !== "loading", authenticated: true, authorized: true, healthy: status === "ready" };
  if (status === "blocked") return capabilityReadinessSchema.parse({ ...base, authorized: false, blockedReason: reason?.trim().slice(0, 500) || "service is blocked" });
  if (status === "unhealthy") return capabilityReadinessSchema.parse({ ...base, blockedReason: reason?.trim().slice(0, 500) || "service is unhealthy" });
  if (status === "loading") return capabilityReadinessSchema.parse({ ...base, blockedReason: reason?.trim().slice(0, 500) || "the service has not started yet" });
  return capabilityReadinessSchema.parse(base);
}

export function serviceStatus(readiness: CapabilityReadiness): ServiceStatus {
  if (isUsable(readiness)) return "ready";
  if (!readiness.installed || !readiness.loaded) return "loading";
  if (!readiness.authenticated || !readiness.authorized) return "blocked";
  if (!readiness.healthy) return "unhealthy";
  return "loading";
}

export function initialServiceState(capabilities: readonly string[]): Record<string, CapabilityReadiness> {
  return Object.fromEntries(capabilities.map((ref) => [ref, readinessForStatus("loading")]));
}

export function transitionServiceState(
  current: Record<string, CapabilityReadiness>,
  capabilityRef: string,
  status: ServiceStatus,
  reason?: string,
): Record<string, CapabilityReadiness> {
  if (!(capabilityRef in current)) return current;
  return {
    ...current,
    [capabilityRef]: readinessForStatus(status, reason ?? (status === "unhealthy" ? "service is unhealthy" : undefined)),
  };
}

export function actionAvailability(input: {
  bindings: readonly ServiceBinding[];
  readiness: Record<string, CapabilityReadiness>;
  offline: boolean;
}): { actionBindingId: string; available: boolean; reason?: string }[] {
  return input.bindings.map((binding) => {
    const capability = input.readiness[binding.capabilityRef];
    const status = capability === undefined ? "loading" : serviceStatus(capability);
    if (input.offline) return { actionBindingId: binding.actionBindingId, available: false, reason: "the node is offline" };
    if (status === "ready") return { actionBindingId: binding.actionBindingId, available: true };
    const reason = capability?.blockedReason ?? (status === "blocked"
      ? "service is blocked"
      : status === "unhealthy"
        ? "service is unhealthy"
        : "service is loading");
    return { actionBindingId: binding.actionBindingId, available: false, reason };
  });
}

/** Validate the complete wire answer; malformed fixture data is answered with a schema-valid refusal. */
export function actionResult(input: {
  nonce: string;
  actionBindingId: string;
  invocationId: string;
  outcome: unknown;
}): Record<string, unknown> {
  const candidate = typeof input.outcome === "object" && input.outcome !== null
    ? { ...input.outcome, kind: "action-result", nonce: input.nonce, actionBindingId: input.actionBindingId, invocationId: input.invocationId }
    : input.outcome;
  const parsed = hostToWidgetSchema.safeParse(candidate);
  if (parsed.success && parsed.data.kind === "action-result") return parsed.data;
  return {
    kind: "action-result",
    nonce: input.nonce,
    actionBindingId: input.actionBindingId,
    invocationId: input.invocationId,
    status: "refused",
    message: "the configured service fixture returned a malformed response",
  };
}
