import { type ReactElement, useEffect, useState } from "react";

import type { InboxSummary } from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import { useT } from "../i18n/locale-context.tsx";
import { inboxMarkState, inboxMarkText, inboxMarkVisible } from "./inbox-model.ts";

/**
 * The inbox, as a mark in the header.
 *
 * Absent when there is nothing in it, for the reason the background mark is: a header that always says "0" carries a
 * permanent line of noise, and the inbox only matters when something is waiting or new. When it is drawn it is a real
 * button — the one way to the inbox by pointer and keyboard — and "mở hộp thư" reaches the same surface by voice and
 * by a typed command, through the same intent.
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

  if (summary === undefined || !inboxMarkVisible(summary)) return null;
  const text = inboxMarkText(summary, t);

  return (
    <button
      type="button"
      className="cc-inbox-mark"
      data-inbox-mark={inboxMarkState(summary)}
      data-inbox-waiting={String(summary.waiting)}
      data-inbox-unread={String(summary.unread)}
      aria-label={t("inbox.mark.aria").replace("{summary}", text)}
      onClick={onOpen}
    >
      <span className="cc-dot" data-state={summary.waiting > 0 ? "waiting" : "ready"} aria-hidden="true" />
      <span>{text}</span>
    </button>
  );
}
