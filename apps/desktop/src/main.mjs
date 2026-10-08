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
 *   electron . -- --renderer-url <u>   load a different shell document
 *   electron . -- --renderer-url <u> --dev   <u> is a loopback Vite dev server; see `tools/dev-desktop.mjs`
 *
 * The `--` is required on Windows once a flag follows a URL: see `launch-args.mjs`. Flags are read by name, so it
 * changes nothing here.
 *
 * `--smoke-test` exists so the security posture is verified by running it rather than by
 * reading it. It creates a real window with a real preload bridge and asserts the bridge's
 * shape and its refusals from inside the renderer.
 */

import { app, BrowserWindow, dialog, ipcMain, Notification, screen, shell, session } from "electron";
import { randomUUID } from "node:crypto";

import { SMOKE_FRAME_PATH, startSmokeNode } from "./smoke-node.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  MAX_PICK_BYTES,
  createFileHandles,
  dispositionFilename,
  fileRefusal,
  mimeForFileName,
  replaceKeepsType,
  reviewPickFileRequest,
  reviewSaveDialog,
  reviewSaveFileRequest,
  writeFileWhole,
} from "./file-bridge.mjs";

import {
  contentSecurityPolicy,
  createWindowOptions,
  DETACHED_WINDOW_CHANNELS,
  IPC_CHANNELS,
  normalizeExternalUrl,
  reviewCredentialRequest,
  reviewDevServerUrl,
  reviewIpcCall,
  reviewNotificationTarget,
  withContentSecurityPolicy,
} from "./security.mjs";
import {
  BROKER_RELAY_VERBS,
  COMPOSER_SURFACE_HEADER,
  DETACHED_LEASE,
  detachedBootstrap,
  detachedWindowOptions,
  redactDevSessionView,
  RELAY_LIMITS,
  relayBudget,
  relayPackagesChanged,
  reviewDetachedBootstrap,
  reviewDetachedBrokerRequest,
  reviewDetachedDevSession,
  reviewDetachedFrameAnswer,
  reviewDetachedFrameRead,
  reviewDetachedIntent,
  reviewDetachedAppearance,
  reviewDetachedSemanticPublish,
  reviewDetachedStateSave,
  runRelay,
  superviseDetachedWindow,
  tokenSessions,
} from "./detached-window.mjs";
import { createNodeCaller } from "./node-call.mjs";
import { COMPACT_MIN_SIZE } from "./window-mode.mjs";
import { createElectronGeometryController, withFallbackController } from "./window-controller.mjs";
import { createHyprlandWindowController } from "./hyprland-window-controller.mjs";
import { createHyprlandSocketTransport, hyprlandSocketPath } from "./hyprland-ipc.mjs";
import { detectWindowSession, geometrySupportFor, selectWindowBackend } from "./window-session.mjs";
import { placementToRemember, restoredPlacement } from "./window-placement.mjs";
import { applyChromiumSwitches } from "./chromium-switches.mjs";

// Before anything else and before the app is ready: Electron reads the feature list once the main script has run.
applyChromiumSwitches(app.commandLine, process.platform);

const here = dirname(fileURLToPath(import.meta.url));
/*
 * The app's icon, set at runtime because nothing packages this app yet: without it an unpackaged run shows Electron's
 * own icon in the Dock and the task bar, which reads as some other app.
 */
const appIcon = join(here, "../assets/icon.png");

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
 * The renderer is a Vite dev server, so the window gets the dev policy that lets hot reload run.
 *
 * Asked for explicitly rather than guessed from the URL, and reviewed before the window exists: a refused dev server
 * ends the run with the reason instead of opening a window whose every script the policy blocks.
 */
const devMode = argv.includes("--dev");
let devOrigin;
if (devMode) {
  const review = reviewDevServerUrl(rendererUrl, { packaged: app.isPackaged });
  if (!review.ok) {
    process.stderr.write(`--dev refused: ${review.reason}\n`);
    process.exit(1);
  }
  devOrigin = review.origin;
}
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

/**
 * How often the detached window's lease is refreshed.
 *
 * The production value is `DETACHED_LEASE.refreshMs`; the smoke test shortens it so a real refresh, and a refused one,
 * happen inside a run that lasts seconds rather than minutes.
 */
let detachedLeaseRefreshMs = DETACHED_LEASE.refreshMs;

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
  "closeWindow",
  "detachWidget",
  "focusWindow",
  "getSession",
  "minimizeWindow",
  "notify",
  "notifyPackagesChanged",
  "onArtifactAttached",
  "onNotificationClicked",
  "onWidgetReattached",
  "openExternal",
  "pickDirectory",
  "pickFile",
  "requestCredential",
  "resizeWindowPreset",
  "restoreWindow",
  "onWindowStateChanged",
  "saveFile",
  "setCompactMode",
  "setFullScreen",
  "setKeepRunningOnWindowClose",
  "setWindowMode",
  "status",
  "updateAppearance",
].sort());

/**
 * The desktop session the window lives in: macOS, Windows, X11, XWayland or native Wayland, and whether Hyprland is the
 * compositor. Read once, before the app is ready, from the environment and Electron's own Ozone switches.
 */
const windowSession = detectWindowSession({
  platform: process.platform,
  env: process.env,
  switches: {
    ozonePlatform: app.commandLine.getSwitchValue("ozone-platform"),
    ozonePlatformHint: app.commandLine.getSwitchValue("ozone-platform-hint"),
  },
});

/** `--window-backend <name>` or `CLARKCANT_WINDOW_BACKEND`: the opt-in for the Hyprland backend. */
const windowBackendFlag = argv.indexOf("--window-backend");
const windowBackendChoice = selectWindowBackend({
  session: windowSession,
  requested: windowBackendFlag >= 0 ? argv[windowBackendFlag + 1] : process.env.CLARKCANT_WINDOW_BACKEND,
});

/**
 * Electron geometry: the backend on macOS, Windows and X11, and under native Wayland with position and always-on-top
 * reported as unsupported. It also holds the window's remembered mode, in the process that owns the window, because a
 * renderer comes and goes: a reload must not move the window back to its expanded size, and returning from compact has
 * to restore what the person had rather than a default.
 */
const geometryController = createElectronGeometryController({
  getWindow: liveShellWindow,
  workAreaFor,
  support: geometrySupportFor(windowSession),
});

/**
 * What every window channel goes through. The Hyprland backend only when asked for and Hyprland is running, and even
 * then with Electron geometry behind it: it is unverified on a real compositor, so the first IPC failure hands the
 * window back for the rest of the session and says so.
 */
const windowController =
  windowBackendChoice.backend === "hyprland" && windowSession.hyprland !== undefined
    ? withFallbackController(
        createHyprlandWindowController({
          request: createHyprlandSocketTransport(hyprlandSocketPath(windowSession.hyprland)),
          getWindow: liveShellWindow,
          pid: process.pid,
          fallbackPreset: (name) => geometryController.resizePreset(name),
        }),
        geometryController,
        { onDegrade: (reason) => process.stderr.write(`window backend: Hyprland given up, using Electron geometry (${reason})\n`) },
      )
    : geometryController;

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

/** Files the person picked for a widget: handle to path, in this process only (`file-bridge.mjs`). */
const fileHandles = createFileHandles();

/** The file the conversation window's last place is kept in, beside Electron's own per-user state. */
function windowPlacementPath() {
  return join(app.getPath("userData"), "window-placement.json");
}

/**
 * Where to open the conversation window, or `undefined` for the default.
 *
 * A missing, unreadable or unusable file is the default, never an error: the window opening at its first-run size is
 * the worst case, and it is not worth a dialog.
 */
function readWindowPlacement() {
  try {
    const saved = JSON.parse(readFileSync(windowPlacementPath(), "utf8"));
    return restoredPlacement(saved, screen.getAllDisplays().map((display) => display.workArea));
  } catch {
    return undefined;
  }
}

/**
 * Keep the window's place as it closes.
 *
 * The size outside maximize and full screen, so a window closed maximized comes back maximized over the size it had
 * before; while collapsed into the bar or the orb, the size the person had before collapsing. A write that fails costs
 * only the next window's placement, so it is reported and nothing else.
 */
function rememberWindowPlacement(window, openedAs) {
  const normalBounds = windowController.collapsedNormalBounds() ?? window.getNormalBounds();
  const placement = placementToRemember({ normalBounds, maximized: window.isMaximized(), fullScreen: window.isFullScreen(), openedAs });
  try {
    writeFileSync(windowPlacementPath(), JSON.stringify(placement));
  } catch (cause) {
    process.stderr.write(`window placement: not remembered (${cause instanceof Error ? cause.message : String(cause)})\n`);
  }
}

/** The work area of the display the window is on, so a compact window lands somewhere reachable. */
function workAreaFor(window) {
  return screen.getDisplayMatching(window.getBounds()).workArea;
}

/**
 * The window showing the conversation, or `undefined` when there is none left.
 *
 * The window channels act on this window by name rather than on `getAllWindows()[0]`: Electron does not promise
 * that order, so with a detached widget window open the first entry could be that window instead. Only the shell
 * document may call these channels, so the window it lives in is the only one they should ever move.
 */
function liveShellWindow() {
  return shellWindow === undefined || shellWindow.isDestroyed() ? undefined : shellWindow;
}


