import {
  type ArtifactRefusal,
  type Instant,
  type MachineSurface,
  type MessageBlock,
  type WidgetArtifactWriteOperation,
  artifactRefusalStatus,
  machineSurfaceOf,
} from "@clarkcant/contracts";
import { decideExecution, getInstance, readExecutionPolicy, recordEffectExecution, requestApproval } from "@clarkcant/core";
import { type AuditOutcome, appendAuditEvent, asJsonValue, instanceIsInConversation, payloadDigest } from "@clarkcant/storage";

import {
  type ArtifactBrokerDeps,
  appendArtifactChunk,
  attachArtifact,
  createWorkingArtifact,
  describeArtifact,
  discardArtifact,
  finalizeArtifact,
} from "../artifact-broker.ts";
import { appendHostReply } from "../routes/conversations.ts";
import { type GatewayResponse, fail, json } from "../routes/http.ts";
import type { NodeServices } from "../services.ts";

/**
 * A widget instance's artifact writes when a machine surface carries them.
 *
 * The person's own app writes as a widget through its host, and those calls run as they always have. MCP, the WebSocket
 * relay and `clarkcant api` carry the same token, so without this an AI client or a remote machine could write into a
 * widget's share and attach the result to the conversation as if it were the widget (#355). The owner's decision is
 * that it may, but only as an effect like any other: the execution policy decides each write (`decideExecution`,
 * `local-write`), and the audit log records the surface, the instance, the artifact, the operation and the decision.
 * Never the bytes.
 *
 * - Autonomous, or Guarded with nothing asking about `local-write`: the write runs, with an activity record before it.
 * - A rule or the mode asks: a host-owned approval card goes into the widget's conversation, and the caller is told
 *   `202 approval-required`. Only the person decides it, on the person-only decide route; the approved write runs from
 *   the card's own payload, hashed again against the digest the card showed. A chunk too large to show on a card is
 *   refused instead (`APPROVAL_UNAVAILABLE`), with nothing written.
 * - A prohibition or a rule refusing `local-write`: `403 POLICY_REFUSED`, nothing written.
 *
 * Which routes this covers is `policyGatedWidgetArtifactWrite`'s, beside `isPersonOnlyRoute` in the contracts. Which
 * surface asked is the marker the node's own surfaces set in a header (`machineSurfaceOf`), never a body field.
 */

/** One write, already read from its request, in the shape both a route and an approved card run. */
export type WidgetArtifactWrite =
  | { operation: "create"; mimeType: string; name?: string }
  | { operation: "write"; artifactId: string; offset: unknown; contentBase64: string; bytes: Uint8Array }
  | { operation: "finalize"; artifactId: string }
  | { operation: "attach"; artifactId: string; name?: string }
  | { operation: "discard"; artifactId: string };

export interface WidgetArtifactScope {
  principalId: string;
  conversationId: string;
  instanceId: string;
}

type MachineWriteServices = Pick<NodeServices, "runtime" | "conductor" | "search">;

/** What a write came to: the route's answer, and the artifact it touched when there is one. */
export type PerformedWrite =
  | { ok: true; response: GatewayResponse; artifactId: string }
  | { ok: false; response: GatewayResponse; code: string };

const PAYLOAD_KIND = "widget-artifact-write";
/** The card's payload bound (`approvalCardBlockSchema.payload`). */
const CARD_PAYLOAD_LIMIT = 4000;
const APPROVAL_TTL_MS = 15 * 60_000;

export function brokerDepsOf(services: Pick<NodeServices, "runtime" | "conductor">): ArtifactBrokerDeps {
  return {
    db: services.runtime.db,
    dataDir: services.runtime.dataDir,
    nodeId: services.runtime.identity.nodeId,
    newId: (prefix) => services.conductor.newId(prefix),
    now: () => new Date(),
  };
}

function refusedBy(refusal: ArtifactRefusal): PerformedWrite {
  return { ok: false, response: fail(artifactRefusalStatus(refusal.code), refusal.code, refusal.message), code: refusal.code };
}

