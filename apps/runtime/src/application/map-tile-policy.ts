import {
  type AppIntentLocale,
  type EffectCategory,
  type Instant,
  MAP_TILE_POLICY_PREFERENCE,
  type MapTilePolicy,
  type MapTilePolicyView,
  type MessageBlock,
  type TurnOrigin,
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

import { preferredAppIntentLocale } from "../app-intents.ts";
import { hostText, type MapTileWords } from "../host-text.ts";
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

/**
 * Where the key goes under this policy, in the person's words: to the policy's origin only when the saved key was
 * entered for it, and otherwise nowhere, with what the person does about it.
 */
function describeKey(policy: Exclude<MapTilePolicy, null>, savedKey: { origin?: string } | null, say: MapTileWords): string {
  const credential = policy.credential;
  if (credential === undefined) return say.noKey;
  const where = credential.header === undefined ? say.keyParameter(credential.query ?? "") : say.keyHeader(credential.header);
  if (savedKey === null) return say.keyMissing(where);
  if (savedKey.origin === policy.origin) return say.keySent(policy.origin, where);
  return say.keyWithheld(savedKey.origin, policy.origin);
}

/**
 * The card's, and the activity record's, description: whose tiles, and where the key goes. Never the key. Worded in
 * `language`, the person's interface language; Vietnamese when none is named.
 */
export function describeMapTilePolicy(
  policy: MapTilePolicy,
  savedKey: { origin?: string } | null,
  language: AppIntentLocale = "vi",
): string {
  const say = hostText(language).approvals.mapTiles;
  if (policy === null) return say.off;
  return say.on(policy.origin, policy.attribution, policy.maxZoom, describeKey(policy, savedKey, say));
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
  input: {
    value: unknown;
    source: Exclude<MapTilePolicySource, "click">;
    conversationId?: string;
    /** Who asked for the turn that wants this (`TurnOrigin`). Absent is the person. */
    origin?: TurnOrigin;
  },
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
    intent: input.origin === undefined ? { kind: "interactive" } : { kind: "interactive", origin: input.origin },
  });
  if (decided.kind === "deny") return { kind: "refused", code: "POLICY_REFUSED", message: decided.reason };
  const description = describeMapTilePolicy(
    policy,
    readMapTileKey({ db: deps.db, principalId: deps.principalId }),
    preferredAppIntentLocale({ db: deps.db, now: deps.now }, deps.principalId),
  );

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
      ...(input.origin === undefined ? {} : { origin: input.origin }),
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
      ...(input.origin === undefined ? {} : { origin: input.origin }),
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
export function describeMapTileReceipt(
  policy: MapTilePolicy,
  status: MapTilePolicyStatus,
  language: AppIntentLocale = "vi",
): string {
  const say = hostText(language).approvals.mapTiles;
  if (policy === null) return say.turnedOff;
  if (status.keyUsable !== false) return say.turnedOn(policy.origin);
  return status.view.offline === "key-origin-mismatch"
    ? say.setButKeyElsewhere(policy.origin, status.savedKey?.origin)
    : say.setButNoKey(policy.origin);
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
    label: describeMapTileReceipt(policy.data, status, preferredAppIntentLocale(deps, input.principalId)),
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
