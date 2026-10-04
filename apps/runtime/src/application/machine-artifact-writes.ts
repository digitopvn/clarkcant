import { createHash } from "node:crypto";

import {
  type ArtifactRefusal,
  type EffectCategory,
  type Instant,
  type MachineSurface,
  type MessageBlock,
  approvalCardBlockSchema,
  artifactIdSchema,
  artifactNameSchema,
  artifactRefusalStatus,
  machineSurfaceOf,
} from "@clarkcant/contracts";
import { decideExecution, getInstance, readExecutionPolicy, recordEffectExecution, requestApproval } from "@clarkcant/core";
import { type AuditOutcome, appendAuditEvent, asJsonValue, instanceIsInConversation, oneRow, payloadDigest } from "@clarkcant/storage";

import { preferredAppIntentLocale } from "../app-intents.ts";
import {
  type ArtifactBrokerDeps,
  appendArtifactChunk,
  attachArtifact,
  checkArtifactOperation,
  checkWorkingArtifactCandidate,
  createWorkingArtifact,
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
 * that it may, but only as an effect like any other: the execution policy decides each write (`decideExecution`), and
 * the audit log records the surface, the instance, the artifact, the operation and the decision. Never the bytes.
 *
 * The effect category is the operation's: every write is `local-write`, except discarding a file that is not an
 * unfinished one this same surface started, which deletes something the person may have no other copy of and is
 * `destructive` — asked about under Guarded, and under Autonomous since nobody in the conversation asked for it.
 *
 * - The policy runs it: the write runs, and the activity stream records it once the broker accepted it.
 * - The policy asks: a host-owned approval card goes into the widget's conversation and the caller is told
 *   `202 approval-required`. Only the person decides it, on the person-only decide route. A card is per file, never per
 *   chunk, and never carries bytes (a conversation is kept, searched, read by the model and may be synced to paired
 *   nodes): approving `create`, or write access to an existing working file, gives that surface a short-lived write
 *   right on that one file of that one instance, which covers its chunks and its finalize, each still audited, and ends
 *   on finalize, discard or expiry. `attach` and `discard` are asked about one by one.
 * - The policy refuses: `403 POLICY_REFUSED`, nothing written.
 *
 * Which surface asked is the marker the node's own surfaces set in a header (`machineSurfaceOf`), never a body field.
 */

/** One write, already read from its request, in the shape every path runs. */
export type WidgetArtifactWrite =
  | { operation: "create"; mimeType: string; name?: string }
  | { operation: "write"; artifactId: string; offset: unknown; bytes: Uint8Array }
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

type WriteCategory = Extract<EffectCategory, "local-write" | "destructive">;

const PAYLOAD_KIND = "widget-artifact-write";
const APPROVAL_TTL_MS = 15 * 60_000;
/** How long the person's approval of one file lets the surface that asked keep writing it. */
const WRITE_RIGHT_TTL_MS = 15 * 60_000;
const WRITE_RIGHT_MINUTES = WRITE_RIGHT_TTL_MS / 60_000;
/** Cards one surface may keep waiting in one conversation; past this it is told to wait, not given another card. */
const MAX_PENDING_CARDS = 8;
/** Unfinished files a surface started that this node remembers, for the discard category. Oldest forgotten first. */
const MAX_TRACKED_CREATIONS = 1024;
/** A media type as `type/subtype`, bounded, before the broker's allowlist is even asked. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
/** `approvalCardBlockSchema.operationDescription`'s bound. */
const CARD_TEXT_LIMIT = 2000;

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

/*
 * What this node remembers between requests, per running node: the write rights the person granted, the unfinished
 * files each surface started, and the cards each surface is waiting on. Kept in memory on purpose. A restart forgets a
 * write right (the surface asks again), forgets who started a file (its discard is then asked about as destructive), and
 * forgets the count of waiting cards; each errs toward asking the person, never toward running.
 */
interface WriteRight {
  surface: MachineSurface;
  conversationId: string;
  instanceId: string;
  artifactId: string;
  approvalId: string;
  expiresAtMs: number;
}

interface MachineWriteState {
  rights: Map<string, WriteRight>;
  started: Map<string, MachineSurface>;
  pending: Map<string, { surface: MachineSurface; conversationId: string }>;
}

const states = new WeakMap<object, MachineWriteState>();

function stateOf(services: Pick<NodeServices, "runtime">): MachineWriteState {
  let state = states.get(services.runtime);
  if (state === undefined) {
    state = { rights: new Map(), started: new Map(), pending: new Map() };
    states.set(services.runtime, state);
  }
  return state;
}

function rightKey(surface: MachineSurface, instanceId: string, artifactId: string): string {
  return `${surface}\u0000${instanceId}\u0000${artifactId}`;
}

function currentRight(
  services: Pick<NodeServices, "runtime">,
  input: { surface: MachineSurface; conversationId: string; instanceId: string; artifactId: string; nowMs: number },
): WriteRight | undefined {
  const { rights } = stateOf(services);
  const key = rightKey(input.surface, input.instanceId, input.artifactId);
  const right = rights.get(key);
  if (right === undefined) return undefined;
  if (right.expiresAtMs <= input.nowMs) {
    rights.delete(key);
    return undefined;
  }
  return right.conversationId === input.conversationId ? right : undefined;
}

/** Forget every write right and start record on a file that was finalized or discarded. */
function settleFile(services: Pick<NodeServices, "runtime">, artifactId: string): void {
  const state = stateOf(services);
  for (const [key, right] of state.rights) if (right.artifactId === artifactId) state.rights.delete(key);
  state.started.delete(artifactId);
}

function rememberStarted(services: Pick<NodeServices, "runtime">, artifactId: string, surface: MachineSurface): void {
  const { started } = stateOf(services);
  started.set(artifactId, surface);
  while (started.size > MAX_TRACKED_CREATIONS) {
    const oldest = started.keys().next().value;
    if (oldest === undefined) break;
    started.delete(oldest);
  }
}

/** What a write that ran leaves this node to remember. */
function afterWrite(services: Pick<NodeServices, "runtime">, surface: MachineSurface, write: WidgetArtifactWrite, performed: PerformedWrite): void {
  if (!performed.ok) return;
  if (write.operation === "create") rememberStarted(services, performed.artifactId, surface);
  if (write.operation === "finalize" || write.operation === "discard") settleFile(services, performed.artifactId);
}

/**
 * The category a write is decided as. Discarding is `local-write` only for an unfinished file this same surface started,
 * which takes nothing from the person; anything else it deletes may be their only copy, so it is `destructive`.
 */
function categoryOf(services: MachineWriteServices, surface: MachineSurface, scope: WidgetArtifactScope, write: WidgetArtifactWrite): WriteCategory {
  if (write.operation !== "discard") return "local-write";
  const checked = checkArtifactOperation(brokerDepsOf(services), {
    principalId: scope.principalId,
    instanceId: scope.instanceId,
    artifactId: write.artifactId,
    need: "discard",
  });
  return checked.ok && checked.ref.kind === "working" && stateOf(services).started.get(write.artifactId) === surface
    ? "local-write"
    : "destructive";
}

/** A card's operation: what the person decides. Per file, never per chunk, and never with bytes. */
type CardOperationName = "create" | "write" | "attach" | "discard";

interface CardOperation {
  kind: typeof PAYLOAD_KIND;
  surface: MachineSurface;
  conversationId: string;
  instanceId: string;
  /** `write` is write access to one existing working file: its chunks and its finalize. */
  operation: CardOperationName;
  category: WriteCategory;
  artifactId?: string;
  mimeType?: string;
  name?: string;
}

function digestOf(value: object): string {
  return payloadDigest(asJsonValue(value));
}

type Locale = "en" | "vi";

const SURFACE_NAMES: Record<MachineSurface, Record<Locale, string>> = {
  mcp: { en: "An MCP client", vi: "Một client MCP" },
  relay: { en: "A WebSocket relay client", vi: "Một client qua WebSocket relay" },
  "cli-api": { en: "The clarkcant api command", vi: "Lệnh clarkcant api" },
};

function localeOf(services: MachineWriteServices, at: Instant): Locale {
  return preferredAppIntentLocale({ db: services.runtime.db, now: () => at }, services.runtime.identity.ownerPrincipalId);
}

function bounded(text: string): string {
  return text.length <= CARD_TEXT_LIMIT ? text : `${text.slice(0, CARD_TEXT_LIMIT - 1)}…`;
}

/** The card's words, in the person's language. Every value in them was checked first: an allowlisted type, a node id. */
function cardText(operation: CardOperation, locale: Locale): string {
  const who = SURFACE_NAMES[operation.surface][locale];
  const id = operation.artifactId ?? "";
  const minutes = String(WRITE_RIGHT_MINUTES);
  if (locale === "en") {
    switch (operation.operation) {
      case "create":
        return `${who} wants to create a new ${operation.mimeType ?? ""} file for the widget in this conversation and write it. Approving lets it write and finish that one file for ${minutes} minutes.`;
      case "write":
        return `${who} wants to write to the widget file ${id} and finish it. Approving lets it write that one file for ${minutes} minutes.`;
      case "attach":
        return `${who} wants to attach the widget file ${id} to this conversation.`;
      default:
        return operation.category === "destructive"
          ? `${who} wants to permanently delete the widget file ${id}. This cannot be undone; a copy already attached to the conversation stays.`
          : `${who} wants to discard the unfinished widget file ${id} it started.`;
    }
  }
  switch (operation.operation) {
    case "create":
      return `${who} muốn tạo một tệp ${operation.mimeType ?? ""} mới cho widget trong hội thoại này và ghi nội dung vào đó. Nếu bạn đồng ý, nó được ghi và hoàn tất đúng tệp đó trong ${minutes} phút.`;
    case "write":
      return `${who} muốn ghi vào tệp widget ${id} và hoàn tất tệp đó. Nếu bạn đồng ý, nó được ghi đúng tệp đó trong ${minutes} phút.`;
    case "attach":
      return `${who} muốn đính kèm tệp widget ${id} vào hội thoại này.`;
    default:
      return operation.category === "destructive"
        ? `${who} muốn xoá vĩnh viễn tệp widget ${id}. Không thể hoàn tác; bản đã đính kèm vào hội thoại vẫn được giữ.`
        : `${who} muốn bỏ tệp widget ${id} đang ghi dở mà nó đã bắt đầu.`;
  }
}

function receiptDone(operation: CardOperation, artifactId: string, locale: Locale): string {
  const minutes = String(WRITE_RIGHT_MINUTES);
  if (locale === "en") {
    switch (operation.operation) {
      case "create":
        return `Created widget file ${artifactId}. The client that asked may write and finish it for the next ${minutes} minutes.`;
      case "write":
        return `The client that asked may write widget file ${artifactId} for the next ${minutes} minutes.`;
      case "attach":
        return `Attached widget file ${artifactId} to the conversation.`;
      default:
        return `Deleted widget file ${artifactId}.`;
    }
  }
  switch (operation.operation) {
    case "create":
      return `Đã tạo tệp widget ${artifactId}. Bên yêu cầu được ghi và hoàn tất tệp này trong ${minutes} phút tới.`;
    case "write":
      return `Bên yêu cầu được ghi tệp widget ${artifactId} trong ${minutes} phút tới.`;
    case "attach":
      return `Đã đính kèm tệp widget ${artifactId} vào hội thoại.`;
    default:
      return `Đã xoá tệp widget ${artifactId}.`;
  }
}

const FAILURE_REASONS: Record<string, Record<Locale, string>> = {
  APPROVAL_PAYLOAD_UNREADABLE: { en: "the card's request could not be read.", vi: "không đọc được yêu cầu trên thẻ." },
  APPROVAL_FORGED: { en: "the request changed after it was shown.", vi: "yêu cầu đã thay đổi sau khi được hiển thị." },
  APPROVAL_STALE: { en: "the file changed since the card was shown.", vi: "tệp đã thay đổi kể từ khi thẻ được hiển thị." },
  RESOURCE_NOT_FOUND: { en: "the widget is no longer in this conversation.", vi: "widget không còn trong hội thoại này." },
  POLICY_REFUSED: { en: "your execution policy now refuses it.", vi: "chính sách thực thi của bạn hiện từ chối việc này." },
};

/** What failed, what was kept and what happens next, for a card the person approved that then could not run. */
function receiptFailed(code: string, locale: Locale): string {
  const reason =
    FAILURE_REASONS[code]?.[locale] ??
    (locale === "en" ? `the widget's file store refused it (${code}).` : `kho tệp của widget đã từ chối (${code}).`);
  return locale === "en"
    ? `Approved, but nothing was written: ${reason} Your files are unchanged; the client can ask again.`
    : `Đã duyệt nhưng không có gì được ghi: ${reason} Các tệp của bạn không thay đổi; bên yêu cầu có thể hỏi lại.`;
}

/** The words a refused card's record carries. */
export function deniedWidgetArtifactWriteLabel(services: MachineWriteServices, at: Instant): string {
  return localeOf(services, at) === "en"
    ? "Denied that widget file request. Nothing was written."
    : "Đã từ chối ghi tệp widget đó. Không có gì được ghi.";
}

/** What a request asked for, for the audit line and the activity record: never the bytes, only how many. */
interface Asked {
  surface: MachineSurface;
  instanceId: string;
  /** The route's operation, or the card's when an approved card runs. */
  operation: string;
  what: string;
  artifactId?: string;
}

function askedOf(surface: MachineSurface, scope: WidgetArtifactScope, write: WidgetArtifactWrite, idChecked: boolean): Asked {
  // An id that failed the format check is never repeated: it is the caller's text, not the node's.
  const artifactId = write.operation === "create" || !idChecked ? undefined : write.artifactId;
  const file = write.operation === "create" ? "a new widget file" : artifactId === undefined ? "a widget file with an unknown id" : `widget file ${artifactId}`;
  const what = (() => {
    switch (write.operation) {
      case "create":
        return `create ${file}`;
      case "write":
        return `write ${String(write.bytes.byteLength)} bytes${typeof write.offset === "number" && Number.isSafeInteger(write.offset) ? ` at offset ${String(write.offset)}` : ""} to ${file}`;
      case "finalize":
        return `finalize ${file}`;
      case "attach":
        return `attach ${file} to the conversation`;
      default:
        return `discard ${file}`;
    }
  })();
  return { surface, instanceId: scope.instanceId, operation: write.operation, what, ...(artifactId === undefined ? {} : { artifactId }) };
}

function askedOfCard(operation: CardOperation): Asked {
  const file = operation.artifactId === undefined ? "a new widget file" : `widget file ${operation.artifactId}`;
  const what = (() => {
    switch (operation.operation) {
      case "create":
        return `create ${file} and write it`;
      case "write":
        return `write ${file} and finish it`;
      case "attach":
        return `attach ${file} to the conversation`;
      default:
        return `discard ${file}`;
    }
  })();
  return {
    surface: operation.surface,
    instanceId: operation.instanceId,
    operation: operation.operation,
    what,
    ...(operation.artifactId === undefined ? {} : { artifactId: operation.artifactId }),
  };
}

function describeAsked(asked: Asked): string {
  const who = SURFACE_NAMES[asked.surface].en;
  return `${who} asked to ${asked.what} of instance ${asked.instanceId} (${asked.surface}, ${asked.operation})`;
}

function audit(
  services: MachineWriteServices,
  input: { asked: Asked; decision: string; outcome: AuditOutcome; artifactId?: string; at: Instant },
): void {
  const artifactId = input.artifactId ?? input.asked.artifactId;
  appendAuditEvent(services.runtime.db, {
    auditId: services.conductor.newId("audit"),
    principalId: services.runtime.identity.ownerPrincipalId,
    nodeId: services.runtime.identity.nodeId,
    kind: "widget-artifact",
    summary: `${describeAsked(input.asked)}${artifactId === undefined || artifactId === input.asked.artifactId ? "" : ` -> ${artifactId}`}: ${input.decision}`,
    outcome: input.outcome,
    ref: artifactId ?? input.asked.instanceId,
    at: input.at,
  });
}

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The checks a card waits on: what the broker would refuse is refused now, and no card is shown for it. */
function precheck(
  services: MachineWriteServices,
  scope: WidgetArtifactScope,
  write: WidgetArtifactWrite,
): { ok: true; mimeType?: string; name?: string } | ArtifactRefusal {
  const broker = brokerDepsOf(services);
  const owner = { principalId: scope.principalId, instanceId: scope.instanceId };
  switch (write.operation) {
    case "create": {
      const checked = checkWorkingArtifactCandidate(broker, { ...owner, mimeType: write.mimeType, name: write.name });
      return checked.ok ? { ok: true, mimeType: checked.mimeType, ...(write.name === undefined ? {} : { name: checked.name }) } : checked;
    }
    case "write":
    case "finalize": {
      const checked = checkArtifactOperation(broker, { ...owner, artifactId: write.artifactId, need: "write" });
      if (!checked.ok) return checked;
      if (write.operation === "write" && write.offset !== checked.ref.sizeBytes) {
        return {
          ok: false,
          code: "ARTIFACT_OFFSET_MISMATCH",
          message: `the artifact is ${String(checked.ref.sizeBytes)} bytes long, so a chunk for offset ${String(write.offset)} does not follow it`,
        };
      }
      return { ok: true };
    }
    case "attach": {
      // The proposed name rides on the card's payload, so it is held to a file name's bounds before it goes there.
      if (write.name !== undefined && !artifactNameSchema.safeParse(write.name).success) {
        return { ok: false, code: "ARTIFACT_NAME_NOT_ALLOWED", message: "a proposed name must be a file name, not a path or a URL" };
      }
      const checked = checkArtifactOperation(broker, { ...owner, artifactId: write.artifactId, need: "read" });
      if (!checked.ok) return checked;
      return checked.ref.kind === "working"
        ? { ok: false, code: "ARTIFACT_NOT_FINALIZED", message: "finalize the artifact before attaching it to the conversation" }
        : { ok: true };
    }
    default: {
      const checked = checkArtifactOperation(broker, { ...owner, artifactId: write.artifactId, need: "discard" });
      return checked.ok ? { ok: true } : checked;
    }
  }
}

function cardOperationOf(
  surface: MachineSurface,
  scope: WidgetArtifactScope,
  write: WidgetArtifactWrite,
  category: WriteCategory,
  checked: { mimeType?: string; name?: string },
): CardOperation {
  const base = { kind: PAYLOAD_KIND, surface, conversationId: scope.conversationId, instanceId: scope.instanceId, category } as const;
  switch (write.operation) {
    case "create":
      return { ...base, operation: "create", mimeType: checked.mimeType ?? write.mimeType, ...(checked.name === undefined ? {} : { name: checked.name }) };
    case "write":
    case "finalize":
      return { ...base, operation: "write", artifactId: write.artifactId };
    case "attach":
      return { ...base, operation: "attach", artifactId: write.artifactId, ...(write.name === undefined ? {} : { name: write.name }) };
    default:
      return { ...base, operation: "discard", artifactId: write.artifactId };
  }
}

/** A card for exactly this operation that is still waiting, so a client asking again is given the same card. */
function waitingCard(services: MachineWriteServices, digest: string, at: Instant): string | undefined {
  return oneRow<{ approval_id: string }>(
    services.runtime.db,
    `SELECT approval_id FROM approvals
      WHERE operation_digest = ? AND decision = 'pending' AND expires_at > ? AND task_id IS NULL
      ORDER BY requested_at DESC LIMIT 1`,
    digest,
    at,
  )?.approval_id;
}

/** Cards this surface is still waiting on in this conversation. */
function waitingCount(services: MachineWriteServices, surface: MachineSurface, conversationId: string, at: Instant): number {
  const { pending } = stateOf(services);
  let count = 0;
  for (const [approvalId, card] of pending) {
    const row = oneRow<{ decision: string; expires_at: string }>(
      services.runtime.db,
      `SELECT decision, expires_at FROM approvals WHERE approval_id = ?`,
      approvalId,
    );
    if (row === undefined || row.decision !== "pending" || row.expires_at <= at) {
      pending.delete(approvalId);
      continue;
    }
    if (card.surface === surface && card.conversationId === conversationId) count += 1;
  }
  return count;
}

/**
 * Decide and, when the policy allows it, run one write a machine surface carried.
 *
 * Called by the artifact routes for every write a request carrying a machine surface's marker makes; everything else
 * about the request — the conversation, the instance and its owner — was already checked by the route.
 */
export function decideMachineArtifactWrite(
  services: MachineWriteServices,
  input: { surface: MachineSurface; scope: WidgetArtifactScope; write: WidgetArtifactWrite },
): GatewayResponse {
  const at = new Date().toISOString() as Instant;
  const { surface, scope, write } = input;
  const broker = brokerDepsOf(services);

  // Caller text is checked before it reaches anything a person or a model reads.
  const idChecked = write.operation === "create" || artifactIdSchema.safeParse(write.artifactId).success;
  const asked = askedOf(surface, scope, write, idChecked);
  if (!idChecked) {
    audit(services, { asked, decision: "refused: the artifact id is not one this node issues", outcome: "refused", at });
    return fail(404, "ARTIFACT_NOT_FOUND", "no artifact with that id is on this node");
  }
  if (write.operation === "create" && !MEDIA_TYPE.test(write.mimeType.trim().toLowerCase())) {
    audit(services, { asked, decision: "refused: the content type is not a media type", outcome: "refused", at });
    return fail(artifactRefusalStatus("ARTIFACT_TYPE_UNSUPPORTED"), "ARTIFACT_TYPE_UNSUPPORTED", "mimeType must be a media type such as text/plain");
  }
  if (write.operation === "write" && !isOffset(write.offset)) {
    // Not a write anyone could approve: the broker refuses it before a byte moves, and that refusal is the answer.
    const performed = performWidgetArtifactWrite(broker, scope, write);
    audit(services, { asked, decision: `refused by the broker with ${performed.ok ? "nothing" : performed.code}`, outcome: "refused", at });
    return performed.response;
  }

  const category = categoryOf(services, surface, scope, write);
  const operationDigest = digestOf({
    kind: PAYLOAD_KIND,
    surface,
    conversationId: scope.conversationId,
    instanceId: scope.instanceId,
    operation: write.operation,
    category,
    ...(write.operation === "create" ? { mimeType: write.mimeType, name: write.name ?? null } : { artifactId: write.artifactId }),
    ...(write.operation === "write"
      ? { offset: write.offset, sha256: createHash("sha256").update(write.bytes).digest("hex"), bytes: write.bytes.byteLength }
      : {}),
  });
  const policy = readExecutionPolicy({ db: services.runtime.db, now: () => at }, scope.principalId);
  const decided = decideExecution({
    policy,
    action: { kind: "effect", category, operationDigest },
    // Not the person asking in the conversation: a client they connected, acting on its own initiative. That is what
    // makes a destructive discard asked about under Autonomous too.
    intent: { kind: "system" },
  });

  if (decided.kind === "deny") {
    audit(services, { asked, decision: `refused by the execution policy (${category}: ${decided.reason})`, outcome: "refused", at });
    return fail(403, "POLICY_REFUSED", `${decided.reason}; nothing was written`);
  }

  if (decided.kind === "execute") {
    const performed = performWidgetArtifactWrite(broker, scope, write);
    afterWrite(services, surface, write, performed);
    if (performed.ok) {
      // After the broker accepted it: the activity stream shows effects that happened, not ones that were refused.
      recordEffectExecution(
        { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => at, newId: services.conductor.newId },
        {
          principalId: scope.principalId,
          mode: policy.mode,
          decision: decided,
          category,
          operationDigest,
          conversationId: scope.conversationId,
          description: describeAsked(asked),
        },
      );
    }
    audit(services, {
      asked,
      decision: performed.ok
        ? `run by the execution policy (${policy.mode}, ${category}: ${decided.reason})`
        : `allowed by the execution policy (${policy.mode}, ${category}), refused by the broker with ${performed.code}`,
      outcome: performed.ok ? "done" : "refused",
      ...(performed.ok ? { artifactId: performed.artifactId } : {}),
      at,
    });
    return performed.response;
  }

  // The policy asks. A chunk or a finalize of a file the person already let this surface write runs under that right.
  if (write.operation === "write" || write.operation === "finalize") {
    const right = currentRight(services, {
      surface,
      conversationId: scope.conversationId,
      instanceId: scope.instanceId,
      artifactId: write.artifactId,
      nowMs: Date.parse(at),
    });
    if (right !== undefined) {
      const performed = performWidgetArtifactWrite(broker, scope, write);
      afterWrite(services, surface, write, performed);
      audit(services, {
        asked,
        decision: performed.ok
          ? `covered by the person's approval on card ${right.approvalId} (${decided.reason})`
          : `covered by the person's approval on card ${right.approvalId}, refused by the broker with ${performed.code}`,
        outcome: performed.ok ? "done" : "refused",
        at,
      });
      return performed.response;
    }
  }

  const checked = precheck(services, scope, write);
  if (!checked.ok) {
    audit(services, { asked, decision: `the policy asks, but the broker refuses it first with ${checked.code}`, outcome: "refused", at });
    return refusedBy(checked).response;
  }
  const operation = cardOperationOf(surface, scope, write, category, checked);
  const digest = digestOf(operation);
  const retryNote =
    operation.operation === "write"
      ? "; once they approve, send the same request again: the approval covers this file's chunks and its finalize for a short time"
      : "";

  const waiting = waitingCard(services, digest, at);
  if (waiting !== undefined) {
    audit(services, { asked, decision: `the execution policy asks (${decided.reason}); already waiting on card ${waiting}`, outcome: "pending", at });
    return json(202, {
      outcome: "approval-required",
      approvalRequired: { approvalId: waiting },
      operation: write.operation,
      message: `the person has not decided the card already in the conversation for this; nothing is written until they approve it${retryNote}`,
    });
  }
  if (waitingCount(services, surface, scope.conversationId, at) >= MAX_PENDING_CARDS) {
    audit(services, { asked, decision: `the execution policy asks, and ${String(MAX_PENDING_CARDS)} cards from this surface are already waiting`, outcome: "refused", at });
    return fail(
      429,
      "APPROVALS_PENDING",
      `${String(MAX_PENDING_CARDS)} approval cards from this surface are already waiting in this conversation; nothing was written. Wait for the person to decide them`,
    );
  }

  const approval = requestApproval(
    { db: services.runtime.db, nodeId: services.runtime.identity.nodeId, now: () => at, newId: services.conductor.newId },
    { operationDigest: digest, operationDescription: bounded(cardText(operation, localeOf(services, at))), effectCategory: category, ttlMs: APPROVAL_TTL_MS },
  );
  // Checked against the card's own schema, so a host block the node stores is always one a client can draw.
  const card = approvalCardBlockSchema.parse({
    type: "approval-card",
    owner: "host",
    approvalId: approval.approvalId,
    operationDescription: approval.operationDescription,
    operationDigest: approval.operationDigest,
    payload: JSON.stringify(operation),
    effectCategory: category,
    expiresAt: approval.expiresAt,
    decider: approval.decider,
    decision: approval.decision,
  });
  appendHostReply(services, { conversationId: scope.conversationId, blocks: [card as MessageBlock], at });
  stateOf(services).pending.set(approval.approvalId, { surface, conversationId: scope.conversationId });
  audit(services, {
    asked,
    decision: `the execution policy asks (${category}: ${decided.reason}); waiting for the person on card ${approval.approvalId}`,
    outcome: "pending",
    at,
  });
  return json(202, {
    outcome: "approval-required",
    approvalRequired: { approvalId: approval.approvalId },
    operation: write.operation,
    message: `${decided.reason}; the person decides this on the card in the conversation, and nothing is written until they approve it${retryNote}`,
  });
}

/** Whether an approval card's payload is a machine surface's widget artifact write. */
export function isWidgetArtifactWritePayload(payload: string): boolean {
  try {
    const value = JSON.parse(payload) as unknown;
    return value !== null && typeof value === "object" && (value as { kind?: unknown }).kind === PAYLOAD_KIND;
  } catch {
    return false;
  }
}

function readOperation(payload: string): CardOperation | undefined {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(payload) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    parsed = value as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (parsed.kind !== PAYLOAD_KIND) return undefined;
  const operations: readonly unknown[] = ["create", "write", "attach", "discard"];
  const categories: readonly unknown[] = ["local-write", "destructive"];
  if (machineSurfaceOf(parsed.surface) === undefined || !operations.includes(parsed.operation) || !categories.includes(parsed.category)) return undefined;
  if (typeof parsed.conversationId !== "string" || typeof parsed.instanceId !== "string") return undefined;
  if (parsed.operation === "create" ? typeof parsed.mimeType !== "string" : typeof parsed.artifactId !== "string") return undefined;
  if (parsed.name !== undefined && typeof parsed.name !== "string") return undefined;
  return parsed as unknown as CardOperation;
}

type ApprovedRun = { ok: true; blocks: MessageBlock[]; description: string } | { ok: false; code: string; message: string; blocks: MessageBlock[] };

function receipt(input: {
  approvalId: string;
  at: Instant;
  label: string;
  operation?: CardOperation;
  outcome: { artifactId: string } | { code: string };
}): MessageBlock {
  return {
    type: "tool-activity",
    toolCallId: `widget-artifact-${input.approvalId}`,
    name: "widget_artifact_write",
    label: input.label,
    status: "artifactId" in input.outcome ? "done" : "failed",
    // The approval id travels with the receipt so the card it answered reads as decided, including after a reload; the
    // artifact id is how the client that asked finds a file the approved write created.
    args: {
      approvalId: input.approvalId,
      decision: "granted",
      ...(input.operation === undefined ? {} : { operation: input.operation.operation, instanceId: input.operation.instanceId }),
      ...input.outcome,
    },
    startedAt: input.at,
    endedAt: input.at,
  } as MessageBlock;
}

/**
 * Run what the person approved on a card.
 *
 * The payload is the card's own, hashed again against the digest the decision covered, so what runs is what was shown;
 * the instance must still be the person's and in this conversation, a discard's category must still be the one shown,
 * and a refusal the person set after the card was shown still stands. The broker judges the write as it would any other.
 * Every outcome, including a refusal after the approval was spent, comes back as a receipt, so the card shows how it
 * ended rather than offering a decision that can no longer be made.
 */
export function runApprovedWidgetArtifactWrite(
  services: MachineWriteServices,
  input: { payload: string; expectedDigest: string; approvalId: string; conversationId: string; at: Instant },
): ApprovedRun {
  const locale = localeOf(services, input.at);
  stateOf(services).pending.delete(input.approvalId);
  const failed = (code: string, message: string, operation?: CardOperation): ApprovedRun => ({
    ok: false,
    code,
    message,
    blocks: [receipt({ approvalId: input.approvalId, at: input.at, label: receiptFailed(code, locale), ...(operation === undefined ? {} : { operation }), outcome: { code } })],
  });

  const operation = readOperation(input.payload);
  if (operation === undefined) return failed("APPROVAL_PAYLOAD_UNREADABLE", "the approved payload names no widget file write");
  const asked = askedOfCard(operation);
  if (digestOf(operation) !== input.expectedDigest || operation.conversationId !== input.conversationId) {
    audit(services, { asked, decision: `approved on card ${input.approvalId}, but the card's request changed after it was shown`, outcome: "refused", at: input.at });
    return failed("APPROVAL_FORGED", "the operation changed after it was displayed; the decision does not cover what would run", operation);
  }
  const principalId = services.runtime.identity.ownerPrincipalId;
  const instance = getInstance(services.conductor, operation.instanceId);
  if (
    instance?.ownerPrincipalId !== principalId ||
    !instanceIsInConversation(services.runtime.db, { conversationId: operation.conversationId, instanceId: operation.instanceId })
  ) {
    audit(services, { asked, decision: `approved on card ${input.approvalId}, but the widget is no longer here`, outcome: "refused", at: input.at });
    return failed("RESOURCE_NOT_FOUND", "the widget this write was approved for is no longer in this conversation", operation);
  }
  const scope = { principalId, conversationId: operation.conversationId, instanceId: operation.instanceId };
  const write: WidgetArtifactWrite =
    operation.operation === "create"
      ? { operation: "create", mimeType: operation.mimeType ?? "", ...(operation.name === undefined ? {} : { name: operation.name }) }
      : operation.operation === "attach"
        ? { operation: "attach", artifactId: operation.artifactId ?? "", ...(operation.name === undefined ? {} : { name: operation.name }) }
        : operation.operation === "discard"
          ? { operation: "discard", artifactId: operation.artifactId ?? "" }
          : { operation: "finalize", artifactId: operation.artifactId ?? "" };
  if (categoryOf(services, operation.surface, scope, write) !== operation.category) {
    audit(services, { asked, decision: `approved on card ${input.approvalId}, but the file changed since the card was shown`, outcome: "refused", at: input.at });
    return failed("APPROVAL_STALE", "the file changed since the card was shown; the approval does not cover what would run now", operation);
  }
  const policy = readExecutionPolicy({ db: services.runtime.db, now: () => input.at }, principalId);
  const now = decideExecution({
    policy,
    action: { kind: "effect", category: operation.category, operationDigest: input.expectedDigest },
    intent: { kind: "system" },
  });
  if (now.kind === "deny") {
    audit(services, { asked, decision: `approved on card ${input.approvalId}, then refused by the execution policy (${now.reason})`, outcome: "refused", at: input.at });
    return failed("POLICY_REFUSED", now.reason, operation);
  }

  // Write access to an existing file runs nothing now: it lets the surface's next chunks and its finalize through.
  const performed: PerformedWrite =
    operation.operation === "write"
      ? (() => {
          const checked = checkArtifactOperation(brokerDepsOf(services), { principalId, instanceId: operation.instanceId, artifactId: operation.artifactId ?? "", need: "write" });
          return checked.ok
            ? { ok: true as const, response: json(200, { artifactRef: checked.ref }), artifactId: checked.ref.artifactId }
            : refusedBy(checked);
        })()
      : performWidgetArtifactWrite(brokerDepsOf(services), scope, write);
  if (operation.operation !== "write") afterWrite(services, operation.surface, write, performed);
  if (performed.ok && (operation.operation === "create" || operation.operation === "write")) {
    stateOf(services).rights.set(rightKey(operation.surface, operation.instanceId, performed.artifactId), {
      surface: operation.surface,
      conversationId: operation.conversationId,
      instanceId: operation.instanceId,
      artifactId: performed.artifactId,
      approvalId: input.approvalId,
      expiresAtMs: Date.parse(input.at) + WRITE_RIGHT_TTL_MS,
    });
  }
  audit(services, {
    asked,
    decision: performed.ok
      ? `approved by the person on card ${input.approvalId}${operation.operation === "create" || operation.operation === "write" ? `, with a write right for ${String(WRITE_RIGHT_MINUTES)} minutes` : ""}`
      : `approved by the person on card ${input.approvalId}, refused by the broker with ${performed.code}`,
    outcome: performed.ok ? "done" : "refused",
    ...(performed.ok ? { artifactId: performed.artifactId } : {}),
    at: input.at,
  });
  if (!performed.ok) return failed(performed.code, "the widget's file store refused the approved write", operation);
  return {
    ok: true,
    blocks: [receipt({ approvalId: input.approvalId, at: input.at, label: receiptDone(operation, performed.artifactId, locale), operation, outcome: { artifactId: performed.artifactId } })],
    description: describeAsked(asked),
  };
}

/** Record that the person refused a machine surface's request on its card. Nothing ran, and the audit says so. */
export function recordDeniedWidgetArtifactWrite(
  services: MachineWriteServices,
  input: { payload: string; approvalId: string; at: Instant },
): void {
  stateOf(services).pending.delete(input.approvalId);
  const operation = readOperation(input.payload);
  if (operation === undefined) return;
  audit(services, { asked: askedOfCard(operation), decision: `denied by the person on card ${input.approvalId}`, outcome: "refused", at: input.at });
}