/**
 * Whether the window is full screen or minimized, read off the window.
 *
 * Pushed to the renderer on every change as well as answered to a request, because the operating system can
 * change either one without asking the client: a keyboard shortcut, a click on the dock, a display going away.
 */
function windowState(window) {
  return { ok: true, fullScreen: window.isFullScreen(), minimized: window.isMinimized() };
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
      // In development a refused bridge call is the usual reason a window shows "not connected", so say which.
      if (devMode) process.stderr.write(`ipc ${channel} refused: ${review.reason}\n`);
      return { ok: false, refused: review.reason };
    }
    /*
     * A detached window's verb is answered only for the window the host opened, compared by the contents themselves
     * rather than by address: another window that loaded the same URL is not the window the instance was handed to.
     */
    if (DETACHED_WINDOW_CHANNELS.includes(channel) && (detached === undefined || event.sender !== detached.window.webContents)) {
      return { ok: false, refused: "this window is not showing a detached instance" };
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
 * travel with the bootstrap. A refusal keeps the node's `code` and details (`node-call.mjs`).
 */
const callNode = createNodeCaller({ readSession: readNodeSession });

/** The live-owner route of the instance a detached window shows. */
function liveOwnerPath(open) {
  return widgetPath(open, "/live-owner");
}

/**
 * A route of the instance a detached window shows, built from the ids the host recorded when it opened the window. The
 * window never names either id: every relay reaches this one instance or nothing.
 */
function widgetPath(open, suffix) {
  return `/conversations/${encodeURIComponent(open.conversationId)}/widgets/${encodeURIComponent(open.instanceId)}${suffix}`;
}

/** A node refusal as a relay answers it: the node's own code and details, so the window maps it as the shell would. */
function relayRefusal(result) {
  return { ok: false, refused: result.refused, code: result.code, details: result.details ?? {} };
}

/**
 * Run one relay for the detached window under its budget, against the window that asked.
 *
 * The budget is the window's own, so a window reopened starts afresh; a call over it is refused at once. `run` gets the
 * only node caller a relay uses, bound to the verb's time limit, so a node that never answers frees the slot with
 * `NODE_TIMEOUT`. A call that settles after its window closed answers as refused, because what it would hand back
 * belongs to a window that is gone.
 */
async function relayForDetached(verb, run) {
  const open = detached;
  if (open === undefined) return { ok: false, refused: "this window is not showing a detached instance" };
  return runRelay(open.budget, verb, callNode, async (call) => {
    const answer = await run(open, call);
    if (detached !== open) return { ok: false, refused: "the widget window closed before the node answered", code: "WINDOW_CLOSED", details: {} };
    return answer;
  });
}

/**
 * End every token session a detached window's frames were issued tokens under, so the node revokes what they were given.
 *
 * Run when the window closes — after the lease is released and before the conversation is told — and when a read shows
 * the frame's document replaced, whose frame is remounted under a session of its own. The host's own cleanup, so it
 * spends from no budget; each call is bounded in time, and a token whose revoke the node never hears lapses at its expiry.
 */
async function endTokenSessions(open) {
  const sessions = open.tokens.drain();
  await Promise.allSettled(
    sessions.map((session) =>
      callNode(widgetPath(open, `/browser-tokens/${encodeURIComponent(session)}`), {
        method: "DELETE",
        timeoutMs: RELAY_LIMITS.tokens.timeoutMs,
      }),
    ),
  );
}

/** A desktop dialog's refusal (`fileRefusal`) as a relay answers it: marked, so the window words it as the desktop's. */
function desktopRefusal(refusal) {
  return { ...refusal, desktop: true };
}

/**
 * Close the detached window, if one is open, and wait until its lease has been given back.
 *
 * Bounded: a node that does not answer the release must not hold the app open, and the lease lapses on its own.
 */
async function closeDetachedWindow() {
  const open = detached;
  if (open === undefined) return;
  open.window.close();
  await Promise.race([open.lease.released, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

/**
 * The OS file picker, parented to the window that asked: the conversation's, or a detached widget window's.
 *
 * Answers the chosen file's bare name, the type its name says and its bytes, and — for this process only — its path, so
 * the caller can remember it under a handle or for a later "replace". Every failure is a fixed code (`fileRefusal`):
 * the error a file system gives names the path.
 */
async function pickFileIn(window, input) {
  const review = reviewPickFileRequest(input);
  if (!review.allowed) return fileRefusal("INVALID_REQUEST");
  if (window === undefined || window.isDestroyed()) return fileRefusal("NO_WINDOW");
  const outcome = await dialog.showOpenDialog(window, {
    title: review.title,
    properties: ["openFile"],
    ...(review.filters.length === 0 ? {} : { filters: review.filters }),
  });
  if (outcome.canceled || outcome.filePaths.length === 0) return { ok: true, canceled: true };
  const chosen = outcome.filePaths[0];
  // A file that vanished, is locked or cannot be read answers with a code: the error's message names the path.
  let bytes;
  try {
    const info = await stat(chosen);
    if (!info.isFile()) return fileRefusal("NOT_A_FILE");
    if (info.size > MAX_PICK_BYTES) return fileRefusal("FILE_TOO_LARGE");
    bytes = await readFile(chosen);
  } catch (cause) {
    return fileRefusal("READ_FAILED", cause);
  }
  if (bytes.byteLength > MAX_PICK_BYTES) return fileRefusal("FILE_TOO_LARGE");
  const name = basename(chosen);
  return { ok: true, canceled: false, file: { name, mimeType: mimeForFileName(name), bytes }, path: chosen };
}

/**
 * Save bytes where the person chooses, in dialogs parented to the window that asked.
 *
 * Save As always asks where. Given `replacePath` — a file this person picked earlier — it writes back over it instead,
 * after asking, and only with bytes of that file's type. The answer is whether the file was saved and under which bare
 * name, never where.
 */
async function saveFileIn(window, review, bytes, replacePath) {
  if (window === undefined || window.isDestroyed()) return fileRefusal("NO_WINDOW");
  let target;
  if (replacePath !== undefined) {
    target = replacePath;
    // Replacing keeps the file's type: a PDF written over notes.md would no longer open as what its name says.
    if (!replaceKeepsType(basename(target), review.mimeType)) return fileRefusal("REPLACE_TYPE_MISMATCH");
    const confirm = await dialog.showMessageBox(window, {
      type: "question",
      title: review.dialog.replaceTitle,
      message: review.dialog.replaceMessage.replace("{name}", basename(target)),
      buttons: [review.dialog.cancel, review.dialog.replace],
      defaultId: 0,
      cancelId: 0,
    });
    if (confirm.response !== 1) return { ok: true, canceled: true };
  } else {
    const outcome = await dialog.showSaveDialog(window, { defaultPath: review.suggestedName, filters: review.filters });
    if (outcome.canceled || outcome.filePath === undefined || outcome.filePath === "") return { ok: true, canceled: true };
    target = outcome.filePath;
  }
  try {
    await writeFileWhole(target, bytes);
  } catch (cause) {
    return fileRefusal("WRITE_FAILED", cause);
  }
  return { ok: true, canceled: false, saved: true, name: basename(target) };
}

function registerHandlers() {
  handle("desktop:openExternal", async (raw) => {
    const checked = normalizeExternalUrl(raw);
    if (!checked.ok) return { ok: false, refused: checked.reason };
    await shell.openExternal(checked.url);
    return { ok: true, opened: checked.url };
  });

  // The client reads the handover under `session` (`sessionFromBridge` in conversation-client); the flat shape is
  // this file's own, for the relay. Handing the flat one over made every window read "no token" with a token on disk.
  handle("desktop:getSession", async () => {
    const session = readNodeSession();
    if (!session.ok) return session;
    return { ok: true, session: { baseUrl: session.baseUrl, token: session.token } };
  });

  handle("desktop:notify", async (input) => {
    const title = typeof input?.title === "string" ? input.title.slice(0, 120) : "";
    const body = typeof input?.body === "string" ? input.body.slice(0, 500) : "";
    if (title.length === 0) return { ok: false, reason: "invalid", refused: "a notification needs a title" };
    if (!Notification.isSupported()) return { ok: false, reason: "unsupported", refused: "this OS does not support notifications" };
    if (shellWindow === undefined || shellWindow.isDestroyed()) {
      return { ok: false, reason: "no-window", refused: "there is no shell window left to open the inbox in" };
    }
    // Host-owned: only the redacted title and body the renderer already bounded ever reach the OS. Clicking it
    // restores the window from orb/compact if it was collapsed, focuses it the same way `desktop:focusWindow`
    // does, then tells the shell window's own renderer so it can open the inbox through its own `inbox.open`
    // intent — never every window, and never an arbitrary `getAllWindows()[0]`, both of which could reach a
    // detached widget window instead of the one actually showing the conversation. The click carries back the id the
    // notification was shown with, checked here against the inbox-target grammar, so the inbox opens on that item;
    // nothing else the renderer sent travels with it.
    const target = reviewNotificationTarget(input?.target);
    const notification = new Notification({ title, body });
    const forget = () => activeNotifications.delete(notification);
    notification.on("click", async () => {
      forget();
      if (shellWindow.isDestroyed()) return;
      // Out of the bar or the orb first, through the same controller as `desktop:restoreWindow`, so the two cannot
      // drift apart. A click while expanded leaves the window alone, as clicking any visible window would.
      try {
        await windowController.restoreIfCollapsed();
      } catch (cause) {
        process.stderr.write(`notification click: window not restored (${cause instanceof Error ? cause.message : String(cause)})\n`);
      }
      if (shellWindow.isDestroyed()) return;
      if (shellWindow.isMinimized()) shellWindow.restore();
      shellWindow.focus();
      shellWindow.webContents.send("desktop:notificationClicked", target === undefined ? {} : { target });
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
    const window = liveShellWindow();
    if (window === undefined) return { ok: false, refused: "no window is available for the picker" };
    const title = typeof input?.title === "string" && input.title.trim() !== "" ? input.title.slice(0, 120) : "Choose a directory";
    const outcome = await dialog.showOpenDialog(window, { title, properties: ["openDirectory"] });
    if (outcome.canceled || outcome.filePaths.length === 0) return { ok: true, canceled: true };
    return { ok: true, canceled: false, path: outcome.filePaths[0] };
  });

  /*
   * A file for a widget, chosen by the person in the OS dialog.
   *
   * What goes back is the bare name, its type and its bytes — never the path. The renderer can ask to write back to
   * this file later, and names it by the handle minted here; the path stays in `fileHandles`.
   */
  handle("desktop:pickFile", async (input) => {
    const picked = await pickFileIn(liveShellWindow(), input);
    if (!picked.ok || picked.canceled) return picked;
    const { name, mimeType, bytes } = picked.file;
    return {
      ok: true,
      canceled: false,
      file: { name, mimeType, contentBase64: bytes.toString("base64"), handle: fileHandles.remember(picked.path) },
    };
  });

  /*
   * Save a file the person exported. Save As always asks where; writing back over a picked file asks first too, and
   * names only the file's name in the question. Either way the answer is whether it was saved, not where.
   *
   * The dialogs speak the person's language: the renderer passes their strings, and the file's type decides the
   * extension Save As offers. A write lands whole or not at all (`writeFileWhole`), so a failure leaves the original.
   */
  handle("desktop:saveFile", async (input) => {
    const review = reviewSaveFileRequest(input);
    if (!review.allowed) return fileRefusal("INVALID_REQUEST");
    const window = liveShellWindow();
    if (window === undefined) return fileRefusal("NO_WINDOW");
    let replacePath;
    if (review.replaceHandle !== undefined) {
      replacePath = fileHandles.pathFor(review.replaceHandle);
      if (replacePath === undefined) return fileRefusal("HANDLE_UNKNOWN");
    }
    return saveFileIn(window, review, Buffer.from(input.contentBase64, "base64"), replacePath);
  });
  handle("desktop:requestCredential", async (input) => {
    const review = reviewCredentialRequest(input);
    if (!review.allowed) return { ok: false, refused: review.reason };
    // Secret entry happens in a host-owned window. The value is never returned to the
    // renderer and never crosses the bridge; only the fact that something was stored does.
    const window = liveShellWindow();
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
    if (liveShellWindow() === undefined) return { ok: false, refused: "there is no window to resize" };
    if (!["enter-compact", "expand", "set-always-on-top"].includes(action?.type)) {
      return { ok: false, refused: "that is not a window mode this build knows" };
    }
    // The older channel speaks in actions; the controller speaks in modes and a pin. Leaving full screen first is this
    // channel's own behaviour (a full-screen window ignores new bounds, so the voice bar would never appear).
    return action.type === "set-always-on-top"
      ? await windowController.setPinned(action.value === true)
      : await windowController.setMode(action.type === "enter-compact" ? "compact" : "normal", {
          exitFullScreen: true,
          reassertPin: true,
        });
  });

  /*
   * The window's named modes.
   *
   * A mode name from the renderer, and everything else decided here: bounds live in this process, so a renderer cannot
   * ask for geometry off the edge of the screen or larger than the display. The answer reports what the window actually
   * has afterwards, read back off the window, and which parts this desktop could not honour at all.
   */
  handle("desktop:setWindowMode", async (mode) => windowController.setMode(mode));

  /*
   * A named size, with the mode left alone.
   *
   * Separate from the mode channels because they answer different questions: a mode is about what the window is
   * for, and a preset is about how big it is. Folding them together would make resizing the conversation window
   * change it into the voice bar.
   */
  handle("desktop:resizeWindowPreset", async (name) => windowController.resizePreset(name));

  /*
   * Back to the size and place the window had before it was collapsed.
   *
   * The remembered bounds live in this process, so a reload that loses the renderer's idea of where the window
   * was does not also lose the window's own position.
   */
  handle("desktop:restoreWindow", async () => windowController.restore());

  /*
   * Bring the window forward.
   *
   * A request that came from voice or from an app intent has nobody behind it to click the window, so the shell
   * is what has to make it the one being looked at.
   */
  handle("desktop:focusWindow", async () => windowController.focus());

  /*
   * Close the window, as the title bar's close button would. Whether the app then quits is the existing
   * `window-all-closed` policy's decision, not this button's: closing a window stops the window, not the work.
   * Closed on the next tick so the renderer gets its answer before its document goes away.
   *
   * Only the shell document may call this, so the window it closes is the shell window, never
   * `getAllWindows()[0]`, which could be a detached widget window while the conversation stays open.
   */
  handle("desktop:closeWindow", async () => {
    const window = shellWindow;
    if (window === undefined || window.isDestroyed()) return { ok: false, refused: "there is no window to close" };
    setTimeout(() => {
      if (!window.isDestroyed()) window.close();
    });
    return { ok: true };
  });

  /*
   * Send the window to the dock or taskbar.
   *
   * The answer reads the window back rather than assuming, and there is no matching "unminimize" verb: a
   * minimized window cannot be clicked, so bringing it back belongs to the OS, to `desktop:focusWindow` or to
   * the host shortcut.
   */
  handle("desktop:minimizeWindow", async () => windowController.minimize());

  /*
   * Take the whole screen, or give it back.
   *
   * A boolean rather than a toggle, so two clicks that cross in flight both end where the person meant instead
   * of cancelling each other out. Leaving full screen puts the window back where it was, which Electron keeps
   * track of for us; entering it from the voice bar grows the conversation first, because a full-screen voice
   * bar is a very large empty strip.
   */
  handle("desktop:setFullScreen", async (value) => windowController.setFullscreen(value));

  /** The window part of the status, or `null` when there is no window left to describe. */
  async function describeShellWindow() {
    const snapshot = await windowController.snapshot();
    if (snapshot === undefined || snapshot === null) return null;
    return { ...snapshot, session: windowSession.kind, backendReason: windowBackendChoice.reason };
  }

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
    // Read off the window, so a renderer that reloaded learns what the window is rather than assuming the default:
    // the chrome's pin toggle assumed "not pinned" after a reload, and pressing it pinned a window that already was.
    // `pinnable` is false where the session cannot keep a window on top, so the chrome offers no pin it cannot honour;
    // `session` and `backend` say which desktop the window is on and what drives it, for diagnostics.
    window: await describeShellWindow(),
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
    const conversationWindow = liveShellWindow();
    if (conversationWindow === undefined) {
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
        appearance: input?.appearance,
      }),
    );
    if (!reviewed.ok) return { ok: false, refused: reviewed.reason };

    /*
     * The detached window is the conversation's own document at `?detached=1`, so it frames what the conversation may
     * frame under the same policy. In every real run that document is `rendererUrl`; the smoke test serves it from its
     * stand-in node (`shellDocumentUrl`), and a window opened at the bundled posture document instead could frame nothing.
     */
    const detachedBase = shellDocumentUrl;
    let address;
    try {
      address = new URL(detachedBase);
    } catch {
      // A shell not loaded from a URL has no address to open a child window at, and a refusal says so rather
      // than throwing inside a handler where nobody would see it.
      return { ok: false, refused: "the conversation window is not loaded from a URL" };
    }
    address.searchParams.set("detached", "1");
    const url = address.toString();
    const bounds = conversationWindow.getBounds();
    const window = new BrowserWindow({
      ...detachedWindowOptions(join(here, "detached-preload.cjs"), bounds, screen.getDisplayMatching(bounds).workArea),
      backgroundColor: "#0d1117",
    });

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, target) => {
      if (!target.startsWith(detachedBase)) event.preventDefault();
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

    const opened = {
      window,
      url,
      bootstrap: reviewed.bootstrap,
      conversationId,
      instanceId,
      ownerToken: randomUUID(),
      lease: undefined,
      // Every relay this window asks for spends from this, and it goes with the window.
      budget: relayBudget(),
      // The token sessions this window's frames were issued under, ended when it closes or its frame is replaced.
      tokens: tokenSessions(),
      // The file the person last picked in this window, so a save may write back over it. Never sent to the window.
      picked: undefined,
    };
    detached = opened;
    /*
     * Claimed after the window loads, and only if it is still open; refreshed for as long as it stays open, with the
     * conversation's own numbers. A refresh refused because another surface holds the instance now means this window
     * shows something it no longer owns, so it closes and the conversation takes the widget back — and is told, by
     * its own claim, where the widget is shown instead.
     *
     * Closing the window is a reattach whether or not anybody clicked anything. An instance cannot be left ownerless
     * by a window that simply disappeared, so the lease is released and the shell is told to take the instance back.
     * The close path and the explicit attach path are the same path. The shell is told once the release has settled,
     * or once its bound has passed: told earlier, its claim would meet this window's lease still in place; never told,
     * the widget would stay read-only with no window open.
     */
    opened.lease = superviseDetachedWindow({
      window,
      isCurrent: () => detached === opened,
      claim: () =>
        callNode(liveOwnerPath(opened), {
          method: "POST",
          body: { ownerToken: opened.ownerToken, surface: "detached", leaseMs: DETACHED_LEASE.leaseMs },
        }),
      release: () => callNode(liveOwnerPath(opened), { method: "DELETE", body: { ownerToken: opened.ownerToken } }),
      // After the release and before the conversation is told: every token the window's frames were given is revoked.
      afterRelease: () => endTokenSessions(opened),
      refreshMs: detachedLeaseRefreshMs,
      onClosed: () => {
        if (detached === opened) detached = undefined;
      },
      onEnded: () => {
        // The conversation window may be the reason this one closed, and a destroyed window has no page to tell.
        liveShellWindow()?.webContents.send("desktop:widgetReattached", { instanceRef: opened.instanceId });
      },
    });
    window.once("ready-to-show", () => window.show());
    try {
      await window.loadURL(url);
    } catch (cause) {
      // A page that failed to load shows nothing and claims nothing. Closing it hands the widget back through the same
      // path as any close, and the conversation says why the window did not open.
      if (!window.isDestroyed()) window.close();
      return { ok: false, refused: `the widget window did not load: ${cause instanceof Error ? cause.message : String(cause)}` };
    }

    const claimed = await opened.lease.begin();
    if (!claimed.ok) return { ok: false, refused: claimed.refused };
    return { ok: true, detached: { instanceRef: instanceId, title: reviewed.bootstrap.title } };
  });

  /** Handing the instance back. The close handler does the releasing, so this is one line of intent. */
  handle("desktop:attachWidget", async () => {
    if (detached === undefined) return { ok: true, attached: false };
    detached.window.close();
    return { ok: true, attached: true };
  });

  handle("desktop:updateAppearance", async (input) => {
    const checked = reviewDetachedAppearance(input);
    if (!checked.ok) return { ok: false, refused: checked.reason };
    if (detached === undefined || detached.bootstrap.appearance?.revision === checked.appearance.revision) return { ok: true };
    detached.bootstrap = { ...detached.bootstrap, appearance: checked.appearance };
    detached.window.webContents.send("detached:appearance", checked.appearance);
    return { ok: true };
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
    return relayForDetached("intent", async (open, call) => {
      // The bindings of the newest read the host made, so a digest the node changed since the window opened is the one
      // sent — and a binding the node no longer holds is refused here.
      const bindings = open.bootstrap.live?.bindings;
      const binding = Array.isArray(bindings)
        ? bindings.find((entry) => entry?.actionBindingId === intent.actionBindingId)
        : undefined;
      if (binding === undefined) return { ok: false, refused: "that action is not bound on this instance", code: "ACTION_UNBOUND", details: {} };
      const result = await call(widgetPath(open, "/actions"), {
        method: "POST",
        // A press in this window is the person's, as it is in the conversation.
        headers: { [COMPOSER_SURFACE_HEADER]: "composer" },
        body: {
          instanceId: open.instanceId,
          actionBindingId: intent.actionBindingId,
          expectedRevision: intent.expectedRevision,
          expectedBindingDigest: binding.bindingDigest,
          input: intent.input ?? {},
          // The frame's own key when it sent one, so its retry of a press is one effect; a fresh one per attempt otherwise.
          invocationId: intent.invocationId ?? randomUUID(),
        },
      });
      if (!result.ok) return relayRefusal(result);
      return { ok: true, result: result.body };
    });
  });

  /*
   * The relays a widget in its own frame needs, each performed by the host with its own credential against the one
   * instance this window was opened for. The window names no id and holds no token; the node re-authorizes every call.
   */

  /*
   * A fresh read of the instance: a new grant in the frame URL every time, never a cached one. The answer is checked to
   * be this instance, still in its own frame, with a URL on the node; the bindings the host resolves digests from and
   * the dev session it reads are refreshed from it.
   */
  handle("detached:frame.read", async (raw) => {
    const reviewed = reviewDetachedFrameRead(raw);
    if (!reviewed.ok) return { ok: false, refused: reviewed.reason };
    return relayForDetached("frame.read", async (open, call) => {
      const session = readNodeSession();
      if (!session.ok) return { ok: false, refused: session.refused, code: "NO_NODE_SESSION", details: {} };
      const result = await call(widgetPath(open, "/live"), { method: "GET" });
      if (!result.ok) return relayRefusal(result);
      const answer = reviewDetachedFrameAnswer(result.body, { instanceId: open.instanceId, baseUrl: session.baseUrl });
      if (!answer.ok) return { ok: false, refused: answer.reason, code: "FRAME_READ_REFUSED", details: {} };
      /*
       * A different document is a new generation of the widget: the window remounts its frame under a new token
       * session, so whatever the old one was given is revoked now rather than when the window closes.
       */
      const before = open.bootstrap.live?.frame?.document;
      if (before !== undefined && before !== answer.live.frame?.document) await endTokenSessions(open);
      open.bootstrap = { ...open.bootstrap, live: answer.live };
      return { ok: true, live: answer.live };
    });
  });

  // A state write the frame made. No surface header: the widget wrote it, not the person.
  handle("detached:state.save", async (raw) => {
    const reviewed = reviewDetachedStateSave(raw);
    if (!reviewed.ok) return { ok: false, refused: reviewed.reason };
    return relayForDetached("state.save", async (open, call) => {
      const result = await call(widgetPath(open, "/state"), { method: "POST", body: reviewed.write });
      if (!result.ok) return relayRefusal(result);
      return { ok: true, saved: result.body };
    });
  });

  // What the frame says it shows, bounded in size, and in time as every relay is.
  handle("detached:semantic.publish", async (raw) => {
    const reviewed = reviewDetachedSemanticPublish(raw);
    if (!reviewed.ok) return { ok: false, refused: reviewed.reason };
    return relayForDetached("semantic.publish", async (open, call) => {
      const result = await call(widgetPath(open, "/semantic"), {
        method: "POST",
        body: { proposal: reviewed.proposal },
      });
      if (!result.ok) return relayRefusal(result);
      return { ok: true };
    });
  });

  /*
   * The status of the widget dev session whose build the frame runs: the session the host's newest read named, read
   * only, and without the developer's folder path — in its own field or inside a build message — or where the session
   * is placed. The conversation still shows those.
   */
  handle("detached:dev.session", async (raw) => {
    const reviewed = reviewDetachedDevSession(raw);
    if (!reviewed.ok) return { ok: false, refused: reviewed.reason };
    return relayForDetached("dev.session", async (open, call) => {
      const sessionId = open.bootstrap.live?.development?.sessionId;
      if (typeof sessionId !== "string" || sessionId === "") {
        return { ok: false, refused: "this widget is not running a widget dev session's build", code: "NO_DEV_SESSION", details: {} };
      }
      const result = await call(`/widget-dev/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" });
      if (!result.ok) return relayRefusal(result);
      if (result.body === null || typeof result.body !== "object" || Array.isArray(result.body)) {
        return { ok: false, refused: "the node's session status is not an object", code: "MALFORMED_RESPONSE", details: {} };
      }
      return { ok: true, view: redactDevSessionView(result.body) };
    });
  });

  /*
   * Files, jobs and browser tokens for the frame, each a verb of its own bound to the instance this window was opened
   * for. The window names an artifact, a job or its frame's token session, never the instance or the conversation; the
   * node checks this instance's grant on every call, as it does for the conversation's.
   */

  /** Register one file, job or token relay: reviewed, then run under the window's budget against its own instance. */
  const brokerRelay = (verb, run) =>
    handle(`detached:${verb}`, async (raw) => {
      const reviewed = reviewDetachedBrokerRequest(verb, raw);
      if (!reviewed.ok) return { ok: false, refused: reviewed.reason, code: "RELAY_REFUSED", details: {} };
      return relayForDetached(verb, (open, call) => run(open, call, reviewed.payload));
    });
  const artifactPath = (open, artifactId, rest = "") => widgetPath(open, `/artifacts/${encodeURIComponent(artifactId)}${rest}`);
  /** An answer naming an artifact: the reference the node gave, passed on. The window parses it as the shell does. */
  const refAnswer = (result) => (result.ok ? { ok: true, artifactRef: result.body?.artifactRef } : relayRefusal(result));

  /*
   * A file the person picks for the widget, in the OS dialog parented to this window. The bytes go from the disk to the
   * node without entering the renderer, and what comes back is the node's reference and the file's bare name — never
   * its path, which this process keeps for a later "replace".
   */
  brokerRelay("artifacts.pick", async (open, call, payload) => {
    const picked = await pickFileIn(open.window, payload);
    if (!picked.ok) return desktopRefusal(picked);
    if (picked.canceled) return { ok: true, canceled: true };
    const { name, mimeType, bytes } = picked.file;
    const result = await call(widgetPath(open, "/artifacts/pick"), {
      method: "POST",
      body: { accept: payload.accept ?? [], name, mimeType, contentBase64: bytes.toString("base64") },
    });
    if (!result.ok) return relayRefusal(result);
    const ref = result.body?.artifactRef;
    // Remembered as the node typed it, which is what decides whether a later file may be written over it.
    open.picked = { path: picked.path, mimeType: typeof ref?.mimeType === "string" ? ref.mimeType : mimeType };
    return { ok: true, canceled: false, artifactRef: ref, original: { name } };
  });

  brokerRelay("artifacts.describe", async (open, call, payload) =>
    refAnswer(await call(artifactPath(open, payload.artifactId), { method: "GET" })),
  );

  brokerRelay("artifacts.create", async (open, call, payload) =>
    refAnswer(await call(widgetPath(open, "/artifacts"), { method: "POST", body: payload })),
  );

  brokerRelay("artifacts.read", async (open, call, payload) => {
    const query = `?offset=${String(payload.offset)}&length=${String(payload.length)}`;
    const result = await call(artifactPath(open, payload.artifactId, `/content${query}`), { method: "GET" });
    if (!result.ok) return relayRefusal(result);
    return { ok: true, artifactRef: result.body?.artifactRef, contentBase64: result.body?.contentBase64, eof: result.body?.eof };
  });

  brokerRelay("artifacts.write", async (open, call, payload) =>
    refAnswer(
      await call(artifactPath(open, payload.artifactId, "/chunks"), {
        method: "POST",
        body: { offset: payload.offset, contentBase64: payload.chunkBase64 },
      }),
    ),
  );

  brokerRelay("artifacts.finalize", async (open, call, payload) =>
    refAnswer(await call(artifactPath(open, payload.artifactId, "/finalize"), { method: "POST", body: {} })),
  );

  /*
   * Save As, or writing back over the file the person picked in this window, in dialogs parented to it. The artifact is
   * described through this instance first, so only a file the widget was given or made can be saved; the bytes come
   * from the node to this process and go to the disk without entering the renderer.
   */
  brokerRelay("artifacts.export", async (open, call, payload) => {
    const described = await call(artifactPath(open, payload.artifactId), { method: "GET" });
    if (!described.ok) return relayRefusal(described);
    const exported = await call(`/artifacts/${encodeURIComponent(payload.artifactId)}/export`, {
      method: "POST",
      body: { suggestedName: payload.suggestedName },
      binary: true,
    });
    if (!exported.ok) return relayRefusal(exported);
    // The type the node sent the bytes as, which is what the file is named and checked by.
    const sent = exported.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const mimeType = sent === "" ? described.body?.artifactRef?.mimeType : sent;
    const review = reviewSaveDialog({
      mimeType,
      suggestedName: dispositionFilename(exported.contentDisposition) ?? payload.suggestedName,
      labels: payload.labels,
    });
    if (!review.allowed) return desktopRefusal(fileRefusal("INVALID_REQUEST"));
    if (payload.replace === true && open.picked === undefined) return desktopRefusal(fileRefusal("HANDLE_UNKNOWN"));
    const saved = await saveFileIn(open.window, review, exported.bytes, payload.replace === true ? open.picked.path : undefined);
    return saved.ok ? saved : desktopRefusal(saved);
  });

  /*
   * Offer a finalized file to the conversation. The conversation window is told, so the chip appears in its composer
   * where the person decides whether to send it; this window only learns that it was attached.
   */
  brokerRelay("artifacts.attach", async (open, call, payload) => {
    const result = await call(artifactPath(open, payload.artifactId, "/attach"), {
      method: "POST",
      body: payload.name === undefined ? {} : { name: payload.name },
    });
    if (!result.ok) return relayRefusal(result);
    const attachmentRef = result.body?.attachmentRef;
    // With the conversation it belongs to, so a shell now showing another one does not put the file in that composer.
    liveShellWindow()?.webContents.send("desktop:artifactAttached", { conversationId: open.conversationId, attachmentRef });
    return { ok: true, artifactRef: result.body?.artifactRef, attachmentRef };
  });

  brokerRelay("artifacts.discard", async (open, call, payload) => {
    const result = await call(artifactPath(open, payload.artifactId), { method: "DELETE" });
    return result.ok ? { ok: true } : relayRefusal(result);
  });

  const jobPath = (open, jobId) => widgetPath(open, `/jobs/${encodeURIComponent(jobId)}`);
  brokerRelay("jobs.get", async (open, call, payload) => {
    const result = await call(jobPath(open, payload.jobId), { method: "GET" });
    return result.ok ? { ok: true, job: result.body?.job } : relayRefusal(result);
  });
  brokerRelay("jobs.list", async (open, call) => {
    const result = await call(widgetPath(open, "/jobs"), { method: "GET" });
    return result.ok ? { ok: true, jobs: result.body?.jobs } : relayRefusal(result);
  });
  brokerRelay("jobs.cancel", async (open, call, payload) => {
    const result = await call(jobPath(open, payload.jobId), { method: "POST", body: {} });
    return result.ok ? { ok: true } : relayRefusal(result);
  });

  /*
   * A short-lived provider token for the frame mounted under `session`, offered only while the newest read declares
   * browser tokens. The host records the session it issued under, so it can end it when the window closes or the frame is
   * replaced; the value goes to the window for that frame and is kept nowhere here.
   */
  brokerRelay("tokens.request", async (open, call, payload) => {
    const declared = open.bootstrap.live?.frame?.browserTokens;
    if (!Array.isArray(declared) || declared.length === 0) {
      return { ok: false, refused: "this widget declares no browser tokens", code: "TOKEN_NOT_DECLARED", details: {} };
    }
    if (!open.tokens.admits(payload.session)) {
      return { ok: false, refused: "this window has issued tokens under too many frames", code: "TOKEN_BUSY", details: {} };
    }
    /*
     * Recorded before the call, so the session is ended with the rest even when the window closes before the node
     * answers. A token issued after that end lapses at its own expiry.
     */
    open.tokens.record(payload.session);
    const result = await call(widgetPath(open, "/browser-tokens"), {
      method: "POST",
      body: { session: payload.session, request: payload.request },
    });
    return result.ok ? { ok: true, token: result.body?.token } : relayRefusal(result);
  });

  brokerRelay("tokens.end", async (open, call, payload) => {
    const result = await call(widgetPath(open, `/browser-tokens/${encodeURIComponent(payload.session)}`), { method: "DELETE" });
    if (!result.ok) return relayRefusal(result);
    open.tokens.forget(payload.session);
    return { ok: true };
  });

  /*
   * The shell says the installed packages changed. The detached window re-reads its frame, so a widget whose package was
   * updated or removed shows what the node now serves; nothing about the change travels with the signal. A burst of
   * signals reaches the window once, after it settles, so the re-reads it causes stay inside the read budget.
   */
  const packagesChanged = relayPackagesChanged({ target: () => detached?.window });
  handle("desktop:notifyPackagesChanged", async () => {
    if (detached !== undefined) packagesChanged.signal();
    return { ok: true };
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
      responseHeaders: withContentSecurityPolicy(
        details,
        contentSecurityPolicy({ appOrigin: rendererUrl, nodeOrigin: nodeUrl, devOrigin }),
        // Read per response: without `--node-url` the node is the origin the window is served from.
        { nodeOrigin: nodeUrl ?? nodeOriginUrl },
      ),
    });
  });
}

async function createShellWindow({ show = true, url } = {}) {
  /*
   * `url` exists for the smoke test, which opens one window against its stand-in node so the detach handoff can be
   * exercised for real. Every other caller loads the app.
   */
  const document = url ?? rendererUrl;
  // Only the conversation window a person sees reopens where they left it; the smoke test's window keeps the default.
  const remembers = show && url === undefined;
  const placement = remembers ? readWindowPlacement() : undefined;
  // What was asked for and what the OS made of it, so a window nobody touched is remembered as asked rather than
  // growing by a rounding pixel at every launch on a scaled display.
  let openedAs;
  const window = new BrowserWindow({
    ...(placement?.bounds ?? { width: 1100, height: 760 }),
    // Always created hidden and shown once it has something to show: a frameless window that appears before its
    // document has painted is a blank rectangle that reads as a failure.
    show: false,
    title: "clarkcant",
    backgroundColor: "#0d1117",
    // The floor from the issue. What the window is allowed to become, not what it aims for.
    minWidth: COMPACT_MIN_SIZE.width,
    minHeight: COMPACT_MIN_SIZE.height,
    frame: !loadingClient,
    // Windows and Linux take the task bar icon from the window; macOS takes it from the Dock, set once at startup.
    icon: appIcon,
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
  /*
   * A detached widget does not outlive the conversation it came from. With the conversation window gone there is no
   * page left to hand the instance back to, so the widget window closes too and its lease is given back on the way.
   */
  window.on("closed", () => {
    if (shellWindow === window) void closeDetachedWindow();
  });
  // Recorded before the load resolves, so a call arriving with the first paint is reviewed against the document
  // this window actually loaded rather than against the previous one.
  shellDocumentUrl = document;
  // Listening before the load, not after it: `ready-to-show` fires on first paint, which for a document served over
  // http comes before `loadURL` resolves. A listener attached after the await never hears it, and the window stays
  // hidden with only a dock icon to show it exists.
  window.once("ready-to-show", () => {
    if (!show) return;
    if (placement !== undefined) openedAs = { requested: placement.bounds, actual: window.getNormalBounds() };
    if (placement?.maximized === true) window.maximize();
    window.show();
    if (placement?.fullScreen === true) window.setFullScreen(true);
  });
  if (remembers) window.on("close", () => rememberWindowPlacement(window, openedAs));

  // The chrome shows what the window is, and the OS can change that without the client asking. Attached before the
  // load, because a window reopened in full screen enters it on first paint. The full-screen events say which way
  // the window went themselves: Windows sends `leave-full-screen` while `isFullScreen()` still answers true, and a
  // chrome told that kept showing full screen over an ordinary window.
  const fullScreenAfter = { "enter-full-screen": true, "leave-full-screen": false };
  for (const event of ["enter-full-screen", "leave-full-screen", "minimize", "restore"]) {
    window.on(event, () => {
      if (window.webContents.isDestroyed()) return;
      const state = windowState(window);
      window.webContents.send("desktop:windowStateChanged", { ...state, fullScreen: fullScreenAfter[event] ?? state.fullScreen });
    });
  }
  await window.loadURL(document);

  // A window somebody dragged is the window they expect back, so a resize while expanded is remembered as the
  // size to return to. A resize during compact is the bar being moved, and remembering that as the normal size
  // would make expanding do nothing at all.
  // Only a normal window's size is the one to return to; the controller decides which resizes count.
  window.on("resize", () => windowController.noteResize(window));

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
      refusedNonBooleanFullScreen: await call("setFullScreen", "yes"),
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
      !observed.bridgeMethods.some((name) =>
        [
          "bootstrap",
          "intent",
          "release",
          "frameRead",
          "saveState",
          "publishSemantic",
          "devSession",
          "artifacts",
          "jobs",
          "tokens",
          "onPackagesChanged",
        ].includes(name),
      ),
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
    // Where the session cannot keep a window on top (native Wayland), the honest answer is a refusal and an unpinned
    // window, not a pin flag Electron set on a window nothing keeps above the others.
    observed.status?.window?.pinnable === false
      ? [
          "a pin this desktop cannot honour is refused, and the window is not reported pinned",
          observed.pinned?.ok === false && observed.status.window.alwaysOnTop === false,
        ]
      : [
          "always on top is reported by the window, not by the model",
          observed.pinned?.ok === true && observed.pinned.alwaysOnTop === true && pinnedNow === true,
        ],
    [
      "the status names the window backend and the desktop session it chose",
      typeof observed.status?.window?.backend === "string" && typeof observed.status?.window?.session === "string",
    ],
    ["a window mode this build does not know is refused", observed.refusedUnknownMode?.ok === false],
    ["a full-screen request that is not a boolean is refused", observed.refusedNonBooleanFullScreen?.ok === false],
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
    // Compiler output checked for drift by the desktop unit tests; fixture data is loaded only in smoke mode.
    const appearance = JSON.parse(readFileSync(join(here, "../test/fixtures/appearance.json"), "utf8"));
    shellDocumentUrl = node.url;
    nodeOriginUrl = node.url;
    nodeIdentityOverride = "smoke-token-not-a-credential";
    step = "open a shell against the stand-in";
    detachShell = await createShellWindow({ show: false, url: node.url });
    step = "install the reattach listener";
    await detachShell.webContents.executeJavaScript(
      "window.__reattached = []; window.__reattachedAt = []; " +
        "window.clarkcant.onWidgetReattached((payload) => { window.__reattached.push(payload); window.__reattachedAt.push(Date.now()); }); " +
        "window.__attached = []; window.clarkcant.onArtifactAttached((payload) => { window.__attached.push(payload); }); true",
    );

    /*
     * An isolated widget is a document the node serves into a sandboxed frame. The window's policy has to let the node
     * be framed, and has to leave the framed document's own policy alone; either mistake leaves the frame blank, and
     * only a real Chromium applying the real headers can tell.
     */
    step = "frame a widget document the stand-in serves";
    const framed = await detachShell.webContents.executeJavaScript(`new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      const timer = setTimeout(() => resolve({ loaded: false }), 3000);
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || event.data?.smokeFrame !== "ready") return;
        clearTimeout(timer);
        resolve({ loaded: true });
      });
      frame.src = ${JSON.stringify(SMOKE_FRAME_PATH)};
      document.body.append(frame);
    })`);
    checks.push(["an isolated widget document served by the node loads and runs in the window", framed?.loaded === true]);

    // Seconds rather than the production half minute, so a refresh and a refused refresh both happen in this run.
    detachedLeaseRefreshMs = 150;
    step = "ask the host to detach";
    const detachRequest = {
      conversationId: "conv_smoke",
      instanceId: "widget_smoke",
      title: "Bang dieu khien",
      appearance: appearance.initial,
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
    };
    const askToDetach = () =>
      detachShell.webContents.executeJavaScript(`window.clarkcant.detachWidget(${JSON.stringify(detachRequest)})`);
    const asked = await askToDetach();

    step = "read the claim the node was asked for";
    const claim = node.calls.find((call) => call.method === "POST");
    const opened = detached?.window;
    const ownerToken = detached?.ownerToken;
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
    // The file, job and token verbs, one function each: no generic call among them.
    const brokerVerbs =
      opened === undefined
        ? []
        : await opened.webContents.executeJavaScript(
            "(() => { const bridge = window.clarkcantDetached ?? {}; " +
              "return ['artifacts', 'jobs', 'tokens'].flatMap((group) => Object.entries(bridge[group] ?? {})" +
              ".map(([name, value]) => `${group}.${name}:${typeof value}`)).sort(); })()",
          );

    step = "subscribe to the detached appearance relay";
    await opened.webContents.executeJavaScript(
      "window.__appearanceEvents = []; window.__stopAppearance = window.clarkcantDetached.onAppearance(" +
      "value => window.__appearanceEvents.push(value)); true",
    );
    step = "send the checked appearance through the shell bridge";
    const updated = await detachShell.webContents.executeJavaScript(
      `window.clarkcant.updateAppearance(${JSON.stringify(appearance.next)})`,
    );
    let events = [];
    for (let attempt = 0; attempt < 40 && events.length === 0; attempt += 1) {
      events = await opened.webContents.executeJavaScript("window.__appearanceEvents");
      if (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const repeated = await detachShell.webContents.executeJavaScript(
      `window.clarkcant.updateAppearance(${JSON.stringify(appearance.next)})`,
    );
    const refused = await detachShell.webContents.executeJavaScript(
      `window.clarkcant.updateAppearance(${JSON.stringify({ ...appearance.next, rawTheme: {} })})`,
    );
    const latest = await opened.webContents.executeJavaScript("window.clarkcantDetached.bootstrap()");
    const initialEvents = events;
    const expectedEvents = [appearance.next];
    const referenceAppearance = JSON.parse(readFileSync(join(here, "../test/fixtures/reference-appearance.json"), "utf8"));
    for (const reference of referenceAppearance) {
      step = `relay ${reference.name} ${reference.scheme} reduced=${reference.reducedMotion}`;
      const result = await detachShell.webContents.executeJavaScript(
        `window.clarkcant.updateAppearance(${JSON.stringify(reference.appearance)})`,
      );
      expectedEvents.push(reference.appearance);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        events = await opened.webContents.executeJavaScript("window.__appearanceEvents");
        if (events.length === expectedEvents.length) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const current = await opened.webContents.executeJavaScript("window.clarkcantDetached.bootstrap()");
      checks.push([`the real detached relay retains ${reference.name} ${reference.scheme} reduced=${reference.reducedMotion}`,
        result?.ok === true && detached?.window === opened &&
        JSON.stringify(events) === JSON.stringify(expectedEvents) &&
        JSON.stringify(current?.bootstrap?.appearance) === JSON.stringify(reference.appearance)]);
    }
    await opened.webContents.executeJavaScript("window.__stopAppearance(); true");
    await detachShell.webContents.executeJavaScript(
      `window.clarkcant.updateAppearance(${JSON.stringify(appearance.initial)})`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    events = await opened.webContents.executeJavaScript("window.__appearanceEvents");
    checks.push(
      ["the initial detached snapshot is the exact host revision", JSON.stringify(bootstrap?.bootstrap?.appearance) === JSON.stringify(appearance.initial)],
      ["the live relay delivers one checked revision without reopening the window", updated?.ok === true && repeated?.ok === true &&
        detached?.window === opened && JSON.stringify(initialEvents) === JSON.stringify([appearance.next])],
      ["the updated bootstrap retains that same appearance revision", JSON.stringify(latest?.bootstrap?.appearance) === JSON.stringify(appearance.next)],
      ["a raw theme is refused before reaching the detached window", refused?.ok === false],
      ["unsubscribing also stops reference appearance events", JSON.stringify(events) === JSON.stringify(expectedEvents)],
    );

    step = "wait for the host to refresh the detached lease";
    const sameOwnerClaims = () =>
      node.calls.filter((call) => call.method === "POST" && call.body["ownerToken"] === ownerToken && ownerToken !== undefined);
    for (let attempt = 0; attempt < 40 && sameOwnerClaims().length < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const refreshes = sameOwnerClaims();

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
          bootstrapKeys === JSON.stringify(["appearance", "instanceRef", "live", "title", "widgetKind"]) &&
          !JSON.stringify(bootstrap.bootstrap).includes("localToken"),
      ],
      [
        "the detached window reaches only its own verbs and read-only appearance subscription",
        JSON.stringify(verbs) ===
          JSON.stringify([
            "artifacts",
            "bootstrap",
            "devSession",
            "frameRead",
            "intent",
            "jobs",
            "onAppearance",
            "onPackagesChanged",
            "publishSemantic",
            "release",
            "saveState",
            "tokens",
          ]),
      ],
      [
        "the detached window's file, job and token verbs are exactly the relays the host answers",
        JSON.stringify(brokerVerbs) === JSON.stringify(BROKER_RELAY_VERBS.map((verb) => `${verb}:function`).sort()),
      ],
      ["closing the window gives the lease back", release !== undefined],
      ["and the shell is told to take the instance back", Array.isArray(reattached) && reattached.length === 1],
      [
        "the detached claim asks for the conversation's lease length",
        claim !== undefined && claim.body["leaseMs"] === DETACHED_LEASE.leaseMs,
      ],
      [
        "the host keeps refreshing the detached lease with the same owner while the window is open",
        refreshes.length >= 3 && refreshes.every((call) => call.body["surface"] === "detached"),
      ],
    );

    /*
     * A refresh the node refuses because another surface holds the instance now: the window no longer owns what it
     * shows, so the host closes it and the conversation is told to take the widget back.
     */
    step = "detach again, then lose the lease to another surface";
    const askedAgain = await askToDetach();
    const second = detached?.window;
    node.control.refuseClaims = true;
    for (let attempt = 0; attempt < 40 && second !== undefined && !second.isDestroyed(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    node.control.refuseClaims = false;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const reattachedAfterLoss = await detachShell.webContents.executeJavaScript("window.__reattached");
    checks.push([
      "a refresh refused as owned elsewhere closes the detached window and hands the widget back",
      askedAgain?.ok === true && second !== undefined && second.isDestroyed() && detached === undefined &&
        Array.isArray(reattachedAfterLoss) && reattachedAfterLoss.length === 2,
    ]);

    /*
     * A widget in its own frame, detached. The window holds no credential, so every request its frame makes is a relay
     * the host performs: this drives each one from the real detached renderer against the stand-in, and checks what
     * reached the node — the bound path, the host's bearer and nobody else's, the composer mark on a press only.
     */
    step = "detach a widget that runs in its own frame";
    const frameRequest = {
      conversationId: "conv_smoke",
      instanceId: "widget_frame_smoke",
      title: "Bo dem",
      appearance: appearance.initial,
      live: {
        kind: "isolated-frame",
        instanceId: "widget_frame_smoke",
        revision: 1,
        readOnly: false,
        frame: {
          url: `${SMOKE_FRAME_PATH}?grant=shell`,
          document: "build-1",
          isolation: "sandboxed-frame",
          grantedCapabilities: [],
          allowedOrigins: [],
        },
        bindings: [{ actionBindingId: "refresh", label: "Refresh", effectCategory: "read", bindingDigest: "sha256:smoke-binding" }],
        props: {},
        stateRevision: 0,
        stateVersion: 1,
        state: {},
        stateStatus: { kind: "writable" },
        ephemeralStateKeys: [],
        development: { sessionId: "dev_smoke" },
      },
    };
    const askedFrame = await detachShell.webContents.executeJavaScript(
      `window.clarkcant.detachWidget(${JSON.stringify(frameRequest)})`,
    );
    const frameWindow = detached?.window;
    const inFrameWindow = (script) =>
      frameWindow === undefined || frameWindow.isDestroyed()
        ? Promise.resolve(undefined)
        : frameWindow.webContents.executeJavaScript(script);
    step = "read the frame through the host";
    const frameRead = await inFrameWindow("window.clarkcantDetached.frameRead()");
    const frameUrl = frameRead?.live?.frame?.url;
    step = "mount the frame the read named in the detached window";
    const frameMounted =
      typeof frameUrl !== "string"
        ? { loaded: false }
        : await inFrameWindow(`new Promise((resolve) => {
            const frame = document.createElement("iframe");
            frame.setAttribute("sandbox", "allow-scripts");
            const timer = setTimeout(() => resolve({ loaded: false }), 3000);
            window.addEventListener("message", (event) => {
              if (event.source !== frame.contentWindow || event.data?.smokeFrame !== "ready") return;
              clearTimeout(timer);
              resolve({ loaded: true });
            });
            frame.src = ${JSON.stringify(frameUrl)};
            document.body.append(frame);
          })`);
    step = "relay a state write, a semantic publish and a press";
    const saved = await inFrameWindow("window.clarkcantDetached.saveState({ expectedRevision: 0, patch: { count: 1 } })");
    const foreign = await inFrameWindow(
      "window.clarkcantDetached.saveState({ conversationId: 'conv_other', expectedRevision: 1, patch: { count: 2 } })",
    );
    const published = await inFrameWindow("window.clarkcantDetached.publishSemantic({ proposal: { summary: 'Counting to one' } })");
    const pressed = await inFrameWindow(
      "window.clarkcantDetached.intent({ instanceRef: 'widget_frame_smoke', actionBindingId: 'refresh', expectedRevision: 1, input: {}, invocationId: 'inv_smoke_frame' })",
    );
    step = "ask for a browser token under the first build's frame session";
    const tokenRequest = { provider: "example.maps", scopes: ["tiles:read"] };
    const firstSession = "smoke_session_build_one";
    const firstToken = await inFrameWindow(
      `window.clarkcantDetached.tokens.request(${JSON.stringify({ session: firstSession, request: tokenRequest })})`,
    );
    const namedInstance = await inFrameWindow(
      `window.clarkcantDetached.tokens.request(${JSON.stringify({ session: "smoke_session_foreign", request: tokenRequest, instanceId: "widget_other" })})`,
    );
    step = "read the dev session, start a new build, and read both again";
    const devBefore = await inFrameWindow("window.clarkcantDetached.devSession()");
    node.control.build = 2;
    const devAfter = await inFrameWindow("window.clarkcantDetached.devSession()");
    const reread = await inFrameWindow("window.clarkcantDetached.frameRead()");
    const tokenEnds = (session) =>
      node.relays.filter((call) => call.method === "DELETE" && call.path.endsWith(`/browser-tokens/${session}`));
    const firstEndedOnNewBuild = tokenEnds(firstSession).length === 1;

    /*
     * Files and jobs, relayed. The OS dialogs are stood in for — a smoke run has nobody to answer them — and record the
     * window they were parented to, which must be the detached one rather than the conversation's.
     */
    step = "relay the frame's files, with the OS dialogs stood in for";
    const realDialogs = { open: dialog.showOpenDialog, save: dialog.showSaveDialog, box: dialog.showMessageBox };
    const dialogParents = [];
    const scratch = join(tmpdir(), `clarkcant-smoke-${randomUUID()}`);
    mkdirSync(scratch, { recursive: true });
    const pickedPath = join(scratch, "picked.txt");
    const savedPath = join(scratch, "saved.txt");
    writeFileSync(pickedPath, "picked");
    let files = {};
    try {
      dialog.showOpenDialog = async (parent) => {
        dialogParents.push(parent);
        return { canceled: false, filePaths: [pickedPath] };
      };
      dialog.showSaveDialog = async (parent) => {
        dialogParents.push(parent);
        return { canceled: false, filePath: savedPath };
      };
      dialog.showMessageBox = async (parent) => {
        dialogParents.push(parent);
        return { response: 1 };
      };
      const bridge = (script) => inFrameWindow(`window.clarkcantDetached.${script}`);
      files = {
        picked: await bridge("artifacts.pick({ accept: ['text/plain'] })"),
        created: await bridge("artifacts.create({ mimeType: 'text/plain', name: 'notes.txt' })"),
        written: await bridge("artifacts.write({ artifactId: 'art_smoke_made', offset: 0, chunkBase64: 'aGVsbG8=' })"),
        finalized: await bridge("artifacts.finalize({ artifactId: 'art_smoke_made' })"),
        read: await bridge("artifacts.read({ artifactId: 'art_smoke_made', offset: 0, length: 5 })"),
        described: await bridge("artifacts.describe({ artifactId: 'art_smoke_made' })"),
        exported: await bridge("artifacts.export({ artifactId: 'art_smoke_made', suggestedName: 'notes.txt' })"),
        replaced: await bridge("artifacts.export({ artifactId: 'art_smoke_made', suggestedName: 'notes.txt', replace: true })"),
        attached: await bridge("artifacts.attach({ artifactId: 'art_smoke_made' })"),
        discarded: await bridge("artifacts.discard({ artifactId: 'art_smoke_made' })"),
        pathNamed: await bridge("artifacts.read({ artifactId: '../../etc/passwd', offset: 0, length: 5 })"),
        job: await bridge("jobs.get({ jobId: 'job_smoke' })"),
        jobs: await bridge("jobs.list()"),
        cancelled: await bridge("jobs.cancel({ jobId: 'job_smoke' })"),
        savedBytes: readFileSync(savedPath, "utf8"),
        pickedBytes: readFileSync(pickedPath, "utf8"),
      };
    } finally {
      dialog.showOpenDialog = realDialogs.open;
      dialog.showSaveDialog = realDialogs.save;
      dialog.showMessageBox = realDialogs.box;
      rmSync(scratch, { recursive: true, force: true });
    }
    let attachedInShell = [];
    for (let attempt = 0; attempt < 40 && attachedInShell.length === 0; attempt += 1) {
      attachedInShell = await detachShell.webContents.executeJavaScript("window.__attached");
      if (attachedInShell.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    step = "ask for a browser token under the new build's frame session";
    const secondSession = "smoke_session_build_two";
    const secondToken = await inFrameWindow(
      `window.clarkcantDetached.tokens.request(${JSON.stringify({ session: secondSession, request: tokenRequest })})`,
    );
    step = "look for a credential in the detached window";
    const heldInWindow = await inFrameWindow(
      "JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie })",
    );
    step = "read faster than the host relays";
    // One after another, so it is the per-verb rate that refuses and not the cap on calls in flight.
    const burst = await inFrameWindow(
      "(async () => { const out = []; for (let i = 0; i < 14; i += 1) out.push(await window.clarkcantDetached.frameRead()); return out; })()",
    );

    const frameRelays = node.relays.filter((call) => call.path.includes("widget_frame_smoke") || call.path.startsWith("/widget-dev/"));
    const relayed = (suffix) => frameRelays.find((call) => call.method === "POST" && call.path.endsWith(suffix));
    const statePosts = frameRelays.filter((call) => call.method === "POST" && call.path.endsWith("/state"));
    const answers = JSON.stringify([frameRead, saved, published, pressed, devBefore, devAfter, reread, burst]);
    checks.push(
      ["a widget that runs in its own frame opens in its own window", askedFrame?.ok === true && frameWindow !== undefined],
      [
        "the host reads the frame for the window, with a fresh grant on the node's own origin",
        frameRead?.ok === true &&
          typeof frameUrl === "string" &&
          frameUrl.startsWith(node.url) &&
          !frameUrl.includes("grant=shell"),
      ],
      ["the frame the read named loads and runs in the detached window", frameMounted?.loaded === true],
      [
        "every relay reaches only the bound instance's routes",
        frameRelays.length > 0 &&
          frameRelays.every(
            (call) => call.path.startsWith("/conversations/conv_smoke/widgets/widget_frame_smoke/") || call.path === "/widget-dev/sessions/dev_smoke",
          ),
      ],
      [
        "the bearer reaches the node from the host only, and never the detached window",
        frameRelays.every((call) => call.authorization === `Bearer ${nodeIdentityOverride}`) &&
          !answers.includes(String(nodeIdentityOverride)) &&
          typeof heldInWindow === "string" &&
          !heldInWindow.includes(String(nodeIdentityOverride)),
      ],
      [
        "a state write the frame made is committed by the node and answered to the window",
        saved?.ok === true && saved.saved?.stateRevision === 1 && relayed("/state")?.surface === undefined,
      ],
      [
        "a relay that names another conversation is refused, and the node never hears of it",
        foreign?.ok === false && statePosts.length === 1 && !node.relays.some((call) => call.path.includes("conv_other")),
      ],
      ["what the frame shows is relayed without a surface mark", published?.ok === true && relayed("/semantic")?.surface === undefined],
      [
        "a press is relayed as the person's, with the frame's own key and the digest the host resolved",
        pressed?.ok === true &&
          relayed("/actions")?.surface === "composer" &&
          relayed("/actions")?.body["invocationId"] === "inv_smoke_frame" &&
          relayed("/actions")?.body["expectedBindingDigest"] === "sha256:smoke-binding",
      ],
      [
        "the dev session's status reaches the window without the developer's folder",
        devBefore?.ok === true &&
          devBefore.view?.running?.generation === 1 &&
          !("root" in devBefore.view) &&
          !("placed" in devBefore.view) &&
          !JSON.stringify(devBefore.view).includes("private-widget") &&
          devBefore.view.lastBuild?.diagnostics?.[0]?.message === "./src/main.ts:3:7: Expected \";\"",
      ],
      [
        "a new build is seen through the relays: the session's running digest and the frame's document both move",
        devAfter?.ok === true &&
          devAfter.view?.running?.digest === "sha256:build-2" &&
          reread?.ok === true &&
          reread.live?.frame?.document === "build-2",
      ],
      [
        "reads faster than the host relays are refused rather than queued",
        Array.isArray(burst) && burst.some((answer) => answer?.ok === false && answer.code === "RELAY_RATE_LIMITED"),
      ],
      [
        "a browser token is relayed for the frame's session, and a request naming an instance is refused unsent",
        firstToken?.ok === true &&
          firstToken.token?.token === "smoke-browser-token" &&
          namedInstance?.ok === false &&
          !node.relays.some((call) => JSON.stringify(call.body).includes("smoke_session_foreign")),
      ],
      ["a read showing a new build ends the token session the old frame was issued under", firstEndedOnNewBuild],
      [
        "a pick opens the OS dialog over the detached window, and the window gets the node's reference and no path",
        files.picked?.ok === true &&
          files.picked.artifactRef?.artifactId === "art_smoke_picked" &&
          files.picked.original?.name === "picked.txt" &&
          !JSON.stringify(files.picked).includes(scratch) &&
          dialogParents.length > 0 &&
          dialogParents.every((parent) => parent === frameWindow),
      ],
      [
        "the frame's file reads, writes and attaches are relayed to the bound instance's artifact routes",
        files.created?.artifactRef?.artifactId === "art_smoke_made" &&
          files.written?.ok === true &&
          files.finalized?.artifactRef?.kind === "finalized" &&
          files.read?.contentBase64 === Buffer.from("hello").toString("base64") &&
          files.read?.eof === true &&
          files.described?.ok === true &&
          files.discarded?.ok === true &&
          files.pathNamed?.ok === false,
      ],
      [
        "an export is saved by the host, as Save As and over the file the person picked, without the bytes entering the window",
        files.exported?.ok === true &&
          files.exported.saved === true &&
          files.replaced?.ok === true &&
          files.replaced.saved === true &&
          files.savedBytes === "hello" &&
          files.pickedBytes === "hello" &&
          !JSON.stringify([files.exported, files.replaced]).includes(scratch),
      ],
      [
        "a file the frame attaches appears in the conversation window's composer, not only in the detached window",
        files.attached?.ok === true &&
          Array.isArray(attachedInShell) &&
          attachedInShell.length === 1 &&
          attachedInShell[0]?.conversationId === "conv_smoke" &&
          attachedInShell[0]?.attachmentRef?.attachmentId === "att_smoke",
      ],
      [
        "the frame's jobs are read and cancelled through the host",
        files.job?.job?.jobId === "job_smoke" && Array.isArray(files.jobs?.jobs) && files.cancelled?.ok === true,
      ],
    );

    step = "close the frame's window";
    const releasesBefore = node.calls.filter((call) => call.method === "DELETE").length;
    const reattachedBefore = (await detachShell.webContents.executeJavaScript("window.__reattachedAt")).length;
    frameWindow?.close();
    for (let attempt = 0; attempt < 40 && detached !== undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const frameRelease = node.calls.filter((call) => call.method === "DELETE")[releasesBefore];
    const reattachedAt = (await detachShell.webContents.executeJavaScript("window.__reattachedAt"))[reattachedBefore];
    const secondEnded = tokenEnds(secondSession)[0];
    checks.push(
      [
        "closing the frame's window gives the lease back before the conversation is told to take the widget back",
        frameRelease !== undefined && typeof reattachedAt === "number" && frameRelease.at <= reattachedAt,
      ],
      [
        "closing the frame's window ends its token session after the lease is given back and before the widget goes back",
        secondToken?.ok === true &&
          secondEnded !== undefined &&
          frameRelease !== undefined &&
          frameRelease.at <= secondEnded.at &&
          typeof reattachedAt === "number" &&
          secondEnded.at <= reattachedAt &&
          tokenEnds(firstSession).length === 1,
      ],
    );

    // The conversation window closing takes the detached window with it, and the lease is given back on the way.
    step = "detach a third time, then close the conversation window";
    const askedThird = await askToDetach();
    const third = detached?.window;
    const thirdOwner = detached?.ownerToken;
    detachShell.close();
    for (let attempt = 0; attempt < 40 && third !== undefined && !third.isDestroyed(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    checks.push([
      "closing the conversation window closes the detached window and gives its lease back",
      askedThird?.ok === true && third !== undefined && third.isDestroyed() && detached === undefined &&
        node.calls.some((call) => call.method === "DELETE" && call.body["ownerToken"] === thirdOwner),
    ]);
  } catch (error) {
    checks.push([
      `the detached-window phase ran to the end (it threw while trying to ${step}: ${
        error instanceof Error ? error.message : String(error)
      })`,
      false,
    ]);
  } finally {
    if (detachShell !== undefined && !detachShell.isDestroyed()) detachShell.close();
    detachedLeaseRefreshMs = DETACHED_LEASE.refreshMs;
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
  if (process.platform === "darwin") app.dock?.setIcon(appIcon);
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

/*
 * Quitting closes the detached window first and waits (bounded) for its lease to be given back, so the instance is
 * not left held by a window that no longer exists until the lease lapses.
 */
let quittingAfterDetachedRelease = false;
app.on("before-quit", (event) => {
  if (detached === undefined || quittingAfterDetachedRelease) return;
  event.preventDefault();
  quittingAfterDetachedRelease = true;
  void closeDetachedWindow().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  // Deliberately not quitting on macOS unless the user said so: a window closing is a UI event,
  // and work already running is not a UI event.
  if (!keepRunningOnWindowClose && process.platform !== "darwin") app.quit();
});
