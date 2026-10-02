import { z } from "zod";

import { ARTIFACT_LIMITS } from "./artifacts.ts";

/**
 * Resource profiles: what a package's code is given to run with, named by the host.
 *
 * A package asks for a profile by name and never for numbers, because a number in a manifest is a package author
 * deciding how much of the person's machine their code takes. The host owns the table below, decides what it grants
 * (`decideResourceProfile`), and the granted profile is the only thing the container, the call deadline, job
 * concurrency and the artifact ceiling are read from.
 *
 * `interactive-light` is the envelope every service ran in before profiles existed, value for value, so a package that
 * asks for nothing runs exactly as it did. The larger profiles are engineering defaults a reviewer can change here.
 */

export const RESOURCE_PROFILE_NAMES = ["interactive-light", "interactive-heavy", "media-workstation", "background-compute"] as const;
export const resourceProfileNameSchema = z.enum(RESOURCE_PROFILE_NAMES);
export type ResourceProfileName = z.infer<typeof resourceProfileNameSchema>;

export const DEFAULT_RESOURCE_PROFILE: ResourceProfileName = "interactive-light";

const MIB = 1024 * 1024;

export interface ResourceProfile {
  name: ResourceProfileName;
  /** The service container's bounds. Memory and `/tmp` are whole MiB, so the engine's `m` suffix says them exactly. */
  container: { memoryMib: number; cpus: number; pids: number; tmpfsMib: number };
  /** The longest one ordinary capability call may take. A caller may ask for less, never for more. */
  callDeadlineMs: number;
  /** The longest one `jobs@1` call may run. */
  jobDeadlineMs: number;
  /** Jobs one package may run at once, inside the node's own limit. */
  maxActiveJobs: number;
  /**
   * The largest file a service result may become. Never above `ARTIFACT_LIMITS.maxBytes`: an artifact must stay
   * attachable to a conversation, so no profile raises it; a profile may only lower it.
   */
  artifactMaxBytes: number;
  /**
   * The largest input the host streams to one call. `maxBytes` is enforced by the host before the call is sent: an
   * artifact larger than it is refused and no byte of it reaches the service. `maxMediaSeconds` is offered to the
   * service, which is the only side that reads a media file's duration, and a service that reads a longer clip refuses
   * it. Neither may be above an attachable file (`ARTIFACT_LIMITS.maxBytes`).
   */
  input: { maxBytes: number; maxMediaSeconds: number };
  /** Services and jobs keep running by policy, whether or not a widget frame is mounted. */
  background: "continue";
  /**
   * What a widget frame does when it scrolls out of view. `suspend` unmounts it. `authorized-playback` also unmounts it,
   * unless the person chose, in host chrome, to keep it playing; the host then shows that it is still running.
   */
  offscreen: "suspend" | "authorized-playback";
  /** A service never gets a network. Outbound requests go through the host's egress broker. */
  network: "none";
}

export const RESOURCE_PROFILES: Readonly<Record<ResourceProfileName, ResourceProfile>> = Object.freeze({
  "interactive-light": Object.freeze({
    name: "interactive-light",
    container: Object.freeze({ memoryMib: 256, cpus: 1, pids: 128, tmpfsMib: 16 }),
    callDeadlineMs: 60_000,
    jobDeadlineMs: 30 * 60_000,
    maxActiveJobs: 4,
    artifactMaxBytes: ARTIFACT_LIMITS.maxBytes,
    input: Object.freeze({ maxBytes: 8 * MIB, maxMediaSeconds: 120 }),
    background: "continue",
    offscreen: "suspend",
    network: "none",
  }),
  "interactive-heavy": Object.freeze({
    name: "interactive-heavy",
    container: Object.freeze({ memoryMib: 1024, cpus: 2, pids: 256, tmpfsMib: 64 }),
    callDeadlineMs: 120_000,
    jobDeadlineMs: 30 * 60_000,
    maxActiveJobs: 2,
    artifactMaxBytes: ARTIFACT_LIMITS.maxBytes,
    input: Object.freeze({ maxBytes: 16 * MIB, maxMediaSeconds: 600 }),
    background: "continue",
    offscreen: "suspend",
    network: "none",
  }),
  "media-workstation": Object.freeze({
    name: "media-workstation",
    container: Object.freeze({ memoryMib: 4096, cpus: 4, pids: 512, tmpfsMib: 512 }),
    callDeadlineMs: 300_000,
    jobDeadlineMs: 2 * 60 * 60_000,
    maxActiveJobs: 1,
    artifactMaxBytes: ARTIFACT_LIMITS.maxBytes,
    input: Object.freeze({ maxBytes: ARTIFACT_LIMITS.maxBytes, maxMediaSeconds: 2 * 60 * 60 }),
    background: "continue",
    offscreen: "authorized-playback",
    network: "none",
  }),
  "background-compute": Object.freeze({
    name: "background-compute",
    container: Object.freeze({ memoryMib: 2048, cpus: 2, pids: 256, tmpfsMib: 256 }),
    callDeadlineMs: 60_000,
    jobDeadlineMs: 4 * 60 * 60_000,
    maxActiveJobs: 2,
    artifactMaxBytes: ARTIFACT_LIMITS.maxBytes,
    input: Object.freeze({ maxBytes: ARTIFACT_LIMITS.maxBytes, maxMediaSeconds: 60 * 60 }),
    background: "continue",
    offscreen: "suspend",
    network: "none",
  }),
});