/** Run one write against the broker, which re-judges it against the instance's grant. The one path for every caller. */
export function performWidgetArtifactWrite(
  broker: ArtifactBrokerDeps,
  scope: WidgetArtifactScope,
  write: WidgetArtifactWrite,
): PerformedWrite {
  const owner = { principalId: scope.principalId, instanceId: scope.instanceId };
  switch (write.operation) {
    case "create": {
      const created = createWorkingArtifact(broker, {
        ...owner,
        conversationId: scope.conversationId,
        mimeType: write.mimeType,
        name: write.name,
      });
      return created.ok ? { ok: true, response: json(201, { artifactRef: created.ref }), artifactId: created.ref.artifactId } : refusedBy(created);
    }
    case "write": {
      const written = appendArtifactChunk(broker, { ...owner, artifactId: write.artifactId, offset: write.offset, bytes: write.bytes });
      return written.ok ? { ok: true, response: json(200, { artifactRef: written.ref }), artifactId: write.artifactId } : refusedBy(written);
    }
    case "finalize": {
      const finalized = finalizeArtifact(broker, { ...owner, artifactId: write.artifactId });
      return finalized.ok ? { ok: true, response: json(200, { artifactRef: finalized.ref }), artifactId: write.artifactId } : refusedBy(finalized);
    }
    case "attach": {
      const attached = attachArtifact(broker, { ...owner, artifactId: write.artifactId, name: write.name });
      return attached.ok
        ? {
            ok: true,
            response: json(201, { artifactRef: attached.ref, attachmentRef: attached.attachmentRef }),
            artifactId: write.artifactId,
          }
        : refusedBy(attached);
    }
    case "discard": {
      const discarded = discardArtifact(broker, { ...owner, artifactId: write.artifactId });
      return discarded.ok
        ? { ok: true, response: json(200, { discarded: true, artifactId: write.artifactId }), artifactId: write.artifactId }
        : refusedBy(discarded);
    }
    default:
      return { ok: false, response: fail(404, "NOT_FOUND", "no such widget artifact operation"), code: "NOT_FOUND" };
  }
}

/** The operation as an approval binds it: everything that would run, and nothing a caller could swap afterwards. */
interface WriteOperation {
  kind: typeof PAYLOAD_KIND;
  surface: MachineSurface;
  conversationId: string;
  instanceId: string;
  operation: WidgetArtifactWriteOperation;
  artifactId?: string;
  mimeType?: string;
  name?: string;
  offset?: number;
  contentBase64?: string;
}

function operationOf(surface: MachineSurface, scope: WidgetArtifactScope, write: WidgetArtifactWrite): WriteOperation {
  const base = { kind: PAYLOAD_KIND, surface, conversationId: scope.conversationId, instanceId: scope.instanceId, operation: write.operation } as const;
  switch (write.operation) {
    case "create":
      return { ...base, mimeType: write.mimeType, ...(write.name === undefined ? {} : { name: write.name }) };
    case "write":
      return { ...base, artifactId: write.artifactId, offset: write.offset as number, contentBase64: write.contentBase64 };
    case "attach":
      return { ...base, artifactId: write.artifactId, ...(write.name === undefined ? {} : { name: write.name }) };
    default:
      return { ...base, artifactId: write.artifactId };
  }
}

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function digestOf(operation: WriteOperation): string {
  return payloadDigest(asJsonValue(operation));
}

const SURFACE_NAMES: Record<MachineSurface, { en: string; vi: string }> = {
  mcp: { en: "an MCP client", vi: "Một client MCP" },
  relay: { en: "a WebSocket relay client", vi: "Một client qua WebSocket relay" },
  "cli-api": { en: "clarkcant api", vi: "Lệnh clarkcant api" },
};

/** What the operation is, for the audit line and the activity record: never the bytes, only how many. */
function describeOperation(operation: WriteOperation): string {
  const who = SURFACE_NAMES[operation.surface].en;
  const file = operation.artifactId === undefined ? "a new widget file" : `widget file ${operation.artifactId}`;
  const what = (() => {
    switch (operation.operation) {
      case "create":
        return `create ${file} (${operation.mimeType ?? "?"})`;
      case "write":
        return `write ${byteCount(operation)} bytes at offset ${String(operation.offset)} to ${file}`;
      case "finalize":
        return `finalize ${file}`;
      case "attach":
        return `attach ${file} to the conversation`;
      default:
        return `discard ${file}`;
    }
  })();
  return `${who} asked to ${what} of instance ${operation.instanceId} (${operation.surface}, ${operation.operation})`;
}

