import { MAP_TILE_POLICY_PREFERENCE } from "./map-view.ts";
import { PACKAGE_INSTRUCTIONS_PREFERENCE } from "./package-instructions.ts";
import { COMPOSER_SURFACE_HEADER } from "./surfaces.ts";

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
 * one writes onto their machine, the other grants a widget bytes it could not otherwise reach. A widget's browser token
 * is asked for only by the host chrome showing that widget: through a machine surface it would be a provider credential
 * handed to whoever relayed the request. Connecting a package's service to an account is the person's for the same
 * reason: it is the consent that lets the package act on that account. Writing the node's map tile policy directly, or
 * undoing a write, is the person's too: a machine surface that wants it changed asks Clark, whose `set_map_tiles` is
 * decided by the execution policy like any other effect. Entering or removing the map tile key is the person's alone:
 * it binds the key to the one origin the node will send it to, and nothing else can move it to another. Writing which
 * projects a package's instructions apply in, or undoing a write, is the person's too: a machine surface that wants one
 * enabled asks Clark, whose `manage_package` is decided by the execution policy.
 *
 * Segments are split the way the gateway splits them (on `/`, empty segments dropped, no decoding), so a path this
 * lets through cannot reach one of these routes under another spelling. A route guarded here must not decode the
 * segment it is matched on either — the notice-action route takes its action name raw and refuses anything that is not
 * a plain action id, so `/actions/%75pdate` is refused rather than read as `update`.
 */
export function isPersonOnlyRoute(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  const segments = (path.split("?")[0] ?? "").split("/").filter((segment) => segment !== "");
  const [first, second, third, fourth, fifth, sixth] = segments;
  // PUT /preferences/maps.tilePolicy and POST /preferences/maps.tilePolicy/undo: which host every map on the node may
  // fetch tiles from, and so tell what it shows. An AI client that could name that host could widen the node's reach.
  if (first === "preferences" && (second === MAP_TILE_POLICY_PREFERENCE || second === PACKAGE_INSTRUCTIONS_PREFERENCE)) {
    return (verb === "PUT" && segments.length === 2) || (verb === "POST" && segments.length === 3 && third === "undo");
  }
  // PUT and DELETE /map-tiles/key: the tile provider's key, and the origin it is bound to. Reading whether one is saved,
  // and for which origin, stays reachable.
  if (first === "map-tiles" && second === "key" && segments.length === 2) return verb !== "GET";
  // Signing in to and out of AI providers, and following a sign-in: whose account the node's models run on is the
  // person's to decide, and a sign-in's page and codes are theirs to see. Listing which providers are signed in stays
  // reachable, as the model picker's own catalogue is.
  if (first === "providers") return !(verb === "GET" && second === "auth" && segments.length === 2);
  if (verb !== "POST") return false;
  switch (segments.length) {
    case 1:
      // POST /grants
      return first === "grants";
    case 2:
      // POST /app-intents/confirm, and POST /packages/install: putting a package's code on the machine. Only the app's
      // own install button calls it; the agents list, uninstall and roll back packages but never install one.
      // POST /widget-dev/sessions installs a folder's package the same way, so it is the person's too; a machine surface
      // that wants one asks Clark, whose `develop_widget` is decided by the execution policy like any install.
      return (
        (first === "app-intents" && second === "confirm") ||
        (first === "packages" && second === "install") ||
        (first === "widget-dev" && second === "sessions")
      );
    case 3:
      // POST /peers/:id/confirm, and POST /app-intents/host-control/:controlId: the screen's own report of
      // what it did with an agent's app-control action, which a machine surface must not be able to forge.
      // POST /effects/:effectId/reconcile: what the person saw of an effect whose outcome nobody observed. An AI client
      // that could say "that push landed" could clear its own task's uncertainty and then report its own success.
      return (
        (first === "conversations" && third === "delete") ||
        (first === "peers" && third === "confirm") ||
        (first === "app-intents" && second === "host-control") ||
        // POST /app-intents/widget-perform/:performId: the screen's report of what a widget's frame did with an action
        // Clark asked it to perform. Forged, it would tell Clark a widget changed what it never changed.
        (first === "app-intents" && second === "widget-perform") ||
        (first === "effects" && third === "reconcile") ||
        // POST /artifacts/:id/export: Save As, the bytes of an artifact written to a file on the person's machine.
        (first === "artifacts" && third === "export") ||
        // POST /widget-dev/chosen-folders/forget: taking back which folders Clark may develop in is the person's, as
        // choosing them is.
        (first === "widget-dev" && second === "chosen-folders" && third === "forget") ||
        // POST /packages/:id/connection: connecting a package's service to the person's account. Consent is the host's
        // and the person's; an AI client that could start it could grant a package an account nobody chose to give it.
        (first === "packages" && third === "connection")
      );
    case 4:
      // POST /feedback/reports/:id/publish: filing a report on GitHub with the person's token, only on the person's own
      // Create issue press. Nothing else files one: a machine surface, or Clark through `report_feedback`, can only
      // prepare a report and show it to the person.
      if (first === "feedback" && second === "reports" && fourth === "publish") return true;
      // POST /widget-dev/sessions/:id/rebuild and /place: installing the folder's newest build, and placing it. Stopping
      // a session (DELETE) and reading one stay reachable everywhere.
      if (first === "widget-dev" && second === "sessions") return fourth === "rebuild" || fourth === "place";
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
      // POST /conversations/:id/widgets/:instanceId/browser-tokens: a provider token handed to the frame the person is
      // looking at. Only the host chrome that mounted the frame asks for one; a machine surface would be asking for a
      // credential to keep.
      if (first === "conversations" && third === "widgets" && fifth === "browser-tokens") return true;
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
    "approvals, grants, trust, file exports, widget browser tokens, deleting conversations, installing packages and updates, the map tile policy and its key, filing a product report, and what an unknown effect did are decided by the person on their own surface, not through a machine interface",
});