/**
 * What a manifest may say: a profile by name and whether its code needs a GPU. Strict, so a field such as `memory`
 * is refused when the manifest is read rather than ignored, and versioned so a later shape is a new literal.
 */
export const resourceRequestSchema = z.strictObject({
  version: z.literal(1),
  profile: resourceProfileNameSchema,
  gpu: z.boolean().optional(),
});
export type ResourceRequest = z.infer<typeof resourceRequestSchema>;

/** What the container engine says about the machine it runs containers on. Undefined fields were not reported. */
export interface EngineCapacity {
  memoryBytes?: number | undefined;
  cpus?: number | undefined;
  /**
   * Whether the engine applies memory and CPU limits. False on a rootless engine without cgroup v2 delegation, where
   * the engine accepts `--memory` and `--cpus` and runs the container without them.
   */
  enforcesLimits?: boolean | undefined;
}

export type ResourceGrant =
  | {
      status: "granted";
      requested: ResourceProfileName;
      profile: ResourceProfile;
      /** Facts a person should see beside the grant, such as limits the engine does not enforce. */
      notes: readonly string[];
    }
  | { status: "degraded"; requested: ResourceProfileName; reason: string };

/** The share of the engine's memory one profile may take, so the node and the other services keep room. */
export const PROFILE_MEMORY_SHARE = 0.5;

function gib(bytes: number): string {
  const value = bytes / (1024 * MIB);
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} GiB`;
}

/**
 * What the host grants for one package.
 *
 * Pure, so the node, the dev host and a test read the same answer. In order:
 *
 *   1. A GPU is never granted: the node does not pass one through to a container, and it is not emulated.
 *   2. `interactive-light` is always granted. It is today's envelope, and taking it away would stop packages that ran.
 *   3. A policy refusal wins over capacity: it is the person's decision about their machine.
 *   4. A profile that needs more CPUs than the engine has, or more than half its memory, is not granted.
 *
 * Never a smaller profile in place of the requested one: a profile that cannot be granted is `degraded`, with the
 * sentence a person reads, and the code does not run under it.
 */
export function decideResourceProfile(input: {
  request: ResourceRequest | undefined;
  /** Whether anything runs in a container; a package with only a widget needs no engine capacity. */
  needsContainer: boolean;
  /** Undefined when the engine has not been asked yet or did not answer. */
  capacity: EngineCapacity | undefined;
  /** A refusal from the execution policy, as its sentence; undefined when the policy does not refuse. */
  policyRefusal?: string | undefined;
}): ResourceGrant {
  const requested = input.request?.profile ?? DEFAULT_RESOURCE_PROFILE;
  const profile = RESOURCE_PROFILES[requested];
  const degraded = (reason: string): ResourceGrant => ({ status: "degraded", requested, reason });

  if (input.request?.gpu === true) {
    return degraded(`${requested} with a GPU cannot be granted: this node does not pass a GPU through to a package`);
  }
  const notes: string[] = [];
  if (input.needsContainer && input.capacity?.enforcesLimits === false) {
    notes.push("the container engine does not enforce memory and CPU limits here, so the service runs without them");
  }
  if (requested === DEFAULT_RESOURCE_PROFILE) return { status: "granted", requested, profile, notes };

  if (input.policyRefusal !== undefined) {
    return degraded(`${requested} is not granted: ${input.policyRefusal}`);
  }
  if (input.needsContainer && input.capacity !== undefined) {
    const { cpus, memoryBytes } = input.capacity;
    if (cpus !== undefined && profile.container.cpus > cpus) {
      return degraded(
        `${requested} needs ${String(profile.container.cpus)} CPUs, and the container engine here has ${String(cpus)}`,
      );
    }
    const wanted = profile.container.memoryMib * MIB;
    if (memoryBytes !== undefined && wanted > memoryBytes * PROFILE_MEMORY_SHARE) {
      return degraded(
        `${requested} needs ${gib(wanted)} of memory, more than half of the ${gib(memoryBytes)} the container engine here has`,
      );
    }
    if (memoryBytes === undefined || cpus === undefined) {
      notes.push("the container engine did not report its memory or CPUs, so the profile was granted without that check");
    }
  }
  return { status: "granted", requested, profile, notes };
}

/** The bounds a person reads in package details: what the granted profile gives, in their units. */
export function describeResourceProfile(profile: ResourceProfile): string {
  const { memoryMib, cpus, pids, tmpfsMib } = profile.container;
  const memory = memoryMib >= 1024 ? `${String(memoryMib / 1024)} GiB` : `${String(memoryMib)} MiB`;
  const minutes = (ms: number): string => (ms >= 60 * 60_000 ? `${String(ms / (60 * 60_000))} h` : `${String(ms / 60_000)} min`);
  return [
    `${memory} memory`,
    `${String(cpus)} CPU${cpus === 1 ? "" : "s"}`,
    `${String(pids)} processes`,
    `${String(tmpfsMib)} MiB scratch`,
    `${String(profile.callDeadlineMs / 1000)} s per call`,
    `${minutes(profile.jobDeadlineMs)} per job`,
    `${String(profile.maxActiveJobs)} job${profile.maxActiveJobs === 1 ? "" : "s"} at once`,
    `${String(profile.input.maxBytes / MIB)} MiB input`,
    `${minutes(profile.input.maxMediaSeconds * 1000)} of media`,
    "no network",
  ].join(", ");
}
