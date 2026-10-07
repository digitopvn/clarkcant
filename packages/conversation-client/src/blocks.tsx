import { useEffect, useState, type ReactElement } from "react";

import {
  attachmentRefSchema,
  changelogCardSchema,
  commandCardSchema,
  modelNoteSchema,
  referenceBlockSchema,
  referenceToken,
  type AttachmentRef,
  type CommandCardAction,
  type ProviderSignInView,
} from "@clarkcant/contracts";

import { CodeBlock, Markdown, linkedText } from "./markdown.tsx";
import { formatFileSize } from "./attachments.ts";
import { attachmentDownloadState, pressAttachmentDownload, settleAttachmentDownload } from "./attachment-open.ts";
import { downloadObjectUrl } from "./download.ts";
import { useAttachmentUrls } from "./use-attachment-urls.ts";
import { type ObjectUrls, useObjectUrls } from "./use-object-urls.ts";
import type { GatewayClient } from "./api.ts";
import { useT } from "./i18n/locale-context.tsx";
import { useSurfaceViewState } from "./surface-view-state.tsx";
import { TerminalCardBlock } from "./terminal-card.tsx";
import { CommandCardBlock } from "./command-card.tsx";
import { ChangelogCardBlock } from "./changelog-card.tsx";
import { PackageReach, readReach } from "./package-reach.tsx";
import { askedByKey } from "./turn-origin-words.ts";
import { effectCategoryLabels } from "./inbox/inbox-model.ts";
import { UnreadListingFieldsNote, readUnreadFields } from "./unread-listing-fields.tsx";
import { MESSAGES_EN, MESSAGES_VI, type MessageKey } from "./i18n/messages.ts";

/**
 * The Vietnamese catalog lookup, used as the default for cards that accept `t` as a prop rather than
 * calling `useT()` directly.
 *
 * Those cards' own unit tests call the exported function directly rather than through React's render
 * pass (see `test/block-helpers.ts`), and calling a hook outside of render throws. Accepting `t` as an
 * optional prop keeps the component callable as a plain function while still letting the real render
 * path (`renderBlock`, itself called from a component that owns a `useT()`) supply the live locale.
 */
const defaultT = (key: MessageKey): string => MESSAGES_VI[key];

/**
 * Block renderers.
 *
 * A host-owned card is drawn with host chrome and `data-owner="host"`.
 *
 * What the renderer does NOT do is prove that provenance. `SystemCardBlock` and its siblings
 * return null unless `block.owner === "host"`, but `owner` is a field the block carries, so a
 * forger that sets it satisfies both the schema's `z.literal("host")` and that check. This
 * comment used to claim the renderer "refuses to draw one that did not come from the host", and
 * that was not true.
 *
 * The real boundary is where blocks enter: the node constructs a host-owned card itself and never
 * from model, widget or pack output, and `prepareBlocksForRender` screens blocks arriving from a
 * non-host origin before they are drawn. This guard stays as a cheap second screen against a
 * careless forgery — it is not a proof, and it should not be read as one.
 */

function textOf(block: Record<string, unknown>): string {
  const content = block.content;
  return typeof content === "string" ? content : "";
}

export function TextBlock({ block }: { block: Record<string, unknown> }): ReactElement {
  const content = textOf(block);
  const streaming = block.streaming === true;
  // Markdown for anything the node marked as such, plain text otherwise. A block written before this
  // existed is plain, and rendering it as markdown would silently reformat history.
  if (block.format === "markdown") {
    return (
      <div className="cc-text" data-streaming={streaming} data-format="markdown">
        <Markdown text={content} />
      </div>
    );
  }
  return (
    <p className="cc-text" data-streaming={streaming} style={{ margin: 0, whiteSpace: "pre-wrap" }}>
      {linkedText(content)}
    </p>
  );
}

/**
 * A tool call, drawn as a widget that opens and closes.
 *
 * Compact while it runs and once it is done: the spinning mark and the label already say what is happening, and the
 * arguments are machinery the person opens only if they want it. A failure opens, because the one thing nobody wants
 * collapsed is the reason something did not work.
 *
 * The state is a `details` element with React driving its open attribute, rather than a div with a click
 * handler: a disclosure built from the platform is keyboard operable, announced as one, and reachable
 * by a screen reader without anything extra to remember.
 */
export function ToolActivityBlock({ block }: { block: Record<string, unknown> }): ReactElement {
  const t = useT();
  const status = typeof block.status === "string" ? block.status : "done";
  const name = typeof block.name === "string" ? block.name : "tool";
  const label = typeof block.label === "string" && block.label !== "" ? block.label : name;
  // The path beside the label is for a call whose label does not say where; one that already names the folder in
  // its own words would otherwise show it twice on the same line.
  const path = typeof block.path === "string" && block.path !== "" && !label.includes(block.path) ? block.path : undefined;
  const result = typeof block.result === "string" ? block.result : "";
  const args = typeof block.args === "object" && block.args !== null ? (block.args as Record<string, unknown>) : {};
  const language = typeof block.language === "string" ? block.language : undefined;
  // The node's record of what became of a question (expired, cancelled, asked again) rather than a call that ran.
  // The question card above already says it in words, so this is a quiet note: never a failure, never opened onto
  // its JSON, and still there to open for anyone who wants the record.
  const questionRecord = name === "ask_user_question" && typeof args.decision === "string" && args.decision !== "answered";
  const mark = questionRecord ? "noted" : status;
  const [open, setOpen] = useSurfaceViewState("tool.open", !questionRecord && status === "failed");

  // A call that fails opens itself — keyed on the status so it happens once, and so a widget the user closed by hand
  // is not opened again underneath them.
  useEffect(() => {
    if (status === "failed" && !questionRecord) setOpen(true);
  }, [status, questionRecord]);

  return (
    <details
      className="cc-tool"
      data-tool-name={name}
      data-tool-status={status}
      data-tool-record={questionRecord ? "question" : undefined}
      data-tool-call={typeof block.toolCallId === "string" ? block.toolCallId : undefined}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cc-tool-head">
        <span className="cc-tool-mark" data-status={mark} aria-hidden="true">
          {mark === "noted" ? "·" : mark === "running" ? "◐" : mark === "failed" ? "✕" : "✓"}
        </span>
        <span className="cc-tool-label">{label}</span>
        {path !== undefined && (
          <code className="cc-tool-path" title={path}>
            {path}
          </code>
        )}
        <span className="cc-sr-only">
          {questionRecord
            ? ""
            : status === "running"
            ? t("blocks.tool.status.running")
            : status === "failed"
              ? t("blocks.tool.status.failed")
              : t("blocks.tool.status.done")}
        </span>
      </summary>
      <div className="cc-tool-body">
        {Object.keys(args).length > 0 && (
          <CodeBlock code={JSON.stringify(args, null, 2)} language="json" label={t("blocks.tool.args.label")} />
        )}
        {result !== "" && (
          <CodeBlock code={result} {...(language === undefined ? {} : { language })} label={t("blocks.tool.result.label")} />
        )}
      </div>
    </details>
  );
}

/**
 * The model's own reasoning, collapsed.
 *
 * Collapsed by default and in its own widget, because it is not the reply: someone who wants to know how
 * the answer was reached can open it, and someone who does not is never shown text the model did not
 * address to them.
 *
 * `writing` is set while this is the most recent thing the turn produced, which is what "still arriving"
 * means for a segment: it stops being the most recent one when text or a tool call follows, and the turn
 * ending removes the live view entirely. The mark therefore has to sit in the head — the block is
 * collapsed, so a marker in the body would be behind a click — and the words carry the state on their own,
 * because a person who cannot see the spin still has to be able to tell a finished block from a running
 * one. A stored block never sets it: history is not still being written.
 */
export function ReasoningBlock({
  block,
  writing = false,
}: {
  block: Record<string, unknown>;
  writing?: boolean;
}): ReactElement {
  const t = useT();
  const content = typeof block.content === "string" ? block.content : "";
  const [open, setOpen] = useSurfaceViewState("reasoning.open", false);

  return (
    <details
      className="cc-tool cc-reasoning"
      data-reasoning="true"
      data-writing={writing ? "true" : undefined}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cc-tool-head">
        <span className="cc-tool-mark" data-status={writing ? "running" : "done"} aria-hidden="true">
          ✳
        </span>
        <span className="cc-tool-label">{t("blocks.reasoning.label")}</span>
        {writing && <span className="cc-reasoning-writing">{t("blocks.reasoning.writing")}</span>}
      </summary>
      <div className="cc-tool-body cc-reasoning-body">
        <Markdown text={content} />
      </div>
    </details>
  );
}

/**
 * What the host checked about the step above it.
 *
 * A footnote to that step rather than a row of its own: the verdict is a word in the reader's language with a glyph
 * that repeats it (so it survives without colour), and only a verdict that is not good keeps a colour strong enough to
 * be noticed.
 */
export function EvidenceBlock({ block }: { block: Record<string, unknown> }): ReactElement {
  const t = useT();
  const raw = typeof block.verdict === "string" ? block.verdict : "not-verified";
  const verdict = raw === "verified" || raw === "contradicted" ? raw : "not-verified";
  const summary = typeof block.summary === "string" ? block.summary : "";
  const kind = typeof block.kind === "string" ? block.kind : "evidence";
  return (
    <div className="cc-evidence" data-verdict={verdict} data-evidence-kind={kind}>
      <span className="cc-evidence-verdict">
        <span aria-hidden="true">{verdict === "verified" ? "✓" : verdict === "contradicted" ? "✕" : "!"}</span>{" "}
        {t(`blocks.evidence.${verdict}`)}
      </span>
      <span className="cc-evidence-summary">{summary}</span>
    </div>
  );
}

