import { useState, type ReactElement } from "react";

import { DevicePairingPanel } from "../DevicePairingPanel.tsx";
import { MicrophoneCheck } from "../microphone-check.tsx";
import type { GatewayClient } from "../api.ts";
import { InlineStatus, SettingsRow } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";

/**
 * Devices & Voice: how Clark hears and speaks.
 *
 * The voice provider, the voice itself, the microphone and the wake phrase are one tab because they are one
 * decision chain: a session needs a provider, a provider offers voices, and the microphone is what feeds it.
 * Splitting them across tabs would mean configuring voice in three places.
 *
 * What is **not** here yet, deliberately: the voice picker and its preview. They arrive with the phase that
 * gives the provider a capabilities contract, because a picker that cannot list the provider's own voices
 * would be a hard-coded list of Gemini names in a React component — which is exactly the thing the plan says
 * not to build. `voice.provider` and `voice.voiceName` are therefore declared in the registry with no control
 * that writes them.
 *
 * The wake phrase has no control either, and its reason is different: there is no local detector yet, so the
 * honest state is a row that says so rather than a toggle that cannot turn anything on.
 */

export interface DevicesVoiceSettingsProps {
  client: GatewayClient;
  prefs: PreferencesHandle;
  facts: { nodeId: string; label: string } | undefined;
}

export function DevicesVoiceSettings({ client, prefs, facts }: DevicesVoiceSettingsProps): ReactElement {
  const [keyDraft, setKeyDraft] = useState("");
  const [keyStatus, setKeyStatus] = useState<string | undefined>(undefined);

  return (
    <>
      <section className="cc-panel-section">
        <h3>Thiết bị</h3>
        <DevicePairingPanel
          nodeId={facts?.nodeId ?? "(chưa đọc được)"}
          nodeLabel={facts?.label ?? "(chưa đọc được)"}
          unblockedBy="chạy node thứ hai trên máy khác rồi ghép nối"
        />
      </section>

      <section className="cc-panel-section" data-voice-settings="true">
        <h3>Giọng nói</h3>
        {/*
          The state of voice configuration, told as it is rather than as a picker that does not exist yet. A
          disabled control with a reason is honest; a control that looks usable and changes nothing is not.
        */}
        <SettingsRow
          label="Chọn giọng"
          description="Chưa có: danh sách giọng phải do provider tự khai báo, và hợp đồng đó chưa có."
          state="absent"
        >
          <span className="cc-badge" data-tone="warn">
            chưa có
          </span>
        </SettingsRow>
        <SettingsRow
          label="“Hey Clark”"
          description="Chưa có bộ nhận diện chạy cục bộ trên máy này. Không dùng cách nghe liên tục qua mạng thay thế."
          state="absent"
        >
          <span className="cc-badge" data-tone="warn">
            chưa có
          </span>
        </SettingsRow>
        <InlineStatus status={prefs.status} forKey="voice.provider" />

        {/*
          The key the live voice provider needs.

          It lives beside the microphone because that is what it is for: a session that cannot start without it.
          The name it is stored under is the node's own, and it cannot be imported here because the runtime is
          not something the browser ships.
        */}
        <form
          className="cc-credential-form"
          data-settings-key-form="gemini"
          onSubmit={(event) => {
            event.preventDefault();
            const value = keyDraft.trim();
            if (value === "") return;
            client
              .putCredential({ fields: [{ name: "gemini", value }] })
              .then((result) => {
                // Cleared the moment it is sent, so nothing later can read it off the screen or out of state.
                setKeyDraft("");
                setKeyStatus(
                  result.names.includes("gemini")
                    ? "Đã lưu khoá."
                    : "Đã gửi, nhưng node không ghi nhận tên khoá nào.",
                );
              })
              .catch(() =>
                // The message says nothing about what was typed: an error that repeated the value would be the leak
                // this field exists to avoid.
                setKeyStatus("Không lưu được khoá. Thử lại."),
              );
          }}
        >
          <label className="cc-credential-field">
            <span>Gemini API key</span>
            <input
              type="password"
              name="gemini"
              autoComplete="off"
              data-settings-key-field="gemini"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="cc-icon-btn"
            style={{ width: "auto", padding: "0 var(--cc-space-sm)" }}
            disabled={keyDraft.trim() === ""}
            data-settings-key-submit="gemini"
          >
            Lưu khoá
          </button>
          <p className="cc-freshness">Dùng cho Gemini Live khi bạn nói. Lần mở voice kế tiếp sẽ dùng khoá này.</p>
          {keyStatus === undefined ? null : (
            <p className="cc-freshness" data-settings-key-status="gemini">
              {keyStatus}
            </p>
          )}
          <button
            type="button"
            className="cc-chip"
            data-settings-key-remove="gemini"
            onClick={() => {
              client
                .deleteCredential("gemini")
                .then(() => setKeyStatus("Đã đăng xuất: node không còn giữ khoá này."))
                .catch(() =>
                  // A refusal here usually means there was nothing to remove, which is a different answer from a
                  // failure and is said as one rather than dressed up as an error.
                  setKeyStatus("Không xoá được — có thể node chưa giữ khoá này."),
                );
            }}
          >
            Đăng xuất
          </button>
        </form>

        <MicrophoneCheck />
      </section>
    </>
  );
}
