import { useEffect, useState, type ReactElement } from "react";

import { ToolLists } from "../tool-lists.tsx";
import type { GatewayClient } from "../api.ts";
import { ToolRow } from "./controls/SettingsRow.tsx";

/**
 * Extensions & Widgets: what this node can do, and what it has loaded.
 *
 * The capability list and the two tool lists belong here rather than in a tab called "Tools", because a
 * person asking "can this thing do X" is asking about all three and needs to know which one would be doing
 * it. The heading on each section says which half holds what.
 *
 * The marketplace and installed-package list arrive in the marketplace phase. What is here now is what the
 * node can actually report: capabilities, and the agent's own tools.
 */

interface ToolFacts {
  ref: string;
  summary: string;
  usable: boolean;
  blockedReason?: string;
}

export interface ExtensionsSettingsProps {
  client: GatewayClient;
  tools: ToolFacts[] | undefined;
}

export function ExtensionsSettings({ client, tools }: ExtensionsSettingsProps): ReactElement {
  const [extensions, setExtensions] = useState<{ name: string; kind: string }[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void client
      .extensions()
      .then((answer) => {
        if (!cancelled) setExtensions(answer.extensions);
      })
      .catch(() => {
        // An empty list rather than an error: what this section answers is what pi loads, and a node that cannot
        // say still leaves the rest of the tab working.
        if (!cancelled) setExtensions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <>
      <section className="cc-panel-section">
        <h3>Capability trên node này</h3>
        <p className="cc-panel-note">
          Thứ gì chưa nạp thì nói rõ vì sao, không được làm tròn thành “dùng được”.
        </p>
        {tools === undefined ? (
          <p className="cc-panel-note">Đang đọc…</p>
        ) : tools.length === 0 ? (
          <p className="cc-panel-note">Chưa có capability nào trên node này.</p>
        ) : (
          tools.map((tool) => (
            <ToolRow
              key={tool.ref}
              toolRef={tool.ref}
              summary={tool.summary}
              usable={tool.usable}
              {...(tool.blockedReason === undefined ? {} : { blockedReason: tool.blockedReason })}
            />
          ))
        )}
      </section>

      <section className="cc-panel-section">
        <h3>Công cụ</h3>
        {/* Two lists, told apart by which half holds them: the node's own, and the agent's built-ins. */}
        <ToolLists client={client} />
      </section>

      <section className="cc-panel-section" data-pi-extensions="true">
        <h3>Extension của pi trên máy này</h3>
        {extensions === undefined ? (
          <p className="cc-panel-note">Đang đọc…</p>
        ) : extensions.length === 0 ? (
          <p className="cc-panel-note" data-pi-extensions="none">
            pi trên máy này chưa nạp extension nào. Danh sách chỉ có tên và loại, không bao giờ có nội dung tệp.
          </p>
        ) : (
          // Names and kinds, and deliberately nothing else: an extension on a real machine can hold a credential,
          // and a section that showed what was inside one would be the place it leaked from.
          <div className="cc-panel-note">
            {extensions.map((entry) => (
              <code key={entry.name} data-pi-extension={entry.name} data-kind={entry.kind}>
                {entry.name}
              </code>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
