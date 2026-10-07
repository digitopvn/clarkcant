/**
 * The semantic window controller: what the conversation asks the window to be, separated from how a desktop does it.
 *
 * The renderer speaks only in intents (`normal`, `expanded`, `compact`, `orb`, pin, focus, minimize, full screen).
 * A backend turns those into window-system requests and answers with the state the window actually has afterwards,
 * read back rather than echoed, plus which parts of its request can take effect (`applied`) and which parts this
 * session cannot honour at all (`unsupported`). An unsupported part is never reported as done: a refused pin is never
 * sent, and a position the compositor ignores is listed as unsupported, so the UI never shows geometry or a pin that
 * did not happen.
 *
 * Backends:
 * - `createElectronGeometryController` (this file): Electron's own bounds and stacking. Full on macOS, Windows and X11;
 *   under native Wayland it still sends full bounds through `setBounds`, which Electron applies as a size only (the
 *   compositor owns placement), so `applied` lists only the size, position is reported unsupported, and a pin is
 *   refused without being sent.
 * - `createHyprlandWindowController` (`hyprland-window-controller.mjs`): Hyprland IPC, opt-in, unverified on a real
 *   compositor, wrapped in `withFallbackController` so any IPC failure degrades to Electron geometry.
 *
 * Every backend has the same methods, answering `{ ok: true, ...WindowState }` or `{ ok: false, refused }`:
 *   setMode(mode, options?)  setPinned(value)  focus()  minimize()  setFullscreen(value)
 *   restore()  restoreIfCollapsed()  resizePreset(name)  snapshot()
 * and three synchronous ones the main process needs between requests:
 *   currentMode()  collapsedNormalBounds()  noteResize(window)
 */

import {
  WINDOW_MODE_PRESETS,
  actionForMode,
  fitIntoWorkArea,
  initialWindowMode,
  nextWindowMode,
} from "./window-mode.mjs";
import { FULL_GEOMETRY } from "./window-session.mjs";

/**
 * The window methods a controller uses: a structural slice of Electron's `BrowserWindow`, so a test can hand in a
 * stand-in and the contract says exactly what a backend may touch.
 *
 * @typedef {object} ControlledWindow
 * @property {() => { x: number, y: number, width: number, height: number }} getBounds
 * @property {(bounds: { x: number, y: number, width: number, height: number }) => void} setBounds
 * @property {() => number[]} getMinimumSize
 * @property {() => boolean} isAlwaysOnTop
 * @property {(value: boolean) => void} setAlwaysOnTop
 * @property {() => boolean} isFocused
 * @property {() => void} focus
 * @property {() => boolean} isMinimized
 * @property {() => void} minimize
 * @property {() => void} restore
 * @property {() => boolean} isMinimizable
 * @property {() => boolean} isFullScreen
 * @property {() => boolean} isFullScreenable
 * @property {(value: boolean) => void} setFullScreen
 * @property {() => string} getTitle
 * @property {(event: string, listener: () => void) => unknown} once
 * @property {(event: string, listener: () => void) => unknown} removeListener
 */

/**
 * What every controller verb answers: the window's state afterwards, or a refusal with its reason.
 *
 * @typedef {{ ok: false, refused: string } | ({ ok: true } & Record<string, unknown>)} WindowAnswer
 */

/**
 * The semantic controller every backend implements.
 *
 * @typedef {object} DesktopWindowController
 * @property {string} backend
 * @property {{ position: boolean, alwaysOnTop: boolean }} support
 * @property {(mode: unknown, options?: { exitFullScreen?: boolean, reassertPin?: boolean }) => Promise<WindowAnswer>} setMode
 * @property {(value: unknown) => Promise<WindowAnswer>} setPinned
 * @property {() => Promise<WindowAnswer>} focus
 * @property {() => Promise<WindowAnswer>} minimize
 * @property {(value: unknown) => Promise<WindowAnswer>} setFullscreen
 * @property {() => Promise<WindowAnswer>} restore
 * @property {() => Promise<WindowAnswer>} restoreIfCollapsed
 * @property {(name: unknown) => Promise<WindowAnswer>} resizePreset
 * @property {() => Promise<Record<string, unknown> | undefined>} snapshot
 * @property {() => string} currentMode
 * @property {() => { x: number, y: number, width: number, height: number } | undefined} collapsedNormalBounds
 * @property {(window: ControlledWindow) => void} noteResize
 */

