import { type ReactElement, useEffect, useState } from "react";

import type { InboxSummary } from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import { useT } from "../i18n/locale-context.tsx";
import { inboxMarkHasNews, inboxMarkState, inboxMarkText } from "./inbox-model.ts";

/**
 * The inbox, as a mark in the header.
 *
 * Always drawn once the node has answered, because it is the one way to the inbox by pointer and keyboard: notices
 * already read are still worth opening again, and a mark that vanished once they were read would leave no way back.
 * At zero it is only the bell — a header that always says "0" carries a permanent line of noise — and the count joins
 * it while something is waiting or new. "mở hộp thư" reaches the same surface by voice and by a typed command, through
 * the same intent.
 *
 * Polled like the background mark, at the same resolution: this is a number glanced at, not a value anything waits
 * on. `refreshKey` makes it read again at once after something that changes it — a decision in the panel, a turn that
 * may have raised an approval — rather than up to five seconds later.
 */
export function InboxMark({
  client,
  refreshKey,
  onOpen,
}: {
  client: GatewayClient;
  refreshKey: string;
  onOpen: () => void;
}): ReactElement | null {
  const t = useT();
  const [summary, setSummary] = useState<InboxSummary | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void client
        .inboxSummary()
        .then((loaded) => {
          if (!cancelled) setSummary(loaded);
        })
        .catch(() => {
          // A node that cannot answer is not a reason to draw a mark, and the last count read is not live either, so it
          // is dropped rather than left on screen as though it were current.
          if (!cancelled) setSummary(undefined);
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, refreshKey]);

  if (summary === undefined) return null;
  const news = inboxMarkHasNews(summary);
  const text = inboxMarkText(summary, t);

  return (
    <button
      type="button"
      className="cc-inbox-mark"
      data-inbox-mark={inboxMarkState(summary)}
      data-inbox-waiting={String(summary.waiting)}
      data-inbox-unread={String(summary.unread)}
      aria-label={news ? t("inbox.mark.aria").replace("{summary}", text) : t("inbox.mark.openAria")}
      title={news ? text : t("inbox.mark.openAria")}
      onClick={onOpen}
    >
      <svg className="cc-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {news ? (
        <>
          <span className="cc-dot" data-state={summary.waiting > 0 ? "waiting" : "ready"} aria-hidden="true" />
          <span>{text}</span>
        </>
      ) : null}
    </button>
  );
}
