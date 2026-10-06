import { useState, type ReactElement } from "react";

import type {
  DiagnosticLine,
  FeedbackCard,
  FeedbackKind,
  FeedbackPublication,
  FeedbackPublishIntent,
  FeedbackRequestInput,
} from "@clarkcant/contracts";

import type { BlockActions, FeedbackCardState } from "./blocks.tsx";
import type { MessageKey } from "./i18n/messages.ts";

/**
 * The host-owned Feedback Composer and its result, in the conversation (#510).
 *
 * `compose`: Bug or Feature, the person's words, whether safe diagnostics go with them and exactly which, a preview of
 * the issue as it would be filed, and Create issue. A report Clark or `/report bug …` already prepared arrives as a
 * compose card holding it: the exact issue, read-only, and Create issue — the only way that report is filed.
 * `result`: what the publish came to, written when it happened — the issue, what was shared, what was already filed,
 * how a feature fits the product, and whether Clark may offer to handle the issue. There is no Handle button: handling
 * is not available in this build, and the card says why. Check again only looks; Send again, offered once GitHub was
 * seen not to hold the report, is the one that sends.
 *
 * Without handlers — a transcript, a search result — and once a later result card answers it, a card draws the record
 * and no controls, because a button that cannot act, or has acted, is a fake control. The result is a pure function of
 * its props; the composer keeps only the text being typed, like a form card.
 */

type T = (key: MessageKey) => string;

function fill(text: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((acc, [key, value]) => acc.split(`{${key}}`).join(value), text);
}

