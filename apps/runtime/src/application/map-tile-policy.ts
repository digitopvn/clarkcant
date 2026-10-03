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

import { mapTileCredentialProblem, readMapTilePolicy } from "../map-tiles.ts";

/**
 * Setting and clearing the node's map tile policy, whoever asks.
 *
 * Settings (a person's click on `PUT /preferences/maps.tilePolicy`) and Clark (`set_map_tiles`) end in the same
 * `writeMapTilePolicy`, so the policy has one schema, one store and one answer. What differs is who decides:
 *
 *   - a click in host-owned Settings is the person deciding, and the route is person-only, so no AI client or
 *     remote surface reaches it (`isPersonOnlyRoute`);
 *   - Clark naming a provider is a request that would send this node's requests — and the provider's key — to a host
 *     the model chose. A conversation turn can come from an AI client through `ask_clark`, so Clark never sets a
 *     provider by itself: it puts a host-owned approval card in the conversation, in every execution mode, and only a
 *     person's decision on that card writes the policy. The execution policy still decides first, so a node that
 *     refuses effects refuses this one too;
 *   - Clark turning tiles off sends nothing anywhere and only narrows what the node does, so the execution policy
 *     decides it like any other local change: it runs, with an activity record, or it asks.
 *
 * A widget never reaches any of it: the tool is the model's, and the card is decided only on the person-only
 * approval route.
 */

export type MapTilePolicySource = "click" | "agent" | "voice";

/** What a person or Clark is told about the policy now. The key's value is never part of it; only whether one is usable. */
export interface MapTilePolicyStatus {
  policy: MapTilePolicy;
  view: MapTilePolicyView;
  /** Present when the policy names a key: whether this node can send it now. */
  keyUsable?: boolean;
  keyProblem?: string;
}

export function mapTilePolicyStatus(deps: { db: Database; now: () => Instant }, principalId: string): MapTilePolicyStatus {
  const policy = readMapTilePolicy(deps, principalId);
  if (policy === null) return { policy, view: mapTilePolicyView(null) };
  const keyProblem = mapTileCredentialProblem({ db: deps.db, principalId }, policy);
  return {
    policy,
    view: mapTilePolicyView(policy, keyProblem === undefined),
    ...(policy.credential === undefined ? {} : { keyUsable: keyProblem === undefined }),
    ...(keyProblem === undefined ? {} : { keyProblem }),
  };
}

/** The one write: the registered preference, validated by its schema. Used by the Settings route and the approved card. */
export function writeMapTilePolicy(
  deps: { db: Database; now: () => Instant },
  input: { principalId: string; value: unknown },
): PreferenceWriteOutcome {
  return writeRegisteredPreference(deps, { principalId: input.principalId, key: MAP_TILE_POLICY_PREFERENCE, value: input.value });
}

/** Setting a provider reaches past this machine; turning tiles off does not. */
export function mapTilePolicyCategory(policy: MapTilePolicy): EffectCategory {
  return policy === null ? "local-write" : "external-write";
}

/** What an approval is bound to: exactly this policy. A card shown for one provider cannot write another. */
export function mapTilePolicyDigest(policy: MapTilePolicy): string {
  return payloadDigest(asJsonValue({ kind: "map-tile-policy", policy }));
}

/** The card's description: whose tiles, and whether a key goes with them, by name only. */
export function describeMapTilePolicy(policy: MapTilePolicy): string {
  if (policy === null) return "Tắt ô bản đồ: bản đồ chỉ dùng nền ngoại tuyến";
  const key = policy.credential === undefined
    ? "không gửi khóa"
    : `gửi khóa ${policy.credential.secret} qua ${policy.credential.header === undefined ? `tham số ${policy.credential.query ?? ""}` : `header ${policy.credential.header}`}`;
  return `Bật ô bản đồ từ ${policy.origin} (${policy.attribution}, zoom tối đa ${String(policy.maxZoom)}; ${key})`;
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
  | { kind: "done"; status: MapTilePolicyStatus }
  | { kind: "approval-required"; approval: ApprovalRecord; card: Record<string, unknown> }
  | { kind: "refused"; code: string; message: string };

/**
 * Clark's request to set or clear the policy.
 *
 * The value is checked by the preference's own schema first, so a card is never shown for a policy that could not be
 * stored. Then the execution policy decides: a refusal is final; clearing runs when the policy allows it; setting a
 * provider always becomes a host-owned approval card, as the module comment explains.
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

  if (decided.kind === "execute" && policy === null) {
    const written = writeMapTilePolicy(deps, { principalId: deps.principalId, value: null });
    if (!written.ok) return { kind: "refused", code: written.code, message: written.message };
    recordEffectExecution(deps, {
      principalId: deps.principalId,
      mode: execution.mode,
      decision: decided,
      category,
      operationDigest,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      description: describeMapTilePolicy(null),
    });
    return { kind: "done", status: mapTilePolicyStatus(deps, deps.principalId) };
  }

  const payload = JSON.stringify({ kind: "map-tile-policy", policy, source: input.source });
  const approval = requestApproval(deps, {
    operationDigest,
    operationDescription: describeMapTilePolicy(policy),
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

/**
 * Write a tile policy a person approved on the host's card. The payload is the card's own and is hashed again against
 * the digest the decision covered, so what is written is what was shown.
 */
export function runApprovedMapTilePolicy(
  deps: { db: Database; now: () => Instant },
  input: { payload: string; expectedDigest: string; approvalId: string; principalId: string },
):
  | { ok: true; blocks: MessageBlock[]; description: string; status: MapTilePolicyStatus }
  | { ok: false; code: string; message: string } {
  let parsed: { policy?: unknown };
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
  const startedAt = deps.now();
  const written = writeMapTilePolicy(deps, { principalId: input.principalId, value: policy.data });
  if (!written.ok) return { ok: false, code: written.code, message: written.message };
  const status = mapTilePolicyStatus(deps, input.principalId);
  const label = policy.data === null
    ? "Đã tắt ô bản đồ; bản đồ chỉ dùng nền ngoại tuyến"
    : status.keyUsable === false
      ? `Đã đặt nhà cung cấp ô ${policy.data.origin}, nhưng khóa của nó chưa dùng được trên máy này nên bản đồ vẫn chỉ dùng nền ngoại tuyến`
      : `Đã bật ô bản đồ từ ${policy.data.origin}`;
  const block = {
    type: "tool-activity",
    toolCallId: `map-tiles-${input.approvalId}`,
    name: "set_map_tiles",
    label,
    status: "done",
    // The approval id travels with the receipt so the card it answered reads as decided, including after a reload.
    args: { approvalId: input.approvalId, decision: "granted", ...(policy.data === null ? { clear: true } : { origin: policy.data.origin }) },
    startedAt,
    endedAt: deps.now(),
  } as MessageBlock;
  return {
    ok: true,
    blocks: [block],
    description: policy.data === null ? "turned map tiles off" : `set the map tile provider to ${policy.data.origin}`,
    status,
  };
}
