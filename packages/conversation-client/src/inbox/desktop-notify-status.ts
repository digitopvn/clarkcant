/**
 * What the last desktop OS notification attempt came to, so Settings can say when the OS toggle is on but
 * nothing reaches the screen.
 *
 * The poll delivers in the background and Settings is a different surface, so the outcome is kept in a small
 * module-level store both can reach. Only the kind of failure is kept — never the title or body shown.
 */

export type DesktopNotifyStatus =
  | { kind: "none" }
  | { kind: "delivered" }
  | { kind: "unsupported" }
  | { kind: "no-window" }
  | { kind: "failed" };

/** Reads what `desktop:notify` answered; anything not shaped like an answer counts as a failure. */
export function classifyDesktopNotifyResult(result: unknown): DesktopNotifyStatus {
  if (typeof result !== "object" || result === null) return { kind: "failed" };
  const answer = result as { ok?: unknown; reason?: unknown };
  if (answer.ok === true) return { kind: "delivered" };
  if (answer.reason === "unsupported") return { kind: "unsupported" };
  if (answer.reason === "no-window") return { kind: "no-window" };
  return { kind: "failed" };
}

let current: DesktopNotifyStatus = { kind: "none" };
const listeners = new Set<() => void>();

export function desktopNotifyStatus(): DesktopNotifyStatus {
  return current;
}

export function recordDesktopNotifyStatus(next: DesktopNotifyStatus): void {
  if (next.kind === current.kind) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeDesktopNotifyStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Message key for the inline status beside the OS toggle; `undefined` when there is nothing to report. */
export function desktopNotifyStatusMessageKey(
  status: DesktopNotifyStatus,
):
  | "settings.control.notifications.os.status.unsupported"
  | "settings.control.notifications.os.status.noWindow"
  | "settings.control.notifications.os.status.failed"
  | undefined {
  switch (status.kind) {
    case "unsupported":
      return "settings.control.notifications.os.status.unsupported";
    case "no-window":
      return "settings.control.notifications.os.status.noWindow";
    case "failed":
      return "settings.control.notifications.os.status.failed";
    default:
      return undefined;
  }
}
