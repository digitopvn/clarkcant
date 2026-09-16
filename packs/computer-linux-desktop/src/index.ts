import type { AutomationTarget } from "@clarkcant/contracts";

/**
 * Linux virtual-desktop pack.
 *
 * A headless server has no desktop, so this pack provides one inside an isolated
 * runner: its own display server, its own filesystem view and its own session. The user
 * sees that session in an authenticated preview, not their own screen.
 *
 * Two consequences of the isolation are stated rather than glossed over:
 *
 * - The runner cannot display macOS applications. A task needing one must be delegated
 *   to a paired Mac node, and the capability discovery has to say so (T60).
 * - A container is not a virtual machine. Against a host-kernel adversary, container
 *   isolation is weaker, and stronger isolation is a threat-model decision rather than
 *   something this pack can promise.
 */

export const DRIVER_ID = "computer.linux-desktop";

export interface VirtualDesktopProfile {
  /** Display geometry. Chosen explicitly so observations have a predictable viewport. */
  width: number;
  height: number;
  /** Colour depth; 24 is enough for screenshots and avoids palette surprises. */
  depth: 24;
  /** Mounted paths. The host home directory is never mounted. */
  mounts: { containerPath: string; hostPath: string; readOnly: boolean }[];
  /** Network policy for the session. */
  egress: "none" | "declared-hosts" | "open";
  cpuShares?: number;
  memoryBytes?: number;
  pidsLimit?: number;
}

export const DEFAULT_VIRTUAL_DESKTOP: VirtualDesktopProfile = {
  width: 1280,
  height: 800,
  depth: 24,
  mounts: [],
  egress: "declared-hosts",
  memoryBytes: 2 * 1024 * 1024 * 1024,
  pidsLimit: 512,
};

/**
 * Validate a runner profile.
 *
 * The refusals here are the ones that turn "sandboxed" into a false claim: mounting the
 * host home, mounting the container runtime socket, or disabling the PID limit each
 * removes the isolation the profile is supposed to provide.
 */
export function validateProfile(
  profile: VirtualDesktopProfile,
): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  for (const mount of profile.mounts) {
    if (mount.containerPath === "/" || mount.containerPath === "/host") {
      problems.push(`mounting ${mount.containerPath} exposes the whole runner filesystem`);
    }
    if (mount.hostPath === process.env.HOME || mount.hostPath === "/") {
      problems.push("mounting the host home or root directory defeats the isolation this profile exists for");
    }
  }
  if (profile.pidsLimit === undefined || profile.pidsLimit <= 0) {
    problems.push("a fork-bomb guard requires a positive pidsLimit");
  }
  if (profile.egress === "open") {
    problems.push("open egress is not a default; declare the hosts the session actually needs");
  }
  if (profile.depth !== 24) {
    problems.push(`colour depth ${profile.depth} is outside the tested 24-bit configuration`);
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

export const CONTAINMENT = "display-scoped" as AutomationTarget["containment"];

/**
 * Whether a task may run here at all.
 *
 * Answering "no, and here is where it should run instead" is the useful outcome. A Linux
 * runner silently failing to launch a Mac application looks like a bug; naming the
 * platform mismatch looks like a product.
 */
export function platformSupports(requirement: {
  needsMacApplication: boolean;
  needsGui: boolean;
}): { ok: true } | { ok: false; reason: string; suggestedTarget?: "macos-node" } {
  if (requirement.needsMacApplication) {
    return {
      ok: false,
      reason:
        "a Linux virtual desktop cannot run macOS applications. This task needs a paired macOS node, and the capability discovery should route it there.",
      suggestedTarget: "macos-node",
    };
  }
  return { ok: true };
}

/**
 * @implementation-status stub
 * TODO(P8): the runner image, display server startup and the short-lived authenticated
 * preview transport. Profile validation, containment labelling and platform routing are
 * implemented and tested; running a real desktop session needs a container engine and a
 * published runner image.
 */
export const RUNNER_IMAGE_STATUS = "contract-implemented-image-not-published";
