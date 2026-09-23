/**
 * A stand-in node, for the smoke test only.
 *
 * The detached-window journey needs somebody to answer the live-owner route: the host claims the lease when the
 * window opens and releases it when the window closes, and with no node those calls fail — so the smoke test could
 * only ever assert the refusal path. This serves the two routes and records what it was asked, which lets the smoke
 * test check the *order* and the *arguments* of the handoff against a real Electron window.
 *
 * It is a fixture, and the distinction matters: it proves the wiring, not the lease. Whether the node genuinely
 * moves one owner rather than two is settled in `packages/core/test/` against the real service, and this module
 * deliberately reimplements none of that — it answers, and it writes down what it was asked.
 *
 * Plain JavaScript: a sandboxed preload cannot be an ES module, and the neighbouring `.mjs` files that Electron
 * loads are plain JavaScript with JSDoc for the same reason.
 */

import { createServer } from "node:http";

/**
 * Start the stand-in on a free loopback port.
 *
 * Loopback only, and it answers exactly two routes: anything else is a 404, so a host that called the wrong path
 * would fail loudly here rather than being quietly served something plausible.
 *
 * @returns {Promise<{ url: string, calls: { method: string, path: string, body: Record<string, unknown> }[], close: () => Promise<void> }>}
 */
export async function startSmokeNode() {
  /** @type {{ method: string, path: string, body: Record<string, unknown> }[]} */
  const calls = [];

  const server = createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      /** @type {Record<string, unknown>} */
      let body = {};
      if (raw !== "") {
        try {
          body = JSON.parse(raw);
        } catch {
          // A body this route cannot parse is still recorded, so a check sees the malformed attempt rather than a
          // silence that looks like "nothing was called".
          body = { unparseable: raw };
        }
      }
      const path = request.url ?? "";
      const isLiveOwner = /^\/conversations\/[^/]+\/widgets\/[^/]+\/live-owner$/.test(path);

      if (isLiveOwner && (request.method === "POST" || request.method === "DELETE")) {
        calls.push({ method: request.method, path, body });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            request.method === "POST"
              ? { claimed: true, surface: body["surface"], expiresAt: new Date(Date.now() + 60_000).toISOString() }
              : { released: true },
          ),
        );
        return;
      }

      if (request.method === "GET" && (path === "/" || path.startsWith("/?"))) {
        // A page with no script of its own: the smoke test installs the reattach listener through
        // `executeJavaScript`, which is not subject to the page's CSP, so this needs no inline script and the
        // production content-security policy stays exactly as it is.
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html lang='en'><title>smoke node</title><body></body></html>");
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // Port 0: the OS picks a free one, so two smoke runs cannot collide on a fixed number.
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the smoke node did not get a port");
  }

  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
