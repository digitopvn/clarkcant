import { createHash } from "node:crypto";

import type { EffectCategory } from "@clarkcant/contracts";
import { type CoordinationDeps, approvalAuthorizes, requestApproval } from "@clarkcant/core";
import { getChannelBinding, getExternalConnection } from "@clarkcant/storage";

import { fitHead } from "../card-text.ts";
import { hostText } from "../host-text.ts";
import type { ChannelToolGate } from "../model-turn.ts";

/**
 * The owner's gate on what a channel participant asks Clark to do.
 *
 * A participant's tool call that no standing grant on the binding covers never runs on their word, and is never simply
 * refused either: it is held, and the owner is asked on the same host-owned approval card every other held effect
 * uses. The card's payload is the exact call; its digest binds the approval to it. When the owner approves, the turn
 * that carries on (`runApprovedChannelTool` in the approve route) is a participant's turn again, holding this one
 * approved call: the gate lets that exact call through once, and only while the approval still authorizes it. Any other
 * call is held again.
 */

/** The card payload of a held participant call: the exact call, and where it was asked. */
export interface ChannelToolPayload {
  kind: "channel-tool";
  version: 1;
  tool: string;
  args: Record<string, unknown>;
  bindingId: string;
}

/** What the card can carry (`approvalCardBlockSchema.payload`). */
const PAYLOAD_MAX = 4000;
const DESCRIPTION_MAX = 2000;
/** As long as a held command's card: long enough to read and decide, short enough not to be approved tomorrow. */
const APPROVAL_TTL_MS = 15 * 60_000;
/** Approved calls already let through, by approval id; bounded so a long-running node does not grow it forever. */
const USED_MAX = 1000;

/** JSON with object keys sorted at every level, so the same call always has the same digest. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function channelToolPayload(input: { tool: string; args: Record<string, unknown>; bindingId: string }): string {
  const payload: ChannelToolPayload = { kind: "channel-tool", version: 1, tool: input.tool, args: input.args, bindingId: input.bindingId };
  return canonicalJson(payload);
}

export function channelToolDigest(payload: string): string {
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

/** The payload of a held participant call, or undefined for any other card's payload. */
export function parseChannelToolPayload(payload: string): ChannelToolPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  if (record["kind"] !== "channel-tool" || record["version"] !== 1) return undefined;
  const { tool, args, bindingId } = record;
  if (typeof tool !== "string" || typeof bindingId !== "string") return undefined;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  return { kind: "channel-tool", version: 1, tool, args: args as Record<string, unknown>, bindingId };
}

/**
 * The category a held call's card shows. Tools that only read say so; everything else is shown as a local write, the
 * more careful reading, since the card is about the owner's resources whatever the tool's own policy would say.
 */
function cardCategory(tool: string): EffectCategory {
  if (/^(read_|search_|list_|find_)/.test(tool) || ["node_status", "inspect_ui", "terminal_read"].includes(tool)) return "read";
  if (tool === "start_browser_task") return "external-write";
  return "local-write";
}

/**
 * What the model is told about a call that did not run. Model input, not text a person reads, so not in `HostText`;
 * each says that nothing ran and that the model must not claim otherwise.
 */
export const channelToolWords = {
  ownerOnly: (tool: string): string =>
    `Not run: ${tool}. The sender is not this node's owner, and only the owner can do this. Nothing ran. Tell the sender so.`,
  heldNoGate: (tool: string): string =>
    `Not run: ${tool}. The sender is not this node's owner, no grant on this channel allows it, and this node cannot ask ` +
    "the owner. Nothing ran. Do not say it was done.",
  held: (tool: string): string =>
    `Not run yet: ${tool}. The sender is not this node's owner, so the owner was asked to approve it. Nothing has run and ` +
    "you cannot approve it yourself. Tell the sender it needs the owner's approval; do not say it was done, and say " +
    "nothing about the owner's files or setup.",
  heldTooLarge: (tool: string): string =>
    `Not run: ${tool}. The sender is not this node's owner, and this call is too long to put on an approval card for the ` +
    "owner. Nothing ran. Do not say it was done.",
  approvedNote: (tool: string, args: string): string =>
    `The owner just approved exactly one call for this sender: ${tool} with the arguments ${args}. Make that call once, ` +
    "exactly so, then answer. Any other call still needs the owner's approval.",
};

export function createChannelToolGate(deps: { coordination: () => CoordinationDeps }): ChannelToolGate {
  const used = new Set<string>();
  return (call) => {
    const coordination = deps.coordination();
    const payload = channelToolPayload({ tool: call.tool, args: call.params, bindingId: call.authority.bindingId });
    const digest = channelToolDigest(payload);

    const approved = call.authority.approvedCall;
    if (approved !== undefined && approved.operationDigest === digest && !used.has(approved.approvalId)) {
      // Read again at the call, not trusted from the turn: an approval that expired or was not granted lets nothing by.
      if (approvalAuthorizes(coordination, approved.approvalId as never, digest).authorized) {
        if (used.size >= USED_MAX) used.clear();
        used.add(approved.approvalId);
        return { kind: "run" };
      }
    }

    // A card cannot hold a shortened call: a shortened call is a different call.
    if (payload.length > PAYLOAD_MAX) return { kind: "held", text: channelToolWords.heldTooLarge(call.tool) };

    const binding = getChannelBinding(coordination.db, call.authority.bindingId);
    const provider =
      (binding === undefined ? undefined : getExternalConnection(coordination.db, binding.connectionRef)?.provider) ??
      binding?.provider ??
      "a channel";
    const approval = requestApproval(coordination, {
      operationDigest: digest,
      operationDescription: fitHead(hostText(call.language).channels.toolCard(provider, call.label, call.tool), DESCRIPTION_MAX),
      effectCategory: cardCategory(call.tool),
      ttlMs: APPROVAL_TTL_MS,
    });
    return {
      kind: "held",
      text: channelToolWords.held(call.tool),
      hostCard: {
        type: "approval-card",
        owner: "host",
        approvalId: approval.approvalId,
        operationDescription: approval.operationDescription,
        operationDigest: approval.operationDigest,
        effectCategory: approval.effectCategory,
        expiresAt: approval.expiresAt,
        decider: approval.decider,
        decision: approval.decision,
        origin: "channel",
        payload,
      },
    };
  };
}
