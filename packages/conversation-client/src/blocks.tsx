import { useEffect, useState, type ReactElement } from "react";

import { attachmentRefSchema, type AttachmentRef } from "@clarkcant/contracts";

import { CodeBlock, Markdown } from "./markdown.tsx";
import { formatFileSize } from "./attachments.ts";
import { useAttachmentUrls } from "./use-attachment-urls.ts";
import { useObjectUrls } from "./use-object-urls.ts";
import type { GatewayClient } from "./api.ts";

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
      {content}
    </p>
  );
}

/**
 * A tool call, drawn as a widget that opens and closes.
 *
 * Open while it runs, closed once it is done: a call in flight is the thing the user is waiting on, and
 * a call that finished is a receipt they can open if they want it. A failure stays open, because the
 * one thing nobody wants collapsed is the reason something did not work.
 *
 * The state is a `details` element with React driving its open attribute, rather than a div with a click
 * handler: a disclosure built from the platform is keyboard operable, announced as one, and reachable
 * by a screen reader without anything extra to remember.
 */
export function ToolActivityBlock({ block }: { block: Record<string, unknown> }): ReactElement {
  const status = typeof block.status === "string" ? block.status : "done";
  const name = typeof block.name === "string" ? block.name : "tool";
  const label = typeof block.label === "string" && block.label !== "" ? block.label : name;
  const path = typeof block.path === "string" ? block.path : undefined;
  const result = typeof block.result === "string" ? block.result : "";
  const args = typeof block.args === "object" && block.args !== null ? (block.args as Record<string, unknown>) : {};
  const language = typeof block.language === "string" ? block.language : undefined;
  const [open, setOpen] = useState(status === "running" || status === "failed");

  // A call that finishes closes itself — keyed on the status so it happens once, and so a widget the
  // user opened by hand is not closed again underneath them.
  useEffect(() => {
    if (status === "done") setOpen(false);
  }, [status]);

  return (
    <details
      className="cc-tool"
      data-tool-name={name}
      data-tool-status={status}
      data-tool-call={typeof block.toolCallId === "string" ? block.toolCallId : undefined}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cc-tool-head">
        <span className="cc-tool-mark" data-status={status} aria-hidden="true">
          {status === "running" ? "◐" : status === "failed" ? "✕" : "✓"}
        </span>
        <span className="cc-tool-label">{label}</span>
        {path !== undefined && <code className="cc-tool-path">{path}</code>}
        <span className="cc-sr-only">
          {status === "running" ? "đang chạy" : status === "failed" ? "lỗi" : "xong"}
        </span>
      </summary>
      <div className="cc-tool-body">
        {Object.keys(args).length > 0 && <CodeBlock code={JSON.stringify(args, null, 2)} language="json" label="tham số" />}
        {result !== "" && <CodeBlock code={result} {...(language === undefined ? {} : { language })} label="kết quả" />}
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
  const content = typeof block.content === "string" ? block.content : "";
  const [open, setOpen] = useState(false);

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
        <span className="cc-tool-label">Suy luận của agent</span>
        {writing && <span className="cc-reasoning-writing">đang viết…</span>}
      </summary>
      <div className="cc-tool-body cc-reasoning-body">
        <Markdown text={content} />
      </div>
    </details>
  );
}

export function EvidenceBlock({ block }: { block: Record<string, unknown> }): ReactElement {
  const verdict = typeof block.verdict === "string" ? block.verdict : "not-verified";
  const summary = typeof block.summary === "string" ? block.summary : "";
  const kind = typeof block.kind === "string" ? block.kind : "evidence";
  return (
    <div className="cc-evidence" data-verdict={verdict} data-evidence-kind={kind}>
      <span className="cc-badge" data-tone={verdict === "verified" ? "ok" : verdict === "contradicted" ? "danger" : "warn"}>
        {verdict}
      </span>
      <span>{summary}</span>
    </div>
  );
}

