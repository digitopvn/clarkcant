/**
 * Whose authority a turn an external channel started acts with.
 *
 * A channel admits people who are not the owner of this node — a group chat, a friend in a direct chat. What they ask
 * Clark is answered, and the answer goes back to them; what they ask Clark to *do* is not theirs to decide. So a
 * channel turn carries the sender's standing, decided by the host from who the message maps to (never from a display
 * name or anything the message says):
 *
 * - `owner`: the sender is the owner, or an external account linked to the owner's principal. The turn is the owner's
 *   own, decided by the one execution policy like any other turn.
 * - `participant`: anyone else. The turn is given none of the owner's memory, instructions or private context, the
 *   model is told by the host that the sender is not the owner, and a tool call beyond the conversation itself runs
 *   only when a standing grant on the binding covers it (`ChannelGrantRef`) or the owner approved that exact call.
 *   Anything else is held and escalated to the owner — never run on the sender's word, and never refused outright.
 *
 * Conversation itself — talking, and the reply that goes back to the same thread — stays autonomous for both.
 */

export type ChannelStanding = "owner" | "participant";

export interface ChannelTurnAuthority {
  standing: ChannelStanding;
  /** The binding the message came in on, so an escalation names where it was asked. */
  bindingId: string;
  /** The binding's standing grants, read when the turn starts. Meaningful only for a participant. */
  grants: readonly string[];
  /**
   * One call the owner approved for a participant, let through once when the call's digest matches the approved one.
   * Set only by the host, on the turn that carries on after the approval.
   */
  approvedCall?: { approvalId: string; operationDigest: string };
}

/** The sender's standing: the owner's principal (directly, or through a linked account) is the owner; nobody else is. */
export function channelStanding(authorPrincipalId: string | undefined, ownerPrincipalId: string): ChannelStanding {
  return authorPrincipalId !== undefined && authorPrincipalId === ownerPrincipalId ? "owner" : "participant";
}

/**
 * Host tools that act only on the conversation itself — the reply, a view drawn into it, stopping it — and so read or
 * change nothing of the owner's. A participant's turn may call these without a grant.
 */
export const CHANNEL_CONVERSATION_TOOLS: readonly string[] = ["show_view", "stop_reply", "show_changelog"];

/**
 * Tools no grant opens to a participant: deciding an approval is the owner's own act, and a sender who could do it
 * through Clark would approve their own request.
 */
export const CHANNEL_OWNER_ONLY_TOOLS: readonly string[] = ["decide_approval"];

/** Whether the binding's standing grants cover one tool. */
export function channelGrantCoversTool(grants: readonly string[], tool: string): boolean {
  return grants.includes(`tool:${tool}`);
}

/**
 * What a participant's tool call may do before anything else is checked: run, be held for the owner, or never run
 * (an owner-only tool). An owner's turn always runs, under the tool's own policy.
 */
export function channelToolStanding(
  authority: ChannelTurnAuthority | undefined,
  tool: string,
): "run" | "needs-owner" | "owner-only" {
  if (authority === undefined || authority.standing === "owner") return "run";
  if (CHANNEL_OWNER_ONLY_TOOLS.includes(tool)) return "owner-only";
  if (CHANNEL_CONVERSATION_TOOLS.includes(tool)) return "run";
  if (channelGrantCoversTool(authority.grants, tool)) return "run";
  return "needs-owner";
}