/** The card's words, in the language the other host cards use. */
function describeForCard(operation: WriteOperation): string {
  const who = SURFACE_NAMES[operation.surface].vi;
  const widget = `widget ${operation.instanceId}`;
  switch (operation.operation) {
    case "create":
      return `${who} muốn tạo một tệp ${operation.mimeType ?? ""} mới cho ${widget}`;
    case "write":
      return `${who} muốn ghi ${byteCount(operation)} byte vào tệp ${operation.artifactId ?? ""} của ${widget}`;
    case "finalize":
      return `${who} muốn chốt tệp ${operation.artifactId ?? ""} của ${widget}`;
    case "attach":
      return `${who} muốn đính kèm tệp ${operation.artifactId ?? ""} của ${widget} vào hội thoại`;
    default:
      return `${who} muốn xoá tệp ${operation.artifactId ?? ""} của ${widget}`;
  }
}

function byteCount(operation: WriteOperation): number {
  return operation.contentBase64 === undefined ? 0 : Buffer.from(operation.contentBase64, "base64").byteLength;
}

function audit(
  services: MachineWriteServices,
  input: { operation: WriteOperation; decision: string; outcome: AuditOutcome; artifactId?: string; at: Instant },
): void {
  const artifactId = input.artifactId ?? input.operation.artifactId;
  appendAuditEvent(services.runtime.db, {
    auditId: services.conductor.newId("audit"),
    principalId: services.runtime.identity.ownerPrincipalId,
    nodeId: services.runtime.identity.nodeId,
    kind: "widget-artifact",
    summary: `${describeOperation(input.operation)}${artifactId === undefined || artifactId === input.operation.artifactId ? "" : ` -> ${artifactId}`}: ${input.decision}`,
    outcome: input.outcome,
    ref: artifactId ?? input.operation.instanceId,
    at: input.at,
  });
}

/**
 * Decide and, when the policy allows it, run one write a machine surface carried.
 *
 * Called by the artifact routes only when the request carries a machine surface's marker and the route is one
 * `policyGatedWidgetArtifactWrite` names; everything else about the request — the conversation, the instance and its
 * owner — was already checked by the route.
 */
export function decideMachineArtifactWrite(
  services: MachineWriteServices,
  input: { surface: MachineSurface; scope: WidgetArtifactScope; write: WidgetArtifactWrite },
): GatewayResponse {
  const at = new Date().toISOString() as Instant;
  if (input.write.operation === "write" && !isOffset(input.write.offset)) {
    // Not a write anyone could approve: the broker refuses it before a byte moves, and that refusal is the answer.
    return performWidgetArtifactWrite(brokerDepsOf(services), input.scope, input.write).response;
  }
  const operation = operationOf(input.surface, input.scope, input.write);
  const operationDigest = digestOf(operation);
  const policy = readExecutionPolicy({ db: services.runtime.db, now: () => at }, input.scope.principalId);
  const decided = decideExecution({
    policy,
    action: { kind: "effect", category: "local-write", operationDigest },
    // Not the person asking in the conversation: a client they connected acting on its own initiative. For a
    // `local-write` that changes nothing in Autonomous or Guarded, and it keeps the risk gate honest if the category
    // ever widens.
    intent: { kind: "system" },
  });

  if (decided.kind === "deny") {
    audit(services, { operation, decision: `refused by the execution policy (${decided.reason})`, outcome: "refused", at });
    return fail(403, "POLICY_REFUSED", `${decided.reason}; nothing was written`);
  }

  if (decided.kind === "execute") {
    // Written before the write, so a write that fails or a node that dies still shows what was started.
    recordEffectExecution(
      { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => at, newId: services.conductor.newId },
      {
        principalId: input.scope.principalId,
        mode: policy.mode,
        decision: decided,
        category: "local-write",
        operationDigest,
        conversationId: input.scope.conversationId,
        description: describeOperation(operation),
      },
    );
    const performed = performWidgetArtifactWrite(brokerDepsOf(services), input.scope, input.write);
    audit(services, {
      operation,
      decision: performed.ok
        ? `run by the execution policy (${policy.mode}: ${decided.reason})`
        : `allowed by the execution policy (${policy.mode}), refused by the broker with ${performed.code}`,
      outcome: performed.ok ? "done" : "refused",
      ...(performed.ok ? { artifactId: performed.artifactId } : {}),
      at,
    });
    return performed.response;
  }

  // The policy asks. Nothing is asked about an operation the broker would refuse anyway.
  if (input.write.operation === "write" || input.write.operation === "finalize" || input.write.operation === "attach") {
    const described = describeArtifact(brokerDepsOf(services), {
      principalId: input.scope.principalId,
      instanceId: input.scope.instanceId,
      artifactId: input.write.artifactId,
    });
    if (!described.ok) {
      audit(services, { operation, decision: `the policy asks, but the broker refuses it first with ${described.code}`, outcome: "refused", at });
      return refusedBy(described).response;
    }
  }
  const payload = JSON.stringify(operation);
  if (payload.length > CARD_PAYLOAD_LIMIT) {
    audit(services, { operation, decision: "the policy asks, and the write is too large to show on an approval card", outcome: "refused", at });
    return fail(
      413,
      "APPROVAL_UNAVAILABLE",
      `${decided.reason}; this write is too large to show on an approval card, so nothing was written. Send smaller chunks, or ask the person to change the execution policy`,
    );
  }
  const approval = requestApproval(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => at, newId: services.conductor.newId },
    { operationDigest, operationDescription: describeForCard(operation), effectCategory: "local-write", ttlMs: APPROVAL_TTL_MS },
  );
  appendHostReply(services, {
    conversationId: input.scope.conversationId,
    blocks: [
      {
        type: "approval-card",
        owner: "host",
        approvalId: approval.approvalId,
        operationDescription: approval.operationDescription,
        operationDigest: approval.operationDigest,
        payload,
        effectCategory: "local-write",
        expiresAt: approval.expiresAt,
        decider: approval.decider,
        decision: approval.decision,
      } as MessageBlock,
    ],
    at,
  });
  audit(services, {
    operation,
    decision: `the execution policy asks (${decided.reason}); waiting for the person on card ${approval.approvalId}`,
    outcome: "pending",
    at,
  });
  return json(202, {
    outcome: "approval-required",
    approvalRequired: { approvalId: approval.approvalId },
    operation: operation.operation,
    message: `${decided.reason}; the person decides this write on the card in the conversation, and nothing is written until they approve it`,
  });
}

