import { useEffect, useState, type ReactElement } from "react";

import { readVar, TokenSpecimens } from "../TokenSpecimens.tsx";
import type { GatewayClient } from "../api.ts";
import { SettingsRow } from "./controls/SettingsRow.tsx";

/**
 * Developer / Advanced: the internals, behind a disclosure.
 *
 * Everything here was previously spread through the tabs a normal user reads — node ids, raw pi settings,
 * extension file names, capability references, token specimens. AGENTS.md's rule is that this material is
 * progressive disclosure rather than part of the default UI: it is genuinely useful when something is wrong
 * and it is noise the rest of the time, and a node id on a settings screen reads as something the user is
 * expected to understand.
 *
 * The section is honest about what it is. Nothing here is a control that changes behaviour; it is a report.
 */

export interface DeveloperSettingsProps {
  client: GatewayClient;
  facts: { nodeId: string; label: string; createdAt: string } | undefined;
}

export function DeveloperSettings({ client, facts }: DeveloperSettingsProps): ReactElement {
  const [settings, setSettings] = useState<{ key: string; value: string }[] | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void client
      .piSettings()
      .then((answer) => {
        if (!cancelled) setSettings(answer.settings);
      })
      .catch(() => {
        // Reported as none rather than as a failure, because the person in front of the panel cannot act on a
        // read error either way.
        if (!cancelled) setSettings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client]);

  return (
    <>
      <section className="cc-panel-section" data-developer-node="true">
        <h3>Node này</h3>
        <SettingsRow label="Mã node" description="Dùng khi ghép nối hoặc khi báo lỗi.">
          <code data-node-id="true">{facts?.nodeId ?? "(chưa đọc được)"}</code>
        </SettingsRow>
        <SettingsRow label="Tên node" description="Nhãn hiển thị của node này.">
          <code>{facts?.label ?? "(chưa đọc được)"}</code>
        </SettingsRow>
        <SettingsRow label="Tạo lúc">
          <code>{facts?.createdAt ?? "(chưa đọc được)"}</code>
        </SettingsRow>
      </section>

      <section className="cc-panel-section" data-pi-settings="true">
        <h3>Cấu hình pi trên máy này</h3>
        <p className="cc-panel-note">
          Chỉ đọc. Tên nào nghe như khoá bí mật thì node đã che sẵn, vì node là thứ duy nhất đọc được tệp gốc.
        </p>
        <div className="cc-panel-row">
          <button
            type="button"
            className="cc-chip"
            aria-expanded={open}
            data-pi-settings-toggle="true"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? "Ẩn" : "Đọc cấu hình"}
          </button>
        </div>
        {!open ? null : settings === undefined ? (
          <p className="cc-panel-note">Đang đọc…</p>
        ) : settings.length === 0 ? (
          <p className="cc-panel-note" data-pi-settings="none">
            Chưa đọc được cấu hình nào từ pi trên máy này.
          </p>
        ) : (
          // A key and a value per line. Anything whose name sounds like a secret arrives already redacted by the
          // node, because the node is the only thing that can see the file it came from.
          <div className="cc-panel-note">
            {settings.map((line) => (
              <code key={line.key} data-pi-setting={line.key}>
                {line.key}: {line.value}
              </code>
            ))}
          </div>
        )}
      </section>

      <section className="cc-panel-section" data-token-specimens="true">
        <h3>Màu và token</h3>
        <p className="cc-panel-note">
          Giá trị thật của token đang áp dụng. Dùng khi kiểm tra tương phản, không phải để chỉnh.
        </p>
        <SettingsRow label="Accent đang dùng" description="Đọc từ token, không phải một giá trị viết cứng.">
          <code>{readVar("--cc-accent") ?? "(không đọc được)"}</code>
        </SettingsRow>
        <TokenSpecimens />
      </section>
    </>
  );
}
