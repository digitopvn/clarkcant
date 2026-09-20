import { useEffect, useState, type ReactElement } from "react";

import { SearchSelect } from "../search-select.tsx";
import type { GatewayClient } from "../api.ts";
import { PERSONAL_INSTRUCTIONS_MAX_CHARS, type ModelPool } from "@clarkcant/contracts";
import { InlineStatus, SettingsRow, ToggleSwitch } from "./controls/primitives.tsx";
import type { PreferencesHandle } from "./controls/use-preferences.ts";

/**
 * AI & Routing: what answers, and what it costs to run.
 *
 * The model and the Jev key sit together because they answer one question — what this node runs — and the
 * credential is asked for in the tab that explains what it pays for. Personal instructions are here because
 * they are about how the model is briefed, which is the same subject.
 *
 * Routing preferences (`ai.backgroundRouting`, `ai.modelFavorites`) are declared in the registry but
 * deliberately have **no control here yet**: nothing reads them until the shared app-control registry and the
 * background-routing work land, and a control that changes nothing teaches the user that the settings screen
 * is decorative.
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

  const chosenProvider = providerDraft ?? facts?.model?.provider ?? catalogue?.[0]?.id ?? "";
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

      <PersonalInstructions prefs={prefs} />

      <ModelPoolSection client={client} />
    </>
  );
}

/**
 * The pool of models, as a table.
 *
 * A table rather than a list of cards because the fields are the point: a person comparing profiles compares
 * priority, roles and whether each one is on. Editing is limited to the two fields that decide what a hotkey does
 * — enabled and priority — because the identifiers belong to the provider and are checked against the node's
 * catalogue; a profile added here with a model the node cannot run would be refused by the node anyway, and saying
 * so afterwards is worse than not offering the field.
 */
