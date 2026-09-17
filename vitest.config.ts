import { defineConfig } from "vitest/config";

/** Repository root. `import.meta.dirname` avoids a fileURLToPath dance. */
const root = `${import.meta.dirname}/`;

/**
 * Every workspace package resolves to its TypeScript source, not a build output.
 * Node 24 strips types at load time and Vite transforms them for tests, so there
 * is exactly one copy of each module in the graph.
 */
const aliases: Record<string, string> = {
  "@clarkcant/design-tokens": "packages/design-tokens/src/index.ts",
  "@clarkcant/contracts": "packages/contracts/src/index.ts",
  "@clarkcant/storage": "packages/storage/src/index.ts",
  "@clarkcant/core": "packages/core/src/index.ts",
  "@clarkcant/pi-adapter": "packages/pi-adapter/src/index.ts",
  "@clarkcant/node-link": "packages/node-link/src/index.ts",
  "@clarkcant/capability-host": "packages/capability-host/src/index.ts",
  "@clarkcant/integration-sdk": "packages/integration-sdk/src/index.ts",
  "@clarkcant/widget-sdk": "packages/widget-sdk/src/index.ts",
  "@clarkcant/widget-host": "packages/widget-host/src/index.ts",
  "@clarkcant/mcp-adapters": "packages/mcp-adapters/src/index.ts",
  "@clarkcant/host-adapters": "packages/host-adapters/src/index.ts",
  "@clarkcant/execution-supervisor": "packages/execution-supervisor/src/index.ts",
  "@clarkcant/voice-adapters": "packages/voice-adapters/src/index.ts",
  "@clarkcant/conversation-client": "packages/conversation-client/src/index.ts",
};

export default defineConfig({
  resolve: {
    alias: [
      // An exact match, listed first. A prefix alias for this pack would also rewrite its subpath
      // export (`@clarkcant/data-canvas/sample`), which the runtime imports, into a path that does
      // not exist. The pack is aliased at all so a test asserting catalog coverage can read the
      // definitions without every package having to depend on a pack.
      { find: /^@clarkcant\/data-canvas$/, replacement: `${root}packs/data-canvas/src/index.ts` },
      ...Object.entries(aliases).map(([name, rel]) => ({ find: name, replacement: `${root}${rel}` })),
    ],
  },
  test: {
    // Single-level globs on purpose: `packages/**/test/**` also matches the workspace
    // symlinks under each package's node_modules, which makes every suite run twice.
    include: [
      "packages/*/test/**/*.spec.ts",
      "packages/*/test/**/*.spec.tsx",
      "apps/*/test/**/*.spec.ts",
      "packs/*/test/**/*.spec.ts",
      // The example fixtures are executable proofs of the contracts, so their tests belong in
      // the default run rather than behind a filter nobody remembers.
      "examples/*/test/**/*.spec.ts",
    ],
    exclude: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
    environment: "node",
    reporters: ["default"],
    testTimeout: 20_000,
    restoreMocks: true,
  },
});
