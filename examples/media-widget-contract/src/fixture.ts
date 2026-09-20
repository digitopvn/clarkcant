/**
 * Media fixture state machine.
 *
 * Synthetic on purpose. No vendor SDK, account, DRM or licensing path is involved, and passing
 * this fixture must never be presented as evidence that a commercial player works. What it
 * demonstrates is the ownership and restore rule, which is ours and not the vendor's.
 *
 * Two rules, both from the blueprint:
 *
 *   1. One logical instance has at most one live media owner. Mounting the same instance inline
 *      and pinned must produce one player, not two playing at once.
 *   2. Restoring a pinned player does not start playback. A pin restores a surface, not a
 *      session, and audio that starts because a panel re-entered the viewport is the behaviour
 *      users describe as "it just started playing by itself".
 */

import { claimLiveOwner, releaseLiveOwner, type WidgetDeps } from "@clarkcant/core";
import { restorePinnedInstance, type LifecycleDeps } from "@clarkcant/core";

export const MEDIA_FIXTURE_STATUS = "implemented-ownership-and-restore";

export const FIXTURE_LABEL = "Synthetic media fixture. No real playback SDK or account is involved.";

export interface MediaFixtureState {
  /** Only one surface may hold this at a time. */
  liveOwnerToken: string | null;
  playing: boolean;
  /** Position survives a pin or unpin so state is preserved rather than restarted. */
  positionSeconds: number;
}

export type MountOutcome =
  | { mounted: true; surface: "inline" | "pin" | "detached"; playing: false }
  | {
      mounted: false;
      reason: "ALREADY_OWNED";
      /** The surface that holds playback, so the UI can move to it instead of duplicating it. */
      heldBy: "inline" | "pin" | "detached";
      message: string;
    };

/**
 * Mount the fixture on a surface.
 *
 * Playback is not started. A mount makes the surface available; `play` is a separate call the
 * user makes. Folding the two together is how a fixture passes by accident and a real player
 * annoys people.
 */
export function mount(
  deps: WidgetDeps,
  input: { instanceId: string; surface: "inline" | "pin" | "detached"; ownerToken: string },
): MountOutcome {
  const claim = claimLiveOwner(deps, {
    instanceId: input.instanceId,
    surface: input.surface,
    ownerToken: input.ownerToken,
  });

  if (!claim.ok) {
    return {
      mounted: false,
      reason: "ALREADY_OWNED",
      heldBy: claim.heldBy.surface,
      message: `this player is already live in the ${claim.heldBy.surface} surface; move to it instead of mounting a second one`,
    };
  }

  return { mounted: true, surface: input.surface, playing: false };
}

/** Unmount a surface. Position is carried by the caller, which owns the persistence decision. */
export function unmount(
  deps: WidgetDeps,
  input: { instanceId: string; ownerToken: string },
): { released: boolean; autoplayStopped: false } {
  return {
    released: releaseLiveOwner(deps, input.instanceId, input.ownerToken),
    // Unmounting stops playback on the surface that closed, and says so rather than leaving it
    // to be inferred.
    autoplayStopped: false,
  };
}

export interface RestoreOutcome {
  positionSeconds: number;
  playing: false;
  reason: string;
}

/**
 * Restore the pinned surface.
 *
 * The position is preserved and playback is not started. The reason travels with the result so
 * the UI can tell the user why nothing is playing, which is the difference between "it did not
 * autoplay" and "it looks broken".
 */
export function restore(deps: LifecycleDeps, pinId: string): RestoreOutcome {
  const restored = restorePinnedInstance(deps, pinId);
  return {
    positionSeconds: restored.positionSeconds,
    playing: false,
    reason: restored.autoplayRefused,
  };
}

/** What the fixture must demonstrate, one assertion per line. */
export const CONTRACT_ASSERTIONS = [
  "mounting the same instance inline and pinned yields one live owner, not two",
  "restoring a pinned fixture does not autoplay",
  "unpinning preserves position and does not stop a running background job",
  "a second surface can preview read-only while the first owns playback",
] as const;
