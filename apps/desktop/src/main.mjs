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

import { app, BrowserWindow, dialog, ipcMain, Notification, screen, shell, session } from "electron";
import { randomUUID } from "node:crypto";

import { startSmokeNode } from "./smoke-node.mjs";
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
  detachedBootstrap,
  detachedWindowOptions,
  reviewDetachedBootstrap,
  reviewDetachedIntent,
} from "./detached-window.mjs";
import {
  COMPACT_MIN_SIZE,
  WINDOW_MODE_PRESETS,
  actionForMode,
  fitIntoWorkArea,
  initialWindowMode,
  nextWindowMode,
} from "./window-mode.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The detached widget window, if one is open.
 *
 * One at a time, because the criterion is that detaching keeps one live owner rather than adding one: a second
 * detached window would be a second owner, and the shell would have no single window to hand an instance back to.
 */
let detached;

/** The window the conversation is in, so a detached view can open beside it and hand the instance back to it. */
let shellWindow;

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

/**
 * The document the IPC review compares a call against.
 *
 * The shell's own URL in every real run. The smoke test moves it, because its detached-window phase is served by a
 * stand-in node rather than by the app - and "did this call come from the document we loaded" has to keep meaning
 * that while the document differs. A review comparing against a fixed constant would refuse every call from that
 * window, which is the same failure the `file://D:\` bug produced from the other direction.
 */
let shellDocumentUrl = rendererUrl;

/**
 * The origin `readNodeSession` treats as the node.
 *
 * In production the window is served by the node it talks to, which is why this starts as the renderer's URL. The
 * smoke test points it at its stand-in so the handoff is exercised end to end rather than only down its refusal path.
 */
let nodeOriginUrl = rendererUrl;

/**
 * The token the host uses when the smoke test has stood a node in for the real one.
 *
 * Every real run reads the local token from the node's own identity file. The smoke run has no node, so it has no
 * identity file either - and without a token the claim is refused before it is attempted, which is what made the
 * first version of the detached checks assert nothing but the refusal. Named here rather than committed as a fixture
 * file, because a tracked file that looks like a credential is a bad thing to have in a repository regardless of
 * whether it is real.
 */
let nodeIdentityOverride;

/** Closing the window stops the window, not the work. Default is to keep running. */
let keepRunningOnWindowClose = true;

/**
 * The bridge methods the preload is expected to expose.
 *
 * Named here so the smoke test can assert the renderer's exact reach. `IPC_CHANNELS` in
 * `security.mjs` stays the enforcing copy; this is what the check compares against.
 */
const EXPECTED_BRIDGE_METHODS = Object.freeze([
  "attachWidget",
  "detachWidget",
  "focusWindow",
  "getSession",
  "notify",
  "onNotificationClicked",
  "onWidgetReattached",
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

/**
 * Notifications currently on screen, kept alive here.
 *
 * `Notification` fires its events for as long as something holds a reference to the instance; a `new
 * Notification(...)` with nothing keeping it means V8 is free to collect it before the person ever clicks it,
 * and a garbage-collected notification's `click` handler simply never runs. Each entry is deleted (`forget`)
 * once its own click, close or failure fires, so this set holds exactly the notifications still capable of
 * doing something — never a growing history of every notification ever shown.
 */
const activeNotifications = new Set();

/** The work area of the display the window is on, so a compact window lands somewhere reachable. */
function workAreaFor(window) {
  return screen.getDisplayMatching(window.getBounds()).workArea;
}

/**
 * Bring a collapsed window back to its normal size and place, before it is focused and handed a notification's
 * click — the same "expand" transform `desktop:restoreWindow` already performs, reused here rather than
 * duplicated so the two paths cannot drift apart.
 *
 * Only `compact` and `orb` count as collapsed: `expanded` is still the conversation, just given more room, so a
 * click there is left alone the way clicking any other visible window would be.
 */
function restoreToNormalIfCollapsed(window) {
  if (windowMode === undefined || (windowMode.mode !== "compact" && windowMode.mode !== "orb")) return;
  windowMode = nextWindowMode({ ...windowMode, workArea: workAreaFor(window) }, { type: "expand" });
  window.setBounds(windowMode.bounds);
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
    // The detached window's own address is passed so the review can tell the two documents apart: the sets of
    // channels they may use are not interchangeable.
    const review = reviewIpcCall(event, channel, shellDocumentUrl, detached?.url);
    if (!review.allowed) {
      return { ok: false, refused: review.reason };
    }
    return await handler(...args);
  });
}

