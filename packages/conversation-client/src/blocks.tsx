import { type ReactElement } from "react";

/**
 * Block renderers.
 *
 * The important distinction lives here: a host-owned card is drawn with host chrome and
 * `data-owner="host"`, and the renderer refuses to draw one that did not come from the
 * host. A widget or a pack can produce something that looks like an approval, but it
 * cannot produce this element with that attribute, and the E2E suite asserts it.
 */

function textOf(block: Record<string, unknown>): string {
  const content = block.content;
  return typeof content === "string" ? content : "";
}

export function TextBlock({ block }: { block: Record<string, unknown> }): ReactElement {
  const content = textOf(block);
  const streaming = block.streaming === true;
  return (
    <p className="cc-text" data-streaming={streaming} style={{ margin: 0, whiteSpace: "pre-wrap" }}>
      {content}
    </p>
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
export function ApprovalCardBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
  if (block.owner !== "host") return null;
  const description = typeof block.operationDescription === "string" ? block.operationDescription : "";
  const digest = typeof block.operationDigest === "string" ? block.operationDigest.slice(0, 20) : "";
  const effect = typeof block.effectCategory === "string" ? block.effectCategory : "external-write";
  const decision = typeof block.decision === "string" ? block.decision : "pending";

  return (
    <section className="cc-card" data-host-card="approval" data-owner="host" data-decision={decision}>
      <header className="cc-card-head">
        <span className="cc-card-title">Cần bạn xác nhận</span>
        <span className="cc-badge" data-tone={effect === "destructive" ? "danger" : "warn"}>
          {effect}
        </span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{description}</p>
        {/* The digest is shown so an approved plan cannot be swapped for another one. */}
        <p className="cc-freshness" style={{ margin: 0 }}>
          operation {digest}…
        </p>
        <p className="cc-freshness" style={{ margin: 0 }}>
          Chỉ bạn xác nhận được. Model không thể tự duyệt.
        </p>
        {decision === "pending" ? (
          <button
            className="cc-icon-btn"
            style={{ width: "auto", padding: "0 var(--cc-space-md)" }}
            // Wired to the approval route once the decide endpoint lands; until then it is
            // visibly disabled rather than pretending to work.
            disabled
            title="Đường duyệt sẽ bật khi endpoint approval.decide được nối"
          >
            Duyệt
          </button>
        ) : (
          <span className="cc-badge">{decision}</span>
        )}
      </div>
    </section>
  );
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

export function CredentialCardBlock({ block }: { block: Record<string, unknown> }): ReactElement | null {
  if (block.owner !== "host") return null;
  const purpose = typeof block.purpose === "string" ? block.purpose : "";
  const destination = typeof block.destination === "string" ? block.destination : "vault-node";
  return (
    <section className="cc-card" data-host-card="credential" data-owner="host">
      <header className="cc-card-head">
        <span className="cc-card-title">Cần thông tin đăng nhập</span>
        <span className="cc-badge">{destination}</span>
      </header>
      <div className="cc-card-body">
        <p style={{ margin: 0 }}>{purpose}</p>
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

export const HOST_OWNED_BLOCK_TYPES = ["system-card", "approval-card", "credential-card", "connection-card"] as const;

export function renderBlock(
  block: Record<string, unknown>,
  index: number,
  surface: (props: { instanceId: string | undefined; definitionId: string; textAlternative: string; revision: number }) => ReactElement,
): ReactElement | null {
  const type = typeof block.type === "string" ? block.type : "";

  switch (type) {
    case "text":
      return <TextBlock key={index} block={block} />;
    case "evidence":
      return <EvidenceBlock key={index} block={block} />;
    case "artifact":
      return <ArtifactBlock key={index} block={block} />;
    case "system-card":
      return <SystemCardBlock key={index} block={block} />;
    case "approval-card":
      return <ApprovalCardBlock key={index} block={block} />;
    case "connection-card":
      return <ConnectionCardBlock key={index} block={block} />;
    case "credential-card":
      return <CredentialCardBlock key={index} block={block} />;
    case "surface": {
      const snapshot = (block.snapshot ?? {}) as Record<string, unknown>;
      const definitionRef = (block.definitionRef ?? {}) as Record<string, unknown>;
      return surface({
        instanceId: typeof snapshot.instanceId === "string" ? snapshot.instanceId : undefined,
        definitionId: typeof definitionRef.id === "string" ? definitionRef.id : "",
        textAlternative: typeof snapshot.textAlternative === "string" ? snapshot.textAlternative : "",
        revision: typeof snapshot.capturedRevision === "number" ? snapshot.capturedRevision : 0,
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
