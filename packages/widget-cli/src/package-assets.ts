import { existsSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
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
 * The lists below are the one source both sides read: the CLI looks assets up by them, and the release build imports
 * them to decide what to copy and bundle, so a template or runtime added here cannot be missing from the package.
 *
 * The package root is this file's parent directory in both layouts: `src/` in the repository, `lib/` once bundled.
 * It is also the root Vite serves from (`dev-module-server.ts`), so a runtime URL below is a path under it.
 */

/** The reference apps the `init` templates copy, by directory name under `examples/reference-apps/`. */
export const REFERENCE_APPS = ["text-editor", "image-generator", "media-render", "connected-app"] as const;
export type ReferenceApp = (typeof REFERENCE_APPS)[number];

/** The browser modules the dev hosts hand to a frame or a preview page, by the source each one is built from. */
export const BROWSER_RUNTIME_SOURCES = {
  "dev-frame-runtime": "src/dev-frame-runtime.ts",
  "catalog-runtime": "src/catalog-runtime.tsx",
  "theme-dev-runtime": "src/theme-dev-runtime.tsx",
} as const;
export type BrowserRuntime = keyof typeof BROWSER_RUNTIME_SOURCES;

const isBrowserRuntime = (name: string): name is BrowserRuntime => Object.hasOwn(BROWSER_RUNTIME_SOURCES, name);

/**
 * A reference app's own files that describe or test that app rather than the package a person starts from. `path`
 * is relative to the app, with `/` separators; a directory is passed with a trailing `/`.
 */
export function skippedFromReference(path: string): boolean {
  return path.startsWith("test/") || path.startsWith("dist/") || path === "README.md" || path === "README.vi.md" || path === "LICENSE";
}

export interface PackageAssets {
  /** The directory a reference template is copied from. */
  referenceAppDirectory(name: ReferenceApp): string;
  /**
   * The URL of a browser module, and whether it is the release build's self-contained bundle. A bundle imports
   * nothing, so it is served from disk as it is; a source module goes through Vite, rooted at the package directory.
   */
  browserRuntime(name: BrowserRuntime): { url: string; prebundled: boolean };
  /** The bytes of the release build's bundle a request path names (`/runtime/<name>.js`), or undefined if none. */
  prebundledRuntime(path: string): Buffer | undefined;
  /** This package's version, from its own `package.json`. */
  version(): string;
}

/** The assets of the package rooted at `packageRoot` (a directory URL ending in `/`). */
export function packageAssets(packageRoot: URL): PackageAssets {
  const fileOf = (relative: string): string => fileURLToPath(new URL(relative, packageRoot));
  const exists = (relative: string): boolean => existsSync(fileOf(relative));
  return {
    referenceAppDirectory: (name) => {
      const published = `templates/${name}/`;
      return fileOf(exists(published) ? published : `../../examples/reference-apps/${name}/`);
    },
    browserRuntime: (name) => {
      const published = `runtime/${name}.js`;
      return exists(published) ? { url: `/${published}`, prebundled: true } : { url: `/${BROWSER_RUNTIME_SOURCES[name]}`, prebundled: false };
    },
    prebundledRuntime: (path) => {
      // Only a known name: a request path is never joined onto the package directory as it arrives.
      const name = /^\/runtime\/([a-z-]+)\.js$/.exec(path)?.[1];
      if (name === undefined || !isBrowserRuntime(name)) return undefined;
      const published = `runtime/${name}.js`;
      return exists(published) ? readFileSync(fileOf(published)) : undefined;
    },
    version: () => {
      const manifest: unknown = JSON.parse(readFileSync(fileOf("package.json"), "utf8"));
      const version = typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : undefined;
      if (typeof version !== "string") throw new Error(`${fileOf("package.json")} names no version`);
      return version;
    },
  };
}

const assets = packageAssets(new URL("../", import.meta.url));

export const referenceAppDirectory = assets.referenceAppDirectory;
export const browserRuntime = assets.browserRuntime;
export const prebundledRuntime = assets.prebundledRuntime;
export const packageVersion = assets.version;

/**
 * Answer a request for a release-build runtime bundle straight from disk and return true, or return false when the
 * path names none (a checkout, or another path). The bundle imports nothing, so passing it through Vite would only
 * add a transform and an inline source map several times the bundle's size.
 */
export function sendPrebundledRuntime(response: ServerResponse, path: string): boolean {
  const bytes = prebundledRuntime(path);
  if (bytes === undefined) return false;
  response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
  response.end(bytes);
  return true;
}
