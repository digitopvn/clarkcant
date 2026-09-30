/**
 * Routes a machine surface must not relay.
 *
 * Approving a guarded action, deciding a package capability, confirming an app intent, trusting a paired peer and
 * issuing a grant are each the person's decision. MCP has no tool for any of them, and the generic relays - the
 * WebSocket `request` frame and `clarkcant api` - would otherwise reach the same decision by path. They refuse these
 * routes instead, so an AI client handed one of those surfaces cannot approve its own action or widen its own trust.
 * Exporting a table to a CSV file is the person's too: it hands a whole dataset over as a download. The person's own
 * surfaces call the routes over HTTP as before. Stop, answering a question and reading stay reachable everywhere.
 * Saying whether an effect whose outcome was unknown took effect is the person's for the same reason as an approval: it
 * decides what a task may report about itself. Installing the update a notice announces is the person's too: it puts new
 * code on the machine and grants that code the capabilities its manifest asks for, which is exactly the trust an AI
 * client must not be able to widen for itself. Installing a package at all is the person's for the same reason, and so
 * is deciding an install their execution policy asked about: that decision runs the install.
 * Saving a widget's artifact to a file (Save As) and handing a widget a file the person picked are the person's too:
 * one writes onto their machine, the other grants a widget bytes it could not otherwise reach.
 *
 * Segments are split the way the gateway splits them (on `/`, empty segments dropped, no decoding), so a path this
 * lets through cannot reach one of these routes under another spelling. A route guarded here must not decode the
 * segment it is matched on either — the notice-action route takes its action name raw and refuses anything that is not
 * a plain action id, so `/actions/%75pdate` is refused rather than read as `update`.
 */
export function isPersonOnlyRoute(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const segments = (path.split("?")[0] ?? "").split("/").filter((segment) => segment !== "");
  const [first, second, third, fourth, fifth, sixth] = segments;
  switch (segments.length) {
    case 1:
      // POST /grants
      return first === "grants";
    case 2:
      // POST /app-intents/confirm, and POST /packages/install: putting a package's code on the machine. Only the app's
      // own install button calls it; the agents list, uninstall and roll back packages but never install one.
      return (first === "app-intents" && second === "confirm") || (first === "packages" && second === "install");
    case 3:
      // POST /peers/:id/confirm, and POST /app-intents/host-control/:controlId: the screen's own report of
      // what it did with an agent's app-control action, which a machine surface must not be able to forge.
      // POST /effects/:effectId/reconcile: what the person saw of an effect whose outcome nobody observed. An AI client
      // that could say "that push landed" could clear its own task's uncertainty and then report its own success.
      return (
        (first === "peers" && third === "confirm") ||
        (first === "app-intents" && second === "host-control") ||
        (first === "effects" && third === "reconcile") ||
        // POST /artifacts/:id/export: Save As, the bytes of an artifact written to a file on the person's machine.
        (first === "artifacts" && third === "export")
      );
    case 4:
      // POST /packages/approvals/:id/decision: a capability for an installed generation, or an install the policy asked about
      return first === "packages" && second === "approvals" && fourth === "decision";
    case 5:
      // POST /conversations/:id/approvals/:approvalId/decide (a card) and
      // POST /tasks/:id/approvals/:approvalId/decide (an approval a running task raised, which has no card)
      if ((first === "conversations" || first === "tasks") && third === "approvals" && fifth === "decide") return true;
      // POST /conversations/:id/widgets/:instanceId/export: a table's rows written to a file for the person to
      // download. A machine surface reads the conversation instead; a whole dataset handed over as a file is not a read
      // an AI client should be able to make on the person's behalf.
      if (first === "conversations" && third === "widgets" && fifth === "export") return true;
      // POST /inbox/notices/:id/actions/update: installing the version an update notice names.
      return first === "inbox" && second === "notices" && fourth === "actions" && fifth === "update";
    case 6:
      // POST /conversations/:id/widgets/:instanceId/artifacts/pick: a file the person chose in host chrome, granted to
      // a widget. The grant is the person's choice; a machine surface cannot make it for them.
      return first === "conversations" && third === "widgets" && fifth === "artifacts" && sixth === "pick";
    default:
      return false;
  }
}

/** The refusal a machine surface gives for a person-only route, in the shape every surface uses. */
export const PERSON_ONLY_REFUSAL = Object.freeze({
  code: "PERSON_ONLY",
  message:
    "approvals, grants, trust, file exports, installing packages and updates, and what an unknown effect did are decided by the person on their own surface, not through a machine interface",
});
