import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/** Source modules for production component previews; author packages never provide executable theme entry points. */
export function createDevModuleServer(opaqueFrame = false) {
  return createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    appType: "custom",
    logLevel: "error",
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, cors: opaqueFrame },
  });
}