/** Why a position is not requested under native Wayland. Shared so every answer says it the same way. */
export const POSITION_UNSUPPORTED = Object.freeze({
  part: "position",
  reason: "this desktop session (native Wayland) decides where windows go, so the app cannot place its own window",
});

/** Why a pin is refused under native Wayland. */
export const PIN_UNSUPPORTED = Object.freeze({
  part: "pin",
  reason: "this desktop session (native Wayland) has no way for an app to keep its window above others",
});

/** A refusal, in the shape every desktop channel answers with. */
export function refuse(reason) {
  return { ok: false, refused: reason };
}

/**
 * The window's state, read off the Electron window.
 *
 * Every field is observed rather than computed from the request: the OS may clamp a size or a position, and a shell
 * that echoed what it asked for could not tell that apart from what happened. `alwaysOnTop` is reported `false` where
 * the session cannot keep a window on top, because Electron keeps its own flag there whether or not anything honoured
 * it, and a pin button lit by that flag would be fake state.
 *
 * @param {ControlledWindow} window
 * @param {{ backend: string, mode: string | null, support: { alwaysOnTop: boolean }, applied?: string[], unsupported?: { part: string, reason: string }[] }} input
 */
export function electronWindowState(window, { backend, mode, support, applied = [], unsupported = [] }) {
  return {
    ok: true,
    backend,
    mode,
    bounds: window.getBounds(),
    minimumSize: window.getMinimumSize(),
    alwaysOnTop: support.alwaysOnTop ? window.isAlwaysOnTop() : false,
    focused: window.isFocused(),
    fullScreen: window.isFullScreen(),
    minimized: window.isMinimized(),
    applied,
    unsupported,
  };
}

/**
 * Enter or leave full screen and wait until the window says it has.
 *
 * On macOS the change is an animated move into its own Space, and `isFullScreen()` read straight after the call still
 * answers the old value. Waiting for the window's own event is what lets the answer be what happened rather than what
 * was asked. The wait is bounded, so a window manager that never sends the event costs a moment rather than a hung
 * request, and the answer is then whatever the window reports.
 */
export async function applyFullScreen(window, value, settleMs = 1500) {
  if (window.isFullScreen() === value) return;
  const settled = new Promise((resolve) => {
    const event = value ? "enter-full-screen" : "leave-full-screen";
    const timer = setTimeout(done, settleMs);
    function done() {
      clearTimeout(timer);
      window.removeListener(event, done);
      resolve();
    }
    window.once(event, done);
  });
  window.setFullScreen(value);
  await settled;
}

/**
 * The Electron geometry backend: today's behaviour on macOS, Windows and X11, unchanged.
 *
 * Holds the remembered mode for the life of the app rather than of one window, as the shell always has: a renderer
 * comes and goes, and a reload must not move the window back to its expanded size.
 *
 * @param {{
 *   getWindow: () => ControlledWindow | undefined,
 *   workAreaFor: (window: ControlledWindow) => { x: number, y: number, width: number, height: number },
 *   support?: { position: boolean, alwaysOnTop: boolean },
 *   settleMs?: number,
 * }} input
 * @returns {DesktopWindowController}
 */
