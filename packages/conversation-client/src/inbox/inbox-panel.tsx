import { Fragment, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import type {
  EffectReconcileResponse,
  InboxResponse,
  Notice,
  NoticeAction,
  NoticeActionUnavailable,
  SettingsTab,
  SkippedVersion,
  WaitingItem,
} from "@clarkcant/contracts";

import type { GatewayClient, Timeline } from "../api.ts";
import { riskLaneLabel } from "../blocks.tsx";
import { Modal } from "../Modal.tsx";
import { useLocaleState, useT } from "../i18n/locale-context.tsx";
import {
  UNAVAILABLE_KEYS,
  canOpenOtherConversation,
  capabilitiesSay,
  decideFailureCategory,
  decideFailureMessageKey,
  effectCategoryLabels,
  gatewayErrorCode,
  nextNoticeFocusTarget,
  noticeActionGroups,
  noticeConversationTarget,
  noticeDetailsText,
  noticeIdsToMarkRead,
  noticeKindQuieted,
  noticeReconcileEffect,
  noticesMayBeCapped,
  reconcileAlreadyRecorded,
  noticeSourceKey,
  noticeTone,
  relativeAge,
  sanitizeReason,
  type SnoozePresetId,
  snoozePresetKey,
  snoozePresets,
  snoozeUntil,
  suppressionDescription,
  timeLeft,
  updateFailureReason,
  waitingKey,
} from "./inbox-model.ts";

export interface InboxPanelProps {
  open: boolean;
  onClose: () => void;
  client: GatewayClient;
  /** The conversation on screen, so a decision about it can redraw its card and "open" it can simply close. */
  conversationId: string | undefined;
  /** A decision about the conversation on screen came back with its new record. */
  onTimeline: (timeline: Timeline) => void;
  /**
   * Opens another conversation. Absent when the host cannot switch conversations, and then the button is not drawn:
   * a control that looks usable before its action exists is the thing the design forbids.
   */
  onOpenConversation?: (conversationId: string) => void;
  /** Something in the inbox changed, so the header mark should read again now rather than at its next tick. */
  onChanged: () => void;
  /**
   * Whether the conversation on screen carries state that switching away from it would silently drop: a running
   * turn, an open voice session, an unsent draft, or an attachment. "Open conversation" for *another* conversation
   * is disabled while any of these is true, with the reason shown rather than hidden behind a tooltip — the host's
   * `key`-remount does not preserve any of it (AGENTS.md: disable with a visible reason instead of a control that
   * looks usable before its action is safe).
   */
  switchGuard: { busy: boolean; voiceOpen: boolean; draftNonEmpty: boolean; hasAttachments: boolean };
  /**
   * Asks Clark about a notice in a message of its own, which leaves whatever is being written alone. Absent when the
   * host has no conversation to send it in, and then the button is not drawn. Held back while a reply is running
   * (`switchGuard.busy`), with the reason shown.
   */
  onAskClark?: (notice: Notice) => void;
  /**
   * Puts a notice into the message being written, as the same chip `@` would have made. "full" when that message
   * already carries as many references as one can; the panel says so and stays open.
   */
  onAddToContext?: (notice: Notice) => "added" | "already" | "full";
  /**
   * Records what the person saw of an effect whose outcome was unknown, through the same path a typed or spoken "it
   * took effect" takes. Absent when the host cannot, and then the two buttons are not drawn.
   */
  onReconcile?: (effectId: string, outcome: "confirmed" | "failed") => Promise<EffectReconcileResponse>;
  /**
   * Opens Settings on a tab, closing the inbox: an update notice's "Review in Settings" goes to the installed extensions.
   * Absent when the host has no Settings to open, and then that action is not drawn.
   */
  onOpenSettings?: (tab: SettingsTab) => void;
  /**
   * Changes when a notice changed from outside the panel — a typed or spoken "dismiss the latest notification" — so an
   * open panel reads again instead of showing a notice that is gone.
   */
  refreshKey?: number;
  /**
   * The notice or waiting item a clicked notification was about (`notice:<id>`, or the waiting item's own key). Once the
   * list is read, the panel scrolls to it, marks it and moves focus onto the row; when it is no longer there, the status line
   * says so. A new target while the panel is open reads the list again first, since a notification is usually about
   * something newer than the last read.
   */
  target?: string;
  /** The target was shown, or said to be gone; the host clears it so a later opening starts at the top. */
  onTargetShown?: () => void;
}

type Load = { state: "loading" } | { state: "failed"; reason: string } | { state: "ready"; inbox: InboxResponse };

/**
 * The outcome line. After a dismissal, a snooze or quieting a kind it carries what "Undo" reverses: bringing the notice
 * back, bringing it back from its snooze, notifying about its kind again, or being told about a skipped version again.
 */
type Undo = { kind: "restore" | "unsnooze" | "unsuppress" | "unskip"; noticeId: string };
type Status = { tone: "done" | "failed"; text: string; undo?: Undo };

/** How long "Copy details" shows what its press did before it reads "Copy details" again. */
const COPY_OUTCOME_MS = 2000;

/** Where focus goes once the render that follows an action has landed, when a disabled button can take it again. */
type FocusTarget = { kind: "notice"; noticeId: string } | { kind: "heading" } | { kind: "status" };

/** What is locked while a decision or a dismissal is in flight, and — for a command approval — which way it went. */
type Busy = { key: string; decision?: "granted" | "denied" };

/**
 * The inbox: what is waiting for the person, then what happened while they were not looking.
 *
 * A host-owned surface, because it carries approve buttons: approval chrome belongs to the host and never to widget
 * code. It is a modal for the reason Settings is one — a focused decision surface over the conversation, which keeps
 * its state underneath and gets focus back when this closes.
 *
 * Nothing here decides anything itself. Approving a command, granting a capability and answering a question each go
 * through the route their card already uses, so the inbox is a second place to reach a decision, never a second way to
 * make one. What it shows is a snapshot, and says so with the time the node read it.
 */
export function InboxPanel({
  open,
  onClose,
  client,
  conversationId,
  onTimeline,
  onOpenConversation,
  onChanged,
  switchGuard,
  onAskClark,
  onAddToContext,
  onReconcile,
  onOpenSettings,
  refreshKey,
  target,
  onTargetShown,
}: InboxPanelProps): ReactElement | null {
  const t = useT();
  const categoryLabels = effectCategoryLabels(t);
  const { locale } = useLocaleState();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [busy, setBusy] = useState<Busy | undefined>(undefined);
  const [status, setStatus] = useState<Status | undefined>(undefined);
  // The one notice whose "More" is open: opening another closes it, as a second disclosure left open would be noise.
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | undefined>(undefined);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const noticesHeading = useRef<HTMLHeadingElement>(null);
  // Each notice row on screen, so an action can move focus to a real neighbour — the row that took a dismissed one's
  // place, or a restored one — instead of leaving it on `<body>` once the button that held it is gone.
  const noticeRows = useRef(new Map<string, HTMLLIElement>());
  const moreButtons = useRef(new Map<string, HTMLButtonElement>());
  // A synchronous lock a second click cannot race past: React state is not visible to the click handler that fires
  // a few milliseconds later with the network still in flight, but a ref write is immediate.
  const inFlight = useRef<string | undefined>(undefined);
  // Counts "Copy details" presses, so only the latest one's result is said.
  const copyAttempt = useRef(0);
  // What the last copy did, shown for a moment on the pressed button itself: the status line may be scrolled out of view.
  const [copyOutcome, setCopyOutcome] = useState<{ noticeId: string; tone: "done" | "failed" } | undefined>(undefined);
  const copyOutcomeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyOutcomeTimer.current), []);
  // Held in a ref because the conversation hands a fresh closure on every render, and the read-on-open effect below
  // must run once per opening rather than once per render of the surface behind it.
  const changed = useRef(onChanged);
  changed.current = onChanged;
  // Held in a ref for the same reason `use-turn-send.ts` keeps `sessionGeneration`: a decide request started for
  // the conversation on screen can still be in flight after the person has navigated elsewhere, and its result must
  // not be drawn over whatever is on screen when it lands.
  const currentConversationId = useRef(conversationId);
  currentConversationId.current = conversationId;

  const read = useCallback(async (): Promise<InboxResponse | undefined> => {
    try {
      const inbox = await client.inbox();
      setLoad({ state: "ready", inbox });
      return inbox;
    } catch (cause) {
      if (cause instanceof Error && cause.name === "ZodError") {
        // A schema failure has no sentence fit for a person to read; the full issue list goes to the console.
        console.error("inbox: could not parse the gateway's response", cause);
      }
      setLoad({ state: "failed", reason: sanitizeReason(cause) ?? t("inbox.reason.unavailable") });
      return undefined;
    }
  }, [client, t]);

  // Every row a notification can point at, keyed the way a target names it: `notice:<id>`, or the waiting item's key.
  const targetRows = useRef(new Map<string, HTMLLIElement>());
  // The row a notification led to, marked until the panel closes or another target arrives.
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined);
  // A target waiting for the render that draws the list it was checked against; its row exists only after that.
  const [pendingTarget, setPendingTarget] = useState<{ target: string; present: boolean } | undefined>(undefined);
  const targetNow = useRef(target);
  targetNow.current = target;
  // False from an opening until its first read lands: a target that arrives with the opening waits for that read,
  // rather than reading the inbox a second time.
  const openRead = useRef(false);

  /** Whether the target is in the inbox this read returned; the render after it scrolls to it (see the effect below). */
  const showTarget = useCallback((inbox: InboxResponse, wanted: string) => {
    const present =
      inbox.notices.some((notice) => `notice:${notice.noticeId}` === wanted) || inbox.waiting.some((item) => waitingKey(item) === wanted);
    setPendingTarget({ target: wanted, present });
  }, []);

  // Read once per opening, and mark read exactly what that read drew. The panel keeps showing those as "unread" for
  // as long as it stays open, because that is what they were when the person opened it.
  useEffect(() => {
    if (!open) {
      openRead.current = false;
      setHighlighted(undefined);
      return;
    }
    let cancelled = false;
    setLoad({ state: "loading" });
    setStatus(undefined);
    setMenuFor(undefined);
    void read().then((inbox) => {
      if (cancelled || inbox === undefined) return;
      openRead.current = true;
      if (targetNow.current !== undefined) showTarget(inbox, targetNow.current);
      const shown = noticeIdsToMarkRead(inbox.notices);
      if (shown.length === 0) return;
      void client
        .markInboxRead(shown)
        .then(() => changed.current())
        // Not marked is not a failure worth a line: the notices stay unread, which is still the truth.
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [open, read, client, showTarget]);

  // A notification clicked while the panel is already open: read again, then go to it.
  useEffect(() => {
    if (!open || target === undefined || !openRead.current) return;
    let cancelled = false;
    void read().then((inbox) => {
      if (!cancelled && inbox !== undefined) showTarget(inbox, target);
    });
    return () => {
      cancelled = true;
    };
  }, [open, target, read, showTarget]);

  // Something outside the panel changed a notice: read again, keeping whatever the status line says.
  const lastRefresh = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === lastRefresh.current) return;
    lastRefresh.current = refreshKey;
    if (open && openRead.current) void read();
  }, [refreshKey, open, read]);

  // Runs after the render that drew the list the target was checked against, so its row exists to scroll to.
  useEffect(() => {
    if (pendingTarget === undefined || load.state !== "ready") return;
    setPendingTarget(undefined);
    onTargetShown?.();
    if (!pendingTarget.present) {
      // Said rather than silently landing on the top of the list: the person clicked something specific.
      setHighlighted(undefined);
      setStatus({ tone: "failed", text: t("inbox.target.gone") });
      setFocusTarget({ kind: "status" });
      return;
    }
    setHighlighted(pendingTarget.target);
    const row = targetRows.current.get(pendingTarget.target);
    if (row === undefined) return;
    const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    // Onto the row itself, which is named for what it is, never onto one of its buttons: landing on "Approve" or
    // "Update" from a notification would leave one keypress between a glance and a decision the person has not read.
    row.focus();
  }, [pendingTarget, load.state, onTargetShown, t]);

  /** The ref callback that keeps `targetRows` in step with the rows on screen. */
  const targetRow = (key: string) => (el: HTMLLIElement | null) => {
    if (el) targetRows.current.set(key, el);
    else targetRows.current.delete(key);
  };

  const settle = useCallback(
    (next: Status) => {
      setStatus(next);
      onChanged();
      // Busy stays locked until this read lands: a second click before then would otherwise reach a route that
      // has nothing left to decide, and get back a refusal that reads as a failure when nothing actually went wrong.
      void read().then(() => {
        inFlight.current = undefined;
        setBusy(undefined);
        statusLine.current?.focus();
      });
    },
    [onChanged, read],
  );

  /**
   * What a decide call's failure says, once the code alone is not enough to know (`decideFailureCategory`'s
   * "ambiguous" case): a fresh read of the inbox says whether the item is still waiting, and only then does the
   * surface say which sentence is true.
   */
  const settleDecideFailure = useCallback(
    (cause: unknown, key: string) => {
      const category = decideFailureCategory(cause);
      if (category !== "ambiguous") {
        settle({ tone: category === "alreadyDecided" ? "done" : "failed", text: t(decideFailureMessageKey(category, undefined)) });
        return;
      }
      // Not routed through `settle`: it would read again just to clear busy, and this branch already needs that
      // same read to answer "is it still waiting" — one `GET /inbox` serves both rather than two.
      setStatus(undefined);
      onChanged();
      void read().then((inbox) => {
        const stillWaiting = inbox !== undefined && inbox.waiting.some((waiting) => waitingKey(waiting) === key);
        inFlight.current = undefined;
        setBusy(undefined);
        setStatus({ tone: "failed", text: t(decideFailureMessageKey(category, stillWaiting)) });
        statusLine.current?.focus();
      });
    },
    [settle, onChanged, read, t],
  );

  const decideCommand = (item: Extract<WaitingItem, { kind: "command-approval" }>, decision: "granted" | "denied") => {
    const key = waitingKey(item);
    if (inFlight.current !== undefined) return;
    inFlight.current = key;
    setBusy({ key, decision });
    setStatus(undefined);
    void client
      .decideApproval(item.conversationId, item.approvalId, { decision, digest: item.operationDigest })
      .then((result) => {
        if (item.conversationId === currentConversationId.current) onTimeline(result.timeline);
        settle({ tone: "done", text: t(decision === "granted" ? "inbox.decided.granted" : "inbox.decided.denied") });
      })
      .catch((cause: unknown) => settleDecideFailure(cause, key));
  };

  const decideCapability = (item: Extract<WaitingItem, { kind: "capability-approval" }>, decision: "granted" | "denied") => {
    const key = waitingKey(item);
    if (inFlight.current !== undefined) return;
    inFlight.current = key;
    setBusy({ key, decision });
    setStatus(undefined);
    void client
      .decideCapabilityApproval(item, decision)
      .then((result) =>
        settle({
          tone: "done",
          // The route resolves a repeated identical decision itself (200, `alreadyDecided: true`) rather than
          // refusing it — a double click here never reaches the 409 path `settleDecideFailure` handles.
          text: result.alreadyDecided
            ? t("inbox.decideFailed.alreadyDecided")
            : t(decision === "granted" ? "settings.extensions.approvals.granted" : "settings.extensions.approvals.denied")
                .replace("{capability}", item.ref)
                .replace("{package}", item.packageId),
        }),
      )
      .catch((cause: unknown) => settleDecideFailure(cause, key));
  };

  /**
   * An install the execution policy asked about. Approving installs exactly the version shown, through the node's own
   * install with every check it makes; denying installs nothing. What the node answered is said in the package's name,
   * and a refusal after approving says why and that what is installed did not change.
   */
  const decideInstall = (item: Extract<WaitingItem, { kind: "install-approval" }>, decision: "granted" | "denied") => {
    const key = waitingKey(item);
    if (inFlight.current !== undefined) return;
    inFlight.current = key;
    setBusy({ key, decision });
    setStatus(undefined);
    const named = (text: string) => text.replace("{name}", item.displayName).replace("{version}", item.version);
    void client
      .decideInstallApproval(item, decision)
      .then(() =>
        settle({
          tone: "done",
          text: named(t(decision === "granted" ? "inbox.install.decided.granted" : "inbox.install.decided.denied")),
        }),
      )
      .catch((cause: unknown) => {
        const code = gatewayErrorCode(cause);
        if (code === "DIGEST_MISMATCH") {
          settle({ tone: "failed", text: named(t("inbox.install.failed.changed")) });
          return;
        }
        if (code === "APPROVAL_EXPIRED" || code === "APPROVAL_ALREADY_DECIDED") {
          settleDecideFailure(cause, key);
          return;
        }
        settle({ tone: "failed", text: named(t("inbox.install.failed")).replace("{reason}", failedReason(cause)) });
      });
  };

  const decideTask = (item: Extract<WaitingItem, { kind: "task-approval" }>, decision: "granted" | "denied") => {
    const key = waitingKey(item);
    if (inFlight.current !== undefined) return;
    inFlight.current = key;
    setBusy({ key, decision });
    setStatus(undefined);
    void client
      .decideTaskApproval(item.taskId, item.approvalId, { decision, digest: item.operationDigest })
      .then((result) => {
        if (item.conversationId !== undefined && item.conversationId === currentConversationId.current) onTimeline(result.timeline);
        settle({
          tone: "done",
          text: t(
            decision === "denied"
              ? "inbox.task.decided.denied"
              : result.redispatched
                ? "inbox.task.decided.redispatched"
                : "inbox.task.decided.grantedNotRun",
          ),
        });
      })
      .catch((cause: unknown) => settleDecideFailure(cause, key));
  };

  // Runs after the render that re-enabled the buttons: focusing a button while it is still disabled does nothing.
  useEffect(() => {
    if (focusTarget === undefined || busy !== undefined) return;
    setFocusTarget(undefined);
    if (focusTarget.kind === "status") statusLine.current?.focus();
    else if (focusTarget.kind === "heading") noticesHeading.current?.focus();
    else noticeRows.current.get(focusTarget.noticeId)?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [focusTarget, busy]);

  /** Locks the panel for a notice action; false when another action already holds it. */
  const lock = (key: string): boolean => {
    if (inFlight.current !== undefined) return false;
    inFlight.current = key;
    setBusy({ key });
    setStatus(undefined);
    setMenuFor(undefined);
    return true;
  };

  /** Reads the inbox again after a notice action, then says how it went and moves focus where it belongs. */
  const finish = (next: Status, focus: FocusTarget) => {
    onChanged();
    void read().then(() => {
      inFlight.current = undefined;
      setBusy(undefined);
      setStatus(next);
      setFocusTarget(focus);
    });
  };

  const failedReason = (cause: unknown) => sanitizeReason(cause) ?? t("inbox.reason.unavailable");

  const dismiss = (notice: Notice) => {
    if (!lock(`notice:${notice.noticeId}`)) return;
    const noticeIdsBeforeDismiss = load.state === "ready" ? load.inbox.notices.map((existing) => existing.noticeId) : [];
    void client
      .dismissNotice(notice.noticeId)
      .then(() => {
        // Announced through the status line's own live region regardless of where focus lands, and moved to a real
        // neighbour — the notice that took the dismissed one's place, or the section heading when none are left.
        // "Undo" sits in that line for as long as it stands; the node keeps the notice restorable for a few minutes.
        const nextId = nextNoticeFocusTarget(noticeIdsBeforeDismiss, notice.noticeId);
        finish(
          { tone: "done", text: t("inbox.dismissed"), undo: { kind: "restore", noticeId: notice.noticeId } },
          nextId === undefined ? { kind: "heading" } : { kind: "notice", noticeId: nextId },
        );
      })
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.dismissFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  const restore = (noticeId: string) => {
    if (!lock(`notice:${noticeId}`)) return;
    void client
      .restoreNotice(noticeId)
      .then(() => finish({ tone: "done", text: t("inbox.restored") }, { kind: "notice", noticeId }))
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.restoreFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  const setRead = (notice: Notice, read: boolean) => {
    if (!lock(`notice:${notice.noticeId}`)) return;
    void (read ? client.markInboxRead([notice.noticeId]) : client.markInboxUnread([notice.noticeId]))
      .then(() => finish({ tone: "done", text: t(read ? "inbox.markedRead" : "inbox.markedUnread") }, { kind: "notice", noticeId: notice.noticeId }))
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.markFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  /** A moment as the person reads it on their own clock: the weekday and the time, which is what "until when" needs. */
  const when = (instant: string | Date): string =>
    new Date(instant).toLocaleString(locale === "vi" ? "vi-VN" : "en-US", { weekday: "long", hour: "2-digit", minute: "2-digit" });

  const snooze = (notice: Notice, preset: SnoozePresetId) => {
    // Worked out at the press, not when the menu was drawn: a menu left open past 17:00 no longer has an evening.
    const until = snoozeUntil(preset, new Date());
    if (until === undefined) {
      setMenuFor(undefined);
      setStatus({ tone: "failed", text: t("inbox.snooze.gone") });
      setFocusTarget({ kind: "status" });
      return;
    }
    if (!lock(`notice:${notice.noticeId}`)) return;
    const noticeIdsBefore = load.state === "ready" ? load.inbox.notices.map((existing) => existing.noticeId) : [];
    void client
      .snoozeNotice(notice.noticeId, until.toISOString())
      .then((answer) => {
        // It leaves the list like a dismissed notice does, so focus goes to the same neighbour a dismissal would pick.
        const nextId = nextNoticeFocusTarget(noticeIdsBefore, notice.noticeId);
        finish(
          {
            tone: "done",
            text: t("inbox.snoozed").replace("{time}", when(answer.snoozedUntil)),
            undo: { kind: "unsnooze", noticeId: notice.noticeId },
          },
          nextId === undefined ? { kind: "heading" } : { kind: "notice", noticeId: nextId },
        );
      })
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.snoozeFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  const unsnooze = (noticeId: string) => {
    if (!lock(`notice:${noticeId}`)) return;
    void client
      .unsnoozeNotice(noticeId)
      .then(() => finish({ tone: "done", text: t("inbox.unsnoozed") }, { kind: "notice", noticeId }))
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.unsnoozeFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  /** Quiet this notice's kind, or notify about it again. The notice itself stays where it is, so focus stays on it. */
  const setQuiet = (noticeId: string, quiet: boolean) => {
    if (!lock(`notice:${noticeId}`)) return;
    void (quiet ? client.suppressNoticeKind(noticeId) : client.unsuppressNoticeKind(noticeId))
      .then(() =>
        finish(
          quiet
            ? { tone: "done", text: t("inbox.suppressed"), undo: { kind: "unsuppress", noticeId } }
            : { tone: "done", text: t("inbox.unsuppressed") },
          { kind: "notice", noticeId },
        ),
      )
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.suppressFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  /** From the list of quieted kinds, for a kind that may have no notice left in the list to act from. */
  const removeSuppression = (suppressionId: string) => {
    if (!lock(`suppression:${suppressionId}`)) return;
    void client
      .removeNoticeSuppression(suppressionId)
      .then(() => finish({ tone: "done", text: t("inbox.unsuppressed") }, { kind: "status" }))
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.suppressFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  const removeSkippedVersion = (skip: SkippedVersion) => {
    if (!lock(`skipped:${skip.subjectKind}:${skip.name}@${skip.version}`)) return;
    void client
      .removeSkippedVersion(skip)
      .then(() => finish({ tone: "done", text: t("inbox.unskipped") }, { kind: "status" }))
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.skipFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  const undo = (what: Undo) => {
    switch (what.kind) {
      case "restore":
        restore(what.noticeId);
        return;
      case "unsnooze":
        unsnooze(what.noticeId);
        return;
      case "unsuppress":
        setQuiet(what.noticeId, false);
        return;
      case "unskip":
        unskip(what.noticeId);
        return;
    }
  };

  /**
   * Record what the person saw of the effect the notice asks about. The notice leaves the list once it is answered (the
   * node dismisses it), so focus goes where a dismissal would send it; a 409 means somebody already answered — another
   * screen, a sentence — and the refreshed list is the truth to show.
   */
  const reconcile = (notice: Notice, effectId: string, outcome: "confirmed" | "failed") => {
    if (onReconcile === undefined || !lock(`notice:${notice.noticeId}`)) return;
    const noticeIdsBefore = load.state === "ready" ? load.inbox.notices.map((existing) => existing.noticeId) : [];
    void onReconcile(effectId, outcome)
      .then((answer) => {
        const nextId = nextNoticeFocusTarget(noticeIdsBefore, notice.noticeId);
        const recorded = t(outcome === "confirmed" ? "inbox.reconciled.confirmed" : "inbox.reconciled.failed");
        finish(
          { tone: "done", text: answer.remainingUnknown > 0 ? `${recorded} ${t("inbox.reconciled.more")}` : recorded },
          nextId === undefined ? { kind: "heading" } : { kind: "notice", noticeId: nextId },
        );
      })
      .catch((cause: unknown) =>
        finish(
          reconcileAlreadyRecorded(cause)
            ? { tone: "done", text: t("inbox.reconcileFailed.already") }
            : { tone: "failed", text: t("inbox.reconcileFailed").replace("{reason}", failedReason(cause)) },
          { kind: "status" },
        ),
      );
  };

  /** The notices on screen now, in order, so an action that takes one out of the list can move focus to its neighbour. */
  const noticeIdsNow = (): string[] => (load.state === "ready" ? load.inbox.notices.map((existing) => existing.noticeId) : []);

  /** Focus for a notice that just left the list: the one that took its place, or the heading when none is left. */
  const afterLeaving = (before: readonly string[], noticeId: string): FocusTarget => {
    const nextId = nextNoticeFocusTarget(before, noticeId);
    return nextId === undefined ? { kind: "heading" } : { kind: "notice", noticeId: nextId };
  };

  /** "Try again": the node starts the same request as new work and takes this notice out; the new run reports itself. */
  const retry = (notice: Notice) => {
    if (notice.subject?.kind !== "background-work") return;
    const workId = notice.subject.workId;
    if (!lock(`notice:${notice.noticeId}`)) return;
    const before = noticeIdsNow();
    void client
      .retryWork(workId)
      .then((answer) =>
        finish(
          {
            tone: "done",
            text:
              answer.state === "queued" && answer.position !== undefined
                ? t("inbox.retryQueued").replace("{position}", String(answer.position))
                : t("inbox.retried"),
          },
          afterLeaving(before, notice.noticeId),
        ),
      )
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.retryFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  /**
   * "Update": the notice's own action on the node, which installs the version the notice names through the same install
   * as any other — so its checks and any approval it needs are the same — and takes the notice out once it is installed.
   * The same action a spoken, confirmed "install the latest update" reaches; installing is the person's own decision, so
   * no agent or machine surface can. When the execution mode asks first, nothing is installed yet: the install waits in
   * "Waiting for you" above, where the person approves or denies it, and the line says where; a
   * refusal says why and leaves the installed version as it was. A permission the update asked for and did not get yet
   * is said after "updated", since the package runs without it.
   */
  const update = (notice: Notice) => {
    const subject = notice.subject;
    if (subject?.kind !== "package" || subject.version === undefined) return;
    const { packageId, version } = subject;
    if (!lock(`notice:${notice.noticeId}`)) return;
    const before = noticeIdsNow();
    void client
      .actOnNotice(notice.noticeId, "update", { source: "click" })
      .then((answer) => {
        if (answer.outcome === "approval-required") {
          // The install now waits above, under "Waiting for you": the line says so, and that row is marked.
          if (answer.approvalId !== undefined) setHighlighted(`install-approval:${answer.approvalId}`);
          finish({ tone: "done", text: t("inbox.updateNeedsApproval") }, { kind: "status" });
          return;
        }
        finish(
          {
            tone: "done",
            text: `${t("inbox.updated").replace("{package}", packageId).replace("{version}", answer.version ?? version)}${capabilitiesSay(answer, t)}`,
          },
          afterLeaving(before, notice.noticeId),
        );
      })
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.updateFailed").replace("{reason}", updateFailureReason(cause, version, t)) }, { kind: "status" }));
  };

  /** "Skip this version": the node stops reporting it (and anything older), and the notice leaves the list, undoably. */
  const skip = (notice: Notice) => {
    if (!lock(`notice:${notice.noticeId}`)) return;
    const before = noticeIdsNow();
    void client
      .skipNoticeVersion(notice.noticeId)
      .then((answer) =>
        finish(
          { tone: "done", text: t("inbox.skipped").replace("{version}", answer.version), undo: { kind: "unskip", noticeId: notice.noticeId } },
          afterLeaving(before, notice.noticeId),
        ),
      )
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.skipFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  const unskip = (noticeId: string) => {
    if (!lock(`notice:${noticeId}`)) return;
    void client
      .unskipNoticeVersion(noticeId)
      .then(() => finish({ tone: "done", text: t("inbox.unskipped") }, { kind: "notice", noticeId }))
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.skipFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  /**
   * "Ask again": the question goes back into its conversation as a new card, which then waits in the section above; the
   * node takes the expiry notice out. The status line says so and takes focus, since the notice it was pressed on is gone.
   */
  const askAgain = (notice: Notice) => {
    const subject = notice.subject;
    if (subject?.kind !== "question") return;
    if (!lock(`notice:${notice.noticeId}`)) return;
    void client
      .askQuestionAgain(subject.conversationId, subject.questionId)
      .then((result) => {
        if (subject.conversationId === currentConversationId.current) onTimeline(result.timeline);
        finish({ tone: "done", text: t("inbox.askedAgain") }, { kind: "status" });
      })
      .catch((cause: unknown) => finish({ tone: "failed", text: t("inbox.askAgainFailed").replace("{reason}", failedReason(cause)) }, { kind: "status" }));
  };

  /** Why an action cannot be taken now, in words beside the others rather than as a button that fails. */
  const unavailableNote = (notice: Notice, action: NoticeAction, reason: NoticeActionUnavailable): ReactElement => (
    <span
      key={`${action.id}-unavailable`}
      className="cc-freshness"
      {...(reason === "conversation-gone" ? { "data-inbox-open-gone": notice.noticeId } : { "data-inbox-unavailable": reason })}
      style={{ flexBasis: "100%" }}
    >
      {t(UNAVAILABLE_KEYS[reason])}
    </span>
  );

  const addToContext = (notice: Notice) => {
    if (onAddToContext === undefined || inFlight.current !== undefined) return;
    // "added" and "already" close the panel from the host, with the caret in the composer after the chip.
    if (onAddToContext(notice) !== "full") return;
    setMenuFor(undefined);
    setStatus({ tone: "failed", text: t("inbox.context.full") });
    setFocusTarget({ kind: "status" });
  };

  /**
   * "Copy details": the notice's own fields as plain text (`noticeDetailsText`), on the clipboard. Nothing on the node
   * changes, so the list is not read again and focus stays on the button that was pressed, with "More" still open. The
   * status line says how it went; a refused clipboard is said in words, and the inbox stays open. The line is emptied
   * before each attempt, so a second "copied" is a new message rather than the same words left in place.
   */
  const copyDetails = (notice: Notice) => {
    const text = noticeDetailsText(notice, t);
    const attempt = ++copyAttempt.current;
    setStatus(undefined);
    clearTimeout(copyOutcomeTimer.current);
    setCopyOutcome(undefined);
    // Only the latest press speaks: an earlier write that settles late does not overwrite what the last one said.
    const say = (next: Status) => {
      if (attempt !== copyAttempt.current) return;
      setStatus(next);
      // The button says it too, for about two seconds, without being a second live region: its accessible name is its
      // aria-label, which does not change, so a screen reader hears the result once, from the status line.
      setCopyOutcome({ noticeId: notice.noticeId, tone: next.tone });
      copyOutcomeTimer.current = setTimeout(() => setCopyOutcome(undefined), COPY_OUTCOME_MS);
    };
    // A page with no clipboard at all (an insecure page has none) throws here, as does a write that throws rather than
    // rejecting: both become the same refusal, settled after the press's own render so the emptied line is drawn first.
    let written: Promise<void>;
    try {
      written = navigator.clipboard.writeText(text);
    } catch (cause) {
      written = Promise.reject(new Error("clipboard refused", { cause }));
    }
    void written.then(
      () => say({ tone: "done", text: t("inbox.copied") }),
      () => say({ tone: "failed", text: t("inbox.copyFailed") }),
    );
  };

  /** "Open conversation" for the one already on screen is "close this"; for another, only when the host can switch. */
  const openButton = (targetId: string, primary = false): ReactElement | null => {
    const isCurrent = targetId === conversationId;
    if (!isCurrent && onOpenConversation === undefined) return null;
    const blocked = !isCurrent && !canOpenOtherConversation(switchGuard);
    return (
      <>
        <button
          type="button"
          className="cc-action"
          {...(primary ? { "data-emphasis": "primary" } : {})}
          data-inbox-open-conversation={targetId}
          disabled={blocked}
          onClick={() => {
            if (isCurrent) onClose();
            else onOpenConversation?.(targetId);
          }}
        >
          {t("inbox.openConversation")}
        </button>
        {blocked && (
          <span className="cc-freshness" data-inbox-open-blocked="true" style={{ flexBasis: "100%" }}>
            {t("inbox.openConversation.blocked")}
          </span>
        )}
      </>
    );
  };

  /**
   * One of a notice's actions as the node worked them out (`notice-actions.ts`). An action the host cannot carry out
   * here — no way to switch conversations, no composer — is left out rather than drawn as a button that does nothing,
   * and one that is held back says why in words beside it.
   */
  const noticeAction = (notice: Notice, action: NoticeAction): ReactElement | null => {
    const primary = action.placement === "primary";
    const emphasis = primary ? { "data-emphasis": "primary" } : {};
    const locked = busy !== undefined;
    if (action.unavailable !== undefined) return unavailableNote(notice, action, action.unavailable);
    switch (action.id) {
      case "open": {
        const target = noticeConversationTarget(notice);
        return target === undefined ? null : <Fragment key="open">{openButton(target, primary)}</Fragment>;
      }
      case "ask-clark":
        if (onAskClark === undefined) return null;
        return (
          <Fragment key="ask-clark">
            <button
              type="button"
              className="cc-action"
              {...emphasis}
              data-inbox-ask={notice.noticeId}
              aria-label={t("inbox.action.askAria").replace("{title}", notice.title)}
              disabled={locked || switchGuard.busy}
              onClick={() => onAskClark(notice)}
            >
              {t("inbox.action.ask")}
            </button>
            {switchGuard.busy && (
              <span className="cc-freshness" data-inbox-ask-blocked="true" style={{ flexBasis: "100%" }}>
                {t("inbox.ask.busy")}
              </span>
            )}
          </Fragment>
        );
      case "add-to-context":
        if (onAddToContext === undefined) return null;
        return (
          <button
            key="add-to-context"
            type="button"
            className="cc-action"
            {...emphasis}
            data-inbox-add-context={notice.noticeId}
            disabled={locked}
            onClick={() => addToContext(notice)}
          >
            {t("inbox.action.addToContext")}
          </button>
        );
      case "copy-details": {
        const outcome = copyOutcome?.noticeId === notice.noticeId ? copyOutcome.tone : undefined;
        const idle = t("inbox.action.copyDetails");
        const copied = t("inbox.action.copyDetailsDone");
        const failed = t("inbox.action.copyDetailsFailed");
        return (
          <button
            key="copy-details"
            type="button"
            className="cc-action"
            {...emphasis}
            data-inbox-copy-details={notice.noticeId}
            data-copy-outcome={outcome ?? "idle"}
            aria-label={t("inbox.action.copyDetailsAria").replace("{title}", notice.title)}
            onClick={() => copyDetails(notice)}
          >
            {/* Every label the button can show is laid in the same cell, the unseen ones drawn invisibly by CSS, so the
                button is as wide as its longest label in this language and never changes width. */}
            <span className="cc-inbox-copy-label">
              <span>{outcome === "done" ? copied : outcome === "failed" ? failed : idle}</span>
              <span className="cc-inbox-copy-sizer" aria-hidden="true" data-one={idle} data-two={copied} />
              <span className="cc-inbox-copy-sizer" aria-hidden="true" data-one={failed} data-two="" />
            </span>
          </button>
        );
      }
      case "mark-read":
      case "mark-unread": {
        const read = action.id === "mark-read";
        return (
          <button
            key={action.id}
            type="button"
            className="cc-action"
            {...emphasis}
            {...(read ? { "data-inbox-mark-read": notice.noticeId } : { "data-inbox-mark-unread": notice.noticeId })}
            disabled={locked}
            onClick={() => setRead(notice, read)}
          >
            {t(read ? "inbox.action.markRead" : "inbox.action.markUnread")}
          </button>
        );
      }
      case "dismiss":
        return (
          <button
            key="dismiss"
            type="button"
            className="cc-action"
            {...emphasis}
            data-inbox-dismiss={notice.noticeId}
            aria-label={t("inbox.dismissAria").replace("{title}", notice.title)}
            disabled={locked}
            onClick={() => dismiss(notice)}
          >
            {t("inbox.dismiss")}
          </button>
        );
      case "snooze":
        // One labelled row of choices rather than a second disclosure inside "More": one press from the menu, and every
        // choice says the time it means on this person's clock.
        return (
          <div
            key="snooze"
            role="group"
            className="cc-inbox-snooze"
            aria-label={t("inbox.snooze.groupAria").replace("{title}", notice.title)}
            data-inbox-snooze-group={notice.noticeId}
          >
            <span className="cc-freshness" aria-hidden="true">
              {t("inbox.snooze.label")}
            </span>
            {snoozePresets(new Date()).map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="cc-action"
                data-inbox-snooze={notice.noticeId}
                data-snooze-preset={preset.id}
                title={when(preset.until)}
                disabled={locked}
                onClick={() => snooze(notice, preset.id)}
              >
                {t(snoozePresetKey(preset.id))}
              </button>
            ))}
          </div>
        );
      case "unsnooze":
        return (
          <button
            key="unsnooze"
            type="button"
            className="cc-action"
            {...emphasis}
            data-inbox-unsnooze={notice.noticeId}
            aria-label={t("inbox.action.unsnoozeAria").replace("{title}", notice.title)}
            disabled={locked}
            onClick={() => unsnooze(notice.noticeId)}
          >
            {t("inbox.action.unsnooze")}
          </button>
        );
      case "retry":
        return (
          <button
            key="retry"
            type="button"
            className="cc-action"
            {...emphasis}
            data-inbox-retry={notice.noticeId}
            aria-label={t("inbox.action.retryAria").replace("{title}", notice.title)}
            disabled={locked}
            onClick={() => retry(notice)}
          >
            {t("inbox.action.retry")}
          </button>
        );
      case "review-update":
        if (onOpenSettings === undefined) return null;
        return (
          <button
            key="review-update"
            type="button"
            className="cc-action"
            {...emphasis}
            data-inbox-review-update={notice.noticeId}
            aria-label={t("inbox.action.reviewUpdateAria").replace("{title}", notice.title)}
            disabled={locked}
            onClick={() => onOpenSettings("extensions")}
          >
            {t("inbox.action.reviewUpdate")}
          </button>
        );
      case "update":
        return (
          <button
            key="update"
            type="button"
            className="cc-action"
            {...emphasis}
            data-inbox-update={notice.noticeId}
            aria-label={t("inbox.action.updateAria").replace("{title}", notice.title)}
            disabled={locked}
            onClick={() => update(notice)}
          >
            {t("inbox.action.update")}
          </button>
        );
      case "skip-version":
        return (
          <button
            key="skip-version"
            type="button"
            className="cc-action"
            {...emphasis}
            data-inbox-skip-version={notice.noticeId}
            aria-label={t("inbox.action.skipVersionAria").replace("{title}", notice.title)}
            disabled={locked}
            onClick={() => skip(notice)}
          >
            {t("inbox.action.skipVersion")}
          </button>
        );
      case "ask-again":
        return (
          <button
            key="ask-again"
            type="button"
            className="cc-action"
            {...emphasis}
            data-inbox-ask-again={notice.noticeId}
            aria-label={t("inbox.action.askAgainAria").replace("{title}", notice.body ?? notice.title)}
            disabled={locked}
            onClick={() => askAgain(notice)}
          >
            {t("inbox.action.askAgain")}
          </button>
        );
      case "suppress":
      case "unsuppress": {
        const quiet = action.id === "suppress";
        return (
          <button
            key={action.id}
            type="button"
            className="cc-action"
            {...emphasis}
            {...(quiet ? { "data-inbox-suppress": notice.noticeId } : { "data-inbox-unsuppress": notice.noticeId })}
            disabled={locked}
            onClick={() => setQuiet(notice.noticeId, quiet)}
          >
            {t(quiet ? "inbox.action.suppress" : "inbox.action.unsuppress")}
          </button>
        );
      }
      case "reconcile-confirmed":
      case "reconcile-failed": {
        const effectId = action.effectId;
        if (onReconcile === undefined || effectId === undefined) return null;
        const landed = action.id === "reconcile-confirmed";
        return (
          <button
            key={action.id}
            type="button"
            className="cc-action"
            {...emphasis}
            data-inbox-reconcile={landed ? "confirmed" : "failed"}
            data-inbox-reconcile-effect={effectId}
            aria-label={t(landed ? "inbox.action.reconcileConfirmedAria" : "inbox.action.reconcileFailedAria").replace("{title}", notice.title)}
            aria-busy={busy?.key === `notice:${notice.noticeId}` ? "true" : undefined}
            disabled={locked}
            onClick={() => reconcile(notice, effectId, landed ? "confirmed" : "failed")}
          >
            {t(landed ? "inbox.action.reconcileConfirmed" : "inbox.action.reconcileFailed")}
          </button>
        );
      }
      default: {
        // An action id added later has to be drawn here, rather than silently leaving its notice without it.
        const unhandled: never = action.id;
        return unhandled;
      }
    }
  };

  /** Escape closes an open "More" before it closes the panel, and hands focus back to the button that opened it. */
  const closeMenuOnEscape = (noticeId: string) => (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || menuFor !== noticeId) return;
    // Stopped here so the dialog's own Escape (a listener on `document`) never sees it.
    event.stopPropagation();
    event.preventDefault();
    setMenuFor(undefined);
    moreButtons.current.get(noticeId)?.focus();
  };

  const readAt =
    load.state === "ready"
      ? new Date(load.inbox.readAt).toLocaleTimeString(locale === "vi" ? "vi-VN" : "en-US", { hour: "2-digit", minute: "2-digit" })
      : undefined;

  return (
    <Modal open={open} onClose={onClose} title={t("inbox.title")} description={t("inbox.description")} width="560px">
      {/* Host-owned, so its approve, deny and reconcile buttons are drawn as Clark's, whatever a theme's recipe says. */}
      <div className="cc-inbox" data-owner="host" data-inbox-panel={load.state}>
        {/* Always in the page, so a screen reader is already listening when a result is written into it: an action
            that leaves focus where it was ("Copy details") is heard only through this line. Empty, it takes no room. */}
        <div className="cc-inbox-status" data-empty={status === undefined ? "true" : "false"}>
          <p
            ref={statusLine}
            tabIndex={-1}
            className="cc-panel-note"
            role="status"
            {...(status === undefined ? {} : { "data-inbox-status": status.tone })}
            style={{ margin: 0 }}
          >
            {status?.text}
          </p>
          {status?.undo !== undefined && (
            <button
              type="button"
              className="cc-action"
              data-inbox-undo={status.undo.noticeId}
              data-inbox-undo-kind={status.undo.kind}
              disabled={busy !== undefined}
              onClick={() => {
                if (status.undo !== undefined) undo(status.undo);
              }}
            >
              {t("inbox.undo")}
            </button>
          )}
        </div>

        {load.state === "loading" && (
          <p className="cc-panel-note" role="status" data-inbox-loading="true" style={{ marginTop: 0 }}>
            {t("inbox.loading")}
          </p>
        )}

        {load.state === "failed" && (
          <p className="cc-panel-note" role="alert" data-inbox-failed="true" style={{ marginTop: 0 }}>
            {t("inbox.loadFailed").replace("{reason}", load.reason)}
          </p>
        )}

        {load.state === "ready" && (
          <>
            <p className="cc-freshness" data-inbox-read-at={load.inbox.readAt} style={{ margin: 0 }}>
              {t("inbox.readAt").replace("{time}", readAt ?? "")}
            </p>

            <section className="cc-inbox-section" aria-labelledby="cc-inbox-waiting">
              <h3 id="cc-inbox-waiting" className="cc-inbox-heading">
                {t("inbox.waiting.heading")}
              </h3>
              {load.inbox.waiting.length === 0 ? (
                <p className="cc-freshness" data-inbox-waiting-empty="true" style={{ margin: 0 }}>
                  {t("inbox.waiting.none")}
                </p>
              ) : (
                <ul className="cc-inbox-list">
                  {load.inbox.waiting.map((item) => {
                    const key = waitingKey(item);
                    const busyHere = busy?.key === key;
                    const running = busyHere && busy?.decision === "granted";
                    const denying = busyHere && busy?.decision === "denied";
                    const left = timeLeft(item.expiresAt, load.inbox.readAt, t);
                    return (
                      <li
                        key={key}
                        ref={targetRow(key)}
                        tabIndex={-1}
                        aria-label={t("inbox.row.waitingAria").replace(
                          "{title}",
                          item.kind === "question"
                            ? item.prompt
                            : item.kind === "install-approval"
                              ? t("inbox.install.title").replace("{name}", item.displayName).replace("{version}", item.version)
                              : item.description,
                        )}
                        className="cc-card cc-inbox-item"
                        data-inbox-waiting-item={item.kind}
                        data-inbox-waiting-key={key}
                        {...(highlighted === key ? { "data-inbox-target": "true" } : {})}
                      >
                        <div className="cc-card-body">
                          {item.kind === "command-approval" && (
                            <>
                              <span className="cc-card-title">{t("inbox.command.title")}</span>
                              <p style={{ margin: 0 }}>{item.description}</p>
                              {item.command !== undefined && (
                                <pre className="cc-inbox-command" data-inbox-command="true">
                                  <code>{item.command}</code>
                                </pre>
                              )}
                              <p className="cc-freshness" style={{ margin: 0 }}>
                                {t("inbox.command.note")}
                                {left === undefined ? "" : ` · ${left}`}
                              </p>
                              <div className="cc-card-actions">
                                <button
                                  type="button"
                                  className="cc-action"
                                  data-inbox-approve={item.approvalId}
                                  disabled={busy !== undefined}
                                  onClick={() => decideCommand(item, "granted")}
                                >
                                  {running ? t("inbox.command.running") : t("inbox.command.approve")}
                                </button>
                                <button
                                  type="button"
                                  className="cc-action"
                                  data-inbox-deny={item.approvalId}
                                  disabled={busy !== undefined}
                                  onClick={() => decideCommand(item, "denied")}
                                >
                                  {denying ? t("inbox.command.denying") : t("inbox.command.deny")}
                                </button>
                                {openButton(item.conversationId)}
                              </div>
                            </>
                          )}
                          {item.kind === "capability-approval" && (
                            <>
                              <span className="cc-card-title">{item.description}</span>
                              {left !== undefined && (
                                <p className="cc-freshness" style={{ margin: 0 }}>
                                  {left}
                                </p>
                              )}
                              {/* The package id, capability ref and version are progressive disclosure: a person decides
                                  from the sentence above, and reaches these only if the decision needs more than that
                                  (AGENTS.md: no capability refs in the default row). */}
                              <details className="cc-inbox-capability-details">
                                <summary>{t("inbox.capability.details")}</summary>
                                <p className="cc-freshness" style={{ margin: 0 }}>
                                  {t("inbox.capability.title").replace("{package}", item.packageId).replace("{capability}", item.ref)}
                                </p>
                                <p className="cc-freshness" style={{ margin: 0 }}>
                                  {t("inbox.capability.version").replace("{version}", item.version)}
                                </p>
                              </details>
                              <div className="cc-card-actions">
                                <button
                                  type="button"
                                  className="cc-action"
                                  data-inbox-grant={item.approvalId}
                                  disabled={busy !== undefined}
                                  onClick={() => decideCapability(item, "granted")}
                                >
                                  {t("inbox.capability.grant")}
                                </button>
                                <button
                                  type="button"
                                  className="cc-action"
                                  data-inbox-deny={item.approvalId}
                                  disabled={busy !== undefined}
                                  onClick={() => decideCapability(item, "denied")}
                                >
                                  {t("inbox.capability.deny")}
                                </button>
                              </div>
                            </>
                          )}
                          {item.kind === "install-approval" && (
                            <>
                              <span className="cc-card-title">
                                {t("inbox.install.title").replace("{name}", item.displayName).replace("{version}", item.version)}
                              </span>
                              {/* What the person decides on, in the listing's own words: what it asks for and where it runs. */}
                              <p style={{ margin: 0 }} data-inbox-install-permissions="true">
                                {item.permissions.length === 0
                                  ? t("inbox.install.asksNothing")
                                  : t("inbox.install.asks").replace("{permissions}", item.permissions.join(", "))}
                              </p>
                              <p style={{ margin: 0 }}>{t("inbox.install.lane").replace("{lane}", riskLaneLabel(t, item.riskTier))}</p>
                              <p className="cc-freshness" style={{ margin: 0 }}>
                                {t("inbox.install.note")}
                                {left === undefined ? "" : ` · ${left}`}
                              </p>
                              <details className="cc-inbox-capability-details">
                                <summary>{t("inbox.capability.details")}</summary>
                                <p className="cc-freshness" style={{ margin: 0 }}>
                                  {item.packageId}
                                </p>
                                <p className="cc-freshness" style={{ margin: 0 }}>
                                  {t("inbox.capability.version").replace("{version}", item.version)}
                                </p>
                              </details>
                              <div className="cc-card-actions">
                                <button
                                  type="button"
                                  className="cc-action"
                                  data-inbox-install-approve={item.approvalId}
                                  disabled={busy !== undefined}
                                  onClick={() => decideInstall(item, "granted")}
                                >
                                  {running ? t("inbox.install.installing") : t("inbox.install.approve")}
                                </button>
                                <button
                                  type="button"
                                  className="cc-action"
                                  data-inbox-deny={item.approvalId}
                                  disabled={busy !== undefined}
                                  onClick={() => decideInstall(item, "denied")}
                                >
                                  {denying ? t("inbox.command.denying") : t("inbox.install.deny")}
                                </button>
                              </div>
                            </>
                          )}
                          {item.kind === "question" && (
                            <>
                              <span className="cc-card-title">{t("inbox.question.title")}</span>
                              <p style={{ margin: 0 }}>{item.prompt}</p>
                              {left !== undefined && (
                                <p className="cc-freshness" style={{ margin: 0 }}>
                                  {left}
                                </p>
                              )}
                              <div className="cc-card-actions">{openButton(item.conversationId)}</div>
                            </>
                          )}
                          {item.kind === "task-approval" && (
                            <>
                              <span className="cc-card-title">
                                {t("inbox.task.title").replace("{capability}", categoryLabels[item.effectCategory])}
                              </span>
                              <p style={{ margin: 0 }}>{item.description}</p>
                              <p className="cc-freshness" style={{ margin: 0 }}>
                                {t("inbox.task.note")}
                                {left === undefined ? "" : ` · ${left}`}
                              </p>
                              <div className="cc-card-actions">
                                <button
                                  type="button"
                                  className="cc-action"
                                  data-inbox-approve={item.approvalId}
                                  disabled={busy !== undefined}
                                  onClick={() => decideTask(item, "granted")}
                                >
                                  {running ? t("inbox.task.running") : t("inbox.task.approve")}
                                </button>
                                <button
                                  type="button"
                                  className="cc-action"
                                  data-inbox-deny={item.approvalId}
                                  disabled={busy !== undefined}
                                  onClick={() => decideTask(item, "denied")}
                                >
                                  {denying ? t("inbox.command.denying") : t("inbox.task.deny")}
                                </button>
                                {item.conversationId !== undefined && openButton(item.conversationId)}
                              </div>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="cc-inbox-section" aria-labelledby="cc-inbox-notices">
              <h3 id="cc-inbox-notices" className="cc-inbox-heading" ref={noticesHeading} tabIndex={-1}>
                {t("inbox.notices.heading")}
              </h3>
              {noticesMayBeCapped(load.inbox.notices) && (
                <p className="cc-freshness" data-inbox-notices-capped="true" style={{ margin: 0 }}>
                  {t("inbox.notices.capped")}
                </p>
              )}
              {load.inbox.notices.length === 0 ? (
                <p className="cc-freshness" data-inbox-notices-empty="true" style={{ margin: 0 }}>
                  {t("inbox.notices.none")}
                </p>
              ) : (
                <ul className="cc-inbox-list">
                  {load.inbox.notices.map((notice) => {
                    const tone = noticeTone(notice.severity);
                    const unread = notice.readAt === undefined;
                    const { buttons, menu } = noticeActionGroups(notice);
                    const menuItems = menu.map((action) => noticeAction(notice, action)).filter((item) => item !== null);
                    const menuOpen = menuFor === notice.noticeId;
                    const menuId = `cc-inbox-more-${notice.noticeId}`;
                    return (
                      <li
                        key={notice.noticeId}
                        ref={(el) => {
                          if (el) noticeRows.current.set(notice.noticeId, el);
                          else noticeRows.current.delete(notice.noticeId);
                          targetRow(`notice:${notice.noticeId}`)(el);
                        }}
                        tabIndex={-1}
                        aria-label={t("inbox.row.noticeAria").replace("{title}", notice.title)}
                        className="cc-inbox-notice"
                        data-inbox-notice={notice.noticeId}
                        data-unread={unread ? "true" : "false"}
                        {...(highlighted === `notice:${notice.noticeId}` ? { "data-inbox-target": "true" } : {})}
                      >
                        <div className="cc-inbox-notice-head">
                          <span className="cc-badge" {...(tone === undefined ? {} : { "data-tone": tone })}>
                            {t(noticeSourceKey(notice.sourceKind))}
                          </span>
                          {unread && (
                            <span className="cc-inbox-unread" data-inbox-unread-label="true">
                              {/* Not the warning token: a result nobody has read yet is not an alarm, so the dot uses
                                  the accent token, and the word beside it — never the colour alone — says "unread". */}
                              <span className="cc-dot" data-state="unread" aria-hidden="true" style={{ background: "var(--cc-accent)" }} />
                              {t("inbox.unread")}
                            </span>
                          )}
                          <span
                            className="cc-freshness"
                            title={new Date(notice.createdAt).toLocaleString(locale === "vi" ? "vi-VN" : "en-US")}
                          >
                            {relativeAge(notice.createdAt, load.inbox.readAt, t)}
                          </span>
                        </div>
                        <p className="cc-inbox-notice-title">{notice.title}</p>
                        {notice.body !== undefined && <p className="cc-inbox-notice-body">{notice.body}</p>}
                        {noticeKindQuieted(notice) && (
                          // Says why a notice of this kind arrived already read, in words rather than by its look alone.
                          <p className="cc-freshness" data-inbox-quiet-kind={notice.noticeId} style={{ margin: 0 }}>
                            {t("inbox.quietKind")}
                          </p>
                        )}
                        {onReconcile !== undefined && noticeReconcileEffect(notice) !== undefined && (
                          // Said before the buttons, not after a press: an answer is recorded for good, and "did you
                          // look?" is the one question worth asking before it.
                          <p className="cc-inbox-reconcile-hint" data-inbox-reconcile-hint={notice.noticeId}>
                            {t("inbox.reconcile.hint")}
                          </p>
                        )}
                        <div className="cc-card-actions" onKeyDown={closeMenuOnEscape(notice.noticeId)}>
                          {buttons.map((action) => noticeAction(notice, action))}
                          {menuItems.length > 0 && (
                            <button
                              type="button"
                              className="cc-action cc-inbox-more"
                              ref={(el) => {
                                if (el) moreButtons.current.set(notice.noticeId, el);
                                else moreButtons.current.delete(notice.noticeId);
                              }}
                              data-inbox-more={notice.noticeId}
                              aria-expanded={menuOpen}
                              aria-controls={menuId}
                              aria-label={t("inbox.action.moreAria").replace("{title}", notice.title)}
                              onClick={() => setMenuFor(menuOpen ? undefined : notice.noticeId)}
                            >
                              {t("inbox.action.more")}
                              <span aria-hidden="true" className="cc-inbox-more-caret" data-open={menuOpen ? "true" : "false"}>
                                ▾
                              </span>
                            </button>
                          )}
                          {menuItems.length > 0 && (
                            // Kept in the page while closed so `aria-controls` always names an element.
                            <div id={menuId} className="cc-inbox-menu" data-inbox-menu={notice.noticeId} hidden={!menuOpen}>
                              {menuItems}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {load.inbox.snoozed.length > 0 && (
                // Closed by default: what the person put aside is out of the way on purpose, but never out of reach.
                <details className="cc-inbox-aside" data-inbox-snoozed-list="true">
                  <summary>{t("inbox.snoozed.heading").replace("{count}", String(load.inbox.snoozed.length))}</summary>
                  <ul className="cc-inbox-list">
                    {load.inbox.snoozed.map((notice) => (
                      <li key={notice.noticeId} className="cc-inbox-notice" data-inbox-snoozed={notice.noticeId}>
                        <div className="cc-inbox-notice-head">
                          <span className="cc-badge">{t(noticeSourceKey(notice.sourceKind))}</span>
                          {notice.snoozedUntil !== undefined && (
                            <span className="cc-freshness" data-inbox-snoozed-until={notice.snoozedUntil}>
                              {t("inbox.snoozed.until").replace("{time}", when(notice.snoozedUntil))}
                            </span>
                          )}
                        </div>
                        <p className="cc-inbox-notice-title">{notice.title}</p>
                        <div className="cc-card-actions">
                          {noticeActionGroups(notice).buttons.map((action) => noticeAction(notice, action))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {load.inbox.suppressions.length > 0 && (
                <details className="cc-inbox-aside" data-inbox-suppressions="true">
                  <summary>{t("inbox.suppressions.heading").replace("{count}", String(load.inbox.suppressions.length))}</summary>
                  <p className="cc-freshness" style={{ marginTop: 0 }}>
                    {t("inbox.suppressions.note")}
                  </p>
                  <ul className="cc-inbox-list">
                    {load.inbox.suppressions.map((suppression) => {
                      const parts = suppressionDescription(suppression);
                      const covers = `${t(parts.scopeKey).replace("{label}", parts.label).replace("{source}", t(noticeSourceKey(suppression.sourceKind)))} — ${t(parts.levelKey)}`;
                      return (
                        <li
                          key={suppression.suppressionId}
                          className="cc-inbox-notice"
                          data-inbox-suppression={suppression.suppressionId}
                        >
                          <div className="cc-inbox-notice-head">
                            <span className="cc-badge" {...(noticeTone(suppression.severity) === undefined ? {} : { "data-tone": noticeTone(suppression.severity) })}>
                              {t(noticeSourceKey(suppression.sourceKind))}
                            </span>
                          </div>
                          <p className="cc-inbox-notice-title" data-inbox-suppression-covers={suppression.suppressionId}>
                            {covers}
                          </p>
                          <p className="cc-freshness" style={{ margin: 0 }}>
                            {t("inbox.suppressions.example").replace("{title}", suppression.example)}
                          </p>
                          <div className="cc-card-actions">
                            <button
                              type="button"
                              className="cc-action"
                              data-inbox-remove-suppression={suppression.suppressionId}
                              aria-label={t("inbox.suppressions.removeAria").replace("{title}", covers)}
                              disabled={busy !== undefined}
                              onClick={() => removeSuppression(suppression.suppressionId)}
                            >
                              {t("inbox.suppressions.remove")}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}
              {load.inbox.skippedVersions.length > 0 && (
                <details className="cc-inbox-aside" data-inbox-skipped-versions="true">
                  <summary>{t("inbox.skippedVersions.heading").replace("{count}", String(load.inbox.skippedVersions.length))}</summary>
                  <p className="cc-freshness" style={{ marginTop: 0 }}>
                    {t("inbox.skippedVersions.note")}
                  </p>
                  <ul className="cc-inbox-list">
                    {load.inbox.skippedVersions.map((skip) => {
                      const key = `${skip.subjectKind}:${skip.name}@${skip.version}`;
                      const covers = t(skip.subjectKind === "pi" ? "inbox.skippedVersions.pi" : "inbox.skippedVersions.package")
                        .replace("{name}", skip.name)
                        .replace("{version}", skip.version);
                      return (
                        <li key={key} className="cc-inbox-notice" data-inbox-skipped-version={key}>
                          <div className="cc-inbox-notice-head">
                            <span className="cc-badge">{t(noticeSourceKey(skip.subjectKind))}</span>
                          </div>
                          <p className="cc-inbox-notice-title">{covers}</p>
                          <div className="cc-card-actions">
                            <button
                              type="button"
                              className="cc-action"
                              data-inbox-remove-skipped-version={key}
                              aria-label={t("inbox.skippedVersions.removeAria").replace("{title}", covers)}
                              disabled={busy !== undefined}
                              onClick={() => removeSkippedVersion(skip)}
                            >
                              {t("inbox.skippedVersions.remove")}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
