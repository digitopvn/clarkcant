import { createServer, type Server, type ServerResponse } from "node:http";
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { readPackage } from "@clarkcant/core";
import { catalogEntry } from "@clarkcant/widget-catalog";
import { catalogFrameHtml, catalogTarget } from "./catalog-target.ts";
import { applyShellAction, initialState, renderShell, type DevShellAction, type DevShellState } from "./dev-shell.ts";

/**
 * `clark widget dev` — the local isolated host.
 *
 * A dev host is a small server plus a page, and the two decisions that matter are both about not lying to the
 * author.
 *
 * **The frame gets the same sandbox the host gives it.** An opaque origin, no `allow-same-origin`. A dev host that
 * relaxed the policy would let an author build something that only works in development, which is the one failure
 * mode a dev host is supposed to prevent.
 *
 * **Nothing is served from outside the package.** A dev server that resolves a path without checking it is a
 * dev server that hands out the author's home directory, and it is the classic way a local tool becomes a way to
 * read files. Every path is resolved and then checked to be inside the root, and a refusal is a refusal rather
 * than a redirect.
 *
 * The shell's behaviour lives in `dev-shell.ts` as plain functions; this file only serves it and streams reloads.
 */

export interface DevHostOptions {
  /** The package directory to develop. Absent when `builtin` names a catalog definition instead. */
  root?: string;
  /**
   * A catalog definition id to develop in place of a package on disk.
   *
   * The frame is the same sandboxed frame, and the renderer is the same production renderer, so what an author sees
   * here is what the conversation would draw. Only where the definition and the frame's module come from differs.
   */
  builtin?: string;
  /** 0 asks the operating system for a free port, which is what a test wants. */
  port?: number;
  watchFiles?: boolean;
}

export interface DevHost {
  url: string;
  port: number;
  /** The shell's state, and the same transition the page performs, so a test drives the real model. */
  state: () => DevShellState;
  apply: (action: DevShellAction) => DevShellState;
  /** Reload notifications sent so far, so a test can prove the watcher fired without a browser. */
  reloads: () => number;
  close: () => Promise<void>;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

/**
 * The in-page script.
 *
 * It collects facts and forwards control changes; every decision is a function in `dev-shell.ts`. Kept small on
 * purpose: logic in a page cannot be tested without a browser, and the checks an author relies on most are the ones
 * most likely to be written as a badge that always passes.
 */
const SHELL_SCRIPT = `
const stateUrl = "/dev/api/state";
let state = await (await fetch(stateUrl)).json();

const width = state.viewportWidths[state.viewport];
document.documentElement.style.setProperty("--frame-width", width + "px");

const log = document.querySelector("[data-dev-log]");
const semantic = document.querySelector("[data-dev-semantic]");
const findings = document.querySelector("[data-dev-findings]");

function appendLog(line) {
  log.textContent = (log.textContent ?? "") + line + "\\n";
}

async function send(action) {
  const response = await fetch("/dev/api/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  state = await response.json();
  location.reload();
}

for (const button of document.querySelectorAll("[data-dev-action][data-dev-value]")) {
  button.addEventListener("click", () => {
    if (button.tagName === "INPUT") return;
    void send({ kind: button.dataset.devAction, value: button.dataset.devValue });
  });
}
for (const input of document.querySelectorAll("input[data-dev-action]")) {
  input.addEventListener("change", () => {
    void send({ kind: input.dataset.devAction, value: input.dataset.devValue ?? input.checked });
  });
}

/* The audit runs over facts collected here; the decision about what they mean lives in the CLI's tested code. */
function collectFacts(frame) {
  const doc = frame.contentDocument;
  const tabbable = [...doc.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")]
    .filter((element) => element.tabIndex >= 0)
    .map((element) => ({
      name: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? element.tagName,
      focusVisible: getComputedStyle(element).outlineStyle !== "none" || element.matches(":focus-visible"),
    }));
  const targets = [...doc.querySelectorAll("button, a[href], input[type=checkbox]")].map((element) => {
    const box = element.getBoundingClientRect();
    return { name: element.tagName, width: box.width, height: box.height };
  });
  const images = [...doc.querySelectorAll("img")].map((element) => ({
    src: element.getAttribute("src") ?? "",
    alt: element.getAttribute("alt") ?? "",
  }));
  return { tabbable, targets, images, textOverMotion: false, zeroDurationAnimation: false, declaredTextFallback: document.querySelector("[data-dev-frame]").title };
}

function renderFindings(list) {
  findings.innerHTML = "";
  if (list.length === 0) {
    const item = document.createElement("li");
    item.textContent = "không có phát hiện nào";
    findings.append(item);
    return;
  }
  for (const finding of list) {
    const item = document.createElement("li");
    item.dataset.severity = finding.severity;
    item.textContent = finding.severity + ": " + finding.message;
    findings.append(item);
  }
}

async function audit() {
  const frame = document.querySelector("[data-dev-frame]");
  try {
    const response = await fetch("/dev/api/a11y", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectFacts(frame)),
    });
    renderFindings((await response.json()).findings);
  } catch (error) {
    renderFindings([{ severity: "warning", message: "không đọc được frame: " + error.message }]);
  }
}

document.querySelector("[data-dev-action='a11y-audit']")?.addEventListener("click", () => void audit());
window.addEventListener("load", () => void audit());

/* Reload on change, so an author sees the edit rather than having to remember to refresh. */
const events = new EventSource("/dev/events");
events.addEventListener("reload", () => location.reload());

/* The frame speaks the bridge; a dev host shows what it said rather than silently accepting it. */
window.addEventListener("message", (event) => {
  appendLog(new Date().toISOString() + " " + JSON.stringify(event.data).slice(0, 400));
  if (event.data && event.data.kind === "semantic.publish") semantic.textContent = event.data.summary;
});
`;

/** Where a shell's facts come from, once the choice between a package and the catalog has been made. */
interface ShellSource {
  /** The directory whose files may be served, or `undefined` for a catalog widget, which has no package. */
  root: string | undefined;
  packageId: string;
  definitionId: string;
  fixtures: readonly string[];
  requestedCapabilities: readonly string[];
  entryUrl: string;
  definition: { textFallback: string; semanticDescription: string };
}

/** The widget-cli package directory, which is Vite's root when the frame is a catalog widget. */
const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));

