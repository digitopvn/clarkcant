import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import type { InboxResponse, Notice, WaitingItem } from "@clarkcant/contracts";

import type { GatewayClient, Timeline } from "../api.ts";
import { Modal } from "../Modal.tsx";
import { useLocaleState, useT } from "../i18n/locale-context.tsx";
import {
  noticeIdsToMarkRead,
  noticeSourceKey,
  noticeTone,
  relativeAge,
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
}

type Load = { state: "loading" } | { state: "failed"; reason: string } | { state: "ready"; inbox: InboxResponse };

type Status = { tone: "done" | "failed"; text: string };

function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

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
}: InboxPanelProps): ReactElement | null {
  const t = useT();
  const { locale } = useLocaleState();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<Status | undefined>(undefined);
  const statusLine = useRef<HTMLParagraphElement>(null);
  // Held in a ref because the conversation hands a fresh closure on every render, and the read-on-open effect below
  // must run once per opening rather than once per render of the surface behind it.
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const read = useCallback(async (): Promise<InboxResponse | undefined> => {
    try {
      const inbox = await client.inbox();
      setLoad({ state: "ready", inbox });
      return inbox;
    } catch (cause) {
      setLoad({ state: "failed", reason: reasonOf(cause) });
      return undefined;
    }
  }, [client]);

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
      setBusy(undefined);
      onChanged();
      void read().then(() => statusLine.current?.focus());
    },
    [onChanged, read],
  );

  const decideCommand = (item: Extract<WaitingItem, { kind: "command-approval" }>, decision: "granted" | "denied") => {
    setBusy(waitingKey(item));
    setStatus(undefined);
    void client
      .decideApproval(item.conversationId, item.approvalId, { decision, digest: item.operationDigest })
      .then((result) => {
        if (item.conversationId === conversationId) onTimeline(result.timeline);
        settle({ tone: "done", text: t(decision === "granted" ? "inbox.decided.granted" : "inbox.decided.denied") });
      })
      .catch((cause: unknown) => settle({ tone: "failed", text: t("inbox.decideFailed").replace("{reason}", reasonOf(cause)) }));
  };

  const decideCapability = (item: Extract<WaitingItem, { kind: "capability-approval" }>, decision: "granted" | "denied") => {
    setBusy(waitingKey(item));
    setStatus(undefined);
    void client
      .decideCapabilityApproval(item, decision)
      .then(() =>
        settle({
          tone: "done",
          text: t(decision === "granted" ? "settings.extensions.approvals.granted" : "settings.extensions.approvals.denied")
            .replace("{capability}", item.ref)
            .replace("{package}", item.packageId),
        }),
      )
      .catch((cause: unknown) => settle({ tone: "failed", text: t("inbox.decideFailed").replace("{reason}", reasonOf(cause)) }));
  };

  const dismiss = (notice: Notice) => {
    setBusy(`notice:${notice.noticeId}`);
    setStatus(undefined);
    void client
      .dismissNotice(notice.noticeId)
      .then(() => {
        setBusy(undefined);
        onChanged();
        void read();
      })
      .catch((cause: unknown) =>
        settle({ tone: "failed", text: t("inbox.dismissFailed").replace("{reason}", reasonOf(cause)) }),
      );
  };

  /** "Open conversation" for the one already on screen is "close this"; for another, only when the host can switch. */
  const openButton = (targetId: string): ReactElement | null => {
    if (targetId !== conversationId && onOpenConversation === undefined) return null;
    return (
      <button
        type="button"
        className="cc-action"
        data-inbox-open-conversation={targetId}
        onClick={() => {
          if (targetId === conversationId) onClose();
          else onOpenConversation?.(targetId);
        }}
      >
        {t("inbox.openConversation")}
      </button>
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
                    const deciding = busy === key;
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
                                  {deciding ? t("inbox.command.running") : t("inbox.command.approve")}
                                </button>
                                <button
                                  type="button"
                                  className="cc-action"
                                  data-inbox-deny={item.approvalId}
                                  disabled={busy !== undefined}
                                  onClick={() => decideCommand(item, "denied")}
                                >
                                  {t("inbox.command.deny")}
                                </button>
                                {openButton(item.conversationId)}
                              </div>
                            </>
                          )}
                          {item.kind === "capability-approval" && (
                            <>
                              <span className="cc-card-title">
                                {t("inbox.capability.title").replace("{package}", item.packageId).replace("{capability}", item.ref)}
                              </span>
                              <p style={{ margin: 0 }}>{item.description}</p>
                              <p className="cc-freshness" style={{ margin: 0 }}>
                                {item.version}
                                {left === undefined ? "" : ` · ${left}`}
                              </p>
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
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="cc-inbox-section" aria-labelledby="cc-inbox-notices">
              <h3 id="cc-inbox-notices" className="cc-inbox-heading">
                {t("inbox.notices.heading")}
              </h3>
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
                              <span className="cc-dot" data-state="waiting" aria-hidden="true" />
                              {t("inbox.unread")}
                            </span>
                          )}
                          <span className="cc-freshness" title={new Date(notice.createdAt).toLocaleString()}>
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