/**
 * The node's own machine surfaces, by the marker each puts on a request it carries: `mcp` from an MCP tool, `relay`
 * from the WebSocket `request` frame, `cli-api` from `clarkcant api`. The marker travels in a header
 * (`MACHINE_SURFACE_HEADER`), never in a body. Any HTTP caller can send it, so it is only ever a reason to decide more
 * carefully, never a reason to allow something the person's own app could not do.
 */
export const MACHINE_SURFACES = ["mcp", "relay", "cli-api"] as const;
export type MachineSurface = (typeof MACHINE_SURFACES)[number];
export const MACHINE_SURFACE_HEADER = COMPOSER_SURFACE_HEADER;

/** The machine surface a header value names, or nothing for the person's app, another value or a list of them. */
export function machineSurfaceOf(marker: unknown): MachineSurface | undefined {
  return typeof marker === "string" && (MACHINE_SURFACES as readonly string[]).includes(marker) ? (marker as MachineSurface) : undefined;
}

/** What a widget instance can do to the files in its share, through the write routes below. */
export type WidgetArtifactWriteOperation = "create" | "write" | "finalize" | "attach" | "discard";

/**
 * Routes a machine surface reaches only through the execution policy.
 *
 * A widget instance's artifact writes — start a file, append a chunk, finalize it, attach it to the conversation,
 * discard it — are a widget's acts, and an AI client or a remote machine carrying the person's token could otherwise
 * make them as if it were the widget. They are not the person's decision the way an approval is, so they are not
 * person-only: on a machine surface each one is an effect like any other, decided by the execution policy
 * (`decideExecution`) and recorded in the audit log with the surface that carried it. The person's own app calls them
 * as before. Reading stays reachable everywhere; Save As and picking a file stay person-only (`isPersonOnlyRoute`).
 *
 * Segments are split the way the gateway and `isPersonOnlyRoute` split them, so another spelling of the same path is
 * classified the same way.
 */
export function policyGatedWidgetArtifactWrite(method: string, path: string): WidgetArtifactWriteOperation | undefined {
  const verb = method.toUpperCase();
  const segments = (path.split("?")[0] ?? "").split("/").filter((segment) => segment !== "");
  if (segments[0] !== "conversations" || segments[2] !== "widgets" || segments[4] !== "artifacts") return undefined;
  // POST /conversations/:id/widgets/:instanceId/artifacts
  if (segments.length === 5) return verb === "POST" ? "create" : undefined;
  // DELETE …/artifacts/:artifactId. `…/artifacts/pick` is person-only for POST and has no DELETE of its own.
  if (segments.length === 6) return verb === "DELETE" ? "discard" : undefined;
  if (segments.length !== 7 || verb !== "POST") return undefined;
  // POST …/artifacts/:artifactId/chunks | finalize | attach
  switch (segments[6]) {
    case "chunks":
      return "write";
    case "finalize":
      return "finalize";
    case "attach":
      return "attach";
    default:
      return undefined;
  }
}
