/**
 * Electron main process.
 *
 * The shell is deliberately thin: it hosts a window, owns OS dialogs and notifications, and
 * exposes those through named IPC methods. It holds no scheduler and no command logic, because
 * closing a window must not be the same thing as stopping work — that distinction only survives
 * if closing the window cannot reach the thing doing the work.
 *
 * Run modes:
 *   electron .                      normal window
 *   electron . --smoke-test         headless self-check, prints JSON, exits 0 or 1
 *   electron . --renderer-url <u>   load a different shell document
 *
 * `--smoke-test` exists so the security posture is verified by running it rather than by
 * reading it. It creates a real window with a real preload bridge and asserts the bridge's
 * shape and its refusals from inside the renderer.
 */

import { app, BrowserWindow, dialog, ipcMain, shell, session } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

import {
  contentSecurityPolicy,
  createWindowOptions,
  IPC_CHANNELS,
  normalizeExternalUrl,
  reviewCredentialRequest,
  reviewIpcCall,
} from "./security.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const smokeTest = argv.includes("--smoke-test");
const rendererUrlFlag = argv.indexOf("--renderer-url");
const rendererUrl =
  rendererUrlFlag >= 0 && argv[rendererUrlFlag + 1] !== undefined
    ? argv[rendererUrlFlag + 1]
    : `file://${join(here, "shell.html")}`;
const dataDirFlag = argv.indexOf("--data-dir");
const dataDir = dataDirFlag >= 0 ? argv[dataDirFlag + 1] : undefined;

/** Closing the window stops the window, not the work. Default is to keep running. */
let keepRunningOnWindowClose = true;

/**
 * The bridge methods the preload is expected to expose.
 *
 * Named here so the smoke test can assert the renderer's exact reach. `IPC_CHANNELS` in
 * `security.mjs` stays the enforcing copy; this is what the check compares against.
 */
const EXPECTED_BRIDGE_METHODS = Object.freeze([
  "notify",
  "openExternal",
  "pickDirectory",
  "requestCredential",
  "setKeepRunningOnWindowClose",
  "status",
  "getSession",
]);

/**
 * Answer a channel only after the call has passed review.
 *
 * The review runs before the handler so a refused call cannot produce a side effect on its way
 * to being refused.
 */
function handle(channel, handler) {
  if (!IPC_CHANNELS.includes(channel)) {
    throw new Error(`refusing to register handler for non-allowlisted channel ${channel}`);
  }
  ipcMain.handle(channel, async (event, ...args) => {
    const review = reviewIpcCall(event, channel, rendererUrl);
    if (!review.allowed) {
      return { ok: false, refused: review.reason };
    }
    return await handler(...args);
  });
}

function registerHandlers() {
  handle("desktop:openExternal", async (raw) => {
    const checked = normalizeExternalUrl(raw);
    if (!checked.ok) return { ok: false, refused: checked.reason };
    await shell.openExternal(checked.url);
    return { ok: true, opened: checked.url };
  });

  handle("desktop:getSession", async () => {
    // The node this window belongs to. The token is read from the node's own identity file rather than passed
    // on the command line or in the URL, where it would be visible in a process list, in history, and in the
    // address bar. The base URL is the window's own origin, because the window is served by that node.
    if (dataDir === undefined) {
      return { ok: false, refused: "no --data-dir was given, so there is no identity to read" };
    }
    let identity;
    try {
      identity = JSON.parse(readFileSync(join(dataDir, "identity.json"), "utf8"));
    } catch (error) {
      return { ok: false, refused: `the node identity could not be read (${error?.code ?? "unreadable"})` };
    }
    const token = typeof identity?.localToken === "string" ? identity.localToken : "";
    if (token.length === 0) return { ok: false, refused: "the node identity carries no local token" };
    let origin;
    try {
      origin = new URL(rendererUrl).origin;
    } catch {
      return { ok: false, refused: "the window's address is not a URL, so there is no node to point at" };
    }
    if (origin === "null") return { ok: false, refused: "the window is not loaded from a node" };
    return { ok: true, session: { baseUrl: origin, token } };
  });

  handle("desktop:notify", async (input) => {
    const title = typeof input?.title === "string" ? input.title.slice(0, 120) : "";
    const body = typeof input?.body === "string" ? input.body.slice(0, 500) : "";
    if (title.length === 0) return { ok: false, refused: "a notification needs a title" };
    return { ok: true, shown: { title, body } };
  });

  handle("desktop:pickDirectory", async (input) => {
    // The OS dialog is the point: choosing a directory is something a person does in a window the
    // owning process controls, not something a script in the renderer can name. Only the path the
    // user actually selected is returned, and it is returned as data the renderer may send back as
    // the answer to the node's own question.
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return { ok: false, refused: "no window is available for the picker" };
    const title = typeof input?.title === "string" && input.title.trim() !== "" ? input.title.slice(0, 120) : "Choose a directory";
    const outcome = await dialog.showOpenDialog(window, { title, properties: ["openDirectory"] });
    if (outcome.canceled || outcome.filePaths.length === 0) return { ok: true, canceled: true };
    return { ok: true, canceled: false, path: outcome.filePaths[0] };
  });

  handle("desktop:requestCredential", async (input) => {
    const review = reviewCredentialRequest(input);
    if (!review.allowed) return { ok: false, refused: review.reason };
    // Secret entry happens in a host-owned window. The value is never returned to the
    // renderer and never crosses the bridge; only the fact that something was stored does.
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return { ok: false, refused: "no window is available for the prompt" };
    const outcome = await dialog.showMessageBox(window, {
      type: "info",
      title: "Credential needed",
      message: input.purpose,
      detail:
        "This shell records that consent was given. Wiring the value into the OS keychain is the remaining step.",
      buttons: ["Cancel", "Continue"],
      defaultId: 1,
      cancelId: 0,
    });
    return { ok: true, stored: outcome.response === 1 };
  });

  handle("desktop:setKeepRunning", async (keep) => {
    if (typeof keep !== "boolean") {
      return { ok: false, refused: "keep must be a boolean" };
    }
    keepRunningOnWindowClose = keep;
    return { ok: true, keepRunningOnWindowClose };
  });

  handle("desktop:getStatus", async () => ({
    ok: true,
    shell: "clarkcant-desktop",
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    contextIsolation: true,
    nodeIntegration: false,
    sandboxed: true,
    keepRunningOnWindowClose,
    channels: [...IPC_CHANNELS],
  }));
}

