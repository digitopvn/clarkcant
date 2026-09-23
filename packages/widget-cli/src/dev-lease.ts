import { claimLiveOwner, releaseLiveOwner, liveOwnerOf, type LiveOwnerClaimResult, type WidgetDeps } from "@clarkcant/core";
import { migrate, openDatabase, type Database } from "@clarkcant/storage";
import type { Instant } from "@clarkcant/contracts";

/**
 * The dev host's single-live-owner lease, answered by the real service.
 *
 * `apps/desktop` proves detaching keeps one live owner by calling the node's own `claimLiveOwner` /
 * `releaseLiveOwner` route (`apps/runtime/src/routes/conversations.ts`), which is a thin HTTP wrapper over
 * `@clarkcant/core`'s `widget-service.ts`. The dev host has no node behind it — it is a local tool for one
 * author, not a conversation server — but the question "did the lease ever have two owners" is the same
 * question, and the answer has to come from the same function or it is not the same question. This module is
 * that function, given a real (in-memory) database instead of a node's durable one: it opens a database, runs
 * the real migrations so `widget_live_owners` and its foreign key exist, and calls the exact `claimLiveOwner` /
 * `releaseLiveOwner` / `liveOwnerOf` the runtime calls. Nothing about "is a claim refused while another is
 * live" or "does an expired lease recover" is reimplemented here.
 */

const DEV_INSTANCE_ID = "dev-instance";
const DEV_NODE_ID = "dev-host";
const DEV_PRINCIPAL_ID = "dev-author";

export type { LiveOwnerClaimResult };

export interface DevLeaseStore {
  /** The instance every claim in this store is about — one widget, the one the dev host is showing. */
  readonly instanceId: string;
  claim(input: { ownerToken: string; surface: "inline" | "pin" | "detached" }): LiveOwnerClaimResult;
  release(ownerToken: string): boolean;
  current(): ReturnType<typeof liveOwnerOf>;
  close(): void;
}

/**
 * Open a fresh lease store for one dev host process.
 *
 * In-memory and migrated from scratch: a dev host is a short-lived local tool, and a store that survived restarts
 * would let a lease from a killed session outlive the session that claimed it.
 */
export function openDevLeaseStore(): DevLeaseStore {
  const db: Database = openDatabase({ path: ":memory:" });
  migrate(db);

  /*
   * The one row `widget_live_owners` requires to exist before a claim can be made — its instance_id column is a
   * foreign key. This is schema setup, not lease policy: the row carries no claim, no owner, nothing the claim
   * functions decide. A dev host shows exactly one widget instance, so one row, inserted once, is enough.
   */
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO widget_instances
       (instance_id, definition_id, definition_version, package_digest, owner_node_id, owner_principal_id,
        revision, presentation_revision, data_revision, action_binding_revision, lifecycle, document, updated_at)
     VALUES (?, 'dev.widget@1', '0.0.0', 'sha256:dev', ?, ?, 1, 1, 1, 1, 'ready', '{}', ?)`,
  ).run(DEV_INSTANCE_ID, DEV_NODE_ID, DEV_PRINCIPAL_ID, now);

  const deps: WidgetDeps = {
    db,
    nodeId: DEV_NODE_ID,
    now: () => new Date().toISOString() as Instant,
    newId: (prefix) => `${prefix}_dev`,
  };

  return {
    instanceId: DEV_INSTANCE_ID,
    claim: (input) =>
      claimLiveOwner(deps, { instanceId: DEV_INSTANCE_ID, ownerToken: input.ownerToken, surface: input.surface }),
    release: (ownerToken) => releaseLiveOwner(deps, DEV_INSTANCE_ID, ownerToken),
    current: () => liveOwnerOf(deps, DEV_INSTANCE_ID),
    close: () => db.close(),
  };
}
