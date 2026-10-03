import { nowInstant } from "@clarkcant/contracts";

import type { NodeServices } from "../services.ts";
import { runUpdateCheckOnce } from "../update-checks.ts";

/**
 * One package update check a browser journey can run when it is ready for it.
 *
 * The periodic check runs once shortly after a node starts and then every six hours, and a fixture node does not run it
 * at all, so a journey that installs a version and then needs the notice for the next one has nothing to wait for. This
 * runs the production check once — the same installed packages, the same directory index, the same notices — at the
 * moment the journey asks.
 *
 * Only the package half is real. The Pi SDK half reads an npm registry, and a browser suite must not depend on one
 * answering, so it is given a registry that has nothing: the check reports it as offline, which writes no notice.
 *
 * Loaded only through `bootstrap/fixtures.ts`, and only when `CC_UPDATE_CHECK_FIXTURE=1`.
 */
export function createUpdateCheckFixture(services: NodeServices): NonNullable<NodeServices["updateCheckFixture"]> {
  return {
    run: async () => {
      const report = await runUpdateCheckOnce({
        services,
        installDeps: {
          db: services.runtime.db,
          nodeId: services.runtime.identity.nodeId,
          now: nowInstant,
          newId: services.conductor.newId,
        },
        fetchImpl: () => Promise.resolve(new Response(null, { status: 404 })),
        piInstalledVersion: () => Promise.resolve("0.0.0"),
      });
      return { packageUpdates: report.packageUpdates };
    },
  };
}
