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
 * Loaded only through `bootstrap/fixtures.ts`, and only when `CC_UPDATE_CHECK_FIXTURE=1`.
 */
export function createUpdateCheckFixture(services: NodeServices): NonNullable<NodeServices["updateCheckFixture"]> {
  return {
    run: async () => {
      const report = runUpdateCheckOnce({
        services,
        dataDir: services.runtime.dataDir,
        installDeps: {
          db: services.runtime.db,
          nodeId: services.runtime.identity.nodeId,
          now: nowInstant,
          newId: services.conductor.newId,
        },
      });
      return { packageUpdates: report.packageUpdates };
    },
  };
}