/**
 * The node this window belongs to, or a refusal saying why there is none.
 *
 * The token is read from the node's own identity file rather than passed on the command line or in the URL, where
 * it would be visible in a process list, in history and in the address bar. The base URL is the window's own
 * origin, because the window is served by that node.
 *
 * A function rather than the body of one handler because the detached window's relay needs the same credential:
 * two reads of the identity file would be two places for the token's rules to drift.
 */
function readNodeSession() {
  if (nodeIdentityOverride !== undefined) {
    let overrideOrigin;
    try {
      overrideOrigin = new URL(nodeOriginUrl).origin;
    } catch {
      return { ok: false, refused: "the window's address is not a URL, so there is no node to point at" };
    }
    return { ok: true, baseUrl: overrideOrigin, token: nodeIdentityOverride };
  }
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
    origin = new URL(nodeOriginUrl).origin;
  } catch {
    return { ok: false, refused: "the window's address is not a URL, so there is no node to point at" };
  }
  if (origin === "null") return { ok: false, refused: "the window is not loaded from a node" };
  return { ok: true, baseUrl: origin, token };
}

/**
 * Call the node with its own token.
 *
 * The host holds the credential so the detached renderer never does: the window asks for an action, and this
 * performs it. That is the whole reason a window with no token can still act — and the reason the token must not
 * travel with the bootstrap.
 */
