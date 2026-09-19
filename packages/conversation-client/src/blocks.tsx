import { useEffect, useState, type ReactElement } from "react";

import { attachmentRefSchema, type AttachmentRef } from "@clarkcant/contracts";

import { CodeBlock, Markdown } from "./markdown.tsx";
import { formatFileSize } from "./attachments.ts";
import { useAttachmentUrls } from "./use-attachment-urls.ts";
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
 */
export function ReasoningBlock({ block }: { block: Record<string, unknown> }): ReactElement {
  const content = typeof block.content === "string" ? block.content : "";
  const [open, setOpen] = useState(false);

  return (
    <details
      className="cc-tool cc-reasoning"
      data-reasoning="true"
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cc-tool-head">
        <span className="cc-tool-mark" data-status="done" aria-hidden="true">
          ✳
        </span>
        <span className="cc-tool-label">Suy luận của agent</span>
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

export function ArtifactBlock({ block }: { block: Record<string, unknown> }): ReactElement {
  const labelValue = typeof block.label === "string" ? block.label : "artifact";
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream";
  const sizeBytes = typeof block.sizeBytes === "number" ? block.sizeBytes : 0;
  const originNodeId = typeof block.originNodeId === "string" ? block.originNodeId : undefined;
  return (
    <div className="cc-card" data-artifact="true">
      <div className="cc-card-head">
        <span className="cc-card-title">{labelValue}</span>
        <span>
          {mimeType} · {sizeBytes} B{originNodeId === undefined ? "" : ` · từ ${originNodeId}`}
        </span>
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
}

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

  const [chosen, setChosen] = useState<string[]>([]);
  const [text, setText] = useState("");
  // Set the moment an answer leaves, so the card does not invite a second press while the node is answering it.
  const [sent, setSent] = useState(false);
  const answered = sent || (questionId !== "" && actions?.answeredQuestions?.includes(questionId) === true);
  const canAnswer = questionId !== "" && actions?.onQuestionAnswer !== undefined && !answered;
  const submit = (answer: { text?: string; optionIds?: string[]; confirmed?: boolean }): void => {
    if (!canAnswer) return;
    setSent(true);
    actions?.onQuestionAnswer?.({ questionId, ...answer });
  };
  const toggle = (id: string): void => {
    setChosen((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  };

  return (
    <section
      className="cc-card"
      data-host-card="question"
      data-owner="host"
      data-question-id={questionId}
      data-question-kind={kind}
      data-answered={answered ? "true" : "false"}
    >
      <header className="cc-card-head">
        <span className="cc-card-title">{answered ? "Câu hỏi đã có câu trả lời" : "Cần bạn chọn"}</span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{prompt}</p>

        {!answered && kind === "confirm" && (
          <div className="cc-card-actions">
            <button type="button" className="cc-action" data-question-answer="yes" disabled={!canAnswer} onClick={() => submit({ confirmed: true })}>
              Đồng ý
            </button>
            <button type="button" className="cc-action" data-question-answer="no" disabled={!canAnswer} onClick={() => submit({ confirmed: false })}>
              Không
            </button>
          </div>
        )}

        {!answered && (kind === "single-choice" || kind === "multi-choice") && (
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
              </button>
            ))}
            {kind === "multi-choice" && (
              <button
                type="button"
                className="cc-action"
                data-question-answer="submit"
                disabled={!canAnswer || chosen.length === 0}
                onClick={() => submit({ optionIds: chosen })}
              >
                Gửi
              </button>
            )}
          </div>
        )}

        {!answered && kind === "text" && (
          <div className="cc-card-actions">
            <input
              className="cc-action"
              data-question-text="true"
              value={text}
              placeholder="Trả lời của bạn"
              disabled={!canAnswer}
              onChange={(event) => setText(event.target.value)}
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

        {answered && (
          <p className="cc-freshness" style={{ margin: 0 }}>
            Câu trả lời đã được ghi vào hội thoại này.
          </p>
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
export function TaskProgressCardBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
  if (block.owner !== "host") return null;
  const goal = fieldText(block.goal);
  const status = fieldText(block.status, "working");
  const steps = listOf(block.steps);
  const targetNode = (block.targetNode ?? undefined) as Record<string, unknown> | undefined;
  const cancellable = block.cancellable === true;
  const startedAt = fieldText(block.startedAt);

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
              <dd>{fieldText(targetNode.label, fieldText(targetNode.nodeId))}</dd>
            </>
          )}
          <dt>Dừng được</dt>
          <dd>{cancellable ? "có" : "không"}</dd>
        </dl>
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
    <section className="cc-card" data-host-card="code-diff" data-owner="host" data-truncated={truncated}>
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

export const HOST_OWNED_BLOCK_TYPES = [
  "system-card",
  "approval-card",
  "question-card",
  "credential-card",
  "connection-card",
  "task-progress-card",
  "task-summary-card",
  "task-overview-card",
  "code-diff-card",
  "project-picker-card",
  "reconnect-card",
] as const;

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
      return <ArtifactBlock key={index} block={block} />;
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
      return <TaskProgressCardBlock key={index} block={block} />;
    case "task-summary-card":
      return <TaskSummaryCardBlock key={index} block={block} />;
    case "task-overview-card":
      return <TaskOverviewCardBlock key={index} block={block} />;
    case "code-diff-card":
      return <CodeDiffCardBlock key={index} block={block} />;
    case "project-picker-card":
      return <ProjectPickerCardBlock key={index} block={block} />;
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
