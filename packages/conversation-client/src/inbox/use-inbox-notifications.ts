import { useEffect, useRef } from "react";

import { parseInboxNotificationsPreference, type InboxNotificationsPreference } from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import { desktopBridge, hasDesktopChrome } from "../desktop-compact.ts";
import type { WindowModeAttribute } from "../input-modality.ts";
import type { MessageKey } from "../i18n/messages.ts";
import { decideInboxNotifications, type InboxNotifyCandidate } from "./inbox-notify-decide.ts";
import { waitingKey } from "./inbox-model.ts";

/**
 * The OS/web notification for #171.
 *
 * Everything DOM- or Electron-shaped lives here rather than in `inbox-notify-decide.ts`: which channel a
 * platform gets, whether the document currently has focus, and the two ways a click can open the inbox. The
 * decision of *whether* to notify stays in the pure module so it can be tested without any of this.
 *
 * This runs its own 5-second poll rather than sharing the header mark's `/inbox/summary` one: the mark only
 * ever needs two counts, and deciding a notification needs the full waiting/notice lists and the stored
 * preference, which `/inbox/summary` does not carry. The `/inbox` read runs even while no channel could deliver
 * (no granted web permission, or both channels off): the set of ids already seen has to keep tracking what the
 * person could already see in the app, or turning notifications on mid-session would either flood them with
 * everything that arrived while it was off, or — re-seeding at that moment instead — silently swallow whatever
 * lands in the seconds right after they turned it on.
 */

const POLL_INTERVAL_MS = 5000;

interface NotifyState {
  initialized: boolean;
  knownIds: Set<string>;
  remindedNearExpiryIds: Set<string>;
}

/**
 * Whether the in-app inbox mark does not already cover this: the tab is hidden, the window has no focus, or
 * the window is collapsed to its orb/compact chrome, which is the same "minimal" reading the issue names.
 */
function isDocumentHidden(windowMode: WindowModeAttribute): boolean {
  if (windowMode === "orb" || windowMode === "compact") return true;
  if (typeof document === "undefined") return false;
  if (document.hidden) return true;
  return typeof document.hasFocus === "function" && !document.hasFocus();
}

function webNotificationApi(scope: unknown = globalThis): typeof Notification | undefined {
  if (typeof scope !== "object" || scope === null) return undefined;
  const candidate = (scope as { Notification?: unknown }).Notification;
  return typeof candidate === "function" ? (candidate as typeof Notification) : undefined;
}

/**
 * `renotify` has been in every shipping browser's Notification API for years, but this repo's `lib.dom.d.ts`
 * does not declare it on `NotificationOptions`. Extending locally keeps the real DOM type for everything else
 * instead of widening to `Record<string, unknown>` or sprinkling `as` casts at each use site.
 */
type WebNotificationOptions = NotificationOptions & { renotify?: boolean };

export interface UseInboxNotificationsInput {
  client: GatewayClient;
  t: (key: MessageKey) => string;
  windowMode: WindowModeAttribute;
  /** Focuses the window (desktop click already did) and opens the inbox — the same path the header mark uses. */
  onOpenInbox: () => void;
}

/**
 * Polls the inbox and the stored preference at the same cadence the header mark uses, and delivers whatever
 * `decideInboxNotifications` says is new.
 *
 * The first poll after mount only seeds what already exists — nothing notifies for a backlog that predates
 * this window opening, the same reasoning the header mark itself does not treat pre-existing counts as new
 * events.
 */