export function createElectronGeometryController({ getWindow, workAreaFor, support = FULL_GEOMETRY, settleMs }) {
  const backend = "electron-geometry";
  /** `undefined` until the first request or resize, when it is learned from the window rather than assumed. */
  let model;

  /** What a geometry change asks for in this session. */
  const geometryParts = support.position
    ? { applied: ["size", "position"], unsupported: [] }
    : { applied: ["size"], unsupported: [POSITION_UNSUPPORTED] };

  function ensureModel(window) {
    if (model === undefined) model = initialWindowMode({ bounds: window.getBounds(), workArea: workAreaFor(window) });
  }

  function step(window, action) {
    model = nextWindowMode({ ...model, workArea: workAreaFor(window) }, action);
  }

  function state(window, parts = { applied: [], unsupported: [] }) {
    return electronWindowState(window, { backend, mode: model?.mode ?? null, support, ...parts });
  }

  return {
    backend,
    support,

    /**
     * Become one of the four modes.
     *
     * `exitFullScreen` and `reassertPin` keep the older compact channel exactly as it was: it leaves full screen first
     * (a full-screen window ignores new bounds, so the bar would never appear) and puts the remembered pin back.
     */
    async setMode(mode, { exitFullScreen = false, reassertPin = false } = {}) {
      const window = getWindow();
      if (window === undefined) return refuse("there is no window to resize");
      const action = actionForMode(mode);
      // Refused rather than coerced into `normal`: silently growing a window somebody asked to shrink is worse than not
      // moving it.
      if (action === undefined) return refuse(`"${String(mode)}" is not a window mode this build knows`);
      if (exitFullScreen) await applyFullScreen(window, false, settleMs);
      ensureModel(window);
      step(window, action);
      // Full bounds on every platform. Under native Wayland Electron applies only the size and ignores x/y, which is
      // why `geometryParts` then lists position as unsupported rather than applied.
      window.setBounds(model.bounds);
      if (reassertPin && support.alwaysOnTop) window.setAlwaysOnTop(model.alwaysOnTop);
      return state(window, geometryParts);
    },

    async setPinned(value) {
      const window = getWindow();
      if (window === undefined) return refuse("there is no window to resize");
      if (typeof value !== "boolean") return refuse("pinned must be true or false");
      if (!support.alwaysOnTop) return refuse(`${PIN_UNSUPPORTED.reason}; the window was left as it was`);
      ensureModel(window);
      step(window, { type: "set-always-on-top", value });
      window.setBounds(model.bounds);
      window.setAlwaysOnTop(model.alwaysOnTop);
      return state(window, { applied: ["pin"], unsupported: [] });
    },

    async focus() {
      const window = getWindow();
      if (window === undefined) return refuse("there is no window to focus");
      if (window.isMinimized()) window.restore();
      window.focus();
      return state(window, { applied: ["focus"], unsupported: [] });
    },

    async minimize() {
      const window = getWindow();
      if (window === undefined) return refuse("there is no window to minimize");
      if (!window.isMinimizable()) return refuse("this window cannot be minimized");
      window.minimize();
      return state(window, { applied: ["minimize"], unsupported: [] });
    },

    /**
     * Take the whole screen, or give it back. Entering it from the bar or the orb grows the conversation first,
     * because a full-screen voice bar is a very large empty strip.
     */
    async setFullscreen(value) {
      if (typeof value !== "boolean") return refuse("full screen must be true or false");
      const window = getWindow();
      if (window === undefined) return refuse("there is no window to resize");
      if (!window.isFullScreenable()) return refuse("this window cannot go full screen");
      if (value && model !== undefined && model.mode !== "normal") {
        step(window, { type: "expand" });
        window.setBounds(model.bounds);
      }
      await applyFullScreen(window, value, settleMs);
      return state(window, { applied: ["fullscreen"], unsupported: [] });
    },

    /** Back to the size and place the window had before it was collapsed. */
    async restore() {
      const window = getWindow();
      if (window === undefined) return refuse("there is no window to restore");
      if (model === undefined) {
        return refuse("this window has not been moved by the shell yet, so there is nothing to restore");
      }
      step(window, { type: "expand" });
      window.setBounds(model.bounds);
      return state(window, geometryParts);
    },

    /**
     * Before a notification's click focuses the window: only the bar and the orb count as collapsed. `expanded` is
     * still the conversation, just given more room, so a click there leaves it alone.
     */
    async restoreIfCollapsed() {
      const window = getWindow();
      if (window === undefined) return refuse("there is no window to restore");
      if (model === undefined || (model.mode !== "compact" && model.mode !== "orb")) return state(window);
      step(window, { type: "expand" });
      window.setBounds(model.bounds);
      return state(window, geometryParts);
    },

    /** A named size with the mode left alone: a mode is what the window is for, a preset is how big it is. */
    async resizePreset(name) {
      const window = getWindow();
      if (window === undefined) return refuse("there is no window to resize");
      const preset = WINDOW_MODE_PRESETS[String(name)];
      if (preset === undefined) return refuse(`"${String(name)}" is not a size preset this build knows`);
      const current = window.getBounds();
      window.setBounds(
        fitIntoWorkArea({ x: current.x, y: current.y, width: preset.width, height: preset.height }, workAreaFor(window)),
      );
      return state(window, geometryParts);
    },

    /** What the chrome needs on mount, read off the window. `pinnable` hides a pin this session cannot honour. */
    async snapshot() {
      const window = getWindow();
      if (window === undefined) return undefined;
      return {
        backend,
        mode: model?.mode ?? "normal",
        alwaysOnTop: support.alwaysOnTop ? window.isAlwaysOnTop() : false,
        fullScreen: window.isFullScreen(),
        pinnable: support.alwaysOnTop,
      };
    },

    currentMode() {
      return model?.mode ?? "normal";
    },

    /** The conversation's own bounds while collapsed, so closing from the bar remembers the conversation's size. */
    collapsedNormalBounds() {
      return model !== undefined && model.mode !== "normal" ? model.normalBounds : undefined;
    },

    /**
     * A window somebody resized is the window they expect back, so a resize while normal is the size to return to. A
     * resize during compact is the bar being moved, and an expanded window is a size the shell chose; remembering either
     * would make restoring leave the window where it is. Full screen is borrowed space, not a size the person chose.
     */
    noteResize(window) {
      ensureModel(window);
      if (model.mode !== "normal") return;
      if (window.isFullScreen()) return;
      const bounds = window.getBounds();
      model = { ...model, bounds, normalBounds: bounds };
    },
  };
}