/** Whether an approval card's payload is a machine surface's widget artifact write. */
export function isWidgetArtifactWritePayload(payload: string): boolean {
  return readOperation(payload) !== undefined;
}

function readOperation(payload: string): WriteOperation | undefined {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(payload) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    parsed = value as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (parsed.kind !== PAYLOAD_KIND) return undefined;
  const surface = machineSurfaceOf(parsed.surface);
  const operations: readonly unknown[] = ["create", "write", "finalize", "attach", "discard"];
  if (surface === undefined || !operations.includes(parsed.operation)) return undefined;
  if (typeof parsed.conversationId !== "string" || typeof parsed.instanceId !== "string") return undefined;
  return parsed as unknown as WriteOperation;
}

/** The write an operation names, or why it cannot be run from it. */
function writeOf(operation: WriteOperation): WidgetArtifactWrite | undefined {
  switch (operation.operation) {
    case "create":
      return typeof operation.mimeType === "string"
        ? { operation: "create", mimeType: operation.mimeType, ...(typeof operation.name === "string" ? { name: operation.name } : {}) }
        : undefined;
    case "write":
      return typeof operation.artifactId === "string" && isOffset(operation.offset) && typeof operation.contentBase64 === "string"
        ? {
            operation: "write",
            artifactId: operation.artifactId,
            offset: operation.offset,
            contentBase64: operation.contentBase64,
            bytes: new Uint8Array(Buffer.from(operation.contentBase64, "base64")),
          }
        : undefined;
    case "attach":
      return typeof operation.artifactId === "string"
        ? { operation: "attach", artifactId: operation.artifactId, ...(typeof operation.name === "string" ? { name: operation.name } : {}) }
        : undefined;
    case "finalize":
    case "discard":
      return typeof operation.artifactId === "string" ? { operation: operation.operation, artifactId: operation.artifactId } : undefined;
    default:
      return undefined;
  }
}