export function ArtifactBlock({
  block,
  actions,
}: {
  block: Record<string, unknown>;
  actions?: BlockActions;
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
          {/* A node id is an internal name; "a node khác" says the same useful thing without exposing one. */}
          {mimeType} · {sizeBytes} B{originNodeId === undefined ? "" : " · từ một node khác"}
        </span>
      </div>
      {/*
        The snapshot is what the message recorded. What the node holds now is a separate question, and only the
        node can answer it — an artifact can expire between the message being written and somebody reading it.
      */}
      {artifactId !== "" && actions?.onArtifactOpen !== undefined ? (
        <div className="cc-chip-row">
          <button
            type="button"
            className="cc-chip"
            data-artifact-open={artifactId}
            /*
             * Disabled only while a request is in flight. Unlike stopping a task, reopening is a question rather
             * than a state change: the answer can have changed since it was asked — an artifact that had expired
             * may have been produced again — so asking a second time has to stay possible.
             */
            disabled={state?.status === "pending"}
            onClick={() => actions.onArtifactOpen?.({ artifactId })}
          >
            {state?.status === "pending" ? "Đang mở…" : "Mở lại"}
          </button>
        </div>
      ) : null}
      {state === undefined || state.status === "pending" ? null : state.status === "failed" ? (
        <p className="cc-freshness" data-artifact-error="true">
          {state.message}
        </p>
      ) : (
        <dl className="cc-fields" data-artifact-opened="true" data-artifact-expired={String(state.expired)}>
          {/*
            An expired artifact is reported as a distinct outcome rather than as a failure: the node had the
            file and a retention window passed, which calls for asking for it again rather than for looking for
            a fault.
          */}
          {state.expired ? (
            <p className="cc-freshness" data-artifact-expiry="true">
              Node đã từng giữ artifact này nhưng đã hết hạn lưu trữ{state.expiresAt === null ? "" : ` từ ${state.expiresAt}`}.
              Nội dung không còn, nên hãy yêu cầu tạo lại nếu vẫn cần.
            </p>
          ) : null}
          <dt>Kích thước</dt>
          <dd>{state.sizeBytes} B</dd>
          <dt>Loại</dt>
          <dd>{state.mimeType}</dd>
          <dt>Digest</dt>
          <dd>
            <code>{state.digest}</code>
          </dd>
          <dt>Tạo lúc</dt>
          <dd>{state.createdAt}</dd>
          <dt>Nguồn</dt>
          <dd>{state.originNodeId}</dd>
          <dt>Hết hạn</dt>
          <dd>{state.expiresAt ?? "không"}</dd>
        </dl>
      )}
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
 * Host-owned system card.
 *
 * `owner` must be `"host"`. A card that claims host ownership without it is refused
 * outright rather than rendered with weaker chrome — the whole point of the attribute is
 * that it cannot be obtained by anyone except the host.
 */
export function SystemCardBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
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
    const summary = [valueOf("Provider"), valueOf("Model"), valueOf("Thời gian")].filter(
      (value): value is string => value !== undefined,
    );
    const rest = fields.filter((field) => !["Provider", "Model", "Thời gian"].includes(String(field.label)));
    return (
      <details
        className="cc-model-note"
        data-host-card="system"
        data-owner="host"
        data-subject={subject}
        data-status={status}
        data-model-note="true"
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

  return (
    <section className="cc-card" data-host-card="system" data-owner="host" data-status={status} data-subject={subject}>
      <header className="cc-card-head">
        <span className="cc-card-title">{title}</span>
        <span className="cc-badge" data-tone={CARD_TONE[status] ?? ""}>
          {status}
        </span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{detail}</p>
        {fields.length > 0 && (
          <dl className="cc-fields">
            {fields.map((field, index) => (
              <Fragment key={index}>
                <dt>{String(field.label ?? "")}</dt>
                <dd>
                  {String(field.value ?? "")}
                  {typeof field.freshness === "string" && (
                    <span className="cc-freshness" data-freshness={field.freshness}>{` · ${field.freshness}`}</span>
                  )}
                </dd>
              </Fragment>
            ))}
          </dl>
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
 * Four states because the four are different truths: it is happening, it happened, a person has to decide first, or
 * it was refused. Collapsing the middle two into "not installed" would hide that one of them is waiting on the
 * reader and the other is not.
 */
export interface PackageInstallState {
  status: "installing" | "installed" | "approval-required" | "refused";
  /** The node's own words where it gave them. */
  message?: string;
  generationId?: string;
  verified?: string;
}

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
  onInstallPackage?: (input: { packageId: string; version: string }) => void;
  /** The attempt for each package id, so the card shows an outcome instead of a spinner that never ends. */
  packageInstall?: Record<string, PackageInstallState>;
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
}

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
export function QuestionCardBlock({
  block,
  actions,
}: {
  block: Record<string, unknown>;
  actions?: BlockActions;
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
      aria-label={prompt}
    >
      <header className="cc-card-head">
        <span className="cc-card-title">{answered ? "Câu hỏi đã có câu trả lời" : "Cần bạn chọn"}</span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{prompt}</p>

        {!answered && canAnswer && kind === "confirm" && (
          <div className="cc-card-actions">
            <button type="button" className="cc-action" data-question-answer="yes" disabled={!canAnswer} onClick={() => submit({ confirmed: true })}>
              Đồng ý
            </button>
            <button type="button" className="cc-action" data-question-answer="no" disabled={!canAnswer} onClick={() => submit({ confirmed: false })}>
              Không
            </button>
          </div>
        )}

        {!answered && canAnswer && (kind === "single-choice" || kind === "multi-choice") && (
          <div className="cc-card-actions">
            {offered.map((option) => (
              <button
                key={option.id}
                type="button"
                className="cc-action"
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
                {option.label}
                {option.description === undefined ? null : (
                  <span className="cc-setting-desc"> {option.description}</span>
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
                Gửi
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
              placeholder="Trả lời của bạn"
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
              Gửi
            </button>
          </div>
        )}

        {sending && !answered && (
          <p className="cc-freshness" style={{ margin: 0 }}>
            Đang gửi câu trả lời…
          </p>
        )}

        {answered && (
          <p className="cc-freshness" style={{ margin: 0 }}>
            Câu trả lời đã được ghi vào hội thoại này.
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
  if (block.owner !== "host") return null;
  const description = typeof block.operationDescription === "string" ? block.operationDescription : "";
  const digest = typeof block.operationDigest === "string" ? block.operationDigest : "";
  const effect = typeof block.effectCategory === "string" ? block.effectCategory : "external-write";
  const decision = typeof block.decision === "string" ? block.decision : "pending";
  const approvalId = typeof block.approvalId === "string" ? block.approvalId : "";
  const payload = typeof block.payload === "string" ? block.payload : undefined;
  const deciding = actions?.decidingApprovalId === approvalId && approvalId !== "";
  const decided = approvalId !== "" && actions?.decidedApprovals?.includes(approvalId) === true;
  const canDecide = decision === "pending" && !decided && approvalId !== "" && actions?.onApprovalDecide !== undefined;

  return (
    <section className="cc-card" data-host-card="approval" data-owner="host" data-decision={decision} data-approval-id={approvalId}>
      <header className="cc-card-head">
        <span className="cc-card-title">Cần bạn xác nhận</span>
        <span className="cc-badge" data-tone={effect === "destructive" ? "danger" : "warn"}>
          {effect}
        </span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{description}</p>
        {payload !== undefined && (
          <CodeBlock
            code={commandOf(payload) ?? payload}
            {...(commandOf(payload) === undefined ? {} : { language: "bash" })}
            label="lệnh sẽ chạy"
          />
        )}
        {/* The digest is shown so an approved plan cannot be swapped for another one. */}
        <p className="cc-freshness" style={{ margin: 0 }}>
          operation {digest.slice(0, 20)}…
        </p>
        <p className="cc-freshness" style={{ margin: 0 }}>
          Chỉ bạn xác nhận được. Model không thể tự duyệt.
        </p>
        {decision === "pending" && !decided ? (
          <div className="cc-card-actions">
            <button
              type="button"
              className="cc-action"
              data-approve={approvalId}
              disabled={!canDecide || deciding}
              onClick={() => actions?.onApprovalDecide?.({ approvalId, digest, decision: "granted" })}
            >
              {deciding ? "Đang chạy…" : "Duyệt và chạy"}
            </button>
            <button
              type="button"
              className="cc-action"
              data-deny={approvalId}
              disabled={!canDecide || deciding}
              onClick={() => actions?.onApprovalDecide?.({ approvalId, digest, decision: "denied" })}
            >
              Từ chối
            </button>
          </div>
        ) : (
          <span className="cc-badge" data-approval-decision={decided ? "answered" : decision}>
            {decided ? "đã quyết định" : decision}
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

export function ConnectionCardBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
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
          {account === undefined ? "Chưa xác minh tài khoản." : `Tài khoản: ${account}`}
        </p>
        {missing.length > 0 && (
          <p className="cc-freshness" style={{ margin: 0 }} data-missing-scopes="true">
            Chưa được cấp: {missing.join(", ")}
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
  const [values, setValues] = useState<Record<string, string>>({});
  const complete = fields.length > 0 && fields.every((field) => (values[field.name] ?? "") !== "");
  const status = actions?.credentialStatus?.requestId === requestId ? actions.credentialStatus.message : undefined;

  return (
    <section className="cc-card" data-host-card="credential" data-owner="host">
      <header className="cc-card-head">
        <span className="cc-card-title">Cần thông tin đăng nhập</span>
        <span className="cc-badge">{destination}</span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{purpose}</p>
        {description !== "" && description !== purpose && (
          <p className="cc-freshness" style={{ margin: 0 }} data-credential-description="true">
            {description}
          </p>
        )}
        {consumer !== "" && (
          <p className="cc-freshness" style={{ margin: 0 }} data-credential-consumer={consumer}>
            Sẽ được dùng bởi: {consumer}
          </p>
        )}
        {scope !== "" && (
          <p className="cc-freshness" style={{ margin: 0 }} data-credential-scope={scope}>
            Lưu trên: {scope}
          </p>
        )}
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
            <button
              type="submit"
              className="cc-icon-btn"
              style={{ width: "auto", padding: "0 var(--cc-space-sm)" }}
              disabled={!complete}
              data-credential-submit="true"
            >
              Lưu
            </button>
          </form>
        )}
        {status !== undefined && (
          <p className="cc-freshness" data-credential-status="true" style={{ margin: 0 }}>
            {status}
          </p>
        )}
        {/* The value is entered in a host-owned field; it never enters the transcript. */}
        <p className="cc-freshness" style={{ margin: 0 }}>
          Giá trị bạn nhập không đi vào hội thoại, không vào model.
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
}: {
  block: Record<string, unknown>;
  actions?: BlockActions;
}): ReactElement | null {
  if (block.owner !== "host") return null;
  const goal = fieldText(block.goal);
  const status = fieldText(block.status, "working");
  const steps = listOf(block.steps);
  const targetNode = (block.targetNode ?? undefined) as Record<string, unknown> | undefined;
  const cancellable = block.cancellable === true;
  const startedAt = fieldText(block.startedAt);
  const taskId = fieldText(block.taskId);
  const stopState = taskId === "" ? undefined : actions?.taskStop?.[taskId];

  return (
    <section className="cc-card" data-host-card="task-progress" data-owner="host" data-status={status}>
      <header className="cc-card-head">
        <span className="cc-card-title">{goal}</span>
        <span className="cc-badge" data-tone={TASK_STATUS_TONE[status] ?? ""}>
          {status}
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
          <dt>Bắt đầu</dt>
          <dd>{startedAt}</dd>
          {targetNode !== undefined && (
            <>
              {/* Named, because a task running elsewhere must not read as a local one. */}
              <dt>Chạy trên</dt>
              {/* Named only if it has a name a person would recognise; otherwise "một node khác", not an id. */}
              <dd>{fieldText(targetNode.label, "một node khác")}</dd>
            </>
          )}
          <dt>Dừng được</dt>
          <dd data-task-cancellable={cancellable ? "true" : "false"}>{cancellable ? "có" : "không"}</dd>
        </dl>
        {/*
          The card used to say a task could be stopped and offer nothing that stopped it. The control appears
          exactly when the block says the task is cancellable, so the claim and the affordance cannot drift.
        */}
        {cancellable && taskId !== "" && actions?.onTaskStop !== undefined ? (
          <div className="cc-chip-row">
            <button
              type="button"
              className="cc-chip"
              data-task-stop={taskId}
              disabled={stopState !== undefined && stopState.status !== "failed"}
              onClick={() => actions.onTaskStop?.({ taskId })}
            >
              {stopState?.status === "pending" ? "Đang gửi yêu cầu dừng…" : "Dừng lại"}
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
            {stopState.confirmed
              ? "Đã dừng. Không có việc nào đang chạy nên không còn gì đang chờ."
              : "Đã yêu cầu dừng. Nơi đang chạy việc này sẽ xác nhận khi nó thật sự dừng — trong lúc đó task đang dừng dở, chưa phải đã dừng."}
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
export function TaskSummaryCardBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
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
          {outcome}
        </span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{summary}</p>
        <p className="cc-evidence" data-verdict={evidence} style={{ margin: 0 }}>
          <span className="cc-badge" data-tone={evidence === "verified" ? "ok" : evidence === "contradicted" ? "danger" : "warn"}>
            {evidence}
          </span>
          <span className="cc-freshness">{`${(durationMs / 1000).toFixed(1)}s`}</span>
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
export function TaskOverviewCardBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
  if (block.owner !== "host") return null;
  const tasks = listOf(block.tasks);
  const unfinished = tasks.filter((task) => {
    const status = fieldText(task.status);
    return status === "working" || status === "queued" || status === "blocked" || status === "needs-decision";
  }).length;

  return (
    <section className="cc-card" data-host-card="task-overview" data-owner="host" data-unfinished={unfinished}>
      <header className="cc-card-head">
        <span className="cc-card-title">Các việc trong hội thoại</span>
        <span className="cc-badge">{tasks.length}</span>
      </header>
      <div className="cc-card-body">
        <p className="cc-freshness" style={{ margin: 0 }} data-unfinished-count={unfinished}>
          {unfinished === 0 ? "Không còn việc nào đang chạy." : `${unfinished} việc còn dở.`}
        </p>
        <ul className="cc-task-list">
          {tasks.map((task, index) => {
            const status = fieldText(task.status, "queued");
            return (
              <li key={index} data-task-status={status}>
                <span className="cc-badge" data-tone={TASK_STATUS_TONE[status] ?? ""}>
                  {status}
                </span>
                <span>{fieldText(task.goal)}</span>
                <span className="cc-freshness">{fieldText(task.updatedAt)}</span>
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
export function CodeDiffCardBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
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
      aria-label={`Diff: ${summary}`}
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
            Diff đã được rút gọn để vừa khung. Phần còn lại không hiển thị ở đây.
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
            Mở trong editor
          </button>
          <span className="cc-freshness" data-action-blocked-reason="true">
            Node chưa có capability mở editor, nên nút này chưa nối được.
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
export function ProjectPickerCardBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
  if (block.owner !== "host") return null;
  const prompt = fieldText(block.prompt);
  const roots = listOf(block.roots);
  const allowManualEntry = block.allowManualEntry === true;

  return (
    <section className="cc-card" data-host-card="project-picker" data-owner="host">
      <header className="cc-card-head">
        <span className="cc-card-title">Chọn project</span>
        <span className="cc-badge">{roots.length}</span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{prompt}</p>
        {roots.length === 0 ? (
          <p className="cc-freshness" style={{ margin: 0 }}>
            Node này chưa được cấp project root nào.
          </p>
        ) : (
          <ul className="cc-root-list">
            {roots.map((root, index) => (
              <li key={index} data-root-id={fieldText(root.rootId)} data-read-only={root.readOnly === true}>
                <span className="cc-setting-text">
                  <span className="cc-setting-label">{fieldText(root.label)}</span>
                  <code className="cc-setting-desc">{fieldText(root.path)}</code>
                </span>
                <span className="cc-badge">{root.readOnly === true ? "chỉ đọc" : "đọc và ghi"}</span>
              </li>
            ))}
          </ul>
        )}
        {allowManualEntry && (
          <p className="cc-freshness" style={{ margin: 0 }}>
            Root ngoài danh sách cần được duyệt riêng, không thêm thẳng ở đây.
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
export function ReconnectCardBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
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
        <span className="cc-card-title">Mất kết nối tới {nodeLabel}</span>
        <span className="cc-badge" data-tone={status === "failed" ? "danger" : "warn"}>
          {status}
        </span>
      </header>
      <div className="cc-card-body">
        <dl className="cc-fields">
          <dt>Node</dt>
          <dd>
            <code>{nodeId}</code>
          </dd>
          <dt>Lần cuối thấy</dt>
          <dd>{lastSeenAt}</dd>
          <dt>Số lần thử</dt>
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
  const resolve = useAttachmentUrls(client, [attachment.attachmentId]);
  const url = resolve(attachment.attachmentId);
  const size = formatFileSize(attachment.sizeBytes);

  if (attachment.kind === "image") {
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
            Không hiện được ảnh {attachment.filename}.
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

  // Text and PDF: a card with a way to open it. A pdf is not rendered in place, because the node serves it as
  // a download and drawing it inline here would claim a preview this node does not produce.
  return (
    <div
      className="cc-attachment"
      data-attachment-block="true"
      data-attachment-kind={attachment.kind}
      data-attachment-id={attachment.attachmentId}
    >
      <span className="cc-attachment-name">{attachment.filename}</span>
      <span className="cc-attachment-size">{size}</span>
      {url === undefined ? (
        <span className="cc-attachment-missing" data-attachment-missing="true">
          Không tải được tệp đính kèm.
        </span>
      ) : (
        <a className="cc-attachment-open" href={url} download={attachment.filename} data-attachment-download="true">
          Tải về
        </a>
      )}
    </div>
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
): ReactElement | null {
  const type = typeof block.type === "string" ? block.type : "";

  switch (type) {
    case "text":
      return <TextBlock key={index} block={block} />;
    case "attachment":
      // The client is what fetches the bytes: an attachment's content route needs the bearer token, so a block
      // drawn without one still shows the file rather than pretending it is missing.
      return <AttachmentBlock key={index} block={block} client={client} />;
    case "tool-activity":
      return <ToolActivityBlock key={index} block={block} />;
    case "reasoning":
      return <ReasoningBlock key={index} block={block} />;
    case "evidence":
      return <EvidenceBlock key={index} block={block} />;
    case "artifact":
      // Forwarded, for the reason the task card's control taught: a component tested by calling it directly
      // passes whether or not the dispatcher hands it anything.
      return <ArtifactBlock key={index} block={block} {...(actions === undefined ? {} : { actions })} />;
    case "system-card":
      return <SystemCardBlock key={index} block={block} />;
    case "approval-card":
      return <ApprovalCardBlock key={index} block={block} {...(actions === undefined ? {} : { actions })} />;
    case "question-card":
      return <QuestionCardBlock key={index} block={block} {...(actions === undefined ? {} : { actions })} />;
    case "connection-card":
      return <ConnectionCardBlock key={index} block={block} />;
    case "credential-card":
      return <CredentialCardBlock key={index} block={block} {...(actions === undefined ? {} : { actions })} />;
    case "task-progress-card":
      // `actions` must be forwarded, or the card's Stop control is unreachable in the browser while its
      // own unit test — which calls the component directly — still passes.
      return (
        <TaskProgressCardBlock key={index} block={block} {...(actions === undefined ? {} : { actions })} />
      );
    case "task-summary-card":
      return <TaskSummaryCardBlock key={index} block={block} />;
    case "task-overview-card":
      return <TaskOverviewCardBlock key={index} block={block} />;
    case "code-diff-card":
      return <CodeDiffCardBlock key={index} block={block} />;
    case "project-picker-card":
      return <ProjectPickerCardBlock key={index} block={block} />;
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
          {...(actions === undefined ? {} : { actions })}
        />
      );
    case "marketplace-results":
      // Forwarded, for the reason the task card's control taught: a component tested by calling it directly passes
      // whether or not the dispatcher hands it anything, and the install action is exactly what would go missing.
      return <MarketplaceResultsBlock key={index} block={block} {...(actions === undefined ? {} : { actions })} />;
    case "reconnect-card":
      return <ReconnectCardBlock key={index} block={block} />;
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
 * The draft is component state and nothing else. That is deliberate: a half-typed form must survive a rerender —
 * a turn streaming behind it, a widget resolving, the window resizing — and it must **not** survive as a
 * preference, because a form is a message being composed, not a setting. Submitting sends the answers as the
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
  if (block.owner !== "host") return null;

  const formId = typeof block.formId === "string" ? block.formId : "";
  const title = typeof block.title === "string" ? block.title : "";
  const submitLabel = typeof block.submitLabel === "string" ? block.submitLabel : "Gửi";
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
  const [values, setValues] = useState<Record<string, string>>({});
  const missing = fields.filter((field) => field.required && (values[field.id] ?? "").trim() === "");
  const complete = missing.length === 0 && fields.length > 0;

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
      <div className="cc-card-title">{title}</div>
      <div className="cc-form-fields" data-form-fields={fields.length}>
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
              <span className="cc-chip" data-form-answer={field.id}>
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
          <div className="cc-chip-row">
            <button
              type="button"
              className="cc-chip"
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
              Còn thiếu: {missing.map((field) => field.label).join(", ")}
            </p>
          )}
        </>
      )}
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
const RISK_LANE_LABELS: Record<string, string> = {
  "isolated-ui": "widget cách ly",
  service: "service",
  declarative: "khai báo",
  "trusted-native": "native tin cậy",
};

/** Where a result would be fetched from, in one line. */
function describePackageSource(raw: unknown): string {
  const source = (raw ?? {}) as Record<string, unknown>;
  if (source.kind === "local" && typeof source.path === "string") return source.path;
  if (source.kind === "git" && typeof source.url === "string") return `${source.url}@${String(source.ref ?? "")}`;
  if (source.kind === "npm" && typeof source.name === "string") return `${source.name}@${String(source.version ?? "")}`;
  return "không rõ nguồn";
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
export function MarketplaceResultsBlock({
  block,
  actions,
}: {
  block: Record<string, unknown>;
  actions?: BlockActions | undefined;
}): ReactElement {
  const directory = typeof block.directory === "string" ? block.directory : "";
  const query = typeof block.query === "string" ? block.query : "";
  const reason = typeof block.unavailableReason === "string" ? block.unavailableReason : undefined;
  const results = Array.isArray(block.results) ? block.results : [];

  return (
    <div className="cc-card cc-marketplace" role="group" aria-label="Kết quả tìm gói" data-marketplace="true">
      <div className="cc-card-title">Kết quả trong {directory}</div>
      {reason !== undefined ? (
        // A directory that could not be consulted is a different truth from one that had nothing, so it says so.
        <p className="cc-card-note" data-marketplace-unavailable="true">
          {reason}
        </p>
      ) : results.length === 0 ? (
        <p className="cc-card-note">Không có gói nào khớp “{query}”.</p>
      ) : (
        <ul className="cc-marketplace-list">
          {results.map((raw, position) => {
            const result = (raw ?? {}) as Record<string, unknown>;
            const packageId = typeof result.packageId === "string" ? result.packageId : "";
            const version = typeof result.version === "string" ? result.version : "";
            const displayName = typeof result.displayName === "string" ? result.displayName : packageId;
            const description = typeof result.description === "string" ? result.description : "";
            const digest = typeof result.digest === "string" ? result.digest : "";
            const lane = typeof result.riskTier === "string" ? result.riskTier : "";
            const installState = actions?.packageInstall?.[packageId];
            return (
              <li className="cc-marketplace-item" key={`${packageId}-${version}-${position}`} data-marketplace-package={packageId}>
                <div className="cc-marketplace-name">
                  {displayName} <span className="cc-marketplace-version">{version}</span>
                </div>
                {description !== "" && <div className="cc-marketplace-desc">{description}</div>}
                <div className="cc-marketplace-meta">
                  <span data-marketplace-source="true">{describePackageSource(result.source)}</span>
                  <span data-marketplace-risk={lane}>{RISK_LANE_LABELS[lane] ?? lane}</span>
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
                  <div className="cc-marketplace-actions">
                    <button
                      type="button"
                      className="cc-chip"
                      data-install-package={packageId}
                      disabled={installState?.status === "installing"}
                      onClick={() => actions.onInstallPackage?.({ packageId, version })}
                    >
                      {installState?.status === "installing" ? "Đang cài…" : "Cài"}
                    </button>
                    {installState !== undefined && installState.status !== "installing" && (
                      <span className="cc-marketplace-install-state" data-install-state={installState.status}>
                        {installState.message ?? ""}
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
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
}: {
  client: GatewayClient | undefined;
  label: string;
  digest: string;
  viewport: { width: number; height: number } | undefined;
  capturedAt: string | undefined;
}): ReactElement {
  const url = useObjectUrls(
    (wanted) =>
      client === undefined
        ? Promise.reject(new Error("this view has no node connection"))
        : client.previewObjectUrl(wanted),
    [digest],
  )(digest);

  const taken = capturedAt === undefined ? "" : ` lúc ${capturedAt}`;
  return (
    /*
     * The digest is on the element as well as in the fetch, so an assertion can ask the node for the frame the
     * card names and check that what comes back hashes to it. Without that the two halves — a card carrying a
     * reference, and a node holding bytes — could each be right about a different picture.
     */
    <figure className="cc-card-preview" data-control-preview-frame="true" data-control-preview-digest={digest}>
      {url === undefined ? (
        <p className="cc-card-preview-pending" role="status">
          Đang tải ảnh chụp màn hình…
        </p>
      ) : (
        <img
          src={url}
          alt={`Ảnh chụp màn hình phiên ${label}${taken}`}
          {...(viewport === undefined ? {} : { width: viewport.width, height: viewport.height })}
        />
      )}
      <figcaption>Ảnh chụp{taken}, không phải màn hình trực tiếp.</figcaption>
    </figure>
  );
}

export function ControlSessionCardBlock({
  block,
  actions,
  client,
}: {
  block: Record<string, unknown>;
  actions?: BlockActions;
  client?: GatewayClient | undefined;
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
      aria-label={`Phiên browser: ${label}`}
    >
      {frameDigest === undefined ? null : (
        <SessionPreviewFrame
          client={client}
          label={label}
          digest={frameDigest}
          viewport={frameViewport}
          capturedAt={frameCapturedAt}
        />
      )}
      <header className="cc-card-head">
        <span className="cc-card-title">{label}</span>
        <span className="cc-badge" data-tone={stopped ? "" : "ok"}>
          {stopped ? "đã dừng" : "đang chạy"}
        </span>
      </header>
      <dl className="cc-fields">
        <dt>Ai đang điều khiển</dt>
        <dd data-control-driver-label="true">{driver === "user" ? "bạn" : "agent"}</dd>

      </dl>
      {/*
        Reported before any control, because it decides whether acting is possible at all. A desktop whose screen
        the operating system has not granted to this node cannot be driven, and the permission is not the node's to
        assume — so the card says what is missing and who owns it.
      */}
      {observable ? null : (
        <p className="cc-freshness" data-control-preview-notice={declaredPreview}>
          {declaredPreview === "needs-permission" ? "Chưa được cấp quyền xem màn hình" : "Không xem được màn hình"}
          {previewReason === undefined ? "" : `: ${previewReason}`}. Quyền này do hệ điều hành cấp, node không tự cấp
          được, và node sẽ không hành động khi không nhìn thấy gì.
        </p>
      )}
      {running ? (
        <div className="cc-chip-row">
          {/*
            Offered only while the agent still has the wheel, and only when something can carry the verb out: a
            takeover control on a session the user already drives would be a control with nothing left to do.
          */}
          {driver === "agent" && actions?.onControlTakeover !== undefined ? (
            <button
              type="button"
              className="cc-chip"
              data-control-takeover={sessionId}
              disabled={busy}
              onClick={() => actions.onControlTakeover?.({ sessionId })}
            >
              {busy ? "Đang chuyển…" : "Tôi tự điều khiển"}
            </button>
          ) : null}
          {actions?.onControlStop !== undefined ? (
            <button
              type="button"
              className="cc-chip"
              data-control-stop={sessionId}
              disabled={busy}
              onClick={() => actions.onControlStop?.({ sessionId })}
            >
              Dừng phiên
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
          {state?.status === "stopped"
            ? "Phiên đã dừng theo yêu cầu của bạn. Không có hành động nào của agent còn được nhận cho phiên này."
            : "Phiên này đã dừng. Không có hành động nào của agent còn được nhận cho phiên này."}
        </p>
      ) : state?.status === "taken-over" ? (
        /*
         * What takeover actually did. Not "you have control" alone: the user needs to know the agent's already
         * planned action was refused, because that is the part that makes the browser theirs.
         */
        <p className="cc-freshness" data-control-notice="taken-over">
          Bạn đang điều khiển. Hành động agent đã lên kế hoạch từ trước đã bị từ chối vì lease cũ, và agent chỉ
          lấy lại được khi bạn dừng phiên rồi mở phiên mới.
        </p>
      ) : null}
    </section>
  );
}
