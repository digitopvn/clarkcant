import {
  type EffectCategory,
  type Instant,
  MAP_TILE_POLICY_PREFERENCE,
  type MapTilePolicy,
  type MapTilePolicyView,
  type MessageBlock,
  mapTilePolicySchema,
  mapTilePolicyView,
} from "@clarkcant/contracts";
import {
  type ApprovalRecord,
  type PreferenceWriteOutcome,
  decideExecution,
  readExecutionPolicy,
  recordEffectExecution,
  requestApproval,
  writeRegisteredPreference,
} from "@clarkcant/core";
import { asJsonValue, type Database, payloadDigest } from "@clarkcant/storage";

import { mapTileCredentialProblem, readMapTileKey, readMapTilePolicy } from "../map-tiles.ts";

/**
 * Setting and clearing the node's map tile policy, whoever asks.
 *
 * Settings (a person's click on `PUT /preferences/maps.tilePolicy`) and Clark (`set_map_tiles`) end in the same
 * `writeMapTilePolicy`, so the policy has one schema, one store and one answer. What differs is who decides:
 *
 *   - a click in host-owned Settings is the person deciding, and the route is person-only, so no AI client or
 *     remote surface reaches it (`isPersonOnlyRoute`);
 *   - Clark setting or clearing the policy is an effect like any other, decided by the execution policy
 *     (`decideExecution`): it runs, with an activity record and the preference's Undo; or it becomes a host-owned
 *     approval card the person decides; or it is refused. No rule here asks on its own account.
 *
 * What keeps a provider Clark names from receiving the person's key is not a confirmation but the key itself: it is the
 * host's own secret `maps:tiles`, bound to the one origin the person entered it for in Settings, and the node sends it
 * nowhere else (`mapTileCredentialProblem`). Clark can name a provider; it cannot move the key to it. A provider named at
 * another origin runs without the key — offline-only, `key-origin-mismatch` — until the person enters the key again.
 *
 * Who wrote the policy is recorded: a click as the person's (`user`), Clark's write as `agent`, whether the policy ran
 * it or the person approved Clark's card.
 *
 * A widget never reaches any of it: the tool is the model's, and a card is decided only on the person-only approval
 * route.
 */

export type MapTilePolicySource = "click" | "agent" | "voice";

/** What a person or Clark is told about the policy now. The key's value is never part of it; only whether one is usable. */
export interface MapTilePolicyStatus {
  policy: MapTilePolicy;
  view: MapTilePolicyView;
  /** Present when the policy names a key: whether this node sends it to the policy's origin now. */
  keyUsable?: boolean;
  keyProblem?: string;
  /** The saved key: the origin it is bound to, or `null` when none is saved. Never its value. */
  savedKey: { origin?: string } | null;
}

export function mapTilePolicyStatus(deps: { db: Database; now: () => Instant }, principalId: string): MapTilePolicyStatus {
  const policy = readMapTilePolicy(deps, principalId);
  const savedKey = readMapTileKey({ db: deps.db, principalId });
  if (policy === null) return { policy, view: mapTilePolicyView(null), savedKey };
  const problem = mapTileCredentialProblem({ db: deps.db, principalId }, policy);
  return {
    policy,
    view: mapTilePolicyView(policy, problem?.offline),
    ...(policy.credential === undefined ? {} : { keyUsable: problem === undefined }),
    ...(problem === undefined ? {} : { keyProblem: problem.message }),
    savedKey,
  };
}

/**
 * The one write: the registered preference, validated by its schema, recorded with who made it. Used by the Settings
 * route, Clark's write under the execution policy, and an approved card.
 */
export function writeMapTilePolicy(
  deps: { db: Database; now: () => Instant },
  input: { principalId: string; value: unknown; source: MapTilePolicySource },
): PreferenceWriteOutcome {
  return writeRegisteredPreference(deps, {
    principalId: input.principalId,
    key: MAP_TILE_POLICY_PREFERENCE,
    value: input.value,
    source: input.source === "click" ? "user" : "agent",
  });
}

/** Setting a provider reaches past this machine; turning tiles off does not. */
export function mapTilePolicyCategory(policy: MapTilePolicy): EffectCategory {
  return policy === null ? "local-write" : "external-write";
}

/** What an approval is bound to: exactly this policy. A card shown for one provider cannot write another. */
export function mapTilePolicyDigest(policy: MapTilePolicy): string {
  return payloadDigest(asJsonValue({ kind: "map-tile-policy", policy }));
}