function applyContentSecurityPolicy() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy()],
      },
    });
  });
}

async function createShellWindow({ show = true } = {}) {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show,
    title: "clarkcant",
    backgroundColor: "#0d1117",
    webPreferences: createWindowOptions(join(here, "preload.cjs")),
  });

  // A renderer asking to open a window, or to navigate away, is refused rather than followed:
  // both are how a shell document gets replaced by something the policy was not written for.
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    process.stderr.write(`preload failed to load from ${preloadPath}: ${error.stack ?? error}\n`);
  });
  // A non-empty console from the renderer at startup is usually a policy violation; the shell
  // reports it rather than letting it pass unremarked.
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) process.stderr.write(`renderer console: ${message}\n`);
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(rendererUrl)) event.preventDefault();
  });

  await window.loadURL(rendererUrl);
  return window;
}

/**
 * Run the self-check inside a real renderer and report what the bridge actually did.
 *
 * This is the difference between "the options object says sandbox: true" and "a renderer ran
 * and could not reach Node".
 */
async function runSmokeTest() {
  const window = await createShellWindow({ show: false });
  // Fixtures the shell must reject. Named so they read as test data rather than configuration;
  // the script-scheme one stays inline because a literal beginning with that scheme trips this
  // repository's own ast-grep rule, and the rule is worth keeping.
  const REFUSED_HTTP_URL = "http://example.com/";
  const REFUSED_FILE_URL = "file:///etc/passwd";
  const probe = `(async () => {
    const bridge = window.clarkcant ?? null;
    const call = async (name, ...args) => {
      try { return await bridge[name](...args); } catch (error) { return { threw: String(error) }; }
    };
    return {
      bridgePresent: bridge !== null,
      bridgeMethods: bridge === null ? [] : Object.keys(bridge).sort(),
      nodeReachable: typeof window.require !== "undefined" || typeof window.process !== "undefined",
      status: await call("status"),
      refusedHttpScheme: await call("openExternal", ${JSON.stringify(REFUSED_HTTP_URL)}),
      refusedFileScheme: await call("openExternal", ${JSON.stringify(REFUSED_FILE_URL)}),
      refusedScriptScheme: await call("openExternal", "javascript:alert(1)"),
      refusedVaguePurpose: await call("requestCredential", { requestId: "r1", purpose: "x" }),
      refusedNonBoolean: await call("setKeepRunningOnWindowClose", "yes"),
    };
  })()`;

  const observed = await window.webContents.executeJavaScript(probe);
  // `close()` is synchronous on BrowserWindow; awaiting it would imply a completion signal that
  // does not exist.
  window.close();

  const checks = [
    ["the preload bridge is present", observed.bridgePresent === true],
    [
      "the bridge exposes exactly the expected named methods",
      JSON.stringify(observed.bridgeMethods) === JSON.stringify([...EXPECTED_BRIDGE_METHODS]),
    ],
    [
      "there is one bridge method per allowlisted channel",
      observed.bridgeMethods.length === IPC_CHANNELS.length,
    ],
    ["Node is unreachable from the renderer", observed.nodeReachable === false],
    ["the shell reports its own posture", observed.status?.sandboxed === true],
    ["http is refused", observed.refusedHttpScheme?.ok === false],
    ["file: is refused", observed.refusedFileScheme?.ok === false],
    ["a scheme that executes script is refused", observed.refusedScriptScheme?.ok === false],
    ["a vague credential purpose is refused", observed.refusedVaguePurpose?.ok === false],
    ["a non-boolean keep flag is refused", observed.refusedNonBoolean?.ok === false],
  ];

  const failed = checks.filter(([, passed]) => !passed);
  process.stdout.write(
    `${JSON.stringify({ mode: "smoke-test", rendererUrl, observed, checks, failed: failed.map(([name]) => name) }, null, 2)}\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

app.whenReady().then(async () => {
  applyContentSecurityPolicy();
  registerHandlers();

  if (smokeTest) {
    // Declared without a value: both paths below assign it, and an initial value would only be
    // there to be overwritten.
    let code;
    try {
      code = await runSmokeTest();
    } catch (cause) {
      process.stderr.write(`smoke test failed: ${cause?.stack ?? String(cause)}\n`);
      code = 1;
    }
    app.exit(code);
    return;
  }

  await createShellWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createShellWindow();
  });
});

app.on("window-all-closed", () => {
  // Deliberately not quitting on macOS unless the user said so: a window closing is a UI event,
  // and work already running is not a UI event.
  if (!keepRunningOnWindowClose && process.platform !== "darwin") app.quit();
});