function ModelPoolSection({ client }: { client: GatewayClient }): ReactElement {
  const [pool, setPool] = useState<ModelPool | undefined>(undefined);
  const [checked, setChecked] = useState<{ alias: string; ok: boolean; message?: string }[]>([]);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let live = true;
    client
      .modelPool()
      .then((answer) => {
        if (!live) return;
        setPool(answer.pool);
        setChecked(answer.checked);
        setCurrent(answer.currentAlias);
      })
      .catch(() => {
        if (live) setStatus("Không đọc được model pool của node này.");
      });
    return () => {
      live = false;
    };
  }, [client]);

  if (pool === undefined) {
    return (
      <section className="cc-panel-section" data-model-pool="none">
        <h3>Model pool</h3>
        <p className="cc-panel-note">{status === "" ? "Đang đọc…" : status}</p>
      </section>
    );
  }

  const edit = (alias: string, patch: { enabled?: boolean; priority?: number }): void => {
    setPool({
      profiles: pool.profiles.map((profile) => (profile.alias === alias ? { ...profile, ...patch } : profile)),
    });
  };

  return (
    <section className="cc-panel-section" data-model-pool="true">
      <h3>Model pool</h3>
      <p className="cc-panel-note">
        Hotkey ⌘] (Ctrl+] trên Windows) đi theo thứ tự ưu tiên này và áp dụng từ lượt kế tiếp, không đổi model của
        lượt đang chạy.
      </p>
      {pool.profiles.length === 0 ? (
        <p className="cc-panel-note" data-model-pool="none">
          Node này chưa có profile nào, nên hotkey ⌘] không có gì để chuyển. Nó vẫn chạy model đã cấu hình.
        </p>
      ) : (
        <table className="cc-model-pool" data-model-pool-table="true">
          <thead>
            <tr>
              <th>Alias</th>
              <th>Model</th>
              <th>Vai trò</th>
              <th>Ưu tiên</th>
              <th>Bật</th>
            </tr>
          </thead>
          <tbody>
            {pool.profiles.map((profile) => {
              const check = checked.find((entry) => entry.alias === profile.alias);
              return (
                <tr key={profile.alias} data-model-profile={profile.alias} data-current={current === profile.alias}>
                  <td>
                    {profile.alias}
                    {current === profile.alias && <span className="cc-badge">đang dùng</span>}
                  </td>
                  <td>
                    {profile.provider}/{profile.modelId}
                    {check !== undefined && !check.ok && (
                      <span className="cc-freshness" data-model-unavailable="true">
                        {check.message}
                      </span>
                    )}
                  </td>
                  <td>{profile.roles.join(", ")}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      value={profile.priority}
                      data-model-priority={profile.alias}
                      onChange={(event) => edit(profile.alias, { priority: Number(event.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={profile.enabled}
                      data-model-enabled={profile.alias}
                      onChange={(event) => edit(profile.alias, { enabled: event.target.checked })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="cc-panel-row">
        <button
          type="button"
          className="cc-chip"
          data-model-pool-save="true"
          onClick={() => {
            client
              .putModelPool(pool)
              .then((answer) => setPool(answer.pool))
              .then(() => setStatus("Đã lưu. Hotkey ⌘] đi theo thứ tự ưu tiên này."))
              .catch((cause: unknown) => setStatus(cause instanceof Error ? cause.message : "Không lưu được."));
          }}
        >
          Lưu model pool
        </button>
      </div>
      {status === "" ? null : <p className="cc-panel-note">{status}</p>}
    </section>
  );
}

/**
 * The user's own instructions, as a section inside the system prompt.
 *
 * Three things this control is careful about, and each is a way the feature could mislead:
 *
 *   - **It says where the text goes.** "Clark will also receive…" rather than "instructions", because a
 *     field labelled only that way invites somebody to think it replaces the product's behaviour. The note
 *     states the precedence: these refine style and defaults, they do not override the rules above them,
 *     and they cannot grant permission.
 *   - **It says when it applies.** From the next turn, which is what `applies: "next-turn"` in the registry
 *     declares, and which is neither "now" nor "after a restart".
 *   - **It reports the size.** The bound is the whole safety story of a text field that becomes prompt text,
 *     so the count is shown before somebody reaches it rather than as a refusal afterwards.
 *
 * The draft is local and only written on blur, so typing does not put a request on the wire per keystroke.
 */
function PersonalInstructions({ prefs }: { prefs: PreferencesHandle }): ReactElement {
  const stored = prefs.preference("ai.personalInstructions")?.value;
  const record = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const enabled = record.enabled === true;
  const text = typeof record.text === "string" ? record.text : "";

  /** Local while typing; committed on blur. A write per keystroke would be a request per keystroke. */
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const shown = draft ?? text;
  const overBound = shown.length > PERSONAL_INSTRUCTIONS_MAX_CHARS;

  const commit = (): void => {
    if (draft === undefined || draft === text) return;
    prefs.write("ai.personalInstructions", { enabled, text: draft });
    setDraft(undefined);
  };

  return (
    <section className="cc-panel-section" data-personal-instructions="true">
      <h3>Chỉ dẫn riêng của bạn</h3>
      <SettingsRow
        label="Bật chỉ dẫn riêng"
        description="Clark sẽ nhận phần này ở lượt kế tiếp, sau các quy tắc của sản phẩm và công cụ."
      >
        <ToggleSwitch
          name="personal-instructions"
          label="Bật chỉ dẫn riêng"
          checked={enabled}
          pending={prefs.pending === "ai.personalInstructions"}
          onChange={(next) => prefs.write("ai.personalInstructions", { enabled: next, text })}
        />
      </SettingsRow>

      <label className="cc-credential-field">
        <span>Nội dung</span>
        <textarea
          className="cc-personal-instructions"
          data-personal-instructions-input="true"
          rows={5}
          spellCheck={false}
          // Disabled rather than hidden while the toggle is off: the text is kept, and a field that
          // disappeared would make it look as though turning the toggle off had discarded it.
          disabled={!enabled}
          value={shown}
          placeholder="Ví dụ: trả lời ngắn gọn. Dùng TypeScript cho ví dụ code."
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
      </label>

      <p className="cc-panel-note" data-personal-instructions-count="true" data-over-bound={overBound}>
        {shown.length} / {PERSONAL_INSTRUCTIONS_MAX_CHARS} ký tự
      </p>

      <p className="cc-panel-note">
        Clark sẽ nhận thêm phần này, không thay thế chỉ dẫn sẵn có. Nó không đổi được quyền hay quy tắc an toàn.
      </p>

      <div className="cc-panel-row">
        <button
          type="button"
          className="cc-chip"
          data-personal-instructions-reset="true"
          onClick={() => {
            setDraft(undefined);
            // `reset` rather than `undo`: the label promises the default, and this preference may have been
            // edited more than once.
            prefs.reset("ai.personalInstructions");
          }}
        >
          Đặt lại
        </button>
      </div>

      <InlineStatus status={prefs.status} forKey="ai.personalInstructions" />
    </section>
  );
}
