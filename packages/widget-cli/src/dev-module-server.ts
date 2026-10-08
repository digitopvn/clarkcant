import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerOptions, ViteDevServer } from "vite";

const cacheDirectories = new WeakMap<ViteDevServer, string>();

/** The directory Vite serves from: this package's root, `src/`'s parent in a checkout and `lib/`'s once installed. */
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The directories a widget frame's modules may be read from, for Vite's `server.fs.allow`.
 *
 * Vite's default is the whole workspace root, which in a checkout is the repository: its plans, docs and every
 * app's source. The browser runtimes import only this package, the workspace packages beside it and their
 * dependencies, so a checkout allows `packages/` and `node_modules/` and nothing else at the root. An installed CLI
 * serves self-contained bundles from disk and never reaches Vite for them, so it allows only its own directory.
 */
export function widgetModuleAllowList(): string[] {
  const repository = join(packageRoot, "..", "..");
  return existsSync(join(repository, "pnpm-workspace.yaml"))
    ? [join(repository, "packages"), join(repository, "node_modules")]
    : [packageRoot];
}

/** Source modules for production component previews; author packages never provide executable theme entry points. */
export async function createDevModuleServer(
  wsServer?: HttpServer,
  port?: number,
  options: {
    isolatedCache?: boolean;
    optimizeDeps?: { noDiscovery?: boolean; include?: string[] };
    /**
     * The URL prefix every module is served and imported under, ending in `/`. Vite rewrites each import to carry
     * it, so a host that hands Vite only requests under a secret prefix serves modules only to pages it gave it to.
     */
    base?: string;
    /** Vite's `server.fs.allow`; Vite's default (the workspace root) when left out. */
    allow?: string[];
  } = {},
) {
  let sharedServer: { port: number; ws: { server: HttpServer } } | Record<string, never> = {};
  if (wsServer !== undefined) {
    if (port === undefined) throw new Error("a shared Vite WebSocket server needs its HTTP port");
    sharedServer = { port, ws: { server: wsServer } };
  }
  const server: ServerOptions = {
    middlewareMode: true,
    hmr: false,
    ...sharedServer,
    /*
     * Never Vite's own CORS answer: `true` is `Access-Control-Allow-Origin: *` on every module, which lets any website
     * read the files Vite serves. A host whose sandboxed frame needs the opaque origin answers it for that frame alone.
     */
    cors: false,
    ...(options.allow === undefined ? {} : { fs: { allow: options.allow } }),
  };
  /*
   * Loaded here rather than at the top of the module: only the dev hosts need Vite, so `--help`, `init`, `test` and
   * `pack` neither pay for loading it nor fail when it cannot load.
   */
  const [{ createServer }, { default: react }] = await Promise.all([import("vite"), import("@vitejs/plugin-react")]);
  const cacheDir = options.isolatedCache === true ? await mkdtemp(join(tmpdir(), "clarkcant-widget-vite-")) : undefined;
  try {
    const vite = await createServer({
      configFile: false,
      root: packageRoot,
      ...(options.base === undefined ? {} : { base: options.base }),
      ...(cacheDir === undefined ? {} : { cacheDir }),
      appType: "custom",
      logLevel: "error",
      plugins: [react()],
      ...(options.optimizeDeps === undefined ? {} : { optimizeDeps: options.optimizeDeps }),
      server,
    });
    if (cacheDir !== undefined) cacheDirectories.set(vite, cacheDir);
    return vite;
  } catch (error) {
    if (cacheDir !== undefined) await rm(cacheDir, { recursive: true, force: true });
    throw error;
  }
}

export async function closeDevModuleServer(vite: ViteDevServer | undefined): Promise<void> {
  if (vite === undefined) return;
  try {
    await vite.close();
  } finally {
    const cacheDir = cacheDirectories.get(vite);
    cacheDirectories.delete(vite);
    if (cacheDir !== undefined) await rm(cacheDir, { recursive: true, force: true });
  }
}
