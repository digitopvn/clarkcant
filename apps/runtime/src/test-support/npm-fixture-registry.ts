import { buildNpmTarballFromDirectory, startFakeNpmRegistry } from "@clarkcant/core/test-support/fake-npm-registry";
import { join } from "node:path";

/**
 * Long-running process Playwright's `webServer` starts and stops around the e2e suite: it tars up
 * `apps/web/e2e/fixtures/dashboard-widget` and serves it as npm package `com.acme.dashboard@1.0.0` from a local
 * HTTP server, so the "install a remote npm package" journey (`apps/web/e2e/package-install.spec.ts`) runs
 * entirely offline instead of depending on the public npm registry — which is unreachable from a sandboxed CI
 * runner and made the suite's outcome depend on a package that does not exist there.
 *
 * Started with a fixed port (`CC_NPM_FIXTURE_REGISTRY_PORT`, matching `playwright.config.ts`'s
 * `CC_NPM_REGISTRY_URL` for the runtime node) rather than an OS-assigned one: Playwright's `webServer` entries
 * start in parallel, and the runtime node needs this server's URL in its own `env` before either process starts,
 * so the port must be known up front rather than discovered after the fact.
 */
const PORT = Number(process.env["CC_NPM_FIXTURE_REGISTRY_PORT"] ?? 8878);
const FIXTURE_DIR = join(process.cwd(), "apps", "web", "e2e", "fixtures", "dashboard-widget");

async function main(): Promise<void> {
  const tarball = buildNpmTarballFromDirectory(FIXTURE_DIR);
  const registry = await startFakeNpmRegistry({
    name: "com.acme.dashboard",
    version: "1.0.0",
    tarball,
    port: PORT,
  });
  process.stdout.write(`npm fixture registry listening on ${registry.url}\n`);

  const shutdown = (): void => {
    registry
      .close()
      .catch((error: unknown) => {
        process.stderr.write(`npm fixture registry: error while closing: ${String(error)}\n`);
      })
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`npm fixture registry failed to start: ${String(error)}\n`);
  process.exit(1);
});
