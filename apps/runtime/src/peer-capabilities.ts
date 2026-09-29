import {
  type CapabilityRef,
  type Instant,
  type PeerCapabilitySummary,
  PEER_CAPABILITY_SUMMARY_MAX,
  PEER_CAPABILITY_SUMMARY_VERSION,
  peerCapabilitySummarySchema,
} from "@clarkcant/contracts";
import { canRunHere } from "@clarkcant/core";
import { type Database, getPeer, livePeerAllowance } from "@clarkcant/storage";

import type { NodeIdentity } from "./node.ts";
import { peerCapabilitiesUrl, readAnswer, sanitizeDeliveryError } from "./peer-transport.ts";
import { outboundPeerToken } from "./peers.ts";

/**
 * What a paired node can run for this one, asked before a task is handed to it.
 *
 * The receiving node answers from its owner's allowance for the asking peer and nothing else: the capability refs that
 * allowance covers, each with whether this node can run it now — the same check a hand-over is decided by. No folder,
 * no other capability and no reason text leave the node, so a peer learns no more than the owner gave it.
 *
 * The answer is a snapshot. A capability can load or fail after it was given, and an owner can change what they allow,
 * so the receiving node's own check when a task is handed over stays the one that decides; the asking node only warns.
 */

/** How long the asking node waits for an answer: a person or a model is waiting on the listing or the setup. */
export const PEER_CAPABILITIES_TIMEOUT_MS = 5_000;

/** What this node can run for a peer right now, inside what its owner allows that peer. */
export function capabilitySummaryFor(
  deps: { db: Database; nodeId: string; now: () => Instant },
  peerNodeId: string,
): PeerCapabilitySummary {
  const allowance = livePeerAllowance(deps.db, peerNodeId, deps.now());
  if (allowance === undefined) return { version: PEER_CAPABILITY_SUMMARY_VERSION, allowed: false, capabilities: [] };
  const refs = [...new Set(allowance.grant.capabilityRefs)].slice(0, PEER_CAPABILITY_SUMMARY_MAX) as CapabilityRef[];
  return {
    version: PEER_CAPABILITY_SUMMARY_VERSION,
    allowed: true,
    capabilities: refs.map((ref) => ({ ref, ready: canRunHere(deps, ref) })),
  };
}

export type PeerCapabilityAnswer =
  | { ok: true; summary: PeerCapabilitySummary }
  | { ok: false; code: "PEER_UNKNOWN" | "UNSUPPORTED" | "UNREACHABLE" | "UNREADABLE"; message: string };

/**
 * Ask a confirmed peer what it can run for this node.
 *
 * Only a peer that said it answers (`capabilities`); any other answer is read no further than the transport's bound,
 * and one that is not exactly a summary is refused whole. Never throws: a node that cannot be asked is an answer too.
 */
export async function askPeerCapabilities(
  deps: { db: Database; identity: Pick<NodeIdentity, "localToken"> },
  peerNodeId: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PeerCapabilityAnswer> {
  const peer = getPeer(deps.db, peerNodeId);
  if (peer === undefined || peer.trustedAt === null || peer.revokedAt !== null) {
    return { ok: false, code: "PEER_UNKNOWN", message: `${peerNodeId} is not a paired node` };
  }
  if (!(peer.features ?? []).includes("capabilities")) {
    return {
      ok: false,
      code: "UNSUPPORTED",
      message: "it has not said it can tell what it runs; ClarkCant there may need updating, or it has not answered anything since this node updated",
    };
  }
  const deadline = AbortSignal.timeout(options.timeoutMs ?? PEER_CAPABILITIES_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(peerCapabilitiesUrl(peer.endpoint), {
      method: "GET",
      headers: { authorization: `Bearer ${outboundPeerToken(deps.identity.localToken, peerNodeId)}` },
      // A redirect would send this node's token wherever the peer pointed.
      redirect: "error",
      signal: deadline,
    });
  } catch (cause) {
    const detail = sanitizeDeliveryError(cause instanceof Error ? cause.message : String(cause));
    return { ok: false, code: "UNREACHABLE", message: `it did not answer (${detail})` };
  }
  const text = await readAnswer(response, deadline);
  if (!response.ok) {
    return { ok: false, code: "UNREADABLE", message: `it answered ${String(response.status)}` };
  }
  let body: unknown;
  try {
    body = text === undefined ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  const summary = peerCapabilitySummarySchema.safeParse(body);
  if (!summary.success) return { ok: false, code: "UNREADABLE", message: "its answer is not a capability summary this node can read" };
  return { ok: true, summary: summary.data };
}

/** What a peer can run for this node, as a listing says it. */
export function describePeerCapabilities(answer: PeerCapabilityAnswer): string {
  if (!answer.ok) return `what it can run for this node is not known: ${answer.message}`;
  if (!answer.summary.allowed) return "runs nothing for this node: its owner has not allowed this node to run work there";
  if (answer.summary.capabilities.length === 0) return "runs nothing for this node: its owner allows nothing it can run";
  return `can run for this node: ${answer.summary.capabilities
    .map((capability) => `${capability.ref} (${capability.ready ? "ready" : "not ready"})`)
    .join(", ")}`;
}

/**
 * What setting up a task for that peer should say about it: whether the peer can run the capability the task needs
 * for this node now. A warning, never a refusal — the peer decides when the task is handed over, and what it lacks now
 * it may have by then.
 */
export function capabilityWarning(peerNodeId: string, needed: CapabilityRef, answer: PeerCapabilityAnswer): string {
  if (!answer.ok) {
    return `Could not check what ${peerNodeId} can run: ${answer.message}. It is checked there each time a run is handed over.`;
  }
  if (!answer.summary.allowed) {
    return `Warning: ${peerNodeId}'s owner has not allowed this node to run work there yet, so each run is refused there until they do.`;
  }
  const offered = answer.summary.capabilities.find((capability) => capability.ref === needed);
  if (offered === undefined) {
    return `Warning: what ${peerNodeId}'s owner allows this node there does not cover ${needed}, which this task needs, so each run is refused there until they allow it.`;
  }
  if (!offered.ready) {
    return `Warning: ${peerNodeId} cannot run ${needed} right now. A run handed over waits there until it can, and it is said in this conversation.`;
  }
  return `${peerNodeId} can run ${needed} for this node now.`;
}