function packageSource(requested: string): ShellSource {
  const root = resolve(requested);
  const pkg = readPackage(root);
  const facet = pkg.facets[0];
  if (facet === undefined) {
    throw new Error(`no widget facet is declared in ${root}, so there is nothing to develop`);
  }
  return {
    root,
    packageId: pkg.manifest.id,
    definitionId: facet.facetId,
    fixtures: Object.keys(pkg.fixtures),
    requestedCapabilities: facet.definition.requestedCapabilities,
    entryUrl: `/${facet.entryPath}`,
    definition: {
      textFallback: facet.definition.textFallback,
      semanticDescription: facet.definition.semanticDescription,
    },
  };
}

function catalogSource(definitionId: string): ShellSource {
  // Resolved through the catalog rather than trusted, so an id the catalog does not have is refused here and not in
  // the browser, where the frame would have to report it.
  const target = catalogTarget({ definitionId, fixtureId: "" });
  if (target === undefined) {
    throw new Error(`${definitionId} is not a definition in the catalog, so there is nothing to develop`);
  }
  return {
    root: undefined,
    packageId: "catalog",
    definitionId: target.entry.definition.id,
    fixtures: target.entry.fixtures.map((fixture) => fixture.id),
    requestedCapabilities: target.entry.definition.requestedCapabilities,
    entryUrl: "/catalog-runtime.html",
    definition: {
      textFallback: target.entry.definition.textFallback,
      semanticDescription: target.entry.definition.semanticDescription,
    },
  };
}