/** The receipt's words for a write the person approved. */
function receiptLabel(operation: WriteOperation, performed: PerformedWrite): string {
  if (!performed.ok) return `Đã duyệt nhưng không ghi được (${performed.code}). Không có gì thay đổi.`;
  switch (operation.operation) {
    case "create":
      return `Đã tạo tệp ${performed.artifactId} cho widget ${operation.instanceId}`;
    case "write":
      return `Đã ghi ${byteCount(operation)} byte vào tệp ${performed.artifactId}`;
    case "finalize":
      return `Đã chốt tệp ${performed.artifactId}`;
    case "attach":
      return `Đã đính kèm tệp ${performed.artifactId} vào hội thoại`;
    default:
      return `Đã xoá tệp ${performed.artifactId}`;
  }
}

/**
 * Run a write the person approved on its card.
 *
 * The payload is the card's own, hashed again against the digest the decision covered, so what runs is what was shown;
 * the instance must still be the person's and in this conversation, and a refusal the person set after the card was
 * shown still stands. The broker judges the write against the instance's grant as it would any other.
 */
export function runApprovedWidgetArtifactWrite(
  services: MachineWriteServices,
  input: { payload: string; expectedDigest: string; approvalId: string; conversationId: string; at: Instant },
): { ok: true; blocks: MessageBlock[]; description: string } | { ok: false; code: string; message: string } {
  const operation = readOperation(input.payload);
  const write = operation === undefined ? undefined : writeOf(operation);
  if (operation === undefined || write === undefined) {
    return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload names no widget file write" };
  }
  if (digestOf(operation) !== input.expectedDigest || operation.conversationId !== input.conversationId) {
    return { ok: false, code: "APPROVAL_FORGED", message: "the operation changed after it was displayed; the decision does not cover what would run" };
  }
  const principalId = services.runtime.identity.ownerPrincipalId;
  const instance = getInstance(services.conductor, operation.instanceId);
  if (
    instance?.ownerPrincipalId !== principalId ||
    !instanceIsInConversation(services.runtime.db, { conversationId: operation.conversationId, instanceId: operation.instanceId })
  ) {
    audit(services, { operation, decision: `approved on card ${input.approvalId}, but the widget is no longer here`, outcome: "refused", at: input.at });
    return { ok: false, code: "RESOURCE_NOT_FOUND", message: "the widget this write was approved for is no longer in this conversation" };
  }
  const policy = readExecutionPolicy({ db: services.runtime.db, now: () => input.at }, principalId);
  const now = decideExecution({
    policy,
    action: { kind: "effect", category: "local-write", operationDigest: input.expectedDigest },
    intent: { kind: "system" },
  });
  if (now.kind === "deny") {
    audit(services, { operation, decision: `approved on card ${input.approvalId}, then refused by the execution policy (${now.reason})`, outcome: "refused", at: input.at });
    return { ok: false, code: "POLICY_REFUSED", message: now.reason };
  }
  const performed = performWidgetArtifactWrite(
    brokerDepsOf(services),
    { principalId, conversationId: operation.conversationId, instanceId: operation.instanceId },
    write,
  );
  audit(services, {
    operation,
    decision: performed.ok
      ? `approved by the person on card ${input.approvalId}`
      : `approved by the person on card ${input.approvalId}, refused by the broker with ${performed.code}`,
    outcome: performed.ok ? "done" : "refused",
    ...(performed.ok ? { artifactId: performed.artifactId } : {}),
    at: input.at,
  });
  const block = {
    type: "tool-activity",
    toolCallId: `widget-artifact-${input.approvalId}`,
    name: "widget_artifact_write",
    label: receiptLabel(operation, performed),
    status: performed.ok ? "done" : "failed",
    // The approval id travels with the receipt so the card it answered reads as decided, including after a reload; the
    // artifact id is how the client that asked finds a file the approved write created.
    args: {
      approvalId: input.approvalId,
      decision: "granted",
      operation: operation.operation,
      instanceId: operation.instanceId,
      ...(performed.ok ? { artifactId: performed.artifactId } : { code: performed.code }),
    },
    startedAt: input.at,
    endedAt: input.at,
  } as MessageBlock;
  return { ok: true, blocks: [block], description: describeOperation(operation) };
}

/** Record that the person refused a machine surface's write on its card. Nothing ran, and the audit says so. */
export function recordDeniedWidgetArtifactWrite(
  services: MachineWriteServices,
  input: { payload: string; approvalId: string; at: Instant },
): void {
  const operation = readOperation(input.payload);
  if (operation === undefined) return;
  audit(services, { operation, decision: `denied by the person on card ${input.approvalId}`, outcome: "refused", at: input.at });
}
