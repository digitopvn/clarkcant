import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerOptions, ViteDevServer } from "vite";

const cacheDirectories = new WeakMap<ViteDevServer, string>();

/** Source modules for production component previews; author packages never provide executable theme entry points. */
export async function createDevModuleServer(
  opaqueFrame = false,
  wsServer?: HttpServer,
  port?: number,
  options: {
    isolatedCache?: boolean;
    optimizeDeps?: { noDiscovery?: boolean; include?: string[] };
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
    cors: opaqueFrame,
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
      root: fileURLToPath(new URL("..", import.meta.url)),
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
