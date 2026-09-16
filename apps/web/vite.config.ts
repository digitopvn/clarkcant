import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const workspace = `${here}../../`;

/**
 * Vite configuration.
 *
 * Workspace packages are aliased to their sources rather than their build output, because
 * there is no build output: Node and Vite both consume TypeScript directly. The aliases
 * mirror `vitest.config.ts` so the browser and the test runner resolve the same graph.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@clarkcant/contracts": `${workspace}packages/contracts/src/index.ts`,
      "@clarkcant/design-tokens": `${workspace}packages/design-tokens/src/index.ts`,
      "@clarkcant/widget-sdk": `${workspace}packages/widget-sdk/src/index.ts`,
      "@clarkcant/conversation-client": `${workspace}packages/conversation-client/src/index.ts`,
    },
  },
  server: {
    port: 5173,
    // Loopback only: the client talks to a local node, and exposing the dev server on the
    // network would publish an interface that carries a bearer token.
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
