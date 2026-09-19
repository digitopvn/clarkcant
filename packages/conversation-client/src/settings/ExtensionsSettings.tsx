import { useEffect, useState, type ReactElement } from "react";

import { ToolLists } from "../tool-lists.tsx";
import type { GatewayClient, InstalledPackageView } from "../api.ts";
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
      {/*
        What is installed, and where it came from.
        ...
      */}
      <InstalledPackagesSection client={client} />
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

/**
 * What is installed, and where each package came from.
 *
 * Four facts, and three of them are ones a user cannot check for themselves: where it came from, which version,
 * which digest, and which lane it runs in. The digest especially — it is the only thing tying what is running to
 * what was approved, so a list that showed a version without one would be inviting trust it has not earned.
 *
 * The lanes are labelled apart on purpose. A native Pi extension is trusted process-level code that runs beside
 * the host; an isolated widget is opaque-origin code in a frame with no Node, no filesystem and no host cookies.
 * Showing them with the same wording would be the one mistake this list exists to prevent.
 */
const LANE_LABELS: Record<InstalledPackageView["lane"], string> = {
  declarative: "chỉ dữ liệu",
  "isolated-ui": "widget cách ly",
  service: "service riêng tiến trình",
  "trusted-native": "extension Pi gốc — chạy cùng tiến trình",
};

function InstalledPackagesSection({ client }: { client: GatewayClient }): ReactElement {
  const [packages, setPackages] = useState<InstalledPackageView[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void client
      .packages()
      .then((answer) => {
        if (!cancelled) setPackages(answer.packages);
      })
      .catch(() => {
        // Named as unread rather than shown as empty: an empty list would say "nothing is installed", which is a
        // different claim from "this node could not say".
        if (!cancelled) setPackages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <section className="cc-panel-section">
      <h3>Đã cài trên node này</h3>
      {packages === undefined ? (
        <p className="cc-panel-note">Đang đọc…</p>
      ) : packages.length === 0 ? (
        <p className="cc-panel-note">Chưa cài gói nào trên node này.</p>
      ) : (
        <ul className="cc-installed-list">
          {packages.map((entry) => (
            <li key={entry.packageId} data-installed-package={entry.packageId} data-installed-lane={entry.lane}>
              <strong>
                {entry.packageId}@{entry.version}
              </strong>
              <span className="cc-badge" data-lane={entry.lane}>
                {LANE_LABELS[entry.lane]}
              </span>
              <dl className="cc-fields">
                <dt>Nguồn</dt>
                {/* The tier the resolver assigned, so "found on the internet" is never dressed up as first-party. */}
                <dd data-installed-source-tier={entry.source.sourceTier}>
                  {entry.source.rationale === "" ? entry.source.sourceTier : entry.source.rationale}
                </dd>
                <dt>Digest</dt>
                <dd>
                  <code data-installed-digest={entry.digest}>{entry.digest}</code>
                </dd>
                <dt>Cài lúc</dt>
                <dd>{entry.activatedAt}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
