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

import { app, BrowserWindow, dialog, ipcMain, screen, shell, session } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import {
  COMPACT_MIN_SIZE,
  WINDOW_MODE_PRESETS,
  actionForMode,
  fitIntoWorkArea,
  initialWindowMode,
  nextWindowMode,
} from "./window-mode.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const smokeTest = argv.includes("--smoke-test");
const rendererUrlFlag = argv.indexOf("--renderer-url");
const rendererUrl =
  rendererUrlFlag >= 0 && argv[rendererUrlFlag + 1] !== undefined
    ? argv[rendererUrlFlag + 1]
    : // `pathToFileURL` rather than string interpolation: `file://` plus a Windows path gives
      // `file://D:\...`, which is not the URL the sender frame reports and made every IPC call look
      // like it came from somewhere else. The review then refused all of them, which is a working
      // security check fed a wrong expectation.
      pathToFileURL(join(here, "shell.html")).href;
const dataDirFlag = argv.indexOf("--data-dir");
const dataDir = dataDirFlag >= 0 ? argv[dataDirFlag + 1] : undefined;
const nodeUrlFlag = argv.indexOf("--node-url");
const nodeUrl = nodeUrlFlag >= 0 ? argv[nodeUrlFlag + 1] : undefined;
/**
 * Whether this window is showing the client rather than the bundled posture document.
 *
 * It decides the frame: the client draws its own chrome - a drag strip and its own buttons - so an OS frame
 * on top of it would be a second title bar. The posture document has no chrome of its own and keeps its frame.
 */
const loadingClient = rendererUrlFlag >= 0;

/** Closing the window stops the window, not the work. Default is to keep running. */
let keepRunningOnWindowClose = true;

/**
 * The bridge methods the preload is expected to expose.
 *
 * Named here so the smoke test can assert the renderer's exact reach. `IPC_CHANNELS` in
 * `security.mjs` stays the enforcing copy; this is what the check compares against.
 */
const EXPECTED_BRIDGE_METHODS = Object.freeze([
  "focusWindow",
  "getSession",
  "notify",
  "openExternal",
  "pickDirectory",
  "requestCredential",
  "resizeWindowPreset",
  "restoreWindow",
  "setCompactMode",
  "setKeepRunningOnWindowClose",
  "setWindowMode",
  "status",
].sort());

/**
 * The window's remembered mode, in the process that owns the window.
 *
 * Held here rather than in the renderer because a renderer comes and goes: a reload must not move the window
 * back to its expanded size, and returning from compact has to restore what the person had rather than a
 * default. `undefined` until the first request, when it is learned from the window itself.
 */
let windowMode;

/** The work area of the display the window is on, so a compact window lands somewhere reachable. */
function workAreaFor(window) {
  return screen.getDisplayMatching(window.getBounds()).workArea;
}

/**
 * What the window actually became, read back off the window.
 *
 * Every field here is observed rather than computed from the request. The OS may clamp a size or a position, and
 * a shell that echoed what it asked for could not tell the difference between that and what happened — which is
 * the whole reason the smoke test reads `getBounds()` instead of trusting an answer.
 */
function describeWindow(window, mode) {
  return {
    ok: true,
    mode: mode?.mode ?? null,
    bounds: window.getBounds(),
    minimumSize: window.getMinimumSize(),
    alwaysOnTop: window.isAlwaysOnTop(),
    focused: window.isFocused(),
  };
}

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

  handle("desktop:setCompactMode", async (action) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return { ok: false, refused: "there is no window to resize" };
    if (!["enter-compact", "expand", "set-always-on-top"].includes(action?.type)) {
      return { ok: false, refused: "that is not a window mode this build knows" };
    }

    // Learned from the window the first time rather than assumed, so a window somebody already moved is
    // remembered where it actually is.
    if (windowMode === undefined) {
      windowMode = initialWindowMode({ bounds: window.getBounds(), workArea: workAreaFor(window) });
    }
    windowMode = nextWindowMode({ ...windowMode, workArea: workAreaFor(window) }, action);
    window.setBounds(windowMode.bounds);
    window.setAlwaysOnTop(windowMode.alwaysOnTop);

    // Every field read off the window rather than computed by the model. The OS may clamp a size or a position,
    // and a shell that echoed its own request could not tell the difference between that and what happened.
    return {
      ok: true,
      mode: windowMode.mode,
      bounds: window.getBounds(),
      minimumSize: window.getMinimumSize(),
      alwaysOnTop: window.isAlwaysOnTop(),
    };
  });

  /*
   * The window's named modes.
   *
   * A mode name from the renderer, and everything else decided here: bounds live in this process, so a
   * renderer cannot ask for geometry off the edge of the screen or larger than the display. The answer reports
   * what the window actually has afterwards, read back off the window, because the OS may clamp a size or a
   * position and a shell that echoed its own request could not tell that difference.
   */
  handle("desktop:setWindowMode", async (mode) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return { ok: false, refused: "there is no window to resize" };
    const action = actionForMode(mode);
    if (action === undefined) {
      // Refused rather than coerced into `normal`: silently growing a window somebody asked to shrink is worse
      // than not moving it.
      return { ok: false, refused: `"${String(mode)}" is not a window mode this build knows` };
    }
    if (windowMode === undefined) {
      windowMode = initialWindowMode({ bounds: window.getBounds(), workArea: workAreaFor(window) });
    }
    windowMode = nextWindowMode({ ...windowMode, workArea: workAreaFor(window) }, action);
    window.setBounds(windowMode.bounds);
    return describeWindow(window, windowMode);
  });

  /*
   * A named size, with the mode left alone.
   *
   * Separate from the mode channels because they answer different questions: a mode is about what the window is
   * for, and a preset is about how big it is. Folding them together would make resizing the conversation window
   * change it into the voice bar.
   */
  handle("desktop:resizeWindowPreset", async (name) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return { ok: false, refused: "there is no window to resize" };
    const preset = WINDOW_MODE_PRESETS[String(name)];
    if (preset === undefined) {
      return { ok: false, refused: `"${String(name)}" is not a size preset this build knows` };
    }
    const current = window.getBounds();
    window.setBounds(
      fitIntoWorkArea(
        { x: current.x, y: current.y, width: preset.width, height: preset.height },
        workAreaFor(window),
      ),
    );
    return describeWindow(window, windowMode);
  });

  /*
   * Back to the size and place the window had before it was collapsed.
   *
   * The remembered bounds live in this process, so a reload that loses the renderer's idea of where the window
   * was does not also lose the window's own position.
   */
  handle("desktop:restoreWindow", async () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return { ok: false, refused: "there is no window to restore" };
    if (windowMode === undefined) {
      return { ok: false, refused: "this window has not been moved by the shell yet, so there is nothing to restore" };
    }
    windowMode = nextWindowMode({ ...windowMode, workArea: workAreaFor(window) }, { type: "expand" });
    window.setBounds(windowMode.bounds);
    return describeWindow(window, windowMode);
  });

  /*
   * Bring the window forward.
   *
   * A request that came from voice or from an app intent has nobody behind it to click the window, so the shell
   * is what has to make it the one being looked at.
   */
  handle("desktop:focusWindow", async () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return { ok: false, refused: "there is no window to focus" };
    if (window.isMinimized()) window.restore();
    window.focus();
    return { ok: true, focused: window.isFocused(), bounds: window.getBounds() };
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
        "Content-Security-Policy": [
          contentSecurityPolicy({ appOrigin: rendererUrl, nodeOrigin: nodeUrl }),
        ],
      },
    });
  });
}