export async function startDevHost(options: DevHostOptions): Promise<DevHost> {
  if (options.builtin !== undefined && options.root !== undefined) {
    throw new Error("a dev host takes either a package directory or a builtin definition id, not both");
  }
  if (options.builtin === undefined && options.root === undefined) {
    throw new Error("a dev host needs a package directory, or a builtin definition id");
  }

  const source = options.builtin === undefined ? packageSource(options.root ?? "") : catalogSource(options.builtin);
  const root = source.root;

  /*
   * Vite serves the catalog frame's module graph from the workspace source, so the preview is the production
   * renderer rather than a copy of it, and there is no build step to forget. It is created only for a catalog
   * widget: a package's frame is its own entry HTML, which this server already knows how to serve.
   */
  const vite: ViteDevServer | undefined =
    source.root === undefined
      ? await createViteServer({
          configFile: false,
          root: CLI_ROOT,
          appType: "custom",
          logLevel: "error",
          plugins: [react()],
          // The frame is an opaque origin, so its module requests arrive with `Origin: null`.
          server: { middlewareMode: true, hmr: false, cors: true },
        })
      : undefined;

  const fixtures = source.fixtures;
  const capabilities = source.requestedCapabilities;
  let state = initialState({ fixtures, requestedCapabilities: capabilities });
  let reloadCount = 0;
  // Typed as the response itself rather than a structural lookalike: a cast here would be a comment about
  // Node's types instead of a fact about this code.
  const clients = new Set<ServerResponse>();

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/dev/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }

    if (path === "/dev/api/state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...state, viewportWidths: { "narrow-320": 320, conversation: 480, compact: 720, expanded: 1024 } }));
      return;
    }

    if (path === "/dev/api/action" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: unknown) => {
        body += String(chunk);
        // Bounded, because this endpoint is on a local port and an unbounded body is free memory for whoever
        // reaches it.
        if (body.length > 8_192) request.destroy();
      });
      request.on("end", () => {
        try {
          const action = JSON.parse(body) as DevShellAction;
          state = applyShellAction(state, action, { fixtures, capabilities });
        } catch {
          // A malformed action leaves the state alone and is reported, rather than resetting the shell.
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "action must be JSON" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(state));
      });
      return;
    }

    if (path === "/dev/api/a11y" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk: unknown) => {
        body += String(chunk);
        if (body.length > 262_144) request.destroy();
      });
      request.on("end", () => {
        void import("./dev-shell.ts").then(({ auditFrame }) => {
          try {
            const facts = JSON.parse(body) as Parameters<typeof auditFrame>[0];
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ findings: auditFrame(facts, { reducedMotion: state.reducedMotion }) }));
          } catch {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "facts must be JSON" }));
          }
        });
      });
      return;
    }

    if (path === "/dev/shell.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(SHELL_SCRIPT);
      return;
    }

    /*
     * The frame's page for a catalog widget. Generated per request so it carries the fixture the shell is currently
     * showing: the shell reloads the frame on every control change, so the state read here is the state on screen.
     */
    if (path === "/catalog-runtime.html" && source.root === undefined) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(catalogFrameHtml({ definitionId: source.definitionId, fixtureId: state.fixture }));
      return;
    }

    if (path === "/" || path === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        renderShell(
          {
            packageId: source.packageId,
            definitionId: source.definitionId,
            fixtures,
            requestedCapabilities: capabilities,
            entryUrl: source.entryUrl,
            definition: source.definition,
          },
          state,
        ),
      );
      return;
    }

    if (source.root === undefined || vite !== undefined) {
      /*
       * A catalog widget has no package files to serve: its module graph belongs to Vite, which resolves the
       * workspace's sources the way the app's own build does. Handing the request over rather than answering it is
       * what keeps the preview the production renderer instead of a second implementation of it.
       */
      vite?.middlewares(request, response, () => {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found\n");
      });
      return;
    }

    /*
     * Package files. Resolved, then checked to be inside the root: a dev server that serves whatever a path
     * resolves to hands out the author's home directory, and it is the ordinary way a local tool becomes a way to
     * read files.
     */
    const packageRoot = source.root;
    const candidate = resolve(join(packageRoot, normalize(path)));
    const inside = candidate === packageRoot || candidate.startsWith(packageRoot + sep);
    if (!inside) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("refused: that path is outside the package\n");
      return;
    }
    try {
      if (!statSync(candidate).isFile()) throw new Error("not a file");
      response.writeHead(200, { "content-type": contentType(candidate) });
      response.end(readFileSync(candidate));
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found\n");
    }
  });

  let watcher: FSWatcher | undefined;
  if (root !== undefined && options.watchFiles !== false) {
    try {
      watcher = watch(root, { recursive: true }, () => {
        reloadCount += 1;
        for (const client of clients) client.write("event: reload\ndata: {}\n\n");
      });
    } catch {
      // A platform without recursive watching still gets a working host; it just needs a manual refresh, and the
      // shell is not told a reload happened because none did.
      watcher = undefined;
    }
  }

  const port = await new Promise<number>((resolvePort) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  return {
    url: `http://127.0.0.1:${String(port)}/`,
    port,
    state: () => state,
    apply: (action) => {
      state = applyShellAction(state, action, { fixtures, capabilities });
      return state;
    },
    reloads: () => reloadCount,
    close: () =>
      new Promise<void>((done) => {
        watcher?.close();
        for (const client of clients) client.end();
        clients.clear();
        void vite?.close();
        server.close(() => {
          done();
        });
      }),
  };
}