export function useInboxNotifications({ client, t, windowMode, onOpenInbox }: UseInboxNotificationsInput): void {
  const stateRef = useRef<NotifyState>({ initialized: false, knownIds: new Set(), remindedNearExpiryIds: new Set() });
  const onOpenInboxRef = useRef(onOpenInbox);
  onOpenInboxRef.current = onOpenInbox;
  const windowModeRef = useRef(windowMode);
  windowModeRef.current = windowMode;
  const tRef = useRef(t);
  tRef.current = t;

  // Desktop notifications are click-through: the main process broadcasts one event for whichever notification
  // was clicked, and any of them opening the inbox is the right reaction. Subscribed once, not per notification,
  // and unsubscribed on cleanup so a remount never leaves a second, stale listener behind.
  useEffect(() => {
    const bridge = desktopBridge();
    if (bridge?.onNotificationClicked === undefined) return;
    const unsubscribe = bridge.onNotificationClicked(() => onOpenInboxRef.current());
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A poll still in flight when the timer fires again is skipped rather than started twice: two polls racing
    // over the same `stateRef.current.knownIds` could each read it before the other's write lands, and the
    // slower one's write would silently undo whatever the faster one just added.
    let inFlight = false;

    const deliver = (candidate: InboxNotifyCandidate, preference: InboxNotificationsPreference): void => {
      if (hasDesktopChrome()) {
        if (!preference.os) return;
        const bridge = desktopBridge();
        if (bridge?.notify === undefined) return;
        bridge.notify({ title: candidate.title, body: candidate.body ?? "" }).catch(() => {
          // Best-effort: a refused OS notification is not an app-level error worth surfacing.
        });
        return;
      }

      if (!preference.web) return;
      const NotificationApi = webNotificationApi();
      if (NotificationApi === undefined || NotificationApi.permission !== "granted") return;
      try {
        // `tag` is the same id `decideInboxNotifications` already tracks: a second notification for the same
        // waiting item or notice replaces the first tab's copy instead of stacking one per open tab, and
        // `renotify` re-alerts for the one case that id legitimately fires twice — the near-expiry reminder.
        const options: WebNotificationOptions = { tag: candidate.id, renotify: candidate.reason === "near-expiry" };
        if (candidate.body !== undefined) options.body = candidate.body;
        const shown = new NotificationApi(candidate.title, options);
        shown.onclick = () => {
          shown.close();
          window.focus();
          onOpenInboxRef.current();
        };
      } catch {
        // A browser that throws from the constructor (permission revoked mid-session, a platform quirk) is
        // treated the same as one that silently drops it.
      }
    };

    const poll = (): void => {
      if (inFlight) return;
      inFlight = true;
      void client
        .preferences()
        .then((preferencesAnswer) => {
          const preference = parseInboxNotificationsPreference(
            preferencesAnswer.preferences.find((entry) => entry.key === "inbox.notifications")?.value,
          );
          if (cancelled) return undefined;
          return client.inbox().then((inboxAnswer) => ({ preference, inboxAnswer }));
        })
        .then((result) => {
          if (cancelled || result === undefined) return;
          const { preference, inboxAnswer } = result;
          const state = stateRef.current;

          if (!state.initialized) {
            for (const notice of inboxAnswer.notices) state.knownIds.add(`notice:${notice.noticeId}`);
            for (const item of inboxAnswer.waiting) state.knownIds.add(waitingKey(item));
            state.initialized = true;
            return;
          }

          const now = new Date();
          const decided = decideInboxNotifications({
            preference,
            notices: inboxAnswer.notices,
            waiting: inboxAnswer.waiting,
            knownIds: state.knownIds,
            remindedNearExpiryIds: state.remindedNearExpiryIds,
            now: inboxAnswer.readAt,
            nowLocalMinutes: now.getHours() * 60 + now.getMinutes(),
            documentHidden: isDocumentHidden(windowModeRef.current),
            t: tRef.current,
          });
          state.knownIds = decided.seenIds;
          state.remindedNearExpiryIds = decided.remindedNearExpiryIds;
          for (const candidate of decided.candidates) deliver(candidate, preference);
        })
        .catch(() => {
          // A node that cannot answer this poll is not a reason to notify about nothing, or to crash the
          // conversation surface — the next poll tries again.
        })
        .finally(() => {
          inFlight = false;
        });
    };

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client]);
}