export function ArtifactBlock({
  block,
  actions,
  t = defaultT,
  locale = "vi",
}: {
  block: Record<string, unknown>;
  actions?: BlockActions;
  t?: (key: MessageKey) => string;
  /** The interface language, for when the file was made and when it expires; Vietnamese by default, like `t`. */
  locale?: string;
}): ReactElement {
  const labelValue = typeof block.label === "string" ? block.label : "artifact";
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream";
  const sizeBytes = typeof block.sizeBytes === "number" ? block.sizeBytes : 0;
  const originNodeId = typeof block.originNodeId === "string" ? block.originNodeId : undefined;
  const artifactId = typeof block.artifactId === "string" ? block.artifactId : "";
  const state = artifactId === "" ? undefined : actions?.artifactOpen?.[artifactId];

  return (
    <div className="cc-card" data-artifact="true" data-artifact-id={artifactId}>
      <div className="cc-card-head">
        <span className="cc-card-title">{labelValue}</span>
        <span>
          {/* A node id is an internal name; the fallback phrase says the same useful thing without exposing one. */}
          {mimeType} · {formatFileSize(sizeBytes)}
          {originNodeId === undefined ? "" : t("blocks.artifact.fromAnotherNode")}
        </span>
      </div>
      <div className="cc-card-body">
        {/*
          The snapshot is what the message recorded. What the node holds now is a separate question, and only the
          node can answer it — an artifact can expire between the message being written and somebody reading it.
        */}
        {artifactId !== "" && actions?.onArtifactOpen !== undefined ? (
          <div className="cc-card-actions">
            <button
              type="button"
              className="cc-action"
              data-artifact-open={artifactId}
              /*
               * Disabled only while a request is in flight. Unlike stopping a task, reopening is a question rather
               * than a state change: the answer can have changed since it was asked — an artifact that had expired
               * may have been produced again — so asking a second time has to stay possible.
               */
              disabled={state?.status === "pending"}
              onClick={() => actions.onArtifactOpen?.({ artifactId })}
            >
              {state?.status === "pending" ? t("blocks.artifact.opening") : t("blocks.artifact.reopen")}
            </button>
          </div>
        ) : null}
        {state === undefined || state.status === "pending" ? null : state.status === "failed" ? (
          <p className="cc-freshness" data-artifact-error="true">
            {state.message}
          </p>
        ) : (
          <div className="cc-card-stack" data-artifact-opened="true" data-artifact-expired={String(state.expired)}>
            {/*
              An expired artifact is reported as a distinct outcome rather than as a failure: the node had the
              file and a retention window passed, which calls for asking for it again rather than for looking for
              a fault.
            */}
            {state.expired ? (
              <p className="cc-freshness" data-artifact-expiry="true">
                {t("blocks.artifact.expiredNotice").replace(
                  "{since}",
                  state.expiresAt === null
                    ? ""
                    : t("blocks.artifact.expiredSince").replace("{at}", readableInstant(state.expiresAt, locale)),
                )}
              </p>
            ) : null}
            <dl className="cc-fields">
              <dt>{t("blocks.artifact.size")}</dt>
              <dd>{formatFileSize(state.sizeBytes)}</dd>
              <dt>{t("blocks.artifact.type")}</dt>
              <dd>{state.mimeType}</dd>
              <dt>{t("blocks.artifact.createdAt")}</dt>
              <dd>{readableInstant(state.createdAt, locale)}</dd>
              <dt>{t("blocks.artifact.expiresAt")}</dt>
              <dd>{state.expiresAt === null ? t("blocks.artifact.none") : readableInstant(state.expiresAt, locale)}</dd>
            </dl>
            {/* What identifies the file to a machine — its digest and the node that holds it — is there when asked for. */}
            <details className="cc-text-alt" data-artifact-references="true">
              <summary>{t("inbox.capability.details")}</summary>
              <dl className="cc-fields">
                <dt>{t("blocks.artifact.digest")}</dt>
                <dd>
                  <code>{state.digest}</code>
                </dd>
                <dt>{t("blocks.artifact.source")}</dt>
                <dd>{state.originNodeId}</dd>
              </dl>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
const CARD_TONE: Record<string, string> = {
  "needs-decision": "warn",
  blocked: "danger",
  failed: "danger",
  ready: "ok",
  done: "ok",
  working: "",
  downloading: "",
  verifying: "",
  "needs-sign-in": "warn",
};

/**
 * A turn's duration as a person reads a wait.
 *
 * The node records "17681 ms", which is exact and hard to read at a glance. Past one second it reads as seconds in the
 * interface's number format ("17,7 giây"); anything else, including a value the node may word differently later, is
 * shown as it came.
 */
export function readableElapsed(value: string, locale: string, secondsUnit: string): string {
  const match = /^(\d+) ms$/u.exec(value);
  if (match === null) return value;
  return readableDuration(Number(match[1]), locale, secondsUnit);
}

/** A duration in milliseconds as a person reads a wait: "850 ms" under a second, seconds in the locale's format past it. */
export function readableDuration(ms: number, locale: string, secondsUnit: string): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(ms / 1000)} ${secondsUnit}`;
}

/**
 * A moment the node recorded, as the reader would say it: the time alone when it is today, the day and time otherwise,
 * in the reader's own timezone. The node stores ISO instants in UTC, which are exact and read as a code. Anything that
 * is not a moment is shown as it came.
 */
export function readableInstant(value: string, locale: string, now: Date = new Date()): string {
  const at = new Date(value);
  if (value === "" || Number.isNaN(at.getTime())) return value;
  const today = now.toDateString() === at.toDateString();
  return new Intl.DateTimeFormat(locale, today ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" }).format(at);
}

/**
 * The typed facts of a model note (`modelNote` on a connection card), read through the contract's own schema: how long
 * the answer took and, when a fallback answered, which model was chosen. Anything the schema does not accept — a record
 * written before the field existed, a version this client does not know, a malformed note — reads as absent, and the
 * card falls back on its readable rows.
 */
export function readModelNote(value: unknown): { elapsedMs: number; fallbackFrom?: string } | undefined {
  const note = modelNoteSchema.safeParse(value);
  if (!note.success) return undefined;
  return note.data.fallback === undefined ? { elapsedMs: note.data.elapsedMs } : { elapsedMs: note.data.elapsedMs, fallbackFrom: note.data.fallback.from };
}

/**
 * Host-owned system card.
 *
 * `owner` must be `"host"`. A card that claims host ownership without it is refused
 * outright rather than rendered with weaker chrome — the whole point of the attribute is
 * that it cannot be obtained by anyone except the host.
 */
export function SystemCardBlock({
  block,
  t = defaultT,
  locale = "vi",
}: {
  block: Record<string, unknown>;
  t?: (key: MessageKey) => string;
  /** The interface language, for the figures the card formats itself; Vietnamese by default, like `t`. */
  locale?: string;
}): ReactElement | null {
  if (block.owner !== "host") return null;

  const title = typeof block.title === "string" ? block.title : "";
  const detail = typeof block.detail === "string" ? block.detail : "";
  const status = typeof block.status === "string" ? block.status : "working";
  const subject = typeof block.subject === "string" ? block.subject : "task";
  const fields = Array.isArray(block.fields) ? (block.fields as Record<string, unknown>[]) : [];

  /**
   * The record of which model answered, drawn as one muted line that opens on demand.
   *
   * It is bookkeeping, not the answer: at full card size it was the largest thing on screen and the
   * first thing read, which put provenance in front of the reply. Its own facts are the summary, so
   * opening it is only ever about the sentence underneath.
   */
  if (subject === "connection" && status === "done") {
    const valueOf = (label: string): string | undefined => {
      const field = fields.find((entry) => entry.label === label);
      return typeof field?.value === "string" ? field.value : undefined;
    };
    // The typed note says how long the answer took and whether a fallback gave it. Its readable time row is the one
    // whose value the note's figure wrote, so it is told apart without reading its label.
    const note = readModelNote(block.modelNote);
    let elapsedText: string | undefined;
    let isElapsedRow: (field: Record<string, unknown>) => boolean;
    // Answered by a fallback rather than the model the person chose: the one line says so in a warning tone, because a
    // different model answering is a fact the person should notice without opening anything.
    let fellBack: boolean;
    if (note !== undefined) {
      elapsedText = readableDuration(note.elapsedMs, locale, t("settings.ai.turnCap.seconds"));
      isElapsedRow = (field) => field.value === `${String(note.elapsedMs)} ms`;
      fellBack = note.fallbackFrom !== undefined;
    } else {
      // A record written before the typed note: its rows are in the language the node wrote them in, so the card's
      // own labels say which one it is, and the elapsed time is read in that same language.
      const english = valueOf("Time") !== undefined;
      const elapsed = english ? valueOf("Time") : valueOf("Thời gian");
      elapsedText =
        elapsed === undefined
          ? undefined
          : english
            ? readableElapsed(elapsed, "en", MESSAGES_EN["settings.ai.turnCap.seconds"])
            : readableElapsed(elapsed, "vi", MESSAGES_VI["settings.ai.turnCap.seconds"]);
      isElapsedRow = (field) => field.label === "Time" || field.label === "Thời gian";
      fellBack = valueOf("Model đã chọn") !== undefined || valueOf("Chosen model") !== undefined;
    }
    const summary = [valueOf("Provider"), valueOf("Model"), elapsedText].filter((value): value is string => value !== undefined);
    const rest = fields.filter((field) => field.label !== "Provider" && field.label !== "Model" && !isElapsedRow(field));
    return (
      <details
        className="cc-model-note"
        data-host-card="system"
        data-owner="host"
        data-subject={subject}
        data-status={status}
        data-model-note="true"
        {...(fellBack ? { "data-fallback": "true" } : {})}
      >
        <summary className="cc-model-note-summary">
          <span>{title}</span>
          {summary.length > 0 && <span className="cc-model-note-meta">{summary.join(" · ")}</span>}
        </summary>
        <div className="cc-model-note-body">
          <p style={{ margin: 0 }}>{detail}</p>
          {rest.length > 0 && (
            <dl className="cc-fields">
              {rest.map((field, index) => (
                <Fragment key={index}>
                  <dt>{String(field.label ?? "")}</dt>
                  <dd>{String(field.value ?? "")}</dd>
                </Fragment>
              ))}
            </dl>
          )}
        </div>
      </details>
    );
  }

  // Internal identifiers (a task's or a node's id) are kept for whoever needs to quote them, one click down: read
  // first, they put the machinery in front of the sentence that says what happened.
  const plainFields = fields.filter((field) => !isInternalId(field.value));
  const referenceFields = fields.filter((field) => isInternalId(field.value));
  return (
    <section className="cc-card" data-host-card="system" data-owner="host" data-status={status} data-subject={subject}>
      <header className="cc-card-head">
        <span className="cc-card-title">{title}</span>
        <span className="cc-badge" data-tone={CARD_TONE[status] ?? ""}>
          {cardStatusLabel(status, t)}
        </span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{detail}</p>
        {plainFields.length > 0 && cardFields(plainFields, t)}
        {referenceFields.length > 0 && (
          <details className="cc-text-alt" data-card-references="true">
            <summary>{t("inbox.capability.details")}</summary>
            {cardFields(referenceFields, t)}
          </details>
        )}
      </div>
    </section>
  );
}

/**
 * Approval card.
 *
 * The decider is always the user. There is no code path that renders an approval as
 * already decided by the model, because the schema has no such value.
 */
/**
 * What a card can ask the host to do.
 *
 * Passed down through `renderBlock` rather than handled inside the card, because the card is rendered from
 * history as well as from live turns and only the conversation knows whether a decision is possible right
 * now. A card with no handler draws the decision buttons disabled instead of pretending.
 */
/**
 * What became of an install attempt, as the card shows it.
 *
 * Five states because the five are different truths: it is happening, it happened, a person has to decide first, it
 * was refused, or the list it was pressed on is out of date. Collapsing the middle two into "not installed" would hide
 * that one of them is waiting on the reader and the other is not.
 */
export interface PackageInstallState {
  status: "installing" | "installed" | "approval-required" | "refused" | "stale";
  /** The node's own words where it gave them. */
  message?: string;
  generationId?: string;
  verified?: string;
  /** The inbox item the install waits on, when the execution policy asked first. */
  approvalId?: string;
  /**
   * For `stale`: the `contentDigest` the refused press sent. Only a row that shows this same digest is out of date; a
   * row from a newer search shows the files as they are now and offers Install again.
   */
  staleContentDigest?: string;
}

/** How a question the agent asked stopped waiting, as the node recorded it in the transcript. */
export type QuestionOutcome = "answered" | "cancelled" | "expired" | "asked-again";

export interface BlockActions {
  onApprovalDecide?: (input: { approvalId: string; digest: string; decision: "granted" | "denied" }) => void;
  /**
   * A secret the person typed, on its way to the node and nowhere else.
   *
   * The callback receives the values because that is what it posts; nothing in this interface keeps them, and the
   * card clears its own inputs as soon as it hands them over, so a value cannot be shown again by accident.
   */
  onCredentialSubmit?: (input: {
    requestId: string;
    fields: { name: string; value: string; kind?: string; description?: string; consumer?: string }[];
  }) => void;
  /** What the node said about the last submission for one request, in words a reader can act on. */
  credentialStatus?: { requestId: string; message: string };
  /** Which approval is waiting on the node, so its own card says so rather than all of them. */
  decidingApprovalId?: string;
  /**
   * Approvals this conversation already has a receipt for.
   *
   * Derived from the transcript rather than from the node: messages are history and are never rewritten,
   * so a card that has been answered keeps saying `pending` in storage. The receipt of the operation is
   * what says the decision happened, and it carries the approval id — which is why the buttons go away
   * here instead of inviting a second press that the node would refuse.
   */
  decidedApprovals?: readonly string[];
  /** The decided approvals whose record says they were refused, so the card can say which way it went. */
  deniedApprovals?: readonly string[];
  /**
   * Post an answer to a question card.
   *
   * One callback for all four kinds, because an answer is one shape: a click, a typed sentence and a spoken
   * utterance all end up here, and the node decides whether the shape fits the question that was asked.
   */
  onQuestionAnswer?: (input: { questionId: string; text?: string; optionIds?: string[]; confirmed?: boolean }) => void;
  /**
   * Questions this conversation already has an answer recorded for.
   *
   * Derived from the transcript, exactly as `decidedApprovals` is: a card keeps saying `waiting` because messages
   * are never rewritten, and the answer record is what says otherwise. Without it, a reload would offer the
   * question again — and the node would have to refuse a second answer rather than the card never asking.
   */
  answeredQuestions?: readonly string[];
  /**
   * How each closed question closed, from the same records: answered, cancelled, expired, or asked again as a new
   * question. A card that only knew "closed" would tell someone whose question timed out that their answer was recorded.
   */
  questionOutcomes?: Readonly<Record<string, QuestionOutcome>>;
  /**
   * The answer to a question the agent asked, on its way back as the user's own message.
   *
   * Not a new action route. The answer travels the path a typed reply takes — the same `send` the composer
   * calls — which is what makes a click, a keystroke and a spoken answer the same thing rather than three
   * implementations that have to be kept in step.
   */
  /**
   * Install a package a directory listing named.
   *
   * Absent where there is nothing to install into: a read-only snapshot, or a build with no node behind it. The
   * control is not rendered at all in that case rather than rendered and refused, which is the difference between a
   * disabled button with a reason and a button that looks usable and is not.
   */
  onInstallPackage?: (input: { packageId: string; version: string; contentDigest?: string }) => void;
  /** The attempt for each package id, so the card shows an outcome instead of a spinner that never ends. */
  packageInstall?: Record<string, PackageInstallState>;
  /**
   * Opens the inbox on one waiting item (an `inbox.open` app intent), for an install that waits on the person's
   * decision there. Absent where there is no inbox to open, and then the card offers no such button.
   */
  onOpenInbox?: (target: string) => void;
  /**
   * Runs a marketplace card's search again, as the person's own next message, for a row whose files changed after the
   * card was made. Absent where there is no conversation to send to, and then the card offers no such button.
   */
  onSearchAgain?: (input: { query: string }) => void;
  /**
   * The answer being composed for a question card, owned by the surface that draws it.
   *
   * The card stays a pure function of what it is given, like the other cards in this file: state kept inside the
   * card would be a second copy of something the conversation also tracks, and the two would disagree exactly when
   * it matters — after a reload, or when the same card appears twice in one snapshot.
   */
  questionDraft?: { questionId: string; chosen: readonly string[]; text: string };
  /** A change to that draft: the selection for a choice, or the text typed so far. */
  onQuestionDraft?: (input: { questionId: string; chosen?: readonly string[]; text?: string }) => void;
  /**
   * The question whose answer is on its way to the node.
   *
   * Sent by the surface that posted the answer, because only it knows a request is in flight. The card reading it
   * is what stops a second press while the first answer is still travelling.
   */
  questionPendingId?: string;
  /**
   * A filled-in form, on its way back as the user's own message.
   *
   * The summary is the answers as lines of text, which is what a reader would have typed — not a JSON blob, which
   * would put a machine shape into the transcript and lose the labels that make it readable.
   */
  onFormSubmit?: (input: { formId: string; summary: string; values: Record<string, string> }) => void;
  /** Forms that may still be submitted: the same rule as questions, from the same computation. */
  openFormIds?: readonly string[];
  /**
   * Ask a running task to stop.
   *
   * The node answers with what it actually did rather than with what was asked: cancellation is two steps, so a
   * task whose executor is still running comes back `cancel_requested` and only a task with nothing in flight is
   * confirmed on the spot. The outcome is the node's answer, never the press.
   */
  onTaskStop?: (input: { taskId: string }) => void;
  /** What the node said about each stop request, keyed by task id. */
  taskStop?: Readonly<Record<string, TaskStopState>>;
  /**
   * Open an artifact from the snapshot of it in the transcript.
   *
   * The inline block is history and stays read-only; reopening asks the node what it still has, which is the
   * only place that can answer — an artifact may have expired since the message was written, and a snapshot
   * cannot know that.
   */
  onArtifactOpen?: (input: { artifactId: string }) => void;
  artifactOpen?: Readonly<Record<string, ArtifactOpenState>>;
  /** Hand the wheel of a browser session to the user. */
  onControlTakeover?: (input: { sessionId: string }) => void;
  /** End a browser session. */
  onControlStop?: (input: { sessionId: string }) => void;
  controlSession?: Readonly<Record<string, ControlSessionActionState>>;
  /**
   * What a terminal card chose to send: a selection, a command's result or the screen, as the user's own message.
   *
   * The same route a typed reply takes, so the agent reads it as something the person said rather than through a
   * side channel. Absent in a snapshot, which is also what keeps a snapshot from attaching to a live shell.
   */
  onTerminalShare?: (input: { text: string }) => void;
  /**
   * A button on a slash command's card (`command-card`): open a conversation, choose a thinking level, sign in to or
   * out of a provider. Carried out through the capability the rest of the app uses for the same thing; absent in a
   * snapshot, where the card shows what it listed and offers nothing to press.
   */
  onCommandAction?: (input: { cardId: string; rowId: string; actionId: string; action: CommandCardAction }) => void;
  /** What each press came to, keyed `cardId/rowId/actionId`, so the card says it beside the button. */
  commandAction?: Readonly<Record<string, CommandActionState>>;
  /** Sign-ins a `/login` card started, keyed `cardId/rowId`: the page to open, the code, the question, the outcome. */
  signIns?: Readonly<Record<string, ProviderSignInView>>;
  /** The person's answer to what a sign-in asks. Sent to the node and dropped from the card at once. */
  onSignInAnswer?: (input: { key: string; signInId: string; value: string }) => void;
  onSignInCancel?: (input: { key: string; signInId: string }) => void;
}

/** What one press on a command card came to. */
export type CommandActionState =
  | { status: "pending" }
  | { status: "done"; message: string }
  | { status: "failed"; message: string };

/**
 * What the node said about a browser session after a verb was applied to it.
 *
 * `taken-over` carries the epoch rather than a boolean, because the epoch is what decides whether an action the
 * agent planned earlier is still admissible — a card that only said "you have control" would leave a reader unable
 * to tell whether the agent's in-flight action had been refused.
 */
export type ControlSessionActionState =
  | { status: "pending" }
  | { status: "taken-over"; leaseEpoch: number }
  | { status: "stopped" }
  | { status: "failed"; message: string };

export type ArtifactOpenState =
  | { status: "pending" }
  | {
      status: "opened";
      digest: string;
      sizeBytes: number;
      mimeType: string;
      originNodeId: string;
      createdAt: string;
      expiresAt: string | null;
      expired: boolean;
    }
  | { status: "failed"; message: string };

export type TaskStopState =
  | { status: "pending" }
  | { status: "requested"; state: string; confirmed: boolean }
  | { status: "failed"; message: string };

/**
 * The approval card.
 *
 * The decider is always the user. There is no code path that renders an approval as already decided by
 * the model, because the schema has no such value — `decider` is the literal `"user"`. The digest is
 * shown because it is what the decision is bound to: the operation that runs is compared against it, so
 * a plan that changed after display is refused rather than executed.
 */
/**
 * The question card.
 *
 * A host-owned card, and the same boundary an approval card draws: the model asks, the person answers, and the
 * model never draws the question. Four kinds because those are the four a voice can answer, and every kind
 * posts to the same route the voice path uses.
 *
 * Not a permission dialog. The agent asks because the work is under-specified — which project, which
 * environment — so the wording says what is being chosen rather than whether it may proceed.
 */
/** What a closed question card says it is, and what became of it, by how it closed. */
const QUESTION_OUTCOME_TITLE: Record<QuestionOutcome, MessageKey> = {
  answered: "blocks.question.answered",
  cancelled: "blocks.question.cancelled",
  expired: "blocks.question.expired",
  "asked-again": "blocks.question.askedAgain",
};
const QUESTION_OUTCOME_NOTE: Record<QuestionOutcome, MessageKey> = {
  answered: "blocks.question.recorded",
  cancelled: "blocks.question.cancelledNote",
  expired: "blocks.question.expiredNote",
  "asked-again": "blocks.question.askedAgainNote",
};

export function QuestionCardBlock({
  block,
  actions,
  t = defaultT,
}: {
  block: Record<string, unknown>;
  actions?: BlockActions;
  t?: (key: MessageKey) => string;
}): ReactElement | null {
  if (block.owner !== "host") return null;
  const questionId = typeof block.questionId === "string" ? block.questionId : "";
  const prompt = typeof block.prompt === "string" ? block.prompt : "";
  const kind = typeof block.questionType === "string" ? block.questionType : "text";
  const offered = (Array.isArray(block.options) ? block.options : []).flatMap((entry) => {
    const option = entry as { id?: unknown; label?: unknown; description?: unknown };
    if (typeof option.id !== "string" || typeof option.label !== "string") return [];
    return [
      {
        id: option.id,
        label: option.label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      },
    ];
  });

  const draft = actions?.questionDraft?.questionId === questionId ? actions.questionDraft : undefined;
  const chosen = draft?.chosen ?? [];
  const text = draft?.text ?? "";
  /*
   * The node says which question it is still waiting on, and the answer on its way is one of those. The card
   * does not track its own press: a press is not an answer until the node records it, and a flag kept here would
   * be a second copy of a fact the transcript already carries.
   */
  const sending = actions?.questionPendingId === questionId;
  const answered = questionId !== "" && actions?.answeredQuestions?.includes(questionId) === true;
  const outcome: QuestionOutcome = actions?.questionOutcomes?.[questionId] ?? "answered";
  const canAnswer = questionId !== "" && actions?.onQuestionAnswer !== undefined && !answered && !sending;
  const submit = (answer: { text?: string; optionIds?: string[]; confirmed?: boolean }): void => {
    if (!canAnswer) return;
    actions?.onQuestionAnswer?.({ questionId, ...answer });
  };
  const toggle = (id: string): void => {
    const next = chosen.includes(id) ? chosen.filter((entry) => entry !== id) : [...chosen, id];
    actions?.onQuestionDraft?.({ questionId, chosen: next });
  };

  return (
    <section
      className="cc-card"
      data-host-card="question"
      data-owner="host"
      data-question-id={questionId}
      data-question-kind={kind}
      data-answered={answered ? "true" : "false"}
      data-question-outcome={answered ? outcome : undefined}
      aria-label={prompt}
    >
      <header className="cc-card-head">
        <span className="cc-card-title">{answered ? t(QUESTION_OUTCOME_TITLE[outcome]) : t("blocks.question.needsChoice")}</span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{prompt}</p>

        {!answered && canAnswer && kind === "confirm" && (
          <div className="cc-card-actions">
            <button type="button" className="cc-action" data-question-answer="yes" disabled={!canAnswer} onClick={() => submit({ confirmed: true })}>
              {t("blocks.question.yes")}
            </button>
            <button type="button" className="cc-action" data-question-answer="no" disabled={!canAnswer} onClick={() => submit({ confirmed: false })}>
              {t("blocks.question.no")}
            </button>
          </div>
        )}

        {!answered && canAnswer && (kind === "single-choice" || kind === "multi-choice") && (
          <div className="cc-card-actions cc-question-options">
            {offered.map((option) => (
              <button
                key={option.id}
                type="button"
                className="cc-action cc-question-option"
                data-question-option={option.id}
                data-selected={chosen.includes(option.id)}
                disabled={!canAnswer}
                onClick={() => {
                  if (kind === "single-choice") {
                    submit({ optionIds: [option.id] });
                    return;
                  }
                  toggle(option.id);
                }}
              >
                <span className="cc-question-option-label">{option.label}</span>
                {option.description === undefined ? null : (
                  <span className="cc-question-option-desc"> {option.description}</span>
                )}
              </button>
            ))}
            {kind === "multi-choice" && (
              <button
                type="button"
                className="cc-action"
                data-question-answer="submit"
                disabled={!canAnswer || chosen.length === 0}
                onClick={() => submit({ optionIds: [...chosen] })}
              >
                {t("blocks.common.send")}
              </button>
            )}
          </div>
        )}

        {!answered && canAnswer && kind === "text" && (
          <div className="cc-card-actions">
            <input
              className="cc-action"
              data-question-text="true"
              value={text}
              placeholder={t("blocks.question.answerPlaceholder")}
              disabled={!canAnswer}
              onChange={(event) => actions?.onQuestionDraft?.({ questionId, text: event.target.value })}
            />
            <button
              type="button"
              className="cc-action"
              data-question-answer="submit"
              disabled={!canAnswer || text.trim() === ""}
              onClick={() => submit({ text })}
            >
              {t("blocks.common.send")}
            </button>
          </div>
        )}

        {sending && !answered && (
          <p className="cc-freshness" style={{ margin: 0 }}>
            {t("blocks.question.sending")}
          </p>
        )}

        {answered && (
          <p className="cc-freshness" style={{ margin: 0 }}>
            {t(QUESTION_OUTCOME_NOTE[outcome])}
          </p>
        )}

        {/*
         * The options as text whenever they cannot be pressed: once an answer is recorded, and on a surface with no
         * node behind it. This is what makes the card's text alternative the same thing as its control — a snapshot,
         * a screen reader and an answered card all read the same list — and it is why the list is not simply hidden
         * behind the buttons.
         */}
        {(answered || !canAnswer) && offered.length > 0 && (
          <ul className="cc-question-options" data-question-options={offered.length}>
            {offered.map((option) => (
              <li key={option.id}>
                {option.label}
                {option.description === undefined ? null : (
                  <span className="cc-setting-desc"> — {option.description}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function ApprovalCardBlock({
  block,
  actions,
}: {
  block: Record<string, unknown>;
  actions?: BlockActions;
}): ReactElement | null {
  const t = useT();
  if (block.owner !== "host") return null;
  const description = typeof block.operationDescription === "string" ? block.operationDescription : "";
  const digest = typeof block.operationDigest === "string" ? block.operationDigest : "";
  const effect = typeof block.effectCategory === "string" ? block.effectCategory : "external-write";
  const decision = typeof block.decision === "string" ? block.decision : "pending";
  const approvalId = typeof block.approvalId === "string" ? block.approvalId : "";
  const payload = typeof block.payload === "string" ? block.payload : undefined;
  // Who asked, said only when it was not the person: a card the person caused needs no attribution, and one an AI
  // client or a script caused is exactly the card where knowing that matters.
  const origin = typeof block.origin === "string" && block.origin !== "person" ? block.origin : undefined;
  const askedBy = askedByKey(origin);
  const deciding = actions?.decidingApprovalId === approvalId && approvalId !== "";
  const decided = approvalId !== "" && actions?.decidedApprovals?.includes(approvalId) === true;
  const denied = decided && actions?.deniedApprovals?.includes(approvalId) === true;
  const canDecide = decision === "pending" && !decided && approvalId !== "" && actions?.onApprovalDecide !== undefined;

  return (
    <section className="cc-card" data-host-card="approval" data-owner="host" data-decision={decision} data-approval-id={approvalId}>
      <header className="cc-card-head">
        {/* A card that has been decided no longer asks: the title says what it was, and the badge below says how it ended. */}
        <span className="cc-card-title">
          {decision === "pending" && !decided ? t("blocks.approval.needsConfirm") : t("blocks.approval.request")}
        </span>
        {/* In the words the Control settings use for the same kind of effect, so a rule and the card it raises match. */}
        <span className="cc-badge" data-tone={effect === "destructive" ? "danger" : "warn"} data-effect={effect}>
          {(effectCategoryLabels(t) as Record<string, string>)[effect] ?? effect}
        </span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{description}</p>
        {askedBy === undefined ? null : (
          <p className="cc-freshness" style={{ margin: 0 }} data-approval-origin={origin}>
            {t(askedBy)}
          </p>
        )}
        {payload !== undefined &&
          (performInputOf(payload) !== undefined ? (
            <CodeBlock code={performInputOf(payload) ?? ""} language="json" label={t("blocks.approval.performInputLabel")} />
          ) : (
            <CodeBlock
              code={commandOf(payload) ?? payload}
              {...(commandOf(payload) === undefined ? {} : { language: "bash" })}
              label={t(isTilePolicyPayload(payload) ? "blocks.approval.tilePolicyLabel" : "blocks.approval.commandLabel")}
            />
          ))}
        {/* The digest is shown so an approved plan cannot be swapped for another one. */}
        <p className="cc-freshness" style={{ margin: 0 }}>
          {t("blocks.approval.digest")} <code>{digest.slice(0, 20)}…</code>
        </p>
        {decision === "pending" && !decided ? (
          <p className="cc-freshness" style={{ margin: 0 }}>
            {t("blocks.approval.onlyYouCanConfirm")}
          </p>
        ) : null}
        {decision === "pending" && !decided ? (
          <div className="cc-card-actions">
            {/*
              Approve is the card's one primary action, filled, and Deny the plain one beside it, so the two answers
              never look alike. Inside a host card both are drawn with Clark's own button, whatever a theme's recipe.
            */}
            <button
              type="button"
              className="cc-action"
              data-emphasis="primary"
              data-approve={approvalId}
              disabled={!canDecide || deciding}
              onClick={() => actions?.onApprovalDecide?.({ approvalId, digest, decision: "granted" })}
            >
              {deciding ? t("blocks.approval.running") : t("blocks.approval.approveAndRun")}
            </button>
            <button
              type="button"
              className="cc-action"
              data-deny={approvalId}
              disabled={!canDecide || deciding}
              onClick={() => actions?.onApprovalDecide?.({ approvalId, digest, decision: "denied" })}
            >
              {t("blocks.approval.deny")}
            </button>
          </div>
        ) : (
          // What was decided, in words: a granted card says approved, and one read back from history says what its record
          // says rather than the wire's value.
          <span className="cc-badge" data-approval-decision={denied ? "denied" : decided ? "answered" : decision}>
            {denied || decision === "denied"
              ? t("blocks.approval.denied")
              : decided || decision === "granted"
                ? t("blocks.approval.granted")
                : decision === "expired"
                  ? t("blocks.approval.expired")
                  : t("blocks.approval.decided")}
          </span>
        )}
      </div>
    </section>
  );
}

/** The command inside an operation payload, when the payload is one of ours. */
function commandOf(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : undefined;
  } catch {
    return undefined;
  }
}

/** The whole input a widget action's card would send, laid out to read, or `undefined` for any other payload. */
function performInputOf(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { kind?: unknown; input?: unknown };
    return parsed.kind === "widget-perform" ? JSON.stringify(parsed.input ?? {}, null, 2) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a card's payload is a map tile policy, which is labelled as one rather than as a command. */
function isTilePolicyPayload(payload: string): boolean {
  try {
    return (JSON.parse(payload) as { kind?: unknown }).kind === "map-tile-policy";
  } catch {
    return false;
  }
}

export function ConnectionCardBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
  const t = useT();
  if (block.owner !== "host") return null;
  const provider = typeof block.provider === "string" ? block.provider : "connection";
  const status = typeof block.status === "string" ? block.status : "unconfigured";
  const account = typeof block.account === "string" ? block.account : undefined;
  const missing = Array.isArray(block.missingScopes) ? (block.missingScopes as string[]) : [];

  return (
    <section className="cc-card" data-host-card="connection" data-owner="host" data-status={status}>
      <header className="cc-card-head">
        <span className="cc-card-title">{provider}</span>
        <span className="cc-badge" data-tone={status === "connected" ? "ok" : status === "revoked" ? "danger" : "warn"}>
          {status}
        </span>
      </header>
      <div className="cc-card-body">
        {/* A partial grant is stated, never smoothed over into "connected". */}
        <p style={{ margin: 0 }}>
          {account === undefined ? t("blocks.connection.unverified") : `${t("blocks.connection.accountLabel")}: ${account}`}
        </p>
        {missing.length > 0 && (
          <p className="cc-freshness" style={{ margin: 0 }} data-missing-scopes="true">
            {t("blocks.connection.missingScopesLabel")}: {missing.join(", ")}
          </p>
        )}
      </div>
    </section>
  );
}

export function CredentialCardBlock({
  block,
  actions,
}: {
  block: Record<string, unknown>;
  actions?: BlockActions;
}): ReactElement | null {
  const t = useT();
  if (block.owner !== "host") return null;
  const purpose = typeof block.purpose === "string" ? block.purpose : "";
  const destination = typeof block.destination === "string" ? block.destination : "vault-node";
  const requestId = typeof block.requestId === "string" ? block.requestId : "";
  // The three fields that answer "what is this for, who will use it, on which machine". They travel with the
  // submission as well as being shown, so the node records the same answer the person was given when they typed.
  const description = typeof block.description === "string" ? block.description : "";
  const consumer = typeof block.consumer === "string" ? block.consumer : "";
  const scope = typeof block.scope === "string" ? block.scope : "";
  const secretKind = typeof block.secretKind === "string" ? block.secretKind : "";
  const fields = Array.isArray(block.fields)
    ? (block.fields as { name?: unknown; label?: unknown; masked?: unknown }[]).flatMap((field) =>
        typeof field?.name === "string" && field.name !== ""
          ? [
              {
                name: field.name,
                label: typeof field.label === "string" && field.label !== "" ? field.label : field.name,
                masked: field.masked !== false,
              },
            ]
          : [],
      )
    : [];
  // Secrets stay in this component and nowhere else: unlike a form's draft they are never copied into the view-state
  // store, so a credential card scrolled far enough away to be unmounted forgets what was typed into it.
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = fields.length > 0 && fields.every((field) => (values[field.name] ?? "") !== "");
  const status = actions?.credentialStatus?.requestId === requestId ? actions.credentialStatus.message : undefined;

  return (
    <section className="cc-card" data-host-card="credential" data-owner="host">
      <header className="cc-card-head">
        <span className="cc-card-title">{t("blocks.credential.needed")}</span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{purpose}</p>
        {description !== "" && description !== purpose && (
          <p className="cc-freshness" style={{ margin: 0 }} data-credential-description="true">
            {description}
          </p>
        )}
        {/*
          Who will use it and where it is kept are machine names (a capability, a node, a vault). They stay one press
          away for the person who wants to check them, and out of the way of the person who only needs to paste a key.
        */}
        <details className="cc-text-alt" data-credential-references="true">
          <summary>{t("inbox.capability.details")}</summary>
          {consumer !== "" && (
            <p className="cc-freshness" style={{ margin: 0 }} data-credential-consumer={consumer}>
              {t("blocks.credential.usedByLabel")}: {consumer}
            </p>
          )}
          {scope !== "" && (
            <p className="cc-freshness" style={{ margin: 0 }} data-credential-scope={scope}>
              {t("blocks.credential.storedOnLabel")}: {scope}
            </p>
          )}
          <p className="cc-freshness" style={{ margin: 0 }} data-credential-destination={destination}>
            {t("blocks.credential.vaultLabel")}: {destination}
          </p>
        </details>
        {fields.length === 0 ? null : (
          <form
            className="cc-credential-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!complete) return;
              actions?.onCredentialSubmit?.({
                requestId,
                fields: fields.map((field) => ({
                  name: field.name,
                  value: values[field.name] ?? "",
                  ...(secretKind === "" ? {} : { kind: secretKind }),
                  ...(description === "" ? {} : { description }),
                  ...(consumer === "" ? {} : { consumer }),
                })),
              });
              // Cleared as soon as it is handed over, so the value cannot be read back off the screen or out of
              // the component's state by anything that comes later.
              setValues({});
            }}
          >
            {fields.map((field) => (
              <label key={field.name} className="cc-credential-field">
                <span>{field.label}</span>
                <input
                  type={field.masked ? "password" : "text"}
                  name={field.name}
                  autoComplete="off"
                  data-credential-field={field.name}
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                />
              </label>
            ))}
            <div className="cc-card-actions">
              <button
                type="submit"
                className="cc-action"
                data-emphasis="primary"
                disabled={!complete}
                data-credential-submit="true"
              >
                {t("blocks.credential.save")}
              </button>
            </div>
          </form>
        )}
        {status !== undefined && (
          <p className="cc-freshness" data-credential-status="true" style={{ margin: 0 }}>
            {status}
          </p>
        )}
        {/* The value is entered in a host-owned field; it never enters the transcript. */}
        <p className="cc-freshness" style={{ margin: 0 }}>
          {t("blocks.credential.notInTranscript")}
        </p>
      </div>
    </section>
  );
}

/** Minimal fragment helper so the fields list does not need a wrapper element. */
function Fragment({ children }: { children: React.ReactNode }): ReactElement {
  return <>{children}</>;
}

/**
 * A status marker that is never colour alone.
 *
 * Each of these carries a glyph and its own label, so the state survives a monochrome screen, a
 * colour-blind reader, and a screenshot printed in black and white. Colour is the second signal,
 * never the first.
 */
const STEP_MARK: Record<string, string> = {
  pending: "○",
  active: "◐",
  done: "●",
  failed: "✕",
  skipped: "—",
};

const TASK_STATUS_TONE: Record<string, string> = {
  // Quoted because a hyphen in an unquoted key is a subtraction, not a property name.
  "needs-decision": "warn",
  blocked: "danger",
  failed: "danger",
  cancelled: "",
  done: "ok",
  succeeded: "ok",
  queued: "",
  working: "",
};

/**
 * A task status in the reader's words. A status this build has no words for is shown as sent rather than hidden, so
 * a newer node's state still reaches the person.
 */
function taskStatusLabel(status: string, t: (key: MessageKey) => string): string {
  const key = `blocks.taskStatus.${status}`;
  return key in MESSAGES_VI ? t(key as MessageKey) : status;
}

/** A runtime identifier such as "task_muuej1j4c11811c" or "node_343a…": a lowercase prefix, then an opaque id. */
function isInternalId(value: unknown): boolean {
  return typeof value === "string" && /^[a-z]+_[0-9a-z]{8,}$/u.test(value);
}

function cardFields(fields: Record<string, unknown>[], t: (key: MessageKey) => string): ReactElement {
  return (
    <dl className="cc-fields">
      {fields.map((field, index) => (
        <Fragment key={index}>
          <dt>{String(field.label ?? "")}</dt>
          <dd>
            {/* A value that is only its own freshness ("sample", marked sample) is said once, in words. */}
            {field.value === field.freshness ? "" : String(field.value ?? "")}
            {typeof field.freshness === "string" && (
              <span className="cc-freshness" data-freshness={field.freshness}>
                {`${field.value === field.freshness ? "" : " · "}${freshnessLabel(field.freshness, t)}`}
              </span>
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function freshnessLabel(freshness: string, t: (key: MessageKey) => string): string {
  const key = `widgets.freshness.${freshness}`;
  return key in MESSAGES_VI ? t(key as MessageKey) : freshness;
}

/** A system card's state in words: the card's own states first, then the ones it shares with a task. */
function cardStatusLabel(status: string, t: (key: MessageKey) => string): string {
  const key = `blocks.cardStatus.${status}`;
  return key in MESSAGES_VI ? t(key as MessageKey) : taskStatusLabel(status, t);
}

function evidenceLabel(evidence: string, t: (key: MessageKey) => string): string {
  const key = `blocks.evidence.${evidence}`;
  return key in MESSAGES_VI ? t(key as MessageKey) : evidence;
}

function fieldText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function listOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/**
 * A task in flight.
 *
 * The steps are whatever the host genuinely knows. A card that fills in every step as done to
 * look complete would be inventing progress, which is the same failure as inventing an answer.
 */
export function TaskProgressCardBlock({
  block,
  actions,
  t = defaultT,
  locale = "vi",
}: {
  block: Record<string, unknown>;
  actions?: BlockActions;
  t?: (key: MessageKey) => string;
  /** The interface language, for the start time; Vietnamese by default, like `t`. */
  locale?: string;
}): ReactElement | null {
  if (block.owner !== "host") return null;
  const goal = fieldText(block.goal);
  const status = fieldText(block.status, "working");
  const steps = listOf(block.steps);
  const targetNode = (block.targetNode ?? undefined) as Record<string, unknown> | undefined;
  const cancellable = block.cancellable === true;
  const startedAt = readableInstant(fieldText(block.startedAt), locale);
  const taskId = fieldText(block.taskId);
  const stopState = taskId === "" ? undefined : actions?.taskStop?.[taskId];

  return (
    <section className="cc-card" data-host-card="task-progress" data-owner="host" data-status={status}>
      <header className="cc-card-head">
        <span className="cc-card-title">{goal}</span>
        <span className="cc-badge" data-tone={TASK_STATUS_TONE[status] ?? ""}>
          {taskStatusLabel(status, t)}
        </span>
      </header>
      <div className="cc-card-body">
        {steps.length > 0 && (
          <ol className="cc-steps">
            {steps.map((step, index) => {
              const stepStatus = fieldText(step.status, "pending");
              return (
                <li key={index} data-step-status={stepStatus}>
                  <span className="cc-step-mark" aria-hidden="true">
                    {STEP_MARK[stepStatus] ?? "○"}
                  </span>
                  <span className="cc-step-label">{fieldText(step.label)}</span>
                  {typeof step.detail === "string" && step.detail !== "" && (
                    <span className="cc-freshness">{step.detail}</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <dl className="cc-fields">
          <dt>{t("blocks.task.started")}</dt>
          <dd>{startedAt}</dd>
          {targetNode !== undefined && (
            <>
              {/* Named, because a task running elsewhere must not read as a local one. */}
              <dt>{t("blocks.task.runsOn")}</dt>
              {/* Named only if it has a name a person would recognise; otherwise the generic fallback, not an id. */}
              <dd>{fieldText(targetNode.label, t("blocks.task.anotherNode"))}</dd>
            </>
          )}
          <dt>{t("blocks.task.cancellable")}</dt>
          <dd data-task-cancellable={cancellable ? "true" : "false"}>{cancellable ? t("blocks.task.yes") : t("blocks.task.no")}</dd>
        </dl>
        {/*
          The card used to say a task could be stopped and offer nothing that stopped it. The control appears
          exactly when the block says the task is cancellable, so the claim and the affordance cannot drift.
        */}
        {cancellable && taskId !== "" && actions?.onTaskStop !== undefined ? (
          <div className="cc-card-actions">
            <button
              type="button"
              className="cc-action"
              data-task-stop={taskId}
              disabled={stopState !== undefined && stopState.status !== "failed"}
              onClick={() => actions.onTaskStop?.({ taskId })}
            >
              {stopState?.status === "pending" ? t("blocks.task.stopSending") : t("blocks.task.stop")}
            </button>
          </div>
        ) : null}
        {stopState === undefined || stopState.status === "pending" ? null : stopState.status === "failed" ? (
          <p className="cc-freshness" data-task-stop-error="true">
            {stopState.message}
          </p>
        ) : (
          <p
            className="cc-freshness"
            data-task-stop-outcome={stopState.state}
            data-task-stop-confirmed={String(stopState.confirmed)}
          >
            {stopState.confirmed ? t("blocks.task.stoppedConfirmed") : t("blocks.task.stopRequested")}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * A finished task.
 *
 * Outcome and evidence are rendered as two separate signals because they answer two different
 * questions: whether the run ended, and whether it achieved anything. Collapsing them into one
 * badge is how a task that stopped without evidence comes to be read as a success.
 */
export function TaskSummaryCardBlock({
  block,
  t = defaultT,
  locale = "vi",
}: {
  block: Record<string, unknown>;
  t?: (key: MessageKey) => string;
  locale?: string;
}): ReactElement | null {
  if (block.owner !== "host") return null;
  const goal = fieldText(block.goal);
  const outcome = fieldText(block.outcome, "not-verified");
  const evidence = fieldText(block.evidence, "not-verified");
  const durationMs = typeof block.durationMs === "number" ? block.durationMs : 0;
  const changes = listOf(block.changes);
  const summary = fieldText(block.summary);

  return (
    <section className="cc-card" data-host-card="task-summary" data-owner="host" data-outcome={outcome}>
      <header className="cc-card-head">
        <span className="cc-card-title">{goal}</span>
        <span className="cc-badge" data-tone={TASK_STATUS_TONE[outcome] ?? ""}>
          {taskStatusLabel(outcome, t)}
        </span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{summary}</p>
        <p className="cc-evidence" data-verdict={evidence} style={{ margin: 0 }}>
          <span className="cc-badge" data-tone={evidence === "verified" ? "ok" : evidence === "contradicted" ? "danger" : "warn"}>
            {evidenceLabel(evidence, t)}
          </span>
          <span className="cc-freshness">{readableDuration(durationMs, locale, t("settings.ai.turnCap.seconds"))}</span>
        </p>
        {changes.length > 0 && (
          <ul className="cc-changes">
            {changes.map((change, index) => (
              <li key={index} data-change-kind={fieldText(change.kind)}>
                <span className="cc-change-kind">{fieldText(change.kind)}</span>
                <code>{fieldText(change.target)}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * Every task in a conversation.
 *
 * The count of unfinished work is stated in words above the list, because a user scanning a
 * conversation needs to know whether anything is still running without reading every row.
 */
export function TaskOverviewCardBlock({
  block,
  t = defaultT,
  locale = "vi",
}: {
  block: Record<string, unknown>;
  t?: (key: MessageKey) => string;
  locale?: string;
}): ReactElement | null {
  if (block.owner !== "host") return null;
  const tasks = listOf(block.tasks);
  const unfinished = tasks.filter((task) => {
    const status = fieldText(task.status);
    return status === "working" || status === "queued" || status === "blocked" || status === "needs-decision";
  }).length;

  return (
    <section className="cc-card" data-host-card="task-overview" data-owner="host" data-unfinished={unfinished}>
      <header className="cc-card-head">
        <span className="cc-card-title">{t("blocks.taskOverview.title")}</span>
        <span className="cc-badge">{tasks.length}</span>
      </header>
      <div className="cc-card-body">
        <p className="cc-freshness" style={{ margin: 0 }} data-unfinished-count={unfinished}>
          {unfinished === 0
            ? t("blocks.taskOverview.noneRunning")
            : t("blocks.taskOverview.unfinishedCount").replace("{count}", String(unfinished))}
        </p>
        <ul className="cc-task-list">
          {tasks.map((task, index) => {
            const status = fieldText(task.status, "queued");
            return (
              <li key={index} data-task-status={status}>
                <span className="cc-badge" data-tone={TASK_STATUS_TONE[status] ?? ""}>
                  {taskStatusLabel(status, t)}
                </span>
                <span>{fieldText(task.goal)}</span>
                <span className="cc-freshness">{readableInstant(fieldText(task.updatedAt), locale)}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/**
 * A diff.
 *
 * Lines are rendered one by one with their own kind rather than as a pre-coloured block, so the
 * colours come from the theme and the text stays selectable and copyable. A truncated diff says so:
 * a change cut for size and not marked as cut reads as the whole change.
 */
export function CodeDiffCardBlock({
  block,
  t = defaultT,
}: {
  block: Record<string, unknown>;
  t?: (key: MessageKey) => string;
}): ReactElement | null {
  if (block.owner !== "host") return null;
  const summary = fieldText(block.summary);
  const files = listOf(block.files);
  const truncated = block.truncated === true;

  return (
    <section
      className="cc-card"
      data-host-card="code-diff"
      data-owner="host"
      data-truncated={truncated}
      /*
       * Reachable without a pointer. A diff is long and read-only, which is exactly the shape that tends to
       * end up as a div only a mouse can scroll inside: the page scrolls, the diff does not, and a keyboard
       * user cannot get to the bottom of the change they were asked to review. Focusable and labelled makes
       * the whole change traversable with the arrow keys.
       *
       * No collapse controls are added for this: the card holds no state, so it stays a pure function of its
       * props and can still be rendered and asserted without a DOM.
       */
      tabIndex={0}
      role="group"
      aria-label={t("blocks.diff.ariaLabel").replace("{summary}", summary)}
      data-diff-keyboard="true"
    >
      <header className="cc-card-head">
        <span className="cc-card-title">{summary}</span>
        <span className="cc-badge">{files.length}</span>
      </header>
      <div className="cc-card-body">
        {files.map((file, index) => {
          const additions = typeof file.additions === "number" ? file.additions : 0;
          const deletions = typeof file.deletions === "number" ? file.deletions : 0;
          const hunks = listOf(file.hunks);
          return (
            <div key={index} className="cc-diff-file" data-diff-path={fieldText(file.path)}>
              <div className="cc-diff-file-head">
                <code>{fieldText(file.path)}</code>
                <span className="cc-freshness">
                  <span data-diff-additions={additions}>+{additions}</span>{" "}
                  <span data-diff-deletions={deletions}>−{deletions}</span>
                </span>
              </div>
              {hunks.map((hunk, hunkIndex) => (
                <div key={hunkIndex} className="cc-diff-hunk">
                  {fieldText(hunk.header) !== "" && <div className="cc-diff-header">{fieldText(hunk.header)}</div>}
                  {listOf(hunk.lines).map((line, lineIndex) => {
                    const kind = fieldText(line.kind, "context");
                    return (
                      <div key={lineIndex} className="cc-diff-line" data-line-kind={kind}>
                        <span className="cc-diff-gutter" aria-hidden="true">
                          {kind === "add" ? "+" : kind === "remove" ? "−" : " "}
                        </span>
                        <code>{fieldText(line.text)}</code>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })}
        {truncated && (
          // Stated, not implied by an ellipsis: an unmarked truncation reads as a complete change.
          <p className="cc-freshness" data-diff-truncated="true" style={{ margin: 0 }}>
            {t("blocks.diff.truncatedNotice")}
          </p>
        )}
        {/*
          The card's actions.

          "Open in editor" is disabled and states why, which is the same rule the project picker
          already follows: a control that looks live and does nothing is the failure this codebase
          refuses everywhere else.

          There is deliberately no "next file" control. Every file is rendered above, so a button
          that stepped through them would be a control with nothing to control — and paginating for
          real would mean holding a selected-file index, which would make this card stateful and
          put it beyond the plain-function tests the other renderers rely on. Saying that is better
          than shipping a button whose only effect is on a number.
        */}
        <div className="cc-card-actions" data-card-actions="code-diff">
          <button type="button" className="cc-action" disabled data-action="open-in-editor">
            {t("blocks.diff.openInEditor")}
          </button>
          <span className="cc-freshness" data-action-blocked-reason="true">
            {t("blocks.diff.noEditorCapability")}
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * Choosing a project.
 *
 * The buttons are disabled until the selection route exists, and the card says so rather than
 * appearing to work. The alternative — a control that looks live and does nothing — is the failure
 * this codebase refuses everywhere else.
 */
export function ProjectPickerCardBlock({
  block,
  t = defaultT,
}: {
  block: Record<string, unknown>;
  t?: (key: MessageKey) => string;
}): ReactElement | null {
  if (block.owner !== "host") return null;
  const prompt = fieldText(block.prompt);
  const roots = listOf(block.roots);
  const allowManualEntry = block.allowManualEntry === true;

  return (
    <section className="cc-card" data-host-card="project-picker" data-owner="host">
      <header className="cc-card-head">
        <span className="cc-card-title">{t("blocks.projectPicker.title")}</span>
        <span className="cc-badge">{roots.length}</span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{prompt}</p>
        {roots.length === 0 ? (
          <p className="cc-freshness" style={{ margin: 0 }}>
            {t("blocks.projectPicker.none")}
          </p>
        ) : (
          <ul className="cc-root-list">
            {roots.map((root, index) => (
              <li key={index} data-root-id={fieldText(root.rootId)} data-read-only={root.readOnly === true}>
                <span className="cc-setting-text">
                  <span className="cc-setting-label">{fieldText(root.label)}</span>
                  <code className="cc-setting-desc">{fieldText(root.path)}</code>
                </span>
                <span className="cc-badge">
                  {root.readOnly === true ? t("blocks.projectPicker.readOnly") : t("blocks.projectPicker.readWrite")}
                </span>
              </li>
            ))}
          </ul>
        )}
        {allowManualEntry && (
          <p className="cc-freshness" style={{ margin: 0 }}>
            {t("blocks.projectPicker.manualEntryNotice")}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * A lost connection.
 *
 * "Since when" and "is it still trying" are the two questions a user has when something stops
 * working, so the last-seen time and the attempt count are on the card rather than inferred.
 */
export function ReconnectCardBlock({
  block,
  t = defaultT,
}: {
  block: Record<string, unknown>;
  t?: (key: MessageKey) => string;
}): ReactElement | null {
  if (block.owner !== "host") return null;
  const nodeLabel = fieldText(block.nodeLabel);
  const nodeId = fieldText(block.nodeId);
  const status = fieldText(block.status, "disconnected");
  const attempt = typeof block.attempt === "number" ? block.attempt : 0;
  const lastSeenAt = fieldText(block.lastSeenAt);
  const reason = fieldText(block.reason);

  return (
    <section className="cc-card" data-host-card="reconnect" data-owner="host" data-status={status}>
      <header className="cc-card-head">
        <span className="cc-card-title">{t("blocks.reconnect.lostTo").replace("{node}", nodeLabel)}</span>
        <span className="cc-badge" data-tone={status === "failed" ? "danger" : "warn"}>
          {status}
        </span>
      </header>
      <div className="cc-card-body">
        <dl className="cc-fields">
          <dt>{t("blocks.reconnect.node")}</dt>
          <dd>
            <code>{nodeId}</code>
          </dd>
          <dt>{t("blocks.reconnect.lastSeen")}</dt>
          <dd>{lastSeenAt}</dd>
          <dt>{t("blocks.reconnect.attempts")}</dt>
          <dd data-reconnect-attempts={attempt}>{attempt}</dd>
        </dl>
        {reason !== "" && (
          <p className="cc-freshness" style={{ margin: 0 }} data-reconnect-reason="true">
            {reason}
          </p>
        )}
      </div>
    </section>
  );
}

/*
 * Re-exported rather than redeclared.
 *
 * There were two copies of this list and they had already drifted — this one knew about two card types the
 * contract's did not, and neither knew about the session cards. The contract's is the one the provenance check
 * reads, so a type missing there is a host-owned card an untrusted source could mint.
 */
export { HOST_OWNED_BLOCK_TYPES } from "@clarkcant/contracts";

/**
 * What a surface block knows about the capture it came from.
 *
 * The snapshot id and the bundle reference travel with the block so history can be rendered from
 * exactly what was captured. Passing only the instance id and a revision would force the renderer to
 * ask the live row for the props, which is how a transcript ends up showing today's numbers under
 * yesterday's timestamp.
 */
export interface SurfaceBlockRef {
  instanceId: string | undefined;
  definitionId: string;
  textAlternative: string;
  revision: number;
  snapshotId: string;
  bundleRef: string | undefined;
  catalogDigest: string | undefined;
  capturedAt: string | undefined;
  stale: boolean;
}

/**
 * One file a person attached, drawn from the stored message.
 *
 * Nothing here keeps state of its own: the block carries the whole reference, so a conversation that is
 * reloaded draws the same picture it drew when it arrived, with no second lookup that could come back empty
 * and leave a gap in the timeline.
 *
 * A malformed block is dropped rather than drawn, the same way an unknown type is: the ref is re-validated
 * here because a block read back from storage is not a type, and a renderer that trusted it would be the
 * place a forged name or a path first reached the DOM.
 */
/**
 * Something the person pointed at when they wrote the message: a skill, a project, a file, a conversation.
 *
 * A read-only chip with the token they saw in the composer, and what the node found when it checked the reference
 * (a file's size, a task's state), so the message reads back the way it was sent.
 */
function ReferenceBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
  const parsed = referenceBlockSchema.safeParse(block);
  if (!parsed.success) return null;
  const { reference, note } = parsed.data;
  return (
    <span className="cc-reference-chip" data-reference-block={reference.label} data-reference-kind={reference.kind}>
      <span className="cc-reference-chip-token">{referenceToken(reference)}</span>
      {note === undefined ? null : <span className="cc-reference-chip-note">{note}</span>}
    </span>
  );
}

function AttachmentBlock({
  block,
  client,
}: {
  block: Record<string, unknown>;
  /** Required but possibly absent: a renderer can be drawn without a node connection, and then it shows the
   *  file rather than fetching anything. */
  client: GatewayClient | undefined;
}): ReactElement | null {
  const parsed = attachmentRefSchema.safeParse(block.attachment);
  if (!parsed.success) return null;
  return <AttachmentCard attachment={parsed.data} client={client} />;
}

function AttachmentCard({
  attachment,
  client,
}: {
  attachment: AttachmentRef;
  client: GatewayClient | undefined;
}): ReactElement {
  const t = useT();
  const id = attachment.attachmentId;
  const picture = attachment.kind === "image";
  // A picture is read as soon as it is drawn, as every picture is; a file is read only when the person downloads it.
  const urls = useAttachmentUrls(client, picture ? [id] : [], picture ? [] : [id]);
  const size = formatFileSize(attachment.sizeBytes);

  if (picture) {
    const url = urls.get(id);
    return (
      <figure
        className="cc-attachment"
        data-attachment-block="true"
        data-attachment-kind="image"
        data-attachment-id={attachment.attachmentId}
      >
        {url === undefined ? (
          // A sentence with the file's name, not an empty frame: bytes that cannot be read are a description.
          <div className="cc-attachment-missing" data-attachment-missing="true">
            {t("blocks.attachment.imageMissing").replace("{filename}", attachment.filename)}
          </div>
        ) : (
          <img src={url} alt={attachment.filename} data-attachment-image="true" />
        )}
        <figcaption>
          {attachment.filename} — {size}
        </figcaption>
      </figure>
    );
  }

  // Text, PDF and audio: a card with a way to open it. A pdf is not rendered in place, because the node serves it as
  // a download and drawing it inline here would claim a preview this node does not produce.
  return (
    <div className="cc-attachment" data-attachment-block="true" data-attachment-kind={attachment.kind} data-attachment-id={id}>
      <span className="cc-attachment-name">{attachment.filename}</span>
      <span className="cc-attachment-size">{size}</span>
      {client === undefined ? (
        <span className="cc-attachment-missing" data-attachment-missing="true">
          {t("blocks.attachment.fileMissing")}
        </span>
      ) : (
        // Keyed by the attachment, so a card that comes to stand for another file does not keep waiting for the first.
        <AttachmentDownload key={id} urls={urls} attachmentId={id} filename={attachment.filename} />
      )}
    </div>
  );
}

/**
 * A file card's Download control, which reads the file only when pressed.
 *
 * The same button throughout, kept focusable while the read is in flight (`aria-disabled`, not `disabled`) so the focus
 * that pressed it is never dropped. A polite status beside it says the download is being prepared, with no invented
 * progress, and, if the node does not give the bytes, what failed, that nothing was downloaded or changed, and that
 * pressing again tries again; the button then says Try again.
 */
function AttachmentDownload({
  urls,
  attachmentId,
  filename,
}: {
  urls: ObjectUrls;
  attachmentId: string;
  filename: string;
}): ReactElement {
  const t = useT();
  const [waiting, setWaiting] = useState(false);
  const status = urls.status(attachmentId);
  useEffect(() => {
    if (!waiting) return;
    if (!settleAttachmentDownload(urls, attachmentId, (url) => downloadObjectUrl(url, filename))) setWaiting(false);
  }, [attachmentId, filename, status, urls, waiting]);
  const state = attachmentDownloadState(status, waiting);
  const message =
    state === "opening"
      ? t("blocks.attachment.opening")
      : state === "failed"
        ? t("blocks.attachment.openFailed").replace("{filename}", filename)
        : "";
  return (
    <>
      <span className="cc-attachment-status" role="status" aria-live="polite" data-attachment-status={state}>
        {message}
      </span>
      <button
        type="button"
        className="cc-action cc-attachment-open"
        data-attachment-download="true"
        aria-disabled={state === "opening"}
        onClick={() => {
          if (state === "opening") return;
          if (pressAttachmentDownload(urls, attachmentId, (url) => downloadObjectUrl(url, filename))) setWaiting(true);
        }}
      >
        {state === "failed" ? t("blocks.attachment.retry") : t("blocks.attachment.download")}
      </button>
    </>
  );
}

export function renderBlock(
  block: Record<string, unknown>,
  index: number,
  surface: (props: SurfaceBlockRef) => ReactElement,
  actions?: BlockActions,
  /**
   * Written as `| undefined` as well as optional because of `exactOptionalPropertyTypes`: an absent key and a
   * key holding undefined are different types there, and this one is forwarded as a value.
   */
  client?: GatewayClient | undefined,
  /**
   * The live locale lookup. Optional and defaulting to the Vietnamese catalog, for the same reason the
   * cards below accept `t` as a prop rather than calling `useT()`: `renderBlock` is itself called as a
   * plain function by its own unit tests, not only from within a component's render pass.
   */
  t: (key: MessageKey) => string = defaultT,
  /** The interface language, for dates and numbers the cards format themselves; Vietnamese by default, like `t`. */
  locale: string = "vi",
): ReactElement | null {
  const type = typeof block.type === "string" ? block.type : "";

  switch (type) {
    case "text":
      return <TextBlock key={index} block={block} />;
    case "attachment":
      // The client is what fetches the bytes: an attachment's content route needs the bearer token, so a block
      // drawn without one still shows the file rather than pretending it is missing.
      return <AttachmentBlock key={index} block={block} client={client} />;
    case "reference":
      return <ReferenceBlock key={index} block={block} />;
    case "tool-activity":
      return <ToolActivityBlock key={index} block={block} />;
    case "reasoning":
      return <ReasoningBlock key={index} block={block} />;
    case "evidence":
      return <EvidenceBlock key={index} block={block} />;
    case "artifact":
      // Forwarded, for the reason the task card's control taught: a component tested by calling it directly
      // passes whether or not the dispatcher hands it anything.
      return <ArtifactBlock key={index} block={block} t={t} locale={locale} {...(actions === undefined ? {} : { actions })} />;
    case "system-card":
      return <SystemCardBlock key={index} block={block} t={t} locale={locale} />;
    case "approval-card":
      return <ApprovalCardBlock key={index} block={block} {...(actions === undefined ? {} : { actions })} />;
    case "question-card":
      return (
        <QuestionCardBlock key={index} block={block} t={t} {...(actions === undefined ? {} : { actions })} />
      );
    case "connection-card":
      return <ConnectionCardBlock key={index} block={block} />;
    case "credential-card":
      return <CredentialCardBlock key={index} block={block} {...(actions === undefined ? {} : { actions })} />;
    case "task-progress-card":
      // `actions` must be forwarded, or the card's Stop control is unreachable in the browser while its
      // own unit test — which calls the component directly — still passes.
      return (
        <TaskProgressCardBlock key={index} block={block} t={t} locale={locale} {...(actions === undefined ? {} : { actions })} />
      );
    case "task-summary-card":
      return <TaskSummaryCardBlock key={index} block={block} t={t} locale={locale} />;
    case "task-overview-card":
      return <TaskOverviewCardBlock key={index} block={block} t={t} locale={locale} />;
    case "code-diff-card":
      return <CodeDiffCardBlock key={index} block={block} t={t} />;
    case "project-picker-card":
      return <ProjectPickerCardBlock key={index} block={block} t={t} />;
    case "form-card":
      return <FormCardBlock key={index} block={block} {...(actions === undefined ? {} : { actions })} />;
    case "browser-session-card":
    case "computer-session-card":
      // One renderer for both surfaces: the question "who may act on this" does not change with the surface, and
      // two components would be two places for the answer to drift.
      return (
        <ControlSessionCardBlock
          key={index}
          block={block}
          client={client}
          t={t}
          locale={locale}
          {...(actions === undefined ? {} : { actions })}
        />
      );
    case "command-card": {
      // Read through the contract: a card that does not match it draws nothing rather than half a card.
      const card = commandCardSchema.safeParse(block);
      return card.success ? (
        <CommandCardBlock key={index} block={card.data} t={t} {...(actions === undefined ? {} : { actions })} />
      ) : null;
    }
    case "changelog-card": {
      // Read through the contract, like the command card: a card that does not match it draws nothing.
      const card = changelogCardSchema.safeParse(block);
      return card.success ? <ChangelogCardBlock key={index} block={card.data} t={t} /> : null;
    }
    case "terminal-session-card":
      return (
        <TerminalCardBlock key={index} block={block} client={client} t={t} {...(actions === undefined ? {} : { actions })} />
      );
    case "marketplace-results":
      // Forwarded, for the reason the task card's control taught: a component tested by calling it directly passes
      // whether or not the dispatcher hands it anything, and the install action is exactly what would go missing.
      return <MarketplaceResultsBlock key={index} block={block} {...(actions === undefined ? {} : { actions })} />;
    case "reconnect-card":
      return <ReconnectCardBlock key={index} block={block} t={t} />;
    case "surface": {
      const snapshot = (block.snapshot ?? {}) as Record<string, unknown>;
      const definitionRef = (block.definitionRef ?? {}) as Record<string, unknown>;
      return surface({
        instanceId: typeof snapshot.instanceId === "string" ? snapshot.instanceId : undefined,
        definitionId: typeof definitionRef.id === "string" ? definitionRef.id : "",
        textAlternative: typeof snapshot.textAlternative === "string" ? snapshot.textAlternative : "",
        revision: typeof snapshot.capturedRevision === "number" ? snapshot.capturedRevision : 0,
        snapshotId: typeof snapshot.snapshotId === "string" ? snapshot.snapshotId : "",
        bundleRef: typeof snapshot.bundleRef === "string" ? snapshot.bundleRef : undefined,
        catalogDigest: typeof snapshot.catalogDigest === "string" ? snapshot.catalogDigest : undefined,
        capturedAt: typeof snapshot.capturedAt === "string" ? snapshot.capturedAt : undefined,
        stale: snapshot.stale === true,
      });
    }
    case "widget-ref": {
      const textAlternative = typeof block.textAlternative === "string" ? block.textAlternative : "";
      return (
        <div key={index} className="cc-freshness" data-widget-placeholder="true">
          {textAlternative}
        </div>
      );
    }
    default:
      // An unknown block type is dropped rather than rendered as raw JSON: a shape this
      // client does not understand must not reach the DOM.
      return null;
  }
}

/**
 * A form the agent asked for, filled in by the user.
 *
 * The same primitive as the question card, for values the agent cannot enumerate: a question offers named answers,
 * a form asks for text. Both exist because an agent that needs several facts otherwise writes them as prose, gets
 * a paragraph back, and has to guess which sentence answered which request.
 *
 * The draft is view state of this card and nothing else. That is deliberate: a half-typed form must survive a
 * rerender — a turn streaming behind it, a widget resolving, the window resizing, the row being scrolled far enough
 * away to be unmounted (`surface-view-state.tsx`) — and it must **not** survive as a preference or leave the
 * browser session, because a form is a message being composed, not a setting. Submitting sends the answers as the
 * user's own next message, so the transcript stays a conversation and there is one way into the agent.
 *
 * Read-only once the conversation has moved past it, for the reason the question card is: the transcript is
 * immutable, and a form that stayed open would invite a second submission of answers already sent.
 */
export function FormCardBlock({
  block,
  actions,
}: {
  block: Record<string, unknown>;
  actions?: BlockActions;
}): ReactElement | null {
  const t = useT();
  if (block.owner !== "host") return null;

  const formId = typeof block.formId === "string" ? block.formId : "";
  const title = typeof block.title === "string" ? block.title : "";
  const submitLabel = typeof block.submitLabel === "string" ? block.submitLabel : t("blocks.common.send");
  const raw = Array.isArray(block.fields) ? (block.fields as Record<string, unknown>[]) : [];
  const fields = raw
    .filter((entry) => typeof entry.id === "string" && typeof entry.label === "string")
    .map((entry) => ({
      id: entry.id as string,
      label: entry.label as string,
      kind: entry.kind === "textarea" || entry.kind === "select" ? entry.kind : ("text" as const),
      options: Array.isArray(entry.options) ? entry.options.filter((o): o is string => typeof o === "string") : [],
      required: entry.required === true,
      ...(typeof entry.placeholder === "string" ? { placeholder: entry.placeholder } : {}),
    }));

  const open =
    formId !== "" && actions?.onFormSubmit !== undefined && actions.openFormIds?.includes(formId) === true;

  // Keyed by field id, so the draft is exactly the answers and nothing else survives a rerender.
  const [values, setValues] = useSurfaceViewState<Record<string, string>>("form.values", {});
  const missing = fields.filter((field) => field.required && (values[field.id] ?? "").trim() === "");
  const complete = missing.length === 0 && fields.length > 0;
  /*
   * A closed form this view holds no answers for: never sent, or sent before a reload emptied the draft. A dash per
   * field would read as an answer of nothing, so the card says it is closed and where a sent answer lives instead.
   */
  const unanswered = !open && fields.every((field) => (values[field.id] ?? "").trim() === "");

  const summary = (): string => {
    const lines = fields
      .map((field) => {
        const value = (values[field.id] ?? "").trim();
        return value === "" ? undefined : `${field.label}: ${value}`;
      })
      .filter((line): line is string => line !== undefined);
    return [title, ...lines].join("\n");
  };

  return (
    <section
      className="cc-card"
      data-host-card="form"
      data-owner="host"
      data-form-id={formId}
      data-form-open={open ? "true" : "false"}
      aria-label={title}
    >
      <header className="cc-card-head">
        <span className="cc-card-title">{title}</span>
      </header>
      <div className="cc-card-body">
        {unanswered ? (
          <p className="cc-freshness" data-form-closed="true">
            {t("blocks.form.closed")}
          </p>
        ) : null}
        <div className="cc-form-fields" data-form-fields={fields.length} hidden={unanswered}>
          {fields.map((field) => (
            <label key={field.id} className="cc-credential-field">
              <span>
                {field.label}
                {field.required ? <span aria-hidden="true"> *</span> : null}
              </span>
              {/*
                Rendered as text once the form is closed. The value the user gave stays readable — it is what the
                conversation is about — and the control goes, because there is nothing left to submit.
              */}
              {!open ? (
                <span className="cc-form-answer" data-form-answer={field.id}>
                  {(values[field.id] ?? "").trim() === "" ? "—" : values[field.id]}
                </span>
              ) : field.kind === "textarea" ? (
                <textarea
                  className="cc-personal-instructions"
                  data-form-input={field.id}
                  rows={3}
                  value={values[field.id] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                />
              ) : field.kind === "select" ? (
                <select
                  className="cc-select"
                  data-form-input={field.id}
                  value={values[field.id] ?? ""}
                  onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                >
                  <option value="">—</option>
                  {field.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  data-form-input={field.id}
                  value={values[field.id] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
        {!open ? null : (
          <>
            <div className="cc-card-actions">
              <button
                type="button"
                className="cc-action"
                data-emphasis="primary"
                data-form-submit="true"
                // Disabled with the reason shown, rather than submitting a form with holes in it.
                disabled={!complete}
                onClick={() => actions?.onFormSubmit?.({ formId, summary: summary(), values })}
              >
                {submitLabel}
              </button>
            </div>
            {complete ? null : (
              <p className="cc-freshness" data-form-incomplete="true">
                {t("blocks.form.missingFieldsLabel")}: {missing.map((field) => field.label).join(", ")}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * A browser session the node is driving, and who has the wheel.
 *
 * The card exists because the one capability that runs unsupervised is the one where "the agent is still driving"
 * has to be something the user can change. Two verbs, and the copy distinguishes them, because they do different
 * things: takeover leaves the session running and its page intact while making the agent's next action invalid,
 * and stop ends the session.
 *
 * The epoch is shown rather than kept internal. It is what decides whether an action the agent planned earlier is
 * still admissible, so a reader who cannot see it cannot tell whether a takeover actually took effect.
 */
/** The risk lanes in words, because a lane name is not something a reader should have to learn. */
export function riskLaneLabel(t: (key: MessageKey) => string, lane: string): string {
  switch (lane) {
    case "isolated-ui":
      return t("blocks.marketplace.lane.isolatedUi");
    case "service":
      return t("blocks.marketplace.lane.service");
    case "declarative":
      return t("blocks.marketplace.lane.declarative");
    case "trusted-native":
      return t("blocks.marketplace.lane.trustedNative");
    default:
      return lane;
  }
}

/** Where a result would be fetched from, in one line. */
function describePackageSource(
  raw: unknown,
  t: (key: MessageKey) => string,
): string {
  const source = (raw ?? {}) as Record<string, unknown>;
  if (source.kind === "local" && typeof source.path === "string") return source.path;
  if (source.kind === "git" && typeof source.url === "string") return `${source.url}@${String(source.ref ?? "")}`;
  if (source.kind === "npm" && typeof source.name === "string") return `${source.name}@${String(source.version ?? "")}`;
  return t("blocks.marketplace.unknownSource");
}

/**
 * The results of a marketplace search.
 *
 * It shows what a listing has to show to be judgeable — where it comes from, which version, the digest the install
 * path will check, and the lane the isolation implies — and it carries the install control on the row it acts on.
 * The control reports what the install route answered rather than installing anything itself: the digest is verified,
 * policy and consent are decided, and the effect is audited, all in one place. A second entry point here would be
 * the one place where a listing could become an authorisation.
 *
 * The directory is named in the heading. A result whose origin was invisible would present what some index says as
 * something this machine knows.
 */
type MarketplaceSourceState = "stale" | "not-fetched" | "unreachable" | "unsupported" | "unreadable";

const SOURCE_STATE_KEYS = {
  stale: "blocks.marketplace.sourceState.stale",
  "not-fetched": "blocks.marketplace.sourceState.notFetched",
  unreachable: "blocks.marketplace.sourceState.unreachable",
  unsupported: "blocks.marketplace.sourceState.unsupported",
  unreadable: "blocks.marketplace.sourceState.unreadable",
} as const satisfies Record<MarketplaceSourceState, string>;

/** The card's source notes, keeping only the ones whose state this client can name. */
function readSourceNotes(raw: unknown): { label: string; state: MarketplaceSourceState; reason?: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    if (item === null || typeof item !== "object") return [];
    const note = item as Record<string, unknown>;
    const state = note.state;
    if (typeof note.label !== "string" || typeof state !== "string" || !Object.hasOwn(SOURCE_STATE_KEYS, state)) return [];
    return [
      {
        label: note.label,
        state: state as MarketplaceSourceState,
        ...(typeof note.reason === "string" && note.reason !== "" ? { reason: note.reason } : {}),
      },
    ];
  });
}

/** A row's origin, when the card names one. */
function readOrigin(raw: unknown): { kind: string; label: string } | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const origin = raw as Record<string, unknown>;
  return typeof origin.kind === "string" && typeof origin.label === "string" ? { kind: origin.kind, label: origin.label } : undefined;
}

export function MarketplaceResultsBlock({
  block,
  actions,
}: {
  block: Record<string, unknown>;
  actions?: BlockActions | undefined;
}): ReactElement {
  const t = useT();
  const directory = typeof block.directory === "string" ? block.directory : "";
  const query = typeof block.query === "string" ? block.query : "";
  const reason = typeof block.unavailableReason === "string" ? block.unavailableReason : undefined;
  const results = Array.isArray(block.results) ? block.results : [];
  const sourceNotes = readSourceNotes(block.sources);

  return (
    <div className="cc-card cc-marketplace" role="group" aria-label={t("blocks.marketplace.searchResultsAria")} data-marketplace="true">
      <header className="cc-card-head">
        <span className="cc-card-title">{t("blocks.marketplace.resultsIn").replace("{directory}", directory)}</span>
      </header>
      <div className="cc-card-body">
        {/*
          A source that did not fully answer is said before the rows, so a partial answer is not read as the whole
          directory and a listing from an earlier copy is not read as live.
        */}
        {sourceNotes.map((note) => (
          <p
            className="cc-card-note"
            key={`${note.label}-${note.state}`}
            data-marketplace-source-state={note.state}
          >
            {note.label}: {t(SOURCE_STATE_KEYS[note.state])}
            {note.reason === undefined ? "" : ` — ${note.reason}`}
          </p>
        ))}
        {reason !== undefined ? (
          // A directory that could not be consulted is a different truth from one that had nothing, so it says so.
          <p className="cc-card-note" data-marketplace-unavailable="true">
            {reason}
          </p>
        ) : results.length === 0 ? (
          <p className="cc-card-note">{t("blocks.marketplace.noMatch").replace("{query}", query)}</p>
        ) : (
          <ul className="cc-marketplace-list">
            {results.map((raw, position) => {
              const result = (raw ?? {}) as Record<string, unknown>;
              const packageId = typeof result.packageId === "string" ? result.packageId : "";
              const version = typeof result.version === "string" ? result.version : "";
              const displayName = typeof result.displayName === "string" ? result.displayName : packageId;
              const description = typeof result.description === "string" ? result.description : "";
              const digest = typeof result.digest === "string" ? result.digest : "";
              // What a listing by a path on this machine showed of its files, sent back so the install is of these files.
              const contentDigest = typeof result.contentDigest === "string" && result.contentDigest !== "" ? result.contentDigest : undefined;
              const lane = typeof result.riskTier === "string" ? result.riskTier : "";
              const origin = readOrigin(result.origin);
              const attempt = actions?.packageInstall?.[packageId];
              /*
               * Out of date only on a row that shows the digest the refused press sent: pressing it again would send the
               * same digest and be refused the same way, so it offers a new search instead. A row from a newer search
               * shows the files as they are now and is not affected.
               */
              const stale =
                attempt?.status === "stale" && contentDigest !== undefined && attempt.staleContentDigest === contentDigest;
              const installState = attempt?.status === "stale" && !stale ? undefined : attempt;
              const stateId = `cc-marketplace-state-${packageId}-${String(position)}`;
              return (
                <li className="cc-marketplace-item" key={`${packageId}-${version}-${position}`} data-marketplace-package={packageId}>
                  <div className="cc-marketplace-name">
                    {displayName} <span className="cc-marketplace-version">{version}</span>
                  </div>
                  {description !== "" && <div className="cc-marketplace-desc">{description}</div>}
                  {Array.isArray(result.widgetAppearance) && result.widgetAppearance.some((entry) =>
                    entry !== null && typeof entry === "object" && entry.mode === "fixed") && (
                    <div className="cc-marketplace-desc" data-widget-appearance="fixed">{t("widgets.appearance.fixed")}</div>
                  )}
                  {/* What installing lets it reach, before the Install press: the install refuses an artifact that differs. */}
                  <PackageReach reach={readReach(result.declaredReach)} />
                  {/* What the listing says that this node does not read, so the row does not pass for all of it. */}
                  <UnreadListingFieldsNote fields={readUnreadFields(result.unreadFields)} />
                  <div className="cc-marketplace-meta">
                    <span data-marketplace-source="true">{describePackageSource(result.source, t)}</span>
                    {/* Which directory listed the row: results from several sources share one card. */}
                    {origin !== undefined && (
                      <span data-marketplace-origin={origin.kind}>{t("blocks.marketplace.listedBy").replace("{label}", origin.label)}</span>
                    )}
                    <span data-marketplace-risk={lane}>{riskLaneLabel(t, lane)}</span>
                    {/* Truncated for the line, complete in the title: the digest is checkable, not decorative. */}
                    <span className="cc-marketplace-digest" title={digest} data-marketplace-digest="true">
                      {digest.length > 18 ? `${digest.slice(0, 18)}…` : digest}
                    </span>
                  </div>
                  {/*
                    Installing goes through the single install route, which applies the execution policy and the install
                    supervisor that already existed. The card was deliberately without this control while that route did
                    not exist, because a button whose action is missing is worse than no button; it exists now, so the
                    control does too — and only where a caller supplied the action, which a read-only snapshot does not.
                  */}
                  {actions?.onInstallPackage !== undefined && (
                    <div className="cc-card-actions cc-marketplace-actions">
                      <button
                        type="button"
                        className="cc-action"
                        data-emphasis="primary"
                        data-install-package={packageId}
                        disabled={installState?.status === "installing" || stale}
                        {...(stale ? { title: t("blocks.marketplace.staleReason"), "aria-describedby": stateId } : {})}
                        onClick={() =>
                          actions.onInstallPackage?.({ packageId, version, ...(contentDigest === undefined ? {} : { contentDigest }) })
                        }
                      >
                        {installState?.status === "installing" ? t("blocks.marketplace.installing") : t("blocks.marketplace.install")}
                      </button>
                      {installState !== undefined && installState.status !== "installing" && (
                        <span id={stateId} className="cc-marketplace-install-state" data-install-state={installState.status}>
                          {installState.message ?? ""}
                        </span>
                      )}
                      {/* The way forward from an out-of-date list: the same search again, as the person's own message. */}
                      {stale && actions.onSearchAgain !== undefined && (
                        <button
                          type="button"
                          className="cc-action"
                          data-marketplace-search-again={packageId}
                          onClick={() => actions.onSearchAgain?.({ query })}
                        >
                          {t("blocks.marketplace.searchAgain")}
                        </button>
                      )}
                      {/* The install waits in the inbox, where the person decides it: one step there, never a decision here. */}
                      {installState?.status === "approval-required" &&
                        installState.approvalId !== undefined &&
                        actions.onOpenInbox !== undefined && (
                          <button
                            type="button"
                            className="cc-action"
                            data-install-open-inbox={installState.approvalId}
                            onClick={() => actions.onOpenInbox?.(`install-approval:${installState.approvalId ?? ""}`)}
                          >
                            {t("blocks.marketplace.openInbox")}
                          </button>
                        )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The captured frame of a session, as a picture.
 *
 * Its own component so the hook that fetches the bytes runs unconditionally: the card below returns early for a
 * block that is not host-owned, and a hook placed after that return would be a hook that sometimes does not run.
 *
 * A frame is never presented as the live screen. The moment it was taken is part of the picture, and while the
 * bytes are still being fetched the caption says so rather than showing an empty box that could be mistaken for a
 * blank screen.
 */
function SessionPreviewFrame({
  client,
  label,
  digest,
  viewport,
  capturedAt,
  locale,
}: {
  client: GatewayClient | undefined;
  label: string;
  digest: string;
  viewport: { width: number; height: number } | undefined;
  capturedAt: string | undefined;
  locale: string;
}): ReactElement {
  const t = useT();
  const url = useObjectUrls(
    (wanted) =>
      client === undefined
        ? Promise.reject(new Error("this view has no node connection"))
        : client.previewObjectUrl(wanted),
    [digest],
  )(digest);

  // Said the way the reader tells time; the exact instant stays on the `time` element for anything that needs it.
  const readable = capturedAt === undefined ? undefined : readableInstant(capturedAt, locale);
  const taken = readable === undefined ? "" : t("blocks.session.takenAtSuffix").replace("{at}", readable);
  const [takenBefore = "", takenAfter = ""] = t("blocks.session.takenAtSuffix").split("{at}");
  return (
    /*
     * The digest is on the element as well as in the fetch, so an assertion can ask the node for the frame the
     * card names and check that what comes back hashes to it. Without that the two halves — a card carrying a
     * reference, and a node holding bytes — could each be right about a different picture.
     */
    <figure className="cc-card-preview" data-control-preview-frame="true" data-control-preview-digest={digest}>
      {url === undefined ? (
        <p className="cc-card-preview-pending" role="status">
          {t("blocks.session.loadingScreenshot")}
        </p>
      ) : (
        <img
          src={url}
          alt={t("blocks.session.screenshotAlt").replace("{label}", label).replace("{taken}", taken)}
          {...(viewport === undefined ? {} : { width: viewport.width, height: viewport.height })}
        />
      )}
      <figcaption>
        {t("blocks.session.captionPrefix")}
        {readable === undefined ? null : (
          <>
            {takenBefore}
            <time dateTime={capturedAt}>{readable}</time>
            {takenAfter}
          </>
        )}
        {t("blocks.session.captionSuffix")}
      </figcaption>
    </figure>
  );
}

export function ControlSessionCardBlock({
  block,
  actions,
  client,
  t = defaultT,
  locale = "vi",
}: {
  block: Record<string, unknown>;
  actions?: BlockActions;
  client?: GatewayClient | undefined;
  t?: (key: MessageKey) => string;
  /** The interface language, for when the frame was taken; Vietnamese by default, like `t`. */
  locale?: string;
}): ReactElement | null {
  if (block.owner !== "host") return null;

  const sessionId = fieldText(block.sessionId);
  const surface = block.type === "computer-session-card" ? "computer" : "browser";
  const declaredPreview = fieldText(block.preview, surface === "browser" ? "available" : "needs-permission");
  const previewReason = typeof block.previewReason === "string" ? block.previewReason : undefined;
  const observable = declaredPreview === "available";
  const label = fieldText(block.label);
  const declaredDriver = fieldText(block.driver, "agent");
  const declaredStatus = fieldText(block.status, "running");
  const declaredEpoch = typeof block.leaseEpoch === "number" ? block.leaseEpoch : 0;
  const state = sessionId === "" ? undefined : actions?.controlSession?.[sessionId];

  // The card's own values are a snapshot; what the node said later wins where the two disagree, because only the
  // node knows who is driving now.
  const stopped = state?.status === "stopped" || declaredStatus === "stopped";
  const driver = state?.status === "taken-over" ? "user" : declaredDriver;
  const leaseEpoch = state?.status === "taken-over" ? state.leaseEpoch : declaredEpoch;
  const running = !stopped;
  const busy = state?.status === "pending";
  /*
   * The captured frame, when there is one. Read defensively because a block is untyped data: a frame that is not
   * shaped like one leaves the card without a picture rather than rendering something that is not the screen.
   */
  const declaredFrame = block.previewFrame;
  const frame = typeof declaredFrame === "object" && declaredFrame !== null ? (declaredFrame as Record<string, unknown>) : undefined;
  const frameDigest = typeof frame?.digest === "string" ? frame.digest : undefined;
  const frameCapturedAt = typeof frame?.capturedAt === "string" ? frame.capturedAt : undefined;
  const declaredViewport =
    typeof frame?.viewport === "object" && frame.viewport !== null
      ? (frame.viewport as Record<string, unknown>)
      : undefined;
  const frameViewport =
    typeof declaredViewport?.width === "number" && typeof declaredViewport.height === "number"
      ? { width: declaredViewport.width, height: declaredViewport.height }
      : undefined;

  return (
    <section
      className="cc-card"
      data-host-card={surface === "computer" ? "computer-session" : "browser-session"}
      data-owner="host"
      data-control-session={sessionId}
      data-control-surface={surface}
      data-control-preview={declaredPreview}
      /* Machine-facing only: an assertion can read the epoch, a reader never sees it. */
      data-control-epoch={leaseEpoch}
      data-control-driver={driver}
      data-control-status={stopped ? "stopped" : "running"}
      aria-label={t("blocks.session.browserSessionAria").replace("{label}", label)}
    >
      {frameDigest === undefined ? null : (
        <SessionPreviewFrame
          client={client}
          label={label}
          digest={frameDigest}
          viewport={frameViewport}
          capturedAt={frameCapturedAt}
          locale={locale}
        />
      )}
      <header className="cc-card-head">
        <span className="cc-card-title">{label}</span>
        <span className="cc-badge" data-tone={stopped ? "" : "ok"}>
          {stopped ? t("blocks.session.stopped") : t("blocks.session.running")}
        </span>
      </header>
      <div className="cc-card-body">
        <dl className="cc-fields">
          <dt>{t("blocks.session.whoIsDriving")}</dt>
          <dd data-control-driver-label="true">{driver === "user" ? t("blocks.session.you") : t("blocks.session.agent")}</dd>

        </dl>
        {/*
          Reported before any control, because it decides whether acting is possible at all. A desktop whose screen
          the operating system has not granted to this node cannot be driven, and the permission is not the node's to
          assume — so the card says what is missing and who owns it.
        */}
        {observable ? null : (
          <p className="cc-freshness" data-control-preview-notice={declaredPreview}>
            {declaredPreview === "needs-permission" ? t("blocks.session.needsPermission") : t("blocks.session.cannotView")}
            {previewReason === undefined ? "" : `: ${previewReason}`}
            {t("blocks.session.permissionNotice")}
          </p>
        )}
        {running ? (
          <div className="cc-card-actions">
            {/*
              Offered only while the agent still has the wheel, and only when something can carry the verb out: a
              takeover control on a session the user already drives would be a control with nothing left to do.
            */}
            {driver === "agent" && actions?.onControlTakeover !== undefined ? (
              <button
                type="button"
                className="cc-action"
                data-control-takeover={sessionId}
                disabled={busy}
                onClick={() => actions.onControlTakeover?.({ sessionId })}
              >
                {busy ? t("blocks.session.switching") : t("blocks.session.takeControl")}
              </button>
            ) : null}
            {actions?.onControlStop !== undefined ? (
              <button
                type="button"
                className="cc-action"
                data-control-stop={sessionId}
                disabled={busy}
                onClick={() => actions.onControlStop?.({ sessionId })}
              >
                {t("blocks.session.stopSession")}
              </button>
            ) : null}
          </div>
        ) : null}
        {/*
          Exactly one notice, decided in one place. Two overlapping branches would render two answers to the same
          question — which is what a duplicate marker caught in the browser, and a reader would have seen the same
          thing twice.
        */}
        {state?.status === "failed" ? (
          <p className="cc-freshness" data-control-error="true">
            {state.message}
          </p>
        ) : !running ? (
          <p className="cc-freshness" data-control-notice="stopped">
            {state?.status === "stopped" ? t("blocks.session.stoppedByYou") : t("blocks.session.stoppedOther")}
          </p>
        ) : state?.status === "taken-over" ? (
          /*
           * What takeover actually did. Not "you have control" alone: the user needs to know the agent's already
           * planned action was refused, because that is the part that makes the browser theirs.
           */
          <p className="cc-freshness" data-control-notice="taken-over">
            {t("blocks.session.takenOverNotice")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
