import { useEffect, useState, type ReactElement } from "react";

import { SearchSelect } from "../search-select.tsx";
import type { GatewayClient } from "../api.ts";
import { InlineStatus, SettingsRow } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";

/**
 * AI & Routing: what answers, and what it costs to run.
 *
 * The model and the Jev key sit together because they answer one question — what this node runs — and the
 * credential is asked for in the tab that explains what it pays for. Routing preferences (`ai.backgroundRouting`,
 * `ai.modelFavorites`) are declared in the registry but deliberately have **no control here yet**: nothing reads
 * them until the shared app-control registry and the background-routing work land, and a control that changes
 * nothing teaches the user that the settings screen is decorative.
 *
 * Personal instructions belong in this tab too, and arrive with the phase that makes them reach the model.
 */

const KEY_FIELDS = [
  {
    name: "typesafe",
    label: "TypeSafe API key (Jev)",
    purpose: "Dùng cho Jev khi nó phải quyết định cách xử lý một việc.",
  },
] as const;

interface NodeFacts {
  model: { provider: string; id: string; maxWallClockMs: number; maxTokens: number } | null;
}

export interface AiRoutingSettingsProps {
  client: GatewayClient;
  prefs: PreferencesHandle;
  facts: NodeFacts | undefined;
}

export function AiRoutingSettings({ client, prefs, facts }: AiRoutingSettingsProps): ReactElement {
  const [catalogue, setCatalogue] = useState<
    | { id: string; models: { provider: string; id: string; contextWindow?: number; current: boolean }[] }[]
    | undefined
  >(undefined);
  const [providerDraft, setProviderDraft] = useState<string | undefined>(undefined);
  const [modelDraft, setModelDraft] = useState<string | undefined>(undefined);
  const [modelStatus, setModelStatus] = useState<string | undefined>(undefined);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyStatus, setKeyStatus] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void client
      .model()
      .then((answer) => {
        if (!cancelled) setCatalogue(answer.catalogue);
      })
      .catch(() => {
        // An empty list rather than an error: the question this section answers is what can be chosen, and a
        // failure to read the list is not something the person in front of the panel can act on.
        if (!cancelled) setCatalogue([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const chosenProvider = providerDraft ?? facts?.model?.provider ?? "";
  const chosenModels = catalogue?.find((provider) => provider.id === chosenProvider)?.models ?? [];

  const saveModelChoice = (): void => {
    const provider = chosenProvider.trim();
    const id = (modelDraft ?? facts?.model?.id ?? "").trim();
    if (provider === "" || id === "") {
      setModelStatus("Chọn một provider và một model trước đã.");
      return;
    }
    if (catalogue !== undefined && catalogue.length > 0 && !chosenModels.some((model) => model.id === id)) {
      // Refused in front of the field it was typed into, rather than by the node after a round trip.
      setModelStatus(`${provider} không có model ${id}.`);
      return;
    }
    client
      .chooseModel({ provider, id })
      .then(() => setModelStatus(`Đã lưu ${provider}/${id}. Áp dụng cho hội thoại mới.`))
      .catch(() => setModelStatus("Không lưu được lựa chọn."));
  };

  return (
    <>
      <section className="cc-panel-section">
        <h3>Model đang dùng</h3>
        {facts === undefined ? (
          <p className="cc-panel-note">Đang đọc…</p>
        ) : facts.model === null ? (
          // A node with no model is a working node. Saying so is the point.
          <p className="cc-panel-note" data-model="none">
            Node này chưa cấu hình model. Nó trả lời bằng recipe và capability đã cài, và không gọi provider nào.
          </p>
        ) : (
          <>
            <SettingsRow label="Provider" description="Đặt bằng CC_MODEL_PROVIDER.">
              <code>{facts.model.provider}</code>
            </SettingsRow>
            <SettingsRow label="Model" description="Đặt bằng CC_MODEL_ID.">
              <code>{facts.model.id}</code>
            </SettingsRow>
            <SettingsRow label="Trần một lượt" description="Một lượt vượt trần sẽ bị dừng, không chạy tiếp.">
              <code>
                {facts.model.maxWallClockMs} ms · {facts.model.maxTokens} token
              </code>
            </SettingsRow>
          </>
        )}
      </section>

      <section className="cc-panel-section" data-providers="true">
        <h3>Chọn provider và model</h3>
        {catalogue === undefined ? (
          <p className="cc-panel-note">Đang đọc…</p>
        ) : catalogue.length === 0 ? (
          <p className="cc-panel-note" data-providers="none">
            Node chưa báo provider nào. Danh sách này đọc từ pi trên máy, nên nó rỗng khi pi chưa thấy provider nào —
            hoặc khi node không dựng được model turn.
          </p>
        ) : (
          <>
            <label className="cc-credential-field">
              <span>Provider</span>
              <SearchSelect
                name="provider"
                placeholder="Gõ để tìm provider"
                value={chosenProvider}
                options={catalogue.map((provider) => ({
                  value: provider.id,
                  label: provider.id,
                  note: `${provider.models.length} model`,
                }))}
                onChange={(next) => {
                  setProviderDraft(next);
                  // A different provider is a different catalogue, so a model chosen for the old one is not a
                  // choice any more - keeping it would offer a pair this node cannot run.
                  setModelDraft("");
                }}
                emptyNote="Không có provider nào khớp."
              />
            </label>

            <label className="cc-credential-field">
              <span>Model</span>
              <SearchSelect
                name="model"
                placeholder="Gõ để tìm model"
                value={modelDraft ?? facts?.model?.id ?? ""}
                options={chosenModels.map((model) => ({
                  value: model.id,
                  label: model.id,
                  ...(model.contextWindow === undefined
                    ? {}
                    : { note: `${Math.round(model.contextWindow / 1000)}K` }),
                }))}
                onChange={setModelDraft}
                emptyNote="Không có model nào khớp."
              />
            </label>

            <div className="cc-chip-row">
              <button type="button" className="cc-chip" data-model-save="true" onClick={saveModelChoice}>
                Lưu lựa chọn
              </button>
            </div>
          </>
        )}
        {modelStatus === undefined ? null : (
          <p className="cc-panel-note" data-model-status="true">
            {modelStatus}
          </p>
        )}
      </section>

      <section className="cc-panel-section" data-models-key="true">
        <h3>Khoá TypeSafe</h3>
        <p className="cc-panel-note">
          Jev dùng TypeSafe khi nó phải quyết định cách xử lý một việc. Ở đây cùng provider và model, vì cả ba đều là
          chuyện chọn cái gì để chạy.
        </p>
        {KEY_FIELDS.map((entry) => (
          <form
            key={entry.name}
            className="cc-credential-form"
            data-settings-key-form={entry.name}
            onSubmit={(event) => {
              event.preventDefault();
              const value = keyDraft.trim();
              if (value === "") return;
              client
                .putCredential({ fields: [{ name: entry.name, value }] })
                .then((result) => {
                  // Cleared the moment it is sent, so nothing later can read it off the screen or out of state.
                  setKeyDraft("");
                  setKeyStatus(
                    result.names.includes(entry.name)
                      ? "Đã lưu khoá."
                      : "Đã gửi, nhưng node không ghi nhận tên khoá nào.",
                  );
                })
                .catch(() =>
                  // The message says nothing about what was typed: an error that repeated the value would be the
                  // leak this field exists to avoid.
                  setKeyStatus("Không lưu được khoá. Thử lại."),
                );
            }}
          >
            <label className="cc-credential-field">
              <span>{entry.label}</span>
              <input
                type="password"
                name={entry.name}
                autoComplete="off"
                data-settings-key-field={entry.name}
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="cc-icon-btn"
              style={{ width: "auto", padding: "0 var(--cc-space-sm)" }}
              disabled={keyDraft.trim() === ""}
              data-settings-key-submit={entry.name}
            >
              Lưu khoá
            </button>
            <p className="cc-freshness">{entry.purpose}</p>
            {keyStatus === undefined ? null : (
              <p className="cc-freshness" data-settings-key-status={entry.name}>
                {keyStatus}
              </p>
            )}
            <button
              type="button"
              className="cc-chip"
              data-settings-key-remove={entry.name}
              onClick={() => {
                client
                  .deleteCredential(entry.name)
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
        ))}
        <InlineStatus status={prefs.status} forKey="ai.personalInstructions" />
      </section>
    </>
  );
}
