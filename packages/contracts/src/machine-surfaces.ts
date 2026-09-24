/**
 * Routes a machine surface must not relay.
 *
 * Approving a guarded action, deciding a package capability, confirming an app intent, trusting a paired peer and
 * issuing a grant are each the person's decision. MCP has no tool for any of them, and the generic relays - the
 * WebSocket `request` frame and `clarkcant api` - would otherwise reach the same decision by path. They refuse these
 * routes instead, so an AI client handed one of those surfaces cannot approve its own action or widen its own trust.
 * The person's own surfaces call the routes over HTTP as before. Stop, answering a question and reading stay
 * reachable everywhere.
 *
 * Segments are split the way the gateway splits them (on `/`, empty segments dropped, no decoding), so a path this
 * lets through cannot reach one of these routes under another spelling.
 */
export function isPersonOnlyRoute(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const segments = (path.split("?")[0] ?? "").split("/").filter((segment) => segment !== "");
  const [first, second, third, fourth, fifth] = segments;
  switch (segments.length) {
    case 1:
      // POST /grants
      return first === "grants";
    case 2:
      // POST /app-intents/confirm
      return first === "app-intents" && second === "confirm";
    case 3:
      // POST /peers/:id/confirm
      return first === "peers" && third === "confirm";
    case 4:
      // POST /packages/approvals/:id/decision
      return first === "packages" && second === "approvals" && fourth === "decision";
    case 5:
      // POST /conversations/:id/approvals/:approvalId/decide
      return first === "conversations" && third === "approvals" && fifth === "decide";
    default:
      return false;
  }
}

/** The refusal a machine surface gives for a person-only route, in the shape every surface uses. */
export const PERSON_ONLY_REFUSAL = Object.freeze({
  code: "PERSON_ONLY",
  message: "approvals, grants and trust are decided by the person on their own surface, not through a machine interface",
});