async function callNode(path, init) {
  const session = readNodeSession();
  if (!session.ok) return { ok: false, refused: session.refused };
  try {
    const response = await fetch(`${session.baseUrl}${path}`, {
      method: init?.method ?? "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.token}`,
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      const reason = typeof body?.error?.message === "string" ? body.error.message : `status ${response.status}`;
      return { ok: false, refused: `the node refused: ${reason}` };
    }
    return { ok: true, body };
  } catch (error) {
    // Named rather than swallowed: "the node is not answering" and "the node said no" are different, and only
    // one of them is worth retrying.
    return { ok: false, refused: `the node could not be reached (${error?.code ?? "unreachable"})` };
  }
}

function registerHandlers() {
  handle("desktop:openExternal", async (raw) => {
    const checked = normalizeExternalUrl(raw);
    if (!checked.ok) return { ok: false, refused: checked.reason };
    await shell.openExternal(checked.url);
    return { ok: true, opened: checked.url };
  });

  handle("desktop:getSession", async () => readNodeSession());

  handle("desktop:notify", async (input) => {
    const title = typeof input?.title === "string" ? input.title.slice(0, 120) : "";
    const body = typeof input?.body === "string" ? input.body.slice(0, 500) : "";
    if (title.length === 0) return { ok: false, refused: "a notification needs a title" };
    if (!Notification.isSupported()) return { ok: false, refused: "this OS does not support notifications" };
    if (shellWindow === undefined || shellWindow.isDestroyed()) {
      return { ok: false, refused: "there is no shell window left to open the inbox in" };
    }
    // Host-owned: only the redacted title and body the renderer already bounded ever reach the OS. Clicking it
    // restores the window from orb/compact if it was collapsed, focuses it the same way `desktop:focusWindow`
    // does, then tells the shell window's own renderer so it can open the inbox through its own `inbox.open`
    // intent — never every window, and never an arbitrary `getAllWindows()[0]`, both of which could reach a
    // detached widget window instead of the one actually showing the conversation.
    const notification = new Notification({ title, body });
    const forget = () => activeNotifications.delete(notification);
    notification.on("click", () => {
      forget();
      if (shellWindow.isDestroyed()) return;
      restoreToNormalIfCollapsed(shellWindow);
      if (shellWindow.isMinimized()) shellWindow.restore();
      shellWindow.focus();
      shellWindow.webContents.send("desktop:notificationClicked");
    });
    notification.on("close", forget);
    notification.on("failed", forget);
    activeNotifications.add(notification);
    notification.show();
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

  /*
   * Moving a widget into its own window.
   *
   * The shell sends the composition it already has, and the host decides whether it may travel: what the window
   * receives is that composition and no credential, which is what lets it draw the instance without being able to
   * read the conversation it came from. The lease is claimed after the window loads and released before the shell
   * is told to take the instance back, so there is never a moment with two owners.
   */
  handle("desktop:detachWidget", async (input) => {
    if (detached !== undefined) {
      // A second detached window would be a second owner, which is the thing detaching must not create.
      return { ok: false, refused: "a widget is already detached" };
    }
    if (shellWindow === undefined) {
      return { ok: false, refused: "there is no conversation window to detach from" };
    }
    const conversationId = typeof input?.conversationId === "string" ? input.conversationId : "";
    const instanceId = typeof input?.instanceId === "string" ? input.instanceId : "";
    if (conversationId === "" || instanceId === "") {
      return { ok: false, refused: "detaching needs the conversation and the instance it is showing" };
    }
    const reviewed = reviewDetachedBootstrap(
      detachedBootstrap({
        instanceRef: instanceId,
        title: input?.title,
        widgetKind: input?.widgetKind,
        live: input?.live,
      }),
    );
    if (!reviewed.ok) return { ok: false, refused: reviewed.reason };

    let address;
    try {
      address = new URL(rendererUrl);
    } catch {
      // A shell not loaded from a URL has no address to open a child window at, and a refusal says so rather
      // than throwing inside a handler where nobody would see it.
      return { ok: false, refused: "the conversation window is not loaded from a URL" };
    }
    address.searchParams.set("detached", "1");
    const url = address.toString();
    const bounds = shellWindow.getBounds();
    const window = new BrowserWindow({
      ...detachedWindowOptions(join(here, "detached-preload.cjs"), bounds, screen.getDisplayMatching(bounds).workArea),
      backgroundColor: "#0d1117",
    });

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, target) => {
      if (!target.startsWith(rendererUrl)) event.preventDefault();
    });
    /*
     * The same two listeners the shell window has, and for the same reason: a preload that fails to load is silent
     * by default, and the symptom is a window that looks fine while answering nothing. That is exactly how the
     * `file://D:\` bug hid, so the window that receives the narrowest bridge is the last one that should be quiet
     * about failing to get it.
     */
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
      process.stderr.write(`detached preload failed to load from ${preloadPath}: ${error.stack ?? error}
`);
    });
    window.webContents.on("console-message", (_event, level, message) => {
      if (level >= 2) process.stderr.write(`detached renderer console: ${message}
`);
    });

    detached = { window, url, bootstrap: reviewed.bootstrap, conversationId, instanceId, ownerToken: randomUUID() };

    /*
     * Closing the window is a reattach whether or not anybody clicked anything.
     *
     * An instance cannot be left ownerless by a window that simply disappeared, so the lease is released here and
     * the shell is told to take the instance back. The close path and the explicit attach path are the same path.
     */
    window.on("closed", () => {
      const closed = detached;
      detached = undefined;
      if (closed !== undefined) {
        void callNode(`/conversations/${closed.conversationId}/widgets/${closed.instanceId}/live-owner`, {
          method: "DELETE",
          body: { ownerToken: closed.ownerToken },
        });
      }
      shellWindow?.webContents.send("desktop:widgetReattached", { instanceRef: closed?.instanceId ?? "" });
    });
    window.once("ready-to-show", () => window.show());
    await window.loadURL(url);

    const claimed = await callNode(`/conversations/${conversationId}/widgets/${instanceId}/live-owner`, {
      method: "POST",
      body: { ownerToken: detached.ownerToken, surface: "detached" },
    });
    if (!claimed.ok) {
      window.close();
      return { ok: false, refused: claimed.refused };
    }
    return { ok: true, detached: { instanceRef: instanceId, title: reviewed.bootstrap.title } };
  });

  /** Handing the instance back. The close handler does the releasing, so this is one line of intent. */
  handle("desktop:attachWidget", async () => {
    if (detached === undefined) return { ok: true, attached: false };
    detached.window.close();
    return { ok: true, attached: true };
  });

  handle("detached:bootstrap", async () => {
    if (detached === undefined) return { ok: false, refused: "this window is not showing a detached instance" };
    const reviewed = reviewDetachedBootstrap(detached.bootstrap);
    if (!reviewed.ok) return { ok: false, refused: reviewed.reason };
    return { ok: true, bootstrap: reviewed.bootstrap };
  });

  /*
   * An action the detached window asked for, performed by the host.
   *
   * The window holds no token, so this is how it acts at all. Two things are resolved here rather than accepted
   * from the window: the binding digest comes from the composition the host handed over, so a window cannot supply
   * a digest the node would accept for a different binding, and the invocation id is fresh per attempt, so a
   * double press is one effect.
   */
  handle("detached:intent", async (raw) => {
    if (detached === undefined) return { ok: false, refused: "this window is not showing a detached instance" };
    const reviewed = reviewDetachedIntent(raw);
    if (!reviewed.ok) return { ok: false, refused: reviewed.reason };
    const intent = reviewed.intent;
    if (intent.instanceRef !== detached.instanceId) {
      // A window that could act on an instance other than the one it shows would have reach beyond its own view.
      return { ok: false, refused: "this window may only act on the instance it is showing" };
    }
    const bindings = detached.bootstrap.live?.bindings;
    const binding = Array.isArray(bindings)
      ? bindings.find((entry) => entry?.actionBindingId === intent.actionBindingId)
      : undefined;
    if (binding === undefined) return { ok: false, refused: "that action is not bound on this instance" };

    const result = await callNode(`/conversations/${detached.conversationId}/widgets/${detached.instanceId}/actions`, {
      method: "POST",
      body: {
        instanceId: detached.instanceId,
        actionBindingId: intent.actionBindingId,
        expectedRevision: intent.expectedRevision,
        expectedBindingDigest: binding.bindingDigest,
        input: intent.input ?? {},
        invocationId: randomUUID(),
      },
    });
    if (!result.ok) return { ok: false, refused: result.refused };
    return { ok: true, result: result.body };
  });

  handle("detached:release", async () => {
    if (detached === undefined) return { ok: false, refused: "this window is not showing a detached instance" };
    // The host closes the window rather than letting the renderer remove itself from the ownership story.
    detached.window.close();
    return { ok: true };
  });
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

