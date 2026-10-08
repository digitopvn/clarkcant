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

/** Where the stand-in serves its widget document, as the node serves one under a frame grant. */
export const SMOKE_FRAME_PATH = "/frame/smoke-grant/index.html";

/**
 * Start the stand-in on a free loopback port.
 *
 * Loopback only, and it answers exactly the live-owner route, the routes a detached frame's relays reach (its live read,
 * state, semantic and actions, its files, jobs and browser tokens, an export, and its widget dev session), a blank page
 * and one widget document: anything else is a
 * 404, so a host that called the wrong path would fail loudly here rather than being quietly served something plausible.
 *
 * @returns {Promise<{ url: string, calls: { method: string, path: string, body: Record<string, unknown>, at: number }[], relays: { method: string, path: string, body: Record<string, unknown>, authorization: string | undefined, surface: string | undefined, at: number }[], control: { refuseClaims: boolean, build: number }, close: () => Promise<void> }>}
 */
export async function startSmokeNode() {
  /** @type {{ method: string, path: string, body: Record<string, unknown>, at: number }[]} */
  const calls = [];
  /**
   * What the detached window's relays reached, with the two headers that say whose they were: the credential, which
   * only the host holds, and the surface mark a press carries. Kept apart from `calls` so the lease checks read only
   * the lease.
   *
   * @type {{ method: string, path: string, body: Record<string, unknown>, authorization: string | undefined, surface: string | undefined, at: number }[]}
   */
  const relays = [];
  /**
   * Switched by the smoke test. `refuseClaims` refuses a claim as the node refuses one another surface holds; `build`
   * is the widget dev session's running build, and the document a read of the frame names, so a new build can be
   * started between two reads.
   */
  const control = { refuseClaims: false, build: 1 };
  let grants = 0;
  let stateRevision = 0;
  /** @type {Record<string, unknown>} */
  let state = {};

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

      const json = (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const widgetRoute = /^\/conversations\/[^/]+\/widgets\/[^/]+\/(live|state|semantic|actions)$/.exec(path);
      const devRoute = /^\/widget-dev\/sessions\/[^/]+$/.test(path);
      // The file, job and token routes of a widget, and the one unbound route an export reaches.
      const brokerRoute = /^\/conversations\/[^/]+\/widgets\/[^/]+\/(artifacts|jobs|browser-tokens)(\/[^?]*)?(\?.*)?$/.exec(path);
      const exportRoute = /^\/artifacts\/([^/]+)\/export$/.exec(path);
      if (widgetRoute !== null || devRoute || brokerRoute !== null || exportRoute !== null) {
        const header = (name) => {
          const value = request.headers[name];
          return Array.isArray(value) ? value.join(",") : value;
        };
        relays.push({
          method: request.method ?? "",
          path,
          body,
          authorization: header("authorization"),
          surface: header("x-clarkcant-surface"),
          at: Date.now(),
        });
      }
      if (widgetRoute?.[1] === "live" && request.method === "GET") {
        // A widget in its own frame, read the way the node answers one: a fresh grant in the URL on every read.
        grants += 1;
        json(200, {
          kind: "isolated-frame",
          instanceId: path.split("/")[4],
          revision: 1,
          readOnly: false,
          frame: {
            url: `${SMOKE_FRAME_PATH}?grant=${String(grants)}`,
            urlExpiresInMs: 60_000,
            document: `build-${String(control.build)}`,
            isolation: "sandboxed-frame",
            grantedCapabilities: [],
            allowedOrigins: [],
            browserTokens: [{ provider: "example.maps", scopes: ["tiles:read"], purpose: "Draws the map." }],
          },
          bindings: [{ actionBindingId: "refresh", label: "Refresh", effectCategory: "read", bindingDigest: "sha256:smoke-binding" }],
          props: {},
          stateRevision,
          stateVersion: 1,
          state,
          stateStatus: { kind: "writable" },
          ephemeralStateKeys: [],
          development: { sessionId: "dev_smoke" },
        });
        return;
      }
      if (widgetRoute?.[1] === "state" && request.method === "POST") {
        if (body["expectedRevision"] !== stateRevision) {
          json(409, { code: "STATE_REVISION_MISMATCH", message: "the state moved on", stateRevision, state });
          return;
        }
        stateRevision += 1;
        state = { ...state, ...(typeof body["patch"] === "object" && body["patch"] !== null ? body["patch"] : {}) };
        json(200, { stateRevision, state });
        return;
      }
      if (widgetRoute?.[1] === "semantic" && request.method === "POST") {
        json(200, { accepted: true });
        return;
      }
      if (widgetRoute?.[1] === "actions" && request.method === "POST") {
        json(200, { invocationId: body["invocationId"], revision: 1, duplicate: false, timeline: [] });
        return;
      }
      if (brokerRoute !== null) {
        const [, family, rest = ""] = brokerRoute;
        // Shaped as the node's own references, which the window reads as strictly as the conversation does.
        const digest = `sha256:${"5".repeat(64)}`;
        const ref = (artifactId, extra = {}) => {
          const made = { v: 1, artifactId, kind: "working", mimeType: "text/plain", sizeBytes: 5, name: "notes.txt", ...extra };
          return made.kind === "working" ? made : { ...made, digest };
        };
        if (family === "artifacts") {
          const id = /^\/([^/]+)/.exec(rest)?.[1];
          const tail = id === undefined ? rest : rest.slice(id.length + 1);
          if (rest === "" && request.method === "POST") return json(200, { artifactRef: ref("art_smoke_made") });
          if (rest === "/pick" && request.method === "POST") {
            return json(200, { artifactRef: ref("art_smoke_picked", { kind: "attachment", name: String(body["name"] ?? "") }) });
          }
          if (id !== undefined && tail === "" && request.method === "GET") return json(200, { artifactRef: ref(decodeURIComponent(id)) });
          if (id !== undefined && tail === "" && request.method === "DELETE") return json(200, { discarded: true });
          if (id !== undefined && tail.startsWith("/content") && request.method === "GET") {
            return json(200, { artifactRef: ref(decodeURIComponent(id)), contentBase64: Buffer.from("hello").toString("base64"), eof: true });
          }
          if (id !== undefined && tail === "/chunks" && request.method === "POST") return json(200, { artifactRef: ref(decodeURIComponent(id)) });
          if (id !== undefined && tail === "/finalize" && request.method === "POST") {
            return json(200, { artifactRef: ref(decodeURIComponent(id), { kind: "finalized" }) });
          }
          if (id !== undefined && tail === "/attach" && request.method === "POST") {
            return json(200, {
              artifactRef: ref(decodeURIComponent(id), { kind: "finalized" }),
              attachmentRef: {
                attachmentId: "att_smoke",
                filename: "notes.txt",
                mime: "text/plain",
                kind: "text",
                sizeBytes: 5,
                sha256: digest,
                blobRef: `${"a".repeat(32)}.txt`,
              },
            });
          }
        }
        const job = (jobId) => ({ jobId, status: "running", resultRefs: [], createdAt: "2026-01-01T00:00:00.000Z" });
        if (family === "jobs" && rest === "" && request.method === "GET") return json(200, { jobs: [job("job_smoke")] });
        if (family === "jobs" && rest !== "" && request.method === "GET") return json(200, { job: job(decodeURIComponent(rest.slice(1))) });
        if (family === "jobs" && rest !== "" && request.method === "POST") return json(200, { cancelled: true });
        if (family === "browser-tokens" && rest === "" && request.method === "POST") {
          // Not a credential: a fixed string the smoke test can look for in what the window was handed.
          return json(200, {
            token: { provider: "example.maps", token: "smoke-browser-token", scopes: ["tiles:read"], expiresAt: "2026-01-01T01:00:00.000Z" },
          });
        }
        if (family === "browser-tokens" && rest !== "" && request.method === "DELETE") return json(200, { ended: true });
        return json(404, { code: "NOT_FOUND", message: "the smoke node does not serve that route" });
      }
      if (exportRoute !== null && request.method === "POST") {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": "attachment; filename=\"notes.txt\"",
        });
        response.end("hello");
        return;
      }
      if (devRoute && request.method === "GET") {
        // The folder path is here because the node sends it; the host is what must keep it from the detached window.
        json(200, {
          sessionId: "dev_smoke",
          status: "live",
          root: "/home/someone/private-widget",
          placed: { conversationId: "conv_smoke", instanceId: "widget_frame_smoke" },
          running: { generation: control.build, digest: `sha256:build-${String(control.build)}` },
          // A bundler names the file it failed on absolutely, so the folder path is inside a message too.
          lastBuild: {
            ok: false,
            at: "2026-01-01T00:00:00.000Z",
            trigger: "change",
            diagnostics: [
              { severity: "error", path: "src/main.ts", message: "/home/someone/private-widget/src/main.ts:3:7: Expected \";\"" },
            ],
          },
        });
        return;
      }

      if (isLiveOwner && (request.method === "POST" || request.method === "DELETE")) {
        calls.push({ method: request.method, path, body, at: Date.now() });
        if (request.method === "POST" && control.refuseClaims) {
          // What the node answers once another surface holds the instance: the detached window has lost it.
          response.writeHead(409, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ code: "ALREADY_OWNED", message: "another surface holds the live view of this instance", heldBySurface: "pin" }),
          );
          return;
        }
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

      if (request.method === "GET" && (path === SMOKE_FRAME_PATH || path.startsWith(`${SMOKE_FRAME_PATH}?`))) {
        /*
         * A widget document the way the node serves one: its own policy in the response, with a per-response script
         * nonce and `frame-ancestors` naming who may frame it (`widgetDocumentPolicy` in core). The script says it ran,
         * which is the one thing a frame the window's policy refused could not do.
         */
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; script-src 'nonce-smokeframe'; frame-ancestors 'self'",
        });
        response.end(
          "<!doctype html><html lang='en'><title>smoke frame</title><body>" +
            "<script nonce='smokeframe'>parent.postMessage({ smokeFrame: 'ready' }, '*');</script></body></html>",
        );
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "NOT_FOUND", message: "the smoke node does not serve that route" }));
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
    relays,
    control,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