/** The methods every backend answers asynchronously, routed by `withFallbackController`. */
const ASYNC_METHODS = Object.freeze([
  "setMode",
  "setPinned",
  "focus",
  "minimize",
  "setFullscreen",
  "restore",
  "restoreIfCollapsed",
  "resizePreset",
  "snapshot",
]);

/**
 * Run `primary`, and fall back to `fallback` for good the first time `primary` throws.
 *
 * A thrown error means the backend could not reach what it drives (a compositor socket that is gone, an answer that was
 * not what it expected); a refusal is an answer and passes straight through. Degrading for the rest of the session,
 * rather than per call, keeps one backend responsible for the window's mode instead of two that each remember half of
 * it. Every answer after the switch says which backend it degraded from and why, so diagnostics can see it.
 *
 * @param {DesktopWindowController} primary
 * @param {DesktopWindowController} fallback
 * @param {{ onDegrade?: (reason: string) => void }} [options]
 * @returns {DesktopWindowController}
 */
export function withFallbackController(primary, fallback, { onDegrade } = {}) {
  /** Why the primary was given up, or `undefined` while it is still in use. */
  let degraded;

  const controller = {
    get backend() {
      return degraded === undefined ? primary.backend : fallback.backend;
    },
    get support() {
      return degraded === undefined ? primary.support : fallback.support;
    },
    currentMode() {
      return degraded === undefined ? primary.currentMode() : fallback.currentMode();
    },
    collapsedNormalBounds() {
      return degraded === undefined ? primary.collapsedNormalBounds() : fallback.collapsedNormalBounds();
    },
    noteResize(window) {
      // The fallback keeps learning the window's size even while unused, so a switch starts from the real window.
      fallback.noteResize(window);
      if (degraded === undefined) primary.noteResize(window);
    },
  };

  for (const name of ASYNC_METHODS) {
    controller[name] = async (...args) => {
      if (degraded === undefined) {
        try {
          return await primary[name](...args);
        } catch (cause) {
          degraded = cause instanceof Error ? cause.message : String(cause);
          onDegrade?.(degraded);
        }
      }
      const answer = await fallback[name](...args);
      if (answer === undefined || answer === null || answer.ok === false) return answer;
      return { ...answer, degradedFrom: { backend: primary.backend, reason: degraded } };
    };
  }
  return controller;
}
