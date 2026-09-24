/**
 * Routes a machine surface must not relay.
 *
 * An approval is the person's decision. MCP has no approval tool for that reason, and the generic relays - the
 * WebSocket `request` frame and `clarkcant api` - would otherwise reach the same decision by path. They refuse these
 * routes instead, so an AI client handed one of those surfaces cannot approve its own guarded action. The person's
 * own surfaces call the routes over HTTP as before.
 */
export function isPersonOnlyRoute(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const segments = (path.split("?")[0] ?? "").split("/").filter((segment) => segment !== "");
  // POST /conversations/:id/approvals/:approvalId/decide
  if (segments.length === 5 && segments[0] === "conversations" && segments[2] === "approvals" && segments[4] === "decide") {
    return true;
  }
  // POST /packages/approvals/:id/decision
  return segments.length === 4 && segments[0] === "packages" && segments[1] === "approvals" && segments[3] === "decision";
}

/** The refusal a machine surface gives for a person-only route, in the shape every surface uses. */
export const PERSON_ONLY_REFUSAL = Object.freeze({
  code: "PERSON_ONLY",
  message: "approvals are decided by the person on their own surface, not through a machine interface",
});