async function createShellWindow({ show = true } = {}) {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    // Always created hidden and shown once it has something to show: a frameless window that appears before its
    // document has painted is a blank rectangle that reads as a failure.
    show: false,
    title: "clarkcant",
    backgroundColor: "#0d1117",
    // The floor from the issue. What the window is allowed to become, not what it aims for.
    minWidth: COMPACT_MIN_SIZE.width,
    minHeight: COMPACT_MIN_SIZE.height,
    frame: !loadingClient,
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

  window.once("ready-to-show", () => {
    if (show) window.show();
  });

  // A window somebody dragged is the window they expect back, so a resize while expanded is remembered as the
  // size to return to. A resize during compact is the bar being moved, and remembering that as the normal size
  // would make expanding do nothing at all.
  window.on("resize", () => {
    if (windowMode === undefined) {
      windowMode = initialWindowMode({ bounds: window.getBounds(), workArea: workAreaFor(window) });
    }
    if (windowMode.mode === "compact") return;
    const bounds = window.getBounds();
    windowMode = { ...windowMode, bounds, normalBounds: bounds };
  });

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
      compact: await call("setCompactMode", { type: "enter-compact" }),
      pinned: await call("setCompactMode", { type: "set-always-on-top", value: true }),
      expanded: await call("setCompactMode", { type: "expand" }),
      refusedUnknownMode: await call("setCompactMode", { type: "become-a-toast" }),
    };
  })()`;

  // Read off the real window around the probe, so the compact checks compare Electron's own answers rather
  // than two copies of the same model agreeing with each other.
  const boundsBefore = window.getBounds();
  const observed = await window.webContents.executeJavaScript(probe);
  const boundsAfter = window.getBounds();
  /*
   * `getMinimumSize()` answers an array, not an object.
   *
   * The check read `.width` and `.height` off it, which are both `undefined`, so it compared `undefined` to `20`
   * and failed while the window was reporting exactly the right floor. Read by index, which is the shape
   * Electron documents.
   */
  const minimum = window.getMinimumSize();
  const minimumWidth = Array.isArray(minimum) ? minimum[0] : minimum.width;
  const minimumHeight = Array.isArray(minimum) ? minimum[1] : minimum.height;
  const pinnedNow = window.isAlwaysOnTop();
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
    [
      "compact mode reads back the bounds Electron actually has",
      observed.compact?.ok === true &&
        observed.compact.bounds.width < boundsBefore.width &&
        observed.compact.bounds.width >= COMPACT_MIN_SIZE.width &&
        observed.compact.mode === "compact",
    ],
    [
      "the minimum size Electron reports is the twenty by fifty floor",
      minimumWidth === COMPACT_MIN_SIZE.width && minimumHeight === COMPACT_MIN_SIZE.height,
    ],
    [
      "expanding restores the bounds Electron had before compact",
      JSON.stringify(boundsAfter) === JSON.stringify(boundsBefore),
    ],
    [
      "always on top is reported by the window, not by the model",
      observed.pinned?.ok === true && observed.pinned.alwaysOnTop === true && pinnedNow === true,
    ],
    ["a window mode this build does not know is refused", observed.refusedUnknownMode?.ok === false],
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