function DiagnosticsList({ lines }: { lines: readonly DiagnosticLine[] }): ReactElement {
  return (
    <dl className="cc-feedback-diagnostics" data-feedback-diagnostics>
      {lines.map((line) => (
        <div key={line.label} className="cc-feedback-diagnostic">
          <dt>{line.label}</dt>
          <dd>{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FeedbackCardBlock({ block, t, actions }: { block: FeedbackCard; t: T; actions?: BlockActions }): ReactElement | null {
  if (block.owner !== "host") return null;
  const answered = actions?.answeredFeedbackCards?.includes(block.cardId) === true;
  const live = actions?.onFeedbackCreate !== undefined && !answered;
  if (block.stage === "result") return <FeedbackResult block={block} t={t} {...(actions === undefined || !live ? {} : { actions })} />;
  if (block.reportId !== undefined && block.preview !== undefined) {
    return <FeedbackPrepared block={block} t={t} {...(live && actions !== undefined ? { actions } : {})} />;
  }
  if (!live) return <FeedbackComposeRecord block={block} t={t} answered={answered} />;
  return <FeedbackComposer block={block} t={t} actions={actions} state={actions?.feedback?.[block.cardId]} />;
}

/** The composer as a record: what it offered, with nothing to press. */
function FeedbackComposeRecord({ block, t, answered }: { block: FeedbackCard; t: T; answered: boolean }): ReactElement {
  return (
    <section
      className="cc-card cc-feedback-card"
      data-owner="host"
      data-feedback-stage="compose"
      {...(answered ? { "data-feedback-answered": true } : {})}
      aria-label={t("feedback.title.compose")}
    >
      <header className="cc-card-head">
        <h3 className="cc-card-title">{t("feedback.title.compose")}</h3>
      </header>
      <div className="cc-card-body">
        {block.kind === undefined ? null : <p className="cc-list-subtitle">{t(block.kind === "bug" ? "feedback.kind.bug" : "feedback.kind.feature")}</p>}
        {block.description === undefined ? null : <p className="cc-list-title">{block.description}</p>}
        <p className="cc-list-subtitle">{fill(t("feedback.repository"), { repo: block.repository })}</p>
        {answered ? (
          <p className="cc-command-status" data-result="done">
            {t("feedback.created")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * A report already prepared — by Clark, voice or `/report bug …` — exactly as Create issue would file it. Read-only:
 * what is shown is what is sent, and the person's press is the only thing that sends it. Without `actions` (a
 * snapshot, or once a result answers it) it is the record of what was offered.
 */
function FeedbackPrepared({ block, t, actions }: { block: FeedbackCard; t: T; actions?: BlockActions }): ReactElement | null {
  const reportId = block.reportId;
  const preview = block.preview;
  if (reportId === undefined || preview === undefined) return null;
  const state = actions?.feedback?.[block.cardId];
  const busy = state?.status === "publishing";
  const done = state?.status === "done";
  return (
    <section
      className="cc-card cc-feedback-card"
      data-owner="host"
      data-feedback-stage="compose"
      data-feedback-prepared={reportId}
      aria-label={t("feedback.title.compose")}
    >
      <header className="cc-card-head">
        <h3 className="cc-card-title">{t("feedback.title.compose")}</h3>
        {block.kind === undefined ? null : (
          <span className="cc-badge">{t(block.kind === "bug" ? "feedback.kind.bug" : "feedback.kind.feature")}</span>
        )}
      </header>
      <div className="cc-card-body">
        <div className="cc-feedback-preview" data-feedback-preview>
          <p className="cc-list-title">{t("feedback.preview.heading")}</p>
          {preview.duplicateOf === undefined ? null : (
            <p className="cc-list-subtitle" data-feedback-duplicate={preview.duplicateOf.number}>
              {fill(t("feedback.preview.duplicate"), { number: String(preview.duplicateOf.number) })}
            </p>
          )}
          {preview.searchUnavailable === undefined ? null : (
            <p className="cc-list-subtitle">{fill(t("feedback.preview.searchUnavailable"), { reason: preview.searchUnavailable })}</p>
          )}
          {block.title === undefined ? null : <p className="cc-list-title">{block.title}</p>}
          <pre className="cc-feedback-body">{preview.body}</pre>
        </div>
        <PhilosophyFit block={block} t={t} />
        <RelatedIssues block={block} t={t} />
        <details className="cc-feedback-shared" data-feedback-shared>
          <summary>{t("feedback.shared.summary")}</summary>
          <p className="cc-list-subtitle">{t("feedback.shared.words")}</p>
          {block.diagnostics.length > 0 ? <DiagnosticsList lines={block.diagnostics} /> : <p className="cc-list-subtitle">{t("feedback.shared.none")}</p>}
          <p className="cc-list-subtitle">{t("feedback.shared.never")}</p>
          <p className="cc-list-subtitle">{fill(t("feedback.repository"), { repo: block.repository })}</p>
        </details>
        {actions === undefined ? null : (
          <div className="cc-form-foot">
            {busy ? (
              <p className="cc-command-status" role="status">
                {t("feedback.creating")}
              </p>
            ) : done ? (
              <p className="cc-command-status" role="status" data-result="done">
                {t("feedback.created")}
              </p>
            ) : state?.status === "failed" ? (
              <p className="cc-command-status" role="status" data-result="failed">
                {fill(t("feedback.failed"), { reason: state.message })}
              </p>
            ) : (
              <p className="cc-list-subtitle">{t("feedback.prepared.notSent")}</p>
            )}
            {done ? null : (
              <div className="cc-command-actions">
                <button
                  type="button"
                  className="cc-action"
                  data-emphasis="primary"
                  data-feedback-create
                  disabled={busy}
                  onClick={() => actions.onFeedbackCreate?.({ cardId: block.cardId, reportId, intent: "send" })}
                >
                  {t("feedback.create")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** How a feature fits the product, as the host wrote it in the person's language. */
function PhilosophyFit({ block, t }: { block: FeedbackCard; t: T }): ReactElement | null {
  if (block.philosophy === undefined) return null;
  return (
    <div className="cc-feedback-philosophy" data-feedback-philosophy={block.philosophy.verdict}>
      <p className="cc-list-subtitle">
        {t(
          block.philosophy.verdict === "aligned"
            ? "feedback.philosophy.aligned"
            : block.philosophy.verdict === "aligned-with-constraints"
              ? "feedback.philosophy.constraints"
              : "feedback.philosophy.conflict",
        )}
      </p>
      {block.philosophy.constraints.length === 0 ? null : (
        <ul className="cc-list">
          {block.philosophy.constraints.map((constraint) => (
            <li key={constraint.invariant} className="cc-list-subtitle">
              {constraint.invariant}: {constraint.note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What GitHub already holds that looks like this report, each with why it matched. */
function RelatedIssues({ block, t }: { block: FeedbackCard; t: T }): ReactElement | null {
  if (block.related === undefined || block.related.length === 0) return null;
  return (
    <details className="cc-feedback-related">
      <summary>{t("feedback.related")}</summary>
      <ul className="cc-list">
        {block.related.map((entry) => (
          <li key={entry.issue.number} className="cc-list-subtitle">
            <a href={entry.issue.url} target="_blank" rel="noopener noreferrer">
              #{entry.issue.number} {entry.issue.title}
            </a>{" "}
            ({entry.basis})
          </li>
        ))}
      </ul>
    </details>
  );
}

function FeedbackComposer({
  block,
  t,
  actions,
  state,
}: {
  block: FeedbackCard;
  t: T;
  actions: BlockActions | undefined;
  state: FeedbackCardState | undefined;
}): ReactElement {
  const [kind, setKind] = useState<FeedbackKind>(block.kind ?? "bug");
  const [description, setDescription] = useState(block.description ?? "");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const request: FeedbackRequestInput = { kind, description: description.trim(), source: "composer", includeDiagnostics };
  const busy = state?.status === "preparing" || state?.status === "publishing";
  const done = state?.status === "done";
  const empty = description.trim() === "";
  const preview = state?.status === "prepared" && state.requestKey === JSON.stringify(request) ? state : undefined;
  const idPrefix = `feedback-${block.cardId}`;
  return (
    <section className="cc-card cc-feedback-card" data-owner="host" data-feedback-stage="compose" aria-label={t("feedback.title.compose")}>
      <header className="cc-card-head">
        <h3 className="cc-card-title">{t("feedback.title.compose")}</h3>
      </header>
      <div className="cc-card-body cc-feedback-form">
        <fieldset className="cc-feedback-kind" disabled={busy || done}>
          <legend className="cc-list-subtitle">{t("feedback.kind.label")}</legend>
          {(["bug", "feature"] as const).map((option) => (
            <label key={option} className="cc-feedback-kind-option">
              <input
                type="radio"
                name={`${idPrefix}-kind`}
                value={option}
                checked={kind === option}
                data-feedback-kind={option}
                onChange={() => setKind(option)}
              />{" "}
              {t(option === "bug" ? "feedback.kind.bug" : "feedback.kind.feature")}
            </label>
          ))}
        </fieldset>
        <label className="cc-list-subtitle" htmlFor={`${idPrefix}-description`}>
          {t("feedback.description.label")}
        </label>
        <textarea
          id={`${idPrefix}-description`}
          className="cc-field-input cc-feedback-description"
          data-feedback-description
          rows={4}
          maxLength={4000}
          disabled={busy || done}
          placeholder={t(kind === "bug" ? "feedback.description.placeholderBug" : "feedback.description.placeholderFeature")}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <label className="cc-feedback-include">
          <input
            type="checkbox"
            checked={includeDiagnostics}
            disabled={busy || done}
            data-feedback-include-diagnostics
            onChange={(event) => setIncludeDiagnostics(event.target.checked)}
          />{" "}
          {t("feedback.includeDiagnostics")}
        </label>
        <details className="cc-feedback-shared" data-feedback-shared>
          <summary>{t("feedback.shared.summary")}</summary>
          <p className="cc-list-subtitle">{t("feedback.shared.words")}</p>
          {includeDiagnostics && block.diagnostics.length > 0 ? (
            <DiagnosticsList lines={block.diagnostics} />
          ) : (
            <p className="cc-list-subtitle">{t("feedback.shared.none")}</p>
          )}
          <p className="cc-list-subtitle">{t("feedback.shared.never")}</p>
          <p className="cc-list-subtitle">{fill(t("feedback.repository"), { repo: block.repository })}</p>
        </details>
        {preview === undefined ? null : (
          <div className="cc-feedback-preview" data-feedback-preview>
            <p className="cc-list-title">{t("feedback.preview.heading")}</p>
            {preview.draft.duplicateOf === undefined ? null : (
              <p className="cc-list-subtitle" data-feedback-duplicate={preview.draft.duplicateOf.number}>
                {fill(t("feedback.preview.duplicate"), { number: String(preview.draft.duplicateOf.number) })}
              </p>
            )}
            {preview.draft.relatedSearch.state === "unavailable" ? (
              <p className="cc-list-subtitle">{fill(t("feedback.preview.searchUnavailable"), { reason: preview.draft.relatedSearch.reason })}</p>
            ) : null}
            <p className="cc-list-title">{preview.draft.title}</p>
            <pre className="cc-feedback-body">{preview.draft.duplicateOf === undefined ? preview.draft.body : (preview.draft.occurrence ?? preview.draft.body)}</pre>
          </div>
        )}
        <div className="cc-form-foot">
          {state?.status === "preparing" || state?.status === "publishing" ? (
            <p className="cc-command-status" role="status">
              {t(state.status === "preparing" ? "feedback.preview.loading" : "feedback.creating")}
            </p>
          ) : state?.status === "done" ? (
            <p className="cc-command-status" role="status" data-result="done">
              {t("feedback.created")}
            </p>
          ) : state?.status === "failed" ? (
            <p className="cc-command-status" role="status" data-result="failed">
              {fill(t("feedback.failed"), { reason: state.message })}
            </p>
          ) : null}
          {done ? null : (
            <div className="cc-command-actions">
              <button
                type="button"
                className="cc-action"
                data-feedback-preview-button
                disabled={busy || empty}
                onClick={() => actions?.onFeedbackPreview?.({ cardId: block.cardId, request })}
              >
                {t("feedback.preview")}
              </button>
              <button
                type="button"
                className="cc-action"
                data-emphasis="primary"
                data-feedback-create
                disabled={busy || empty}
                onClick={() => actions?.onFeedbackCreate?.({ cardId: block.cardId, request })}
              >
                {t("feedback.create")}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const STATUS_KEY: Record<FeedbackPublication["status"], MessageKey> = {
  published: "feedback.status.created",
  unknown: "feedback.status.unknown",
  failed: "feedback.status.failed",
  "needs-access": "feedback.status.needsAccess",
  refused: "feedback.status.refused",
};

const STATUS_TONE: Record<FeedbackPublication["status"], string | undefined> = {
  published: "ok",
  unknown: "warn",
  failed: "danger",
  "needs-access": "warn",
  refused: "danger",
};

/**
 * The result of a publish, as written. Pure: what a later check found is a new card, never a change to this one.
 * Check again only looks for the report on GitHub; Send again — offered only once GitHub was seen not to hold it, or
 * refused it in a way sending again can help — is the press that sends. An outcome checking cannot settle offers no
 * Check again: it says so, links the person's own GitHub list and the manual page with a duplicate warning, and leaves
 * Send anyway to the person.
 */
export function FeedbackResult({ block, t, actions }: { block: FeedbackCard; t: T; actions?: BlockActions }): ReactElement | null {
  const publication = block.publication;
  if (publication === undefined || block.reportId === undefined) return null;
  const reportId = block.reportId;
  const live = actions?.onFeedbackCreate !== undefined;
  const state = actions?.feedback?.[block.cardId];
  const busy = state?.status === "publishing";
  const inconclusive = publication.status === "unknown" ? publication.inconclusive : undefined;
  const status =
    publication.status === "published" && publication.mode === "commented"
      ? "feedback.status.commented"
      : inconclusive === undefined
        ? STATUS_KEY[publication.status]
        : "feedback.status.inconclusive";
  const press = (label: MessageKey, marker: string, intent: FeedbackPublishIntent): ReactElement | null =>
    live ? (
      <button
        type="button"
        className="cc-action"
        {...{ [marker]: true }}
        disabled={busy}
        onClick={() => actions?.onFeedbackCreate?.({ cardId: block.cardId, reportId, intent })}
      >
        {t(label)}
      </button>
    ) : null;
  return (
    <section
      className="cc-card cc-feedback-card"
      data-owner="host"
      data-feedback-stage="result"
      data-feedback-status={publication.status}
      aria-label={t("feedback.title.result")}
    >
      <header className="cc-card-head">
        <h3 className="cc-card-title">{t("feedback.title.result")}</h3>
        <span className="cc-badge" data-tone={STATUS_TONE[publication.status]}>
          {t(status)}
        </span>
      </header>
      <div className="cc-card-body">
        {block.title === undefined ? null : <p className="cc-list-title">{block.title}</p>}
        {publication.status === "published" ? (
          <p className="cc-list-subtitle">
            <a href={publication.commentUrl ?? publication.issue.url} target="_blank" rel="noopener noreferrer" data-feedback-issue={publication.issue.number}>
              {publication.commentUrl === undefined ? t("feedback.open") : t("feedback.openComment")} #{publication.issue.number}
            </a>
          </p>
        ) : publication.status === "needs-access" ? (
          <>
            <p className="cc-list-subtitle">{publication.reason}</p>
            <p className="cc-list-subtitle">
              <a href={publication.manualUrl} target="_blank" rel="noopener noreferrer" data-feedback-manual>
                {t("feedback.openManual")}
              </a>
            </p>
          </>
        ) : inconclusive === undefined ? (
          <p className="cc-list-subtitle">{publication.reason}</p>
        ) : (
          <div data-feedback-inconclusive>
            <p className="cc-list-subtitle">{publication.reason}</p>
            <p className="cc-list-subtitle">
              <a href={inconclusive.searchUrl} target="_blank" rel="noopener noreferrer" data-feedback-search>
                {fill(t("feedback.inconclusive.search"), { date: inconclusive.since.slice(0, 10) })}
              </a>
            </p>
            <p className="cc-list-subtitle">
              <a href={inconclusive.manualUrl} target="_blank" rel="noopener noreferrer" data-feedback-manual>
                {t("feedback.openManual")}
              </a>
            </p>
            <p className="cc-list-subtitle" data-feedback-duplicate-warning>
              {t("feedback.inconclusive.warning")}
            </p>
          </div>
        )}
        {publication.status === "unknown" && inconclusive === undefined ? press("feedback.checkAgain", "data-feedback-check", "check") : null}
        {inconclusive === undefined ? null : press("feedback.sendAnyway", "data-feedback-send-anyway", "send-anyway")}
        {publication.status === "failed" && publication.retryable ? press("feedback.sendAgain", "data-feedback-send-again", "send") : null}
        {state?.status === "publishing" ? (
          <p className="cc-command-status" role="status">
            {t(state.intent === "check" ? "feedback.checking" : "feedback.creating")}
          </p>
        ) : state?.status === "failed" ? (
          <p className="cc-command-status" role="status" data-result="failed">
            {fill(t("feedback.failed"), { reason: state.message })}
          </p>
        ) : null}
        <PhilosophyFit block={block} t={t} />
        <RelatedIssues block={block} t={t} />
        {block.eligibility === undefined ? null : (
          <div className="cc-feedback-handling" data-feedback-eligibility={block.eligibility.eligible ? "eligible" : block.eligibility.code}>
            <p className="cc-list-title">{t("feedback.handling.heading")}</p>
            {block.eligibility.eligible ? (
              <p className="cc-list-subtitle">{block.eligibility.reason}</p>
            ) : (
              <>
                <p className="cc-list-subtitle">{fill(t("feedback.handling.notNow"), { reason: block.eligibility.reason })}</p>
                {block.eligibility.suggestion === "plan-split" ? <p className="cc-list-subtitle">{t("feedback.handling.planSplit")}</p> : null}
                {block.eligibility.blockers.length === 0 ? null : (
                  <p className="cc-list-subtitle">
                    {t("feedback.handling.blockers")}{" "}
                    {block.eligibility.blockers.map((blocker, index) => (
                      <span key={blocker.number}>
                        {index === 0 ? "" : ", "}
                        {blocker.url === undefined ? (
                          `#${String(blocker.number)}`
                        ) : (
                          <a href={blocker.url} target="_blank" rel="noopener noreferrer">
                            #{blocker.number}
                          </a>
                        )}
                      </span>
                    ))}
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {block.diagnostics.length === 0 ? null : (
          <details className="cc-feedback-shared">
            <summary>{t("feedback.diagnostics.shared")}</summary>
            <DiagnosticsList lines={block.diagnostics} />
          </details>
        )}
      </div>
    </section>
  );
}
