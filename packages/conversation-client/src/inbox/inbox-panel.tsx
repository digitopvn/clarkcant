import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import type { InboxResponse, Notice, WaitingItem } from "@clarkcant/contracts";

import type { GatewayClient, Timeline } from "../api.ts";
import { Modal } from "../Modal.tsx";
import { useLocaleState, useT } from "../i18n/locale-context.tsx";
import {
  canOpenOtherConversation,
  decideFailureCategory,
  decideFailureMessageKey,
  nextNoticeFocusTarget,
  noticeIdsToMarkRead,
  noticesMayBeCapped,
  noticeSourceKey,
  noticeTone,
  relativeAge,
  sanitizeReason,
  timeLeft,
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
}

type Load = { state: "loading" } | { state: "failed"; reason: string } | { state: "ready"; inbox: InboxResponse };

type Status = { tone: "done" | "failed"; text: string };

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
}: InboxPanelProps): ReactElement | null {
  const t = useT();
  const { locale } = useLocaleState();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [busy, setBusy] = useState<Busy | undefined>(undefined);
  const [status, setStatus] = useState<Status | undefined>(undefined);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const noticesHeading = useRef<HTMLHeadingElement>(null);
  // The dismiss button for each notice currently on screen, so a dismissal can move focus to a real neighbour
  // instead of to `<body>` once the dismissed `<li>` (and the button that held focus) is gone.
  const dismissButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  // A synchronous lock a second click cannot race past: React state is not visible to the click handler that fires
  // a few milliseconds later with the network still in flight, but a ref write is immediate.
  const inFlight = useRef<string | undefined>(undefined);
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

  // Read once per opening, and mark read exactly what that read drew. The panel keeps showing those as "unread" for
  // as long as it stays open, because that is what they were when the person opened it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoad({ state: "loading" });
    setStatus(undefined);
    void read().then((inbox) => {
      if (cancelled || inbox === undefined) return;
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
  }, [open, read, client]);

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

  const decideTask = (item: Extract<WaitingItem, { kind: "task-approval" }>, decision: "granted" | "denied") => {
    setBusy(waitingKey(item));
    setStatus(undefined);
    void client
      .decideTaskApproval(item.taskId, item.approvalId, { decision, digest: item.operationDigest })
      .then((result) => {
        if (item.conversationId !== undefined && item.conversationId === conversationId) onTimeline(result.timeline);
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
      .catch((cause: unknown) => settle({ tone: "failed", text: t("inbox.decideFailed").replace("{reason}", reasonOf(cause)) }));
  };

  const dismiss = (notice: Notice) => {
    const key = `notice:${notice.noticeId}`;
    if (inFlight.current !== undefined) return;
    inFlight.current = key;
    setBusy({ key });
    setStatus(undefined);
    const noticeIdsBeforeDismiss = load.state === "ready" ? load.inbox.notices.map((existing) => existing.noticeId) : [];
    void client
      .dismissNotice(notice.noticeId)
      .then(() => {
        onChanged();
        return read();
      })
      .then(() => {
        inFlight.current = undefined;
        setBusy(undefined);
        // Announced through the status line's own live region regardless of where focus lands, and moved to a real
        // neighbour — the notice that took the dismissed one's place, or the section heading when none are left —
        // rather than to `<body>`, which is where focus goes once the button that held it is removed from the DOM.
        setStatus({ tone: "done", text: t("inbox.dismissed") });
        const nextId = nextNoticeFocusTarget(noticeIdsBeforeDismiss, notice.noticeId);
        if (nextId !== undefined) dismissButtonRefs.current.get(nextId)?.focus();
        else noticesHeading.current?.focus();
      })
      .catch((cause: unknown) => {
        inFlight.current = undefined;
        settle({ tone: "failed", text: t("inbox.dismissFailed").replace("{reason}", sanitizeReason(cause) ?? t("inbox.reason.unavailable")) });
      });
  };

  /** "Open conversation" for the one already on screen is "close this"; for another, only when the host can switch. */
  const openButton = (targetId: string): ReactElement | null => {
    const isCurrent = targetId === conversationId;
    if (!isCurrent && onOpenConversation === undefined) return null;
    const blocked = !isCurrent && !canOpenOtherConversation(switchGuard);
    return (
      <>
        <button
          type="button"
          className="cc-action"
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

  const readAt =
    load.state === "ready"
      ? new Date(load.inbox.readAt).toLocaleTimeString(locale === "vi" ? "vi-VN" : "en-US", { hour: "2-digit", minute: "2-digit" })
      : undefined;

  return (
    <Modal open={open} onClose={onClose} title={t("inbox.title")} description={t("inbox.description")} width="560px">
      <div className="cc-inbox" data-inbox-panel={load.state}>
        {status !== undefined && (
          <p
            ref={statusLine}
            tabIndex={-1}
            className="cc-panel-note"
            role="status"
            data-inbox-status={status.tone}
            style={{ marginTop: 0 }}
          >
            {status.text}
          </p>
        )}

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
                      <li key={key} className="cc-card cc-inbox-item" data-inbox-waiting-item={item.kind}>
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
                                {t("inbox.task.title").replace("{capability}", item.effectCategory)}
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
                                  {deciding ? t("inbox.task.running") : t("inbox.task.approve")}
                                </button>
                                <button
                                  type="button"
                                  className="cc-action"
                                  data-inbox-deny={item.approvalId}
                                  disabled={busy !== undefined}
                                  onClick={() => decideTask(item, "denied")}
                                >
                                  {t("inbox.task.deny")}
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
                    return (
                      <li
                        key={notice.noticeId}
                        className="cc-inbox-notice"
                        data-inbox-notice={notice.noticeId}
                        data-unread={unread ? "true" : "false"}
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
                        <div className="cc-card-actions">
                          {notice.conversationId !== undefined && openButton(notice.conversationId)}
                          <button
                            type="button"
                            className="cc-action"
                            ref={(el) => {
                              if (el) dismissButtonRefs.current.set(notice.noticeId, el);
                              else dismissButtonRefs.current.delete(notice.noticeId);
                            }}
                            data-inbox-dismiss={notice.noticeId}
                            aria-label={t("inbox.dismissAria").replace("{title}", notice.title)}
                            disabled={busy !== undefined}
                            onClick={() => dismiss(notice)}
                          >
                            {t("inbox.dismiss")}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
