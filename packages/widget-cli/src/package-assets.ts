import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Where the CLI's non-code assets are: in this repository, or inside an installed `@clarkcant/widget-cli`.
 *
 * In the repository the CLI runs from source. Its `init` templates are the reference apps under
 * `examples/reference-apps/`, and the dev host's browser modules are TypeScript sources Vite transforms on request.
 * An installed package has neither: the examples are not part of it, and Node does not strip types from files under
 * `node_modules`. So the release build (`tools/build-widget-tooling.mjs`) copies each reference app to
 * `templates/<name>/` and bundles each browser module, with everything it imports, to `runtime/<name>.js`, both
 * beside the bundled `lib/`. Every lookup here prefers that published location and otherwise uses the checkout's.
 *
 * The package root is this file's parent directory in both layouts: `src/` in the repository, `lib/` once bundled.
 * It is also the root Vite serves from (`dev-module-server.ts`), so a runtime URL below is a path under it.
 */

/** A reference app the `init` templates copy, by its directory name under `examples/reference-apps/`. */
export type ReferenceApp = "text-editor" | "image-generator" | "media-render" | "connected-app";

/** The browser modules the dev hosts hand to a frame or a preview page. */
export type BrowserRuntime = "dev-frame-runtime" | "catalog-runtime" | "theme-dev-runtime";

const RUNTIME_SOURCES: Readonly<Record<BrowserRuntime, string>> = {
  "dev-frame-runtime": "src/dev-frame-runtime.ts",
  "catalog-runtime": "src/catalog-runtime.tsx",
  "theme-dev-runtime": "src/theme-dev-runtime.tsx",
};

export interface PackageAssets {
  /** The directory a reference template is copied from. */
  referenceAppDirectory(name: ReferenceApp): string;
  /**
   * The URL, under the Vite root, of a browser module, and whether it is the release build's self-contained bundle.
   * A bundle imports nothing, so a caller asks Vite to pre-optimise no dependencies for it; a source module still
   * needs React's entry points optimised.
   */
  browserRuntime(name: BrowserRuntime): { url: string; prebundled: boolean };
}

/** The assets of the package rooted at `packageRoot` (a directory URL ending in `/`). */
export function packageAssets(packageRoot: URL): PackageAssets {
  const exists = (relative: string): boolean => existsSync(fileURLToPath(new URL(relative, packageRoot)));
  return {
    referenceAppDirectory: (name) => {
      const published = `templates/${name}/`;
      return fileURLToPath(new URL(exists(published) ? published : `../../examples/reference-apps/${name}/`, packageRoot));
    },
    browserRuntime: (name) => {
      const published = `runtime/${name}.js`;
      return exists(published) ? { url: `/${published}`, prebundled: true } : { url: `/${RUNTIME_SOURCES[name]}`, prebundled: false };
    },
  };
}

const assets = packageAssets(new URL("../", import.meta.url));

export const referenceAppDirectory = assets.referenceAppDirectory;
export const browserRuntime = assets.browserRuntime;
