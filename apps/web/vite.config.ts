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
    rollupOptions: {
      /*
       * Two entries: the app, and the widget runtime a frame loads.
       *
       * The second one carries a fixed file name on purpose. The node injects a script tag pointing at it into the
       * widget document it serves, and a hashed name would mean the node had to be told what the build produced —
       * a coupling that breaks the first time somebody rebuilds.
       */
      input: {
        main: `${here}index.html`,
        widgetRuntime: `${here}src/widget-runtime.ts`,
      },
      /*
       * Keep the runtime entry's exports, which Vite otherwise strips.
       *
       * Vite defaults `preserveEntrySignatures` to `false` for an app, which lets Rollup treat an entry as a
       * run-for-side-effects file. This entry does nothing *but* re-export, so the default built a `widget-runtime.js`
       * that loaded, parsed and exported nothing — the frame's bootstrap imported it successfully, found no
       * `createWidgetRuntime`, and the frame sat at `loading` with no error a person could act on. `strict` makes the
       * build either keep every export or fail, which is the behaviour this entry needs to be trustworthy.
       */
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: (chunk) => (chunk.name === "widgetRuntime" ? "widget-runtime.js" : "assets/[name]-[hash].js"),
      },
    },
    /**
     * The capture worklet must be emitted as its own file, never inlined.
     *
     * Vite inlines small assets as `data:` URLs, and the app's policy is `script-src 'self'`, so an
     * inlined worklet is blocked from loading — the session then reports that it is listening while
     * capturing nothing. A `blob:` URL fails for the same reason. This function is what keeps it a
     * same-origin file, which is the only form the policy allows.
     *
     * Returning `false` means "never inline"; returning `undefined` keeps Vite's default for every
     * other asset, so nothing else about the build changes.
     *
     * Fonts are never inlined either, for the same kind of reason: the policy has no `font-src`, so it
     * falls back to `default-src 'self'` and refuses a `data:` font. The smallest subsets of the UI
     * face - Vietnamese among them - are under Vite's inline limit, so they were the ones refused, and
     * the diacritics were drawn in a fallback face while the console said why.
     */
    assetsInlineLimit: (filePath: string): boolean | undefined =>
      filePath.endsWith("voice-capture-worklet.js") || /\.woff2?$/.test(filePath) ? false : undefined,
  },
});
