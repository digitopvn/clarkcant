import { useId, useRef, useState, type FormEvent, type ReactElement } from "react";

import type { CommandCard } from "@clarkcant/contracts";

import type { BlockActions, CommandActionState, FolderEntryReason } from "./blocks.tsx";
import type { MessageKey } from "./i18n/messages.ts";
import { AfterSignIn, ModelPicker } from "./model-picker.tsx";
import { SignInPanel } from "./provider-sign-in-panel.tsx";

/**
 * The widget a slash command answers with: a host-owned card in the conversation.
 *
 * Pure. What a press did, and a sign-in the card started, live in the page's block actions and are drawn beside the
 * row they belong to; the card itself is what was true when the command ran. Without handlers — a transcript, a search
 * result — it draws the record and no buttons, because a button that cannot act is a fake control.
 */

type CardRow = CommandCard["rows"][number];

const BADGE_TONE: Record<NonNullable<CardRow["badge"]>["tone"], string | undefined> = {
  neutral: undefined,
  active: "info",
  success: "ok",
  warning: "warn",
  danger: "danger",
};

export function CommandCardBlock({
  block,
  t,
  actions,
}: {
  block: CommandCard;
  t: (key: MessageKey) => string;
  actions?: BlockActions;
}): ReactElement | null {
  if (block.owner !== "host") return null;
  const live = actions?.onCommandAction !== undefined;
  // The picker is drawn from what the node holds now, so only a live card with the page's reads draws it.
  const picker = block.picker !== undefined && live && actions?.readModelChoices !== undefined;
  return (
    <section className="cc-card" data-owner="host" data-command={block.command} aria-label={block.title}>
      <header className="cc-card-head">
        <h3 className="cc-card-title">{block.title}</h3>
      </header>
      <div className="cc-card-body">
        {block.detail === undefined ? null : <p className="cc-list-subtitle">{block.detail}</p>}
        {picker ? (
          <ModelPicker t={t} pickerKey={`${block.cardId}/picker`} initialQuery={block.picker?.query ?? ""} port={actions} />
        ) : block.rows.length === 0 ? (
          <p className="cc-list-subtitle">{block.empty ?? t("commandCard.empty")}</p>
        ) : (
          <ul className="cc-list">
            {block.rows.map((row) => (
              <CommandRow key={row.rowId} cardId={block.cardId} row={row} live={live} t={t} actions={actions} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function CommandRow({
  cardId,
  row,
  live,
  t,
  actions,
}: {
  cardId: string;
  row: CardRow;
  live: boolean;
  t: (key: MessageKey) => string;
  actions: BlockActions | undefined;
}): ReactElement {
  const rowKey = `${cardId}/${row.rowId}`;
  const signIn = actions?.signIns?.[rowKey];
  const states = row.actions.map((entry) => actions?.commandAction?.[`${rowKey}/${entry.actionId}`]);
  const pending = states.some((state) => state?.status === "pending");
  const settled = states.find((state): state is Exclude<CommandActionState, { status: "pending" }> => state !== undefined && state.status !== "pending");
  const signingIn = signIn !== undefined && (signIn.state === "running" || signIn.state === "waiting");
  /** The row's buttons, so focus returns to the one that opened a folder path field once that field closes. */
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // A `/develop` row's badge is what was true when the card was drawn; once a press on the row has settled, the status
  // line beside it says what is true now (a session started, a folder forgotten), so the old badge is not shown with it.
  const superseded = settled?.status === "done" && row.actions.some((entry) => entry.action.kind === "develop-folder" || entry.action.kind === "develop-folder-forget");
  const badge = superseded ? undefined : row.badge;
  return (
    <li className="cc-list-item cc-command-row" data-row-id={row.rowId} data-current={row.current === true ? "true" : undefined}>
      <div className="cc-list-main">
        <div className="cc-list-text">
          <span className="cc-list-title">
            {row.label}
            {row.current === true ? <span className="cc-command-current"> · {t("commandCard.current")}</span> : null}
          </span>
          {row.note === undefined ? null : <span className="cc-list-subtitle">{row.note}</span>}
        </div>
        {badge === undefined ? null : (
          <span className="cc-badge" data-tone={BADGE_TONE[badge.tone]}>
            {badge.text}
          </span>
        )}
      </div>
      {live && row.actions.length > 0 ? (
        <div className="cc-command-actions">
          {row.actions.map((entry) => (
            <button
              key={entry.actionId}
              ref={(element) => {
                if (element === null) buttons.current.delete(entry.actionId);
                else buttons.current.set(entry.actionId, element);
              }}
              type="button"
              className="cc-action"
              data-emphasis={entry.tone === "primary" ? "primary" : undefined}
              data-tone={entry.tone === "danger" ? "danger" : undefined}
              disabled={pending || signingIn}
              onClick={() => actions?.onCommandAction?.({ cardId, rowId: row.rowId, actionId: entry.actionId, action: entry.action })}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
      {pending ? (
        <p className="cc-command-status" role="status">
          {t("commandCard.working")}
        </p>
      ) : settled === undefined ? null : (
        <p className="cc-command-status" role="status" data-result={settled.status}>
          {settled.message}
        </p>
      )}
      {signIn === undefined ? null : (
        <SignInPanel
          signIn={signIn}
          providerName={row.label}
          t={t}
          onAnswer={(value) => actions?.onSignInAnswer?.({ key: rowKey, signInId: signIn.signInId, value })}
          onCancel={() => actions?.onSignInCancel?.({ key: rowKey, signInId: signIn.signInId })}
          after={<AfterSignIn t={t} signInKey={rowKey} providerId={signIn.providerId} providerName={row.label} port={actions} />}
        />
      )}
      {live
        ? row.actions.map((entry) => {
            const key = `${rowKey}/${entry.actionId}`;
            const reason = actions?.folderEntries?.[key];
            return reason === undefined ? null : (
              <FolderEntry
                key={key}
                cardId={cardId}
                rowId={row.rowId}
                actionId={entry.actionId}
                reason={reason}
                t={t}
                actions={actions}
                onClosed={() => buttons.current.get(entry.actionId)?.focus()}
              />
            );
          })
        : null}
    </li>
  );
}

/**
 * A folder's path, typed: what a `/develop` row asks for where the OS folder dialog cannot answer — a browser, a node on
 * another machine, or a dialog that did not open — and says which. The path goes to the node as the person's own start.
 */
function FolderEntry({
  cardId,
  rowId,
  actionId,
  reason,
  t,
  actions,
  onClosed,
}: {
  cardId: string;
  rowId: string;
  actionId: string;
  reason: FolderEntryReason;
  t: (key: MessageKey) => string;
  actions: BlockActions | undefined;
  /** Called once the field closes, so focus goes back to the button that opened it rather than to the page. */
  onClosed: () => void;
}): ReactElement {
  const [value, setValue] = useState("");
  const hintId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const root = value.trim();
    if (root === "") return;
    actions?.onFolderEntrySubmit?.({ cardId, rowId, actionId, root });
    onClosed();
  };
  const cancel = () => {
    actions?.onFolderEntryCancel?.({ key: `${cardId}/${rowId}/${actionId}` });
    onClosed();
  };
  return (
    <form className="cc-card-stack" data-folder-entry={reason} onSubmit={submit}>
      <p className="cc-list-subtitle" id={hintId}>
        {t(`commandCard.develop.reason.${reason}`)}
      </p>
      <div className="cc-search-row">
        <input
          className="cc-field-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          // The person pressed the row's button to get here, so the field is where they are about to type.
          autoFocus
          aria-label={t("commandCard.develop.pathLabel")}
          aria-describedby={hintId}
          placeholder={t("commandCard.develop.pathPlaceholder")}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            cancel();
          }}
        />
        <button type="submit" className="cc-action" data-emphasis="primary" disabled={value.trim() === ""}>
          {t("commandCard.develop.submit")}
        </button>
        <button type="button" className="cc-action" onClick={cancel}>
          {t("commandCard.develop.cancel")}
        </button>
      </div>
    </form>
  );
}