const SETTINGS_PLACE = "Cài đặt → Tiện ích → Ô bản đồ";

/**
 * Where the key goes under this policy, in the person's words: to the policy's origin only when the saved key was
 * entered for it, and otherwise nowhere, with what the person does about it.
 */
function describeKey(policy: Exclude<MapTilePolicy, null>, savedKey: { origin?: string } | null): string {
  const credential = policy.credential;
  if (credential === undefined) return "không gửi khóa";
  const where = credential.header === undefined ? `tham số ${credential.query ?? ""}` : `header ${credential.header}`;
  if (savedKey === null) {
    return `cần khóa qua ${where}, nhưng chưa có khóa nào được lưu: bản đồ chỉ dùng nền ngoại tuyến cho tới khi người dùng nhập khóa trong ${SETTINGS_PLACE}`;
  }
  if (savedKey.origin === policy.origin) return `gửi khóa đã lưu cho ${policy.origin} qua ${where}, chỉ tới ${policy.origin}`;
  const bound = savedKey.origin === undefined ? "không gắn với nguồn nào" : `được nhập cho ${savedKey.origin}`;
  return (
    `khóa đã lưu ${bound} nên KHÔNG được gửi tới ${policy.origin}: nhà cung cấp này chạy không có khóa — bản đồ chỉ dùng ` +
    `nền ngoại tuyến — cho tới khi người dùng nhập lại khóa trong ${SETTINGS_PLACE}`
  );
}

/** The card's, and the activity record's, description: whose tiles, and where the key goes. Never the key. */
export function describeMapTilePolicy(policy: MapTilePolicy, savedKey: { origin?: string } | null): string {
  if (policy === null) return "Tắt ô bản đồ: bản đồ chỉ dùng nền ngoại tuyến";
  return `Bật ô bản đồ từ ${policy.origin} (${policy.attribution}, zoom tối đa ${String(policy.maxZoom)}; ${describeKey(policy, savedKey)})`;
}

const APPROVAL_TTL_MS = 15 * 60_000;

export interface MapTilePolicyRequestDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
  principalId: string;
}

export type MapTilePolicyRequestOutcome =
  | { kind: "done"; policy: MapTilePolicy; status: MapTilePolicyStatus }
  | { kind: "approval-required"; approval: ApprovalRecord; card: Record<string, unknown> }
  | { kind: "refused"; code: string; message: string };

/**
 * Clark's request to set or clear the policy.
 *
 * The value is checked by the preference's own schema first, so nothing is written or shown for a policy that could not
 * be stored — including one naming any secret but the host's own. Then the execution policy decides, as for any effect:
 * a refusal is final, an approval becomes the host's card, and an execution writes, records and can be undone.
 */
