import type { ExecutionPolicyConfig } from "@clarkcant/contracts";

import type { PolicyDecision } from "./execution-policy.ts";

/**
 * Whether Clark may send on an external channel, decided by the one execution policy.
 *
 * Sending is a `communication` effect wherever it goes. What differs is whose intent stands behind it:
 *
 * - **A reply on the route a message came in on.** The owner bound that space to the conversation so Clark would talk
 *   there, and the person who wrote asked; answering them where they wrote is the conversation itself, not Clark
 *   reaching somewhere new. So it is sent without asking in every mode — unless the owner refused all effects, refused
 *   `communication` with a rule, or wrote a rule that asks before it, which are their own decisions and always win.
 * - **Anything else** — another space, a message nobody asked for — is an ordinary `communication` effect, decided by
 *   `decideExecution` with the intent behind it, by whoever sends it (the delivery router of #526). A connected
 *   channel alone authorizes nothing there.
 */
export function decideChannelReply(policy: ExecutionPolicyConfig, operationDigest: string): PolicyDecision {
  if (policy.prohibition === "all") {
    return { kind: "deny", reason: "this node refuses every effect, so no category is exempt", refusal: { code: "prohibited" } };
  }
  const rule = policy.rules.find((candidate) => candidate.effectCategory === "communication");
  if (rule?.decision === "deny") {
    return {
      kind: "deny",
      reason: "a rule refuses communication effects on this machine",
      refusal: { code: "rule", category: "communication" },
    };
  }
  if (rule?.decision === "ask") {
    return {
      kind: "ask",
      reason: "a rule asks before communication effects, replies included",
      approvalSpec: { effectCategory: "communication", operationDigest, because: "a rule asks before communication effects" },
    };
  }
  return {
    kind: "execute",
    reason: "a reply where the message was written, on a space the owner bound to this conversation",
    audit: true,
  };
}
