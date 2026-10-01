import { fileURLToPath } from "node:url";
import type { Server as HttpServer } from "node:http";
import react from "@vitejs/plugin-react";
import { createServer, type ServerOptions } from "vite";

/** Source modules for production component previews; author packages never provide executable theme entry points. */
export function createDevModuleServer(opaqueFrame = false, wsServer?: HttpServer, port?: number) {
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
  return createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    appType: "custom",
    logLevel: "error",
    plugins: [react()],
    server,
  });
}
