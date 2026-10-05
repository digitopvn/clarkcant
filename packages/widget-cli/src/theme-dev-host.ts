import { createServer, type ServerResponse } from "node:http";
import { watch } from "node:fs";
import { resolve } from "node:path";
import type { ViteDevServer } from "vite";

import { installedThemes } from "@clarkcant/core";
import type { ThemeDocument } from "@clarkcant/contracts";

import { closeDevModuleServer, createDevModuleServer } from "./dev-module-server.ts";
import { browserRuntime, sendPrebundledRuntime } from "./package-assets.ts";
import { runThemeConformance } from "./theme-conformance.ts";
import type { ConformanceReport } from "./conformance.ts";

export interface ThemeDevView {
  themes: { themeRef: string; document: ThemeDocument }[];
  report: ConformanceReport;
  problem?: string;
}

export function readThemeDevView(root: string): ThemeDevView {
  const report = runThemeConformance(root);
  const result = installedThemes({ source: { kind: "local", path: root } });
  const problems = report.checks.filter((check) => check.status === "fail").map((check) => check.detail);
  return { themes: result.ok ? result.themes.map(({ themeRef, document }) => ({ themeRef, document })) : [], report,
    ...(problems.length === 0 ? {} : { problem: problems.join("\n") }) };
}

/** Theme facet of the existing author dev host: checked data and the shared production module server only. */
export async function startThemeDevHost(options: { root: string; port?: number; watchFiles?: boolean }) {
  const root = resolve(options.root);
  const initial = readThemeDevView(root);
  if (initial.themes.length === 0) throw new Error(initial.problem ?? "No theme facet to preview");
  const runtime = browserRuntime("theme-dev-runtime");
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClarkCant Theme Lab</title></head><body><main id="cc-theme-dev-root"></main><script type="module" src="${runtime.url}"></script></body></html>`;
  let vite: ViteDevServer | undefined;
  const clients = new Set<ServerResponse>();
  let reloads = 0;
  let address = "";
  const server = createServer((request, response) => {
    if (request.headers.host !== address || (request.headers.origin !== undefined && request.headers.origin !== `http://${address}`)) {
      response.writeHead(403); response.end("A theme dev host accepts only its own loopback origin"); return;
    }
    if (request.method !== "GET") { response.writeHead(405); response.end("Read-only preview"); return; }
    const path = new URL(request.url ?? "/", `http://${address}`).pathname;
    if (path === "/") {
      if (runtime.prebundled) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(page);
        return;
      }
      if (vite === undefined) { response.writeHead(503); response.end("Preview server is starting"); return; }
      void vite.transformIndexHtml("/", page)
        .then((html) => {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(html);
        }, (error: unknown) => {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end(error instanceof Error ? error.message : String(error));
        });
      return;
    }
    if (path === "/dev/theme") {
      try {
        const body = JSON.stringify(readThemeDevView(root));
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(body);
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ problem: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (path === "/dev/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (sendPrebundledRuntime(response, path)) return;
    if (!runtime.prebundled && (path.startsWith("/src/") || path.startsWith("/@") || path.startsWith("/node_modules/"))) {
      if (vite === undefined) { response.writeHead(503); response.end("Preview server is starting"); return; }
      vite.middlewares(request, response, () => { response.writeHead(404); response.end("Not found"); });
      return;
    }
    response.writeHead(404); response.end("Not found");
  });
  await new Promise<void>((done, failed) => {
    server.once("error", failed);
    server.listen(options.port ?? 4319, "127.0.0.1", () => { server.removeListener("error", failed); done(); });
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("Theme dev host did not bind TCP");
  address = `127.0.0.1:${String(bound.port)}`;
  // An installed CLI's runtime is a self-contained bundle served from disk, so it needs no module server at all.
  if (!runtime.prebundled) {
    try {
      vite = await createDevModuleServer(false, server, bound.port, {
        isolatedCache: true,
        // This custom preview has no workspace HTML entry to scan. Keep Vite's cold-start optimizer
        // bounded to the runtime's React and CommonJS highlighting entries instead of scanning the workspace.
        optimizeDeps: {
          noDiscovery: true,
          include: ["react", "react-dom/client", "@clarkcant/conversation-client > highlight.js/lib/common"],
        },
      });
    } catch (error) {
      await new Promise<void>((done, failed) => server.close((closeError) => closeError === undefined ? done() : failed(closeError)));
      throw error;
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  try { watcher = options.watchFiles === false ? undefined : watch(root, { recursive: true }, (_event, filename) => {
    if (filename !== null && /^(?:dist|node_modules|\.git)(?:[\\/]|$)/.test(String(filename))) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      reloads += 1;
      for (const client of clients) client.write(`data: ${String(reloads)}\n\n`);
    }, 75);
  }); } catch (error) {
    await closeDevModuleServer(vite);
    await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    url: `http://${address}`, port: bound.port, reloads: () => reloads,
    close: (): Promise<void> => {
      closing ??= (async () => {
        watcher?.close();
        if (timer !== undefined) clearTimeout(timer);
        for (const client of clients) client.end();
        clients.clear();
        await closeDevModuleServer(vite);
        await new Promise<void>((done, failed) => server.close((error) => error === undefined ? done() : failed(error)));
      })();
      return closing;
    },
  };
}
