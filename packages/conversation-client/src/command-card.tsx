import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from "react";

import { COMMAND_BADGE_PHASE, type CommandCard, type SurfacePhase, type SurfaceStatus, canRetry, settleSurfaceStatus } from "@clarkcant/contracts";

import type { BlockActions, CommandActionState, FolderEntryReason } from "./blocks.tsx";
import type { MessageKey } from "./i18n/messages.ts";
import { AfterSignIn, ModelPicker } from "./model-picker.tsx";
import { SignInPanel } from "./provider-sign-in-panel.tsx";
import { LiveNote, PhaseBadge, phaseOf } from "./surface-status.tsx";

/**
 * The widget a slash command answers with: a host-owned card in the conversation.
 *
 * Pure. What a press did, and a sign-in the card started, live in the page's block actions and are drawn beside the
 * row they belong to; the card itself is what was true when the command ran. Without handlers — a transcript, a search
 * result — it draws the record and no buttons, because a button that cannot act is a fake control.
 */

type CardRow = CommandCard["rows"][number];

/** What a press came to, read through the shared status contract: a reply nobody can read is not a success. */
export const COMMAND_ACTION_PHASE: Record<CommandActionState["status"], SurfacePhase> = {
  pending: "pending",
  done: "success",
  failed: "error",
  unknown: "partial",
};

function asSurfaceStatus(state: CommandActionState): SurfaceStatus {
  return { phase: COMMAND_ACTION_PHASE[state.status], attempt: state.attempt ?? 0, freshness: { kind: "snapshot" } };
}

/**
 * The state a press's key holds after `incoming` arrives, by the contract's rule for late answers: an answer for an
 * earlier press is dropped, and the first outcome of a press is final — a late "working" never reopens it.
 */
export function settleCommandAction(current: CommandActionState | undefined, incoming: CommandActionState): CommandActionState {
  if (current === undefined) return incoming;
  const shownStatus = asSurfaceStatus(current);
  return settleSurfaceStatus(shownStatus, asSurfaceStatus(incoming)) === shownStatus ? current : incoming;
}

/** Which of a row's buttons holds the latest press, or -1 when none was pressed. */
function latestCommandIndex(states: readonly (CommandActionState | undefined)[]): number {
  let latest = -1;
  states.forEach((state, index) => {
    if (state === undefined) return;
    const shown = latest === -1 ? undefined : states[latest];
    if (shown === undefined || (state.attempt ?? 0) > (shown.attempt ?? 0)) latest = index;
  });
  return latest;
}

/** The press a row speaks for: the latest among its buttons, so an older press on a sibling button never shows over it. */
export function latestCommandAction(states: readonly (CommandActionState | undefined)[]): CommandActionState | undefined {
  const index = latestCommandIndex(states);
  return index === -1 ? undefined : states[index];
}

/**
 * Whether a settled press offers Try again, by the shared status's rule (`canRetry`): only a failure whose press did not
 * get through and is safe to send again says `next: "retry"`. A refusal the node decided, and a reply this app cannot
 * read, offer nothing to repeat.
 */
export function commandActionRetryable(state: CommandActionState | undefined): boolean {
  if (state === undefined) return false;
  return canRetry({ phase: COMMAND_ACTION_PHASE[state.status], ...(state.status === "failed" && state.next !== undefined ? { next: state.next } : {}) });
}

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
  /*
   * `pending` covers the whole row (any button still waiting), while the outcome shown is the latest press. The two agree
   * only because a busy row is `aria-disabled` and refuses every press until it settles, so no sibling press can start
   * behind a pending one. If that guard ever changes, compute `pending` from the latest press too, or an older sibling's
   * failure would hide behind a newer success.
   */
  const pending = states.some((state) => state?.status === "pending");
  const latestIndex = latestCommandIndex(states);
  const latest = latestIndex === -1 ? undefined : states[latestIndex];
  const settled = latest === undefined || latest.status === "pending" ? undefined : latest;
  // Try again repeats the press the row shows, through the same path its button takes.
  const retryEntry = commandActionRetryable(settled) ? row.actions[latestIndex] : undefined;
  const signingIn = signIn !== undefined && (signIn.state === "running" || signIn.state === "waiting");
  const busy = pending || signingIn;
  /** The row's buttons, so focus returns to the one that opened a folder path field once that field closes. */
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // A `/login` row drawn again shows the sign-in the node still runs for its provider, rather than nothing.
  const signInProvider = row.actions.find((entry) => entry.action.kind === "provider-sign-in")?.action;
  const providerId = signInProvider?.kind === "provider-sign-in" ? signInProvider.providerId : undefined;
  const reattach = live ? actions?.onSignInReattach : undefined;
  useEffect(() => {
    if (providerId !== undefined) reattach?.({ key: rowKey, providerId });
  }, [reattach, rowKey, providerId]);
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
        {badge === undefined ? null : <PhaseBadge phase={phaseOf(COMMAND_BADGE_PHASE, badge.tone)}>{badge.text}</PhaseBadge>}
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
              // aria-disabled, not disabled: a disabled button drops the focus that pressed it to the page.
              aria-disabled={busy ? "true" : undefined}
              onClick={() => {
                if (busy) return;
                actions?.onCommandAction?.({ cardId, rowId: row.rowId, actionId: entry.actionId, action: entry.action });
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
      {/*
        What a press came to, in live regions that exist before the answer arrives: a failure interrupts, anything else
        waits its turn, and a row drawn again with an outcome already there (a reload, a scroll back) says nothing.
      */}
      {live && row.actions.length > 0 ? (
        <div className="cc-command-outcome">
          <LiveNote
            phase={pending ? "pending" : settled === undefined ? undefined : COMMAND_ACTION_PHASE[settled.status]}
            className="cc-command-status"
            data-result={pending ? undefined : settled?.status}
          >
            {pending ? t("commandCard.working") : settled?.message}
          </LiveNote>
          {retryEntry === undefined ? null : (
            <button
              type="button"
              className="cc-chip"
              data-command-retry={retryEntry.actionId}
              aria-disabled={busy ? "true" : undefined}
              onClick={() => {
                if (busy) return;
                // The press's own button keeps the focus while the press runs again; this one goes away with the failure.
                buttons.current.get(retryEntry.actionId)?.focus();
                const root = settled?.status === "failed" ? settled.root : undefined;
                if (retryEntry.action.kind === "develop-folder" && root !== undefined) {
                  actions?.onFolderEntrySubmit?.({ cardId, rowId: row.rowId, actionId: retryEntry.actionId, root });
                  return;
                }
                actions?.onCommandAction?.({ cardId, rowId: row.rowId, actionId: retryEntry.actionId, action: retryEntry.action });
              }}
            >
              {t("surface.retry")}
            </button>
          )}
        </div>
      ) : null}
      {signIn === undefined ? null : (
        <SignInPanel
          signIn={signIn}
          providerName={row.label}
          t={t}
          onAnswer={(value) => actions?.onSignInAnswer?.({ key: rowKey, signInId: signIn.signInId, value })}
          onCancel={() => actions?.onSignInCancel?.({ key: rowKey, signInId: signIn.signInId })}
          after={
            <AfterSignIn
              key={signIn.signInId}
              t={t}
              signInKey={rowKey}
              signInId={signIn.signInId}
              providerId={signIn.providerId}
              providerName={row.label}
              port={actions}
            />
          }
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
