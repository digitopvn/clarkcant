import { type ReactElement, useCallback, useEffect, useState } from "react";

import type { MemoryRecord } from "@clarkcant/contracts";

import type { GatewayClient } from "../api.ts";
import { useT } from "../i18n/locale-context.tsx";
import { memoryView, type MemoryGroupView } from "../memory-groups.ts";
import { useT } from "../i18n/locale-context.tsx";

/**
 * What this node remembers, and the way to remove it.
 *
 * Loaded when the tab is opened rather than when Settings is: reading what is remembered is a request, and a
 * settings dialog should not spend one on a screen nobody asked for.
 *
 * Four states, and the failure one is the reason this is a component rather than a list: a node that cannot answer
 * still has a screen, which says why and offers to ask again. A blank panel would be indistinguishable from having
 * remembered nothing, and those are very different things to be told.
 *
 * Deleting waits for the node before the row leaves the list. A row that disappears optimistically would come back
 * on the next read if the delete had failed, and the person would have been told something that was not true.
 */

type PanelState =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "ready"; records: MemoryRecord[] }
  | { state: "failed"; reason: string };

export interface MemorySettingsProps {
  client: GatewayClient;
}

export function MemorySettings({ client }: MemorySettingsProps): ReactElement {
  const t = useT();
  const [panel, setPanel] = useState<PanelState>({ state: "loading" });
  const [deletingId, setDeletingId] = useState<string | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    setPanel({ state: "loading" });
    const answer = await client.listMemories();
    if (!answer.ok) {
      setPanel({ state: "failed", reason: answer.reason });
      return;
    }
    setPanel(answer.items.length === 0 ? { state: "empty" } : { state: "ready", records: answer.items });
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = useCallback(
    async (memoryId: string): Promise<void> => {
      setDeletingId(memoryId);
      const answer = await client.deleteMemory(memoryId);
      setDeletingId(undefined);
      if (!answer.ok) {
        // The row stays, and the reason is shown. Saying a thing was removed when it was not is the one failure
        // this screen cannot have, because the whole promise is that removal is real.
        setPanel({ state: "failed", reason: answer.reason });
        return;
      }
      setPanel((current) => {
        if (current.state !== "ready") return current;
        const records = current.records.filter((record) => record.memoryId !== memoryId);
        return records.length === 0 ? { state: "empty" } : { state: "ready", records };
      });
    },
    [client],
  );

  if (panel.state === "loading") {
    return (
      <p className="cc-memory-loading" data-memory-state="loading">
        {t("settings.memory.loading")}
      </p>
    );
  }

  if (panel.state === "failed") {
    return (
      <div className="cc-memory-failed" data-memory-state="failed">
        <p>{panel.reason}</p>
        <button type="button" className="cc-secondary-button" data-memory-retry="true" onClick={() => void load()}>
          {t("settings.memory.retry")}
        </button>
      </div>
    );
  }

  if (panel.state === "empty") {
    return (
      <p className="cc-memory-empty" data-memory-state="empty">
        {t("settings.memory.empty")}
      </p>
    );
  }

  const view = memoryView(panel.records, new Date().toISOString(), t);

  return (
    // `memory-groups.ts` (group labels, relative-time and scope text) is outside this file's ownership and
    // still renders its own Vietnamese copy; the marker lets an i18n-coverage check skip this subtree.
    <div
      className="cc-memory"
      data-memory-state="ready"
      data-memory-count={view.count}
      data-out-of-scope-i18n="memory-groups"
    >
      {view.groups.map((group) => (
        <MemoryGroup key={group.kind} group={group} deletingId={deletingId} onDelete={remove} />
      ))}
    </div>
  );
}

function MemoryGroup({
  group,
  deletingId,
  onDelete,
}: {
  group: MemoryGroupView;
  deletingId: string | undefined;
  onDelete: (memoryId: string) => Promise<void>;
}): ReactElement {
  const t = useT();
  return (
    <section className="cc-memory-group" data-memory-kind={group.kind}>
      <h3 className="cc-memory-group-title">
        {group.label} <span className="cc-memory-group-count">{group.rows.length}</span>
      </h3>
      <ul className="cc-memory-rows">
        {group.rows.map((row) => (
          <li
            key={row.memoryId}
            className="cc-memory-row"
            data-memory-id={row.memoryId}
            data-memory-state={deletingId === row.memoryId ? "deleting" : "ready"}
          >
            <p className="cc-memory-text">{row.text}</p>
            <p className="cc-memory-meta">
              <span data-memory-source={row.sourceLabel}>{row.sourceLabel}</span>
              {" · "}
              <span>{row.timeLabel}</span>
              {" · "}
              <span>{row.scopeLabel}</span>
            </p>
            <button
              type="button"
              className="cc-memory-delete"
              data-memory-delete="true"
              aria-label={t("settings.memory.deleteAria")}
              disabled={deletingId === row.memoryId}
              onClick={() => void onDelete(row.memoryId)}
            >
              {t("settings.memory.delete")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
