/** Durable view state shared by the local media widgets and their host. */
export const MEDIA_VIEW_OPERATION = "media.view";
export const MEDIA_STATE_VERSION = 2;

/** The longest a playing local video goes without writing where it is. Pause, seek and end are written at once. */
export const MEDIA_PLAYBACK_WRITE_INTERVAL_MS = 3_000;
/**
 * How long a stored "playing" is believed. A player that is still playing writes at least every interval, so a
 * "playing" older than two intervals plus slack for a slow round trip was left by a player that is gone (a closed tab,
 * a crash, a lost network) and is read as paused where it was last seen.
 */
export const MEDIA_PLAYING_FRESH_MS = 2 * MEDIA_PLAYBACK_WRITE_INTERVAL_MS + 2_000;

export const MEDIA_SELECTION_MIGRATION = {
  from: 1,
  to: 2,
  ops: [{ op: "default" as const, key: "selectedIndex", value: 0 }],
};

export const MEDIA_VIDEO_MIGRATION = {
  from: 1,
  to: 2,
  ops: [
    { op: "default" as const, key: "status", value: "paused" },
    { op: "default" as const, key: "position", value: 0 },
    { op: "default" as const, key: "duration", value: 0 },
  ],
};

export interface MediaSelectionState {
  selectedIndex: number;
}

export interface MediaPlaybackState {
  status: "playing" | "paused" | "ended";
  position: number;
  duration: number;
}

export function readMediaSelection(value: unknown, itemCount: number): MediaSelectionState {
  const record = recordOf(value);
  const index = record?.selectedIndex ?? record?.index;
  const safeCount = Number.isSafeInteger(itemCount) && itemCount > 0 ? itemCount : 0;
  return { selectedIndex: safeCount === 0 || typeof index !== "number" || !Number.isFinite(index) ? 0 : Math.max(0, Math.min(Math.floor(index), safeCount - 1)) };
}

/**
 * Whether a stored "playing" still describes a live player: written within {@link MEDIA_PLAYING_FRESH_MS} of `now`.
 * An unreadable time is not fresh, so an old or damaged row never reads as playing.
 */
export function playingIsFresh(updatedAt: string | undefined, now: string): boolean {
  const written = updatedAt === undefined ? Number.NaN : Date.parse(updatedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(written) || !Number.isFinite(current)) return false;
  return current - written <= MEDIA_PLAYING_FRESH_MS;
}

/** A restored player is always paused, even when its last durable snapshot was taken while playing. */
export function readMediaPlayback(value: unknown): MediaPlaybackState {
  const record = recordOf(value);
  const duration = finiteNonNegative(record?.duration);
  const position = Math.min(finiteNonNegative(record?.position), duration > 0 ? duration : Number.MAX_SAFE_INTEGER);
  const status = record?.status === "ended" ? "ended" : "paused";
  return { status, position, duration };
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