export function requestMapTilePolicy(
  deps: MapTilePolicyRequestDeps,
  input: { value: unknown; source: Exclude<MapTilePolicySource, "click">; conversationId?: string },
): MapTilePolicyRequestOutcome {
  const parsed = mapTilePolicySchema.safeParse(input.value);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "policy"}: ${issue.message}`).join("; ");
    return { kind: "refused", code: "PREFERENCE_INVALID", message: issues };
  }
  const policy = parsed.data;
  const category = mapTilePolicyCategory(policy);
  const operationDigest = mapTilePolicyDigest(policy);
  const execution = readExecutionPolicy({ db: deps.db, now: deps.now }, deps.principalId);
  const decided = decideExecution({
    policy: execution,
    action: { kind: "effect", category, operationDigest },
    intent: { kind: "interactive" },
  });
  if (decided.kind === "deny") return { kind: "refused", code: "POLICY_REFUSED", message: decided.reason };
  const description = describeMapTilePolicy(policy, readMapTileKey({ db: deps.db, principalId: deps.principalId }));

  if (decided.kind === "execute") {
    // Recorded before the write, so the activity shows what was started even if the write is then refused.
    recordEffectExecution(deps, {
      principalId: deps.principalId,
      mode: execution.mode,
      decision: decided,
      category,
      operationDigest,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      description: `Clark: ${description}`,
    });
    const written = writeMapTilePolicy(deps, { principalId: deps.principalId, value: policy, source: input.source });
    if (!written.ok) return { kind: "refused", code: written.code, message: written.message };
    return { kind: "done", policy, status: mapTilePolicyStatus(deps, deps.principalId) };
  }

  const payload = JSON.stringify({ kind: "map-tile-policy", policy, source: input.source });
  const approval = requestApproval(deps, {
    operationDigest,
    operationDescription: description,
    effectCategory: category,
    ttlMs: APPROVAL_TTL_MS,
  });
  return {
    kind: "approval-required",
    approval,
    card: {
      type: "approval-card",
      owner: "host",
      approvalId: approval.approvalId,
      operationDescription: approval.operationDescription,
      operationDigest: approval.operationDigest,
      payload,
      effectCategory: category,
      expiresAt: approval.expiresAt,
      decider: approval.decider,
      decision: approval.decision,
    },
  };
}

/** Whether an approval card's payload is a tile policy change rather than a command or a capability call. */
export function isMapTilePolicyPayload(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as { kind?: unknown };
    return parsed.kind === "map-tile-policy";
  } catch {
    return false;
  }
}

/** What happened, in the person's words, after a policy Clark asked for was written. */
export function describeMapTileReceipt(policy: MapTilePolicy, status: MapTilePolicyStatus): string {
  if (policy === null) return "Đã tắt ô bản đồ; bản đồ chỉ dùng nền ngoại tuyến";
  if (status.keyUsable !== false) return `Đã bật ô bản đồ từ ${policy.origin}`;
  return status.view.offline === "key-origin-mismatch"
    ? `Đã đặt nhà cung cấp ô ${policy.origin}, nhưng khóa đã lưu dành cho ${status.savedKey?.origin ?? "nguồn khác"} nên không được gửi tới đó: ` +
        `bản đồ chỉ dùng nền ngoại tuyến cho tới khi người dùng nhập lại khóa trong ${SETTINGS_PLACE}`
    : `Đã đặt nhà cung cấp ô ${policy.origin}, nhưng chưa có khóa dùng được nên bản đồ vẫn chỉ dùng nền ngoại tuyến cho tới khi ` +
        `người dùng nhập khóa trong ${SETTINGS_PLACE}`;
}

/**
 * Write a tile policy a person approved on the host's card. The payload is the card's own and is hashed again against
 * the digest the decision covered, so what is written is what was shown; a refusal the person set after the card was
 * shown still stands.
 */
export function runApprovedMapTilePolicy(
  deps: { db: Database; now: () => Instant },
  input: { payload: string; expectedDigest: string; approvalId: string; principalId: string },
):
  | { ok: true; blocks: MessageBlock[]; description: string; status: MapTilePolicyStatus }
  | { ok: false; code: string; message: string } {
  let parsed: { policy?: unknown; source?: unknown };
  try {
    parsed = JSON.parse(input.payload) as typeof parsed;
  } catch {
    return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload is not readable" };
  }
  const policy = mapTilePolicySchema.safeParse(parsed.policy);
  if (!policy.success) return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload names no tile policy" };
  if (mapTilePolicyDigest(policy.data) !== input.expectedDigest) {
    return { ok: false, code: "APPROVAL_FORGED", message: "the operation changed after it was displayed; the decision does not cover what would run" };
  }
  const execution = readExecutionPolicy(deps, input.principalId);
  const now = decideExecution({
    policy: execution,
    action: { kind: "effect", category: mapTilePolicyCategory(policy.data), operationDigest: input.expectedDigest },
    intent: { kind: "interactive" },
  });
  if (now.kind === "deny") return { ok: false, code: "POLICY_REFUSED", message: now.reason };
  const startedAt = deps.now();
  const source = parsed.source === "voice" ? "voice" : "agent";
  const written = writeMapTilePolicy(deps, { principalId: input.principalId, value: policy.data, source });
  if (!written.ok) return { ok: false, code: written.code, message: written.message };
  const status = mapTilePolicyStatus(deps, input.principalId);
  const block = {
    type: "tool-activity",
    toolCallId: `map-tiles-${input.approvalId}`,
    name: "set_map_tiles",
    label: describeMapTileReceipt(policy.data, status),
    status: "done",
    // The approval id travels with the receipt so the card it answered reads as decided, including after a reload.
    args: { approvalId: input.approvalId, decision: "granted", ...(policy.data === null ? { clear: true } : { origin: policy.data.origin }) },
    startedAt,
    endedAt: deps.now(),
  } as MessageBlock;
  return {
    ok: true,
    blocks: [block],
    description: policy.data === null
      ? "turned map tiles off at Clark's request"
      : `set the map tile provider to ${policy.data.origin} at Clark's request`,
    status,
  };
}