async function createShellWindow({ show = true, url } = {}) {
  /*
   * `url` exists for the smoke test, which opens one window against its stand-in node so the detach handoff can be
   * exercised for real. Every other caller loads the app.
   */
  const document = url ?? rendererUrl;
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
    if (!target.startsWith(document)) event.preventDefault();
  });

  // The window the conversation is in, remembered so a detached view can open beside it and hand back to it.
  shellWindow = window;
  // Recorded before the load resolves, so a call arriving with the first paint is reviewed against the document
  // this window actually loaded rather than against the previous one.
  shellDocumentUrl = document;
  await window.loadURL(document);

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
  /*
   * Read with a bounded retry, because the window manager applies the flag asynchronously: a bare synchronous read
   * raced it and failed roughly one run in three. A check that fails occasionally is worse than no check, because it
   * teaches people to re-run instead of to look.
   */
  let pinnedNow = window.isAlwaysOnTop();
  for (let attempt = 0; attempt < 20 && pinnedNow !== true; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    pinnedNow = window.isAlwaysOnTop();
  }
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
      /*
       * The count used to be the check, back when one bridge served one window. There are two now, and their
       * channel sets are deliberately different - the shell must not be able to ask for a detached bootstrap, and
       * a detached window must not be able to ask for the local token - so a count would compare two numbers that
       * are supposed to differ. What matters is that the shell exposes none of the detached window's own verbs.
       */
      "the shell bridge cannot reach the detached window's own channels",
      !observed.bridgeMethods.some((name) => ["bootstrap", "intent", "release"].includes(name)),
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

  /*
   * The detached window, exercised against a stand-in node.
   *
   * Everything here is real except the node: a real BrowserWindow with the real narrow preload, the real IPC
   * channels, the real claim/release handoff. The node is stood in for because the smoke run has no runtime, and
   * without one the only reachable outcome would be the refusal - so a smoke test with no stand-in could not check
   * the thing this criterion is about at all.
   */
  const node = await startSmokeNode();
  const previousDocument = shellDocumentUrl;
  const previousOrigin = nodeOriginUrl;
  let detachShell;
  /*
   * Which step the phase is on, so a failure names it.
   *
   * The first version of this phase let an exception escape, and the smoke test printed "Script failed to execute"
   * with nothing to say about where — the same shape of unhelpful output this whole smoke test exists to replace.
   * A step name turns a crash into a check that says what broke.
   */
  let step = "start";
  /** What the detached window could see, so a failure there is diagnosable rather than a bare `false`. */
  let detachedObserved = {};
  try {
    shellDocumentUrl = node.url;
    nodeOriginUrl = node.url;
    nodeIdentityOverride = "smoke-token-not-a-credential";
    step = "open a shell against the stand-in";
    detachShell = await createShellWindow({ show: false, url: node.url });
    step = "install the reattach listener";
    await detachShell.webContents.executeJavaScript(
      "window.__reattached = []; window.clarkcant.onWidgetReattached((payload) => window.__reattached.push(payload)); true",
    );

    step = "ask the host to detach";
    const asked = await detachShell.webContents.executeJavaScript(
      `window.clarkcant.detachWidget(${JSON.stringify({
        conversationId: "conv_smoke",
        instanceId: "widget_smoke",
        title: "Bang dieu khien",
        live: {
          compositionId: "comp_smoke",
          readOnly: false,
          revision: 1,
          period: "week",
          timezone: "Asia/Saigon",
          state: {},
          spec: { instanceId: "widget_smoke", catalogDigest: "sha256:smoke", sections: [], actions: [] },
          bindings: [],
          sections: [],
          availability: {},
        },
      })})`,
    );

    step = "read the claim the node was asked for";
    const claim = node.calls.find((call) => call.method === "POST");
    const opened = detached?.window;
    step = "ask the detached window what it received";
    const bootstrap =
      opened === undefined
        ? undefined
        : await opened.webContents.executeJavaScript(
            "(() => { const bridge = window.clarkcantDetached; " +
              "if (bridge === undefined) return { ok: false, refused: 'the detached window has no bridge' }; " +
              "return bridge.bootstrap(); })()",
          );
    step = "ask the detached window what it can reach";
    const verbs =
      opened === undefined
        ? []
        : await opened.webContents.executeJavaScript(
            "(() => { const bridge = window.clarkcantDetached; " +
              "return bridge === undefined ? [] : Object.keys(bridge).sort(); })()",
          );

    step = "close the detached window";
    opened?.close();
    // The close handler releases the lease and messages the shell; neither is synchronous with `close()`.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const release = node.calls.find((call) => call.method === "DELETE");
    const reattached = await detachShell.webContents.executeJavaScript("window.__reattached");
    const bootstrapKeys =
      bootstrap?.ok === true ? JSON.stringify(Object.keys(bootstrap.bootstrap).sort()) : "[]";

    detachedObserved = { verbs, bootstrapOk: bootstrap?.ok === true, bootstrapKeys };
    checks.push(
      [
        "the stand-in node was asked to move the lease to the detached surface",
        claim !== undefined && claim.body["surface"] === "detached",
      ],
      ["a real detached window opened, and the host said so", asked?.ok === true && opened !== undefined],
      [
        "the bootstrap carries the widget and no credential",
        bootstrap?.ok === true &&
          bootstrapKeys === JSON.stringify(["instanceRef", "live", "title", "widgetKind"]) &&
          !JSON.stringify(bootstrap.bootstrap).includes("localToken"),
      ],
      [
        "the detached window reaches only its own three verbs",
        JSON.stringify(verbs) === JSON.stringify(["bootstrap", "intent", "release"]),
      ],
      ["closing the window gives the lease back", release !== undefined],
      ["and the shell is told to take the instance back", Array.isArray(reattached) && reattached.length === 1],
    );
  } catch (error) {
    checks.push([
      `the detached-window phase ran to the end (it threw while trying to ${step}: ${
        error instanceof Error ? error.message : String(error)
      })`,
      false,
    ]);
  } finally {
    detachShell?.close();
    shellDocumentUrl = previousDocument;
    nodeOriginUrl = previousOrigin;
    nodeIdentityOverride = undefined;
    await node.close();
  }

  const failed = checks.filter(([, passed]) => !passed);
  process.stdout.write(
    `${JSON.stringify(
      { mode: "smoke-test", rendererUrl, observed, detachedObserved, checks, failed: failed.map(([name]) => name) },
      null,
      2,
    )}\n`,
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
