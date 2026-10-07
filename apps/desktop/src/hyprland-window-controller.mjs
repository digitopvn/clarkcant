/**
 * The Hyprland window backend: the four modes, pin, focus and full screen as Hyprland dispatchers.
 *
 * UNVERIFIED ON A REAL COMPOSITOR. The command mapping is unit-tested against an injected transport and written from
 * the Hyprland 0.54 dispatcher and IPC documentation; nobody has yet run it against a live Hyprland or Omarchy session.
 * That is why it is opt-in (`--window-backend hyprland` or `CLARKCANT_WINDOW_BACKEND=hyprland`, and only when Hyprland
 * is detected, see `window-session.mjs`) and why the main process wraps it in `withFallbackController`: any IPC failure
 * hands the window back to Electron geometry for the rest of the session.
 *
 * Why a compositor backend at all. Under native Wayland the compositor owns placement, so Electron cannot put the bar
 * or the orb anywhere, and has no way to keep a window on top. Hyprland can do both for a window it is told about:
 *
 *   normal   -> the window's own floating/tiled state and size from before it collapsed
 *   expanded -> maximized (`fullscreen 1`), which keeps gaps and bars
 *   compact  -> floating at the bar's size
 *   orb      -> floating at the orb's size, pinned (shown on every workspace, above tiled windows)
 *   pin      -> floating and pinned; Hyprland only pins floating windows
 *   minimize -> refused: Hyprland has no minimized state
 *
 * Every command names the window by its address, read from `j/clients` and checked, so nothing from the renderer and
 * nothing unchecked from the compositor ever reaches a command string. A dispatcher that does not answer `ok` throws,
 * which is what makes the fallback take over.
 */

import { WINDOW_MODES, WINDOW_MODE_PRESETS } from "./window-mode.mjs";
import { refuse } from "./window-controller.mjs";

/** Hyprland window addresses are hexadecimal pointers; anything else is not used in a command. */
const ADDRESS = /^0x[0-9a-f]{1,16}$/i;

/** An IPC answer that could not be used. Thrown so the fallback wrapper degrades instead of guessing. */
export class HyprlandIpcError extends Error {
  constructor(message) {
    super(message);
    this.name = "HyprlandIpcError";
  }
}

/**
 * Find this app's conversation window among Hyprland's clients.
 *
 * By process id and title: the detached widget window shares the process, so the pid alone can name two windows.
 * When the title does not settle it, the call fails rather than moving a window that may not be the conversation.
 *
 * @param {unknown} clients the parsed `j/clients` answer
 * @param {{ pid: number, title: string }} identity
 */
export function findOwnClient(clients, { pid, title }) {
  if (!Array.isArray(clients)) throw new HyprlandIpcError("Hyprland's client list was not a list");
  const ours = clients.filter((client) => client !== null && typeof client === "object" && client.pid === pid);
  const titled = ours.filter((client) => client.title === title);
  const match = titled.length === 1 ? titled[0] : ours.length === 1 ? ours[0] : undefined;
  if (match === undefined) {
    throw new HyprlandIpcError(
      ours.length === 0
        ? "Hyprland lists no window for this app"
        : "Hyprland lists more than one window for this app, and the title does not say which is the conversation",
    );
  }
  return readClient(match);
}

/**
 * The fields this backend uses, checked. `fullscreen` was a boolean plus `fullscreenMode` before Hyprland 0.42 and a
 * bit field after (1 maximized, 2 full screen); both read as the bit field.
 */
function readClient(client) {
  if (typeof client.address !== "string" || !ADDRESS.test(client.address)) {
    throw new HyprlandIpcError("Hyprland reported a window address this backend does not recognise");
  }
  const at = pair(client.at);
  const size = pair(client.size);
  if (at === undefined || size === undefined) throw new HyprlandIpcError("Hyprland reported a window without a geometry");
  let fullscreen = 0;
  if (typeof client.fullscreen === "number" && Number.isInteger(client.fullscreen)) fullscreen = client.fullscreen;
  else if (client.fullscreen === true) fullscreen = client.fullscreenMode === 1 ? 1 : 2;
  return {
    address: client.address,
    floating: client.floating === true,
    pinned: client.pinned === true,
    fullscreen,
    bounds: { x: at[0], y: at[1], width: size[0], height: size[1] },
  };
}

function pair(value) {
  return Array.isArray(value) && value.length === 2 && value.every((entry) => Number.isFinite(entry))
    ? [Math.round(value[0]), Math.round(value[1])]
    : undefined;
}

const isMaximized = (client) => (client.fullscreen & 1) !== 0;
const isFullScreen = (client) => (client.fullscreen & 2) !== 0;

/**
 * @param {{
 *   request: (text: string) => Promise<string>,
 *   getWindow: () => import("./window-controller.mjs").ControlledWindow | undefined,
 *   pid: number,
 *   fallbackPreset?: (name: unknown) => Promise<import("./window-controller.mjs").WindowAnswer>,
 * }} input `request` sends one Hyprland IPC request and answers its reply; `fallbackPreset` handles the legacy named-size
 * channel, which is Electron geometry on every backend
 * @returns {import("./window-controller.mjs").DesktopWindowController}
 */
export function createHyprlandWindowController({ request, getWindow, pid, fallbackPreset }) {
  const backend = "hyprland";
  /** The mode this backend last put the window in. */
  let mode = "normal";
  /** The conversation's own presentation before it collapsed, restored on the way back. */
  let beforeCollapse;
  /** Whether the orb added the pin, so leaving the orb takes away only a pin the person did not ask for. */
  let pinnedByOrb = false;

  async function own() {
    const window = getWindow();
    if (window === undefined) return undefined;
    const reply = await request("j/clients");
    let clients;
    try {
      clients = JSON.parse(reply);
    } catch {
      throw new HyprlandIpcError("Hyprland's client list was not JSON");
    }
    return findOwnClient(clients, { pid, title: window.getTitle() });
  }

  async function dispatch(command) {
    const reply = String(await request(`dispatch ${command}`)).trim();
    if (reply !== "ok") throw new HyprlandIpcError(`Hyprland did not accept "${command}": ${reply.slice(0, 200)}`);
  }

  const at = (client) => `address:${client.address}`;

  /** `fullscreen` acts on the focused window only, so it is always preceded by focusing this one. */
  async function setFullscreenState(client, kind, value) {
    await dispatch(`focuswindow ${at(client)}`);
    await dispatch(`fullscreen ${kind} ${value ? "set" : "unset"}`);
  }

  async function togglePin(client) {
    await dispatch(`pin ${at(client)}`);
  }

  /**
   * Undo a collapse: the pin the orb added, then floating or tiled and the size the conversation had. Answers the parts
   * it asked Hyprland for, so the state says what was requested rather than what a full restore would have been.
   */
  async function restoreConversation(client) {
    const applied = [];
    if (pinnedByOrb && client.pinned) {
      await togglePin(client);
      applied.push("pin");
    }
    pinnedByOrb = false;
    if (beforeCollapse === undefined) return applied;
    const before = beforeCollapse;
    beforeCollapse = undefined;
    if (!before.floating) {
      await dispatch(`settiled ${at(client)}`);
      return [...applied, "tile"];
    }
    await dispatch(`resizewindowpixel exact ${before.bounds.width} ${before.bounds.height},${at(client)}`);
    await dispatch(`movewindowpixel exact ${before.bounds.x} ${before.bounds.y},${at(client)}`);
    return [...applied, "size", "position"];
  }

  async function state(applied) {
    const window = getWindow();
    const client = await own();
    if (window === undefined || client === undefined) return refuse("there is no window to describe");
    return {
      ok: true,
      backend,
      mode,
      bounds: client.bounds,
      minimumSize: window.getMinimumSize(),
      // Hyprland's pin: shown on every workspace and above tiled windows. The nearest thing Hyprland has to "on top".
      alwaysOnTop: client.pinned,
      focused: window.isFocused(),
      fullScreen: isFullScreen(client),
      minimized: false,
      applied,
      unsupported: [],
    };
  }

  async function setMode(target) {
    let client = await own();
    if (client === undefined) return refuse("there is no window to resize");
    if (!WINDOW_MODES.includes(target)) return refuse(`"${String(target)}" is not a window mode this build knows`);

    // Out of full screen and out of maximized first: Hyprland ignores size requests for either.
    if (isFullScreen(client)) await setFullscreenState(client, 0, false);
    if (isMaximized(client)) await setFullscreenState(client, 1, false);
    if (isFullScreen(client) || isMaximized(client)) client = await own();

    if (target === "normal" || target === "expanded") {
      const applied = await restoreConversation(client);
      if (target === "expanded") {
        await setFullscreenState(client, 1, true);
        applied.push("maximize");
      }
      mode = target;
      return state(applied);
    }

    // Collapsing: remember the conversation once, so bar then orb still restores the conversation, not the bar.
    if (beforeCollapse === undefined) beforeCollapse = { floating: client.floating, bounds: client.bounds };
    const preset = WINDOW_MODE_PRESETS[target];
    if (!client.floating) await dispatch(`setfloating ${at(client)}`);
    await dispatch(`resizewindowpixel exact ${preset.width} ${preset.height},${at(client)}`);
    if (target === "orb" && !client.pinned) {
      await togglePin(client);
      pinnedByOrb = true;
    } else if (target === "compact" && pinnedByOrb && client.pinned) {
      await togglePin(client);
      pinnedByOrb = false;
    }
    mode = target;
    return state(target === "orb" ? ["float", "size", "pin"] : ["float", "size"]);
  }

  return {
    backend,
    support: Object.freeze({ position: true, alwaysOnTop: true }),

    setMode,

    async setPinned(value) {
      if (typeof value !== "boolean") return refuse("pinned must be true or false");
      const client = await own();
      if (client === undefined) return refuse("there is no window to resize");
      // The person decided, so the pin is theirs from here on and leaving the orb must not undo it.
      pinnedByOrb = false;
      if (value && !client.floating) await dispatch(`setfloating ${at(client)}`);
      if (client.pinned !== value) await togglePin(client);
      return state(value ? ["float", "pin"] : ["pin"]);
    },

    async focus() {
      const client = await own();
      if (client === undefined) return refuse("there is no window to focus");
      await dispatch(`focuswindow ${at(client)}`);
      return state(["focus"]);
    },

    async minimize() {
      if (getWindow() === undefined) return refuse("there is no window to minimize");
      return refuse("Hyprland has no minimized windows, so the window was left where it is");
    },

    async setFullscreen(value) {
      if (typeof value !== "boolean") return refuse("full screen must be true or false");
      let client = await own();
      if (client === undefined) return refuse("there is no window to resize");
      // A full-screen voice bar is a very large empty strip: grow the conversation first, as Electron geometry does.
      if (value && (mode === "compact" || mode === "orb")) {
        await setMode("normal");
        client = await own();
      }
      if (isFullScreen(client) !== value) await setFullscreenState(client, 0, value);
      return state(["fullscreen"]);
    },

    async restore() {
      if (getWindow() === undefined) return refuse("there is no window to restore");
      return setMode("normal");
    },

    async restoreIfCollapsed() {
      if (getWindow() === undefined) return refuse("there is no window to restore");
      if (mode !== "compact" && mode !== "orb") return state([]);
      return setMode("normal");
    },

    async resizePreset(name) {
      if (fallbackPreset === undefined) return refuse("named sizes are not available on this backend");
      return fallbackPreset(name);
    },

    async snapshot() {
      const client = await own();
      if (client === undefined) return undefined;
      return { backend, mode, alwaysOnTop: client.pinned, fullScreen: isFullScreen(client), pinnable: true };
    },

    currentMode() {
      return mode;
    },

    collapsedNormalBounds() {
      return beforeCollapse?.bounds;
    },

    noteResize() {
      // Hyprland remembers the conversation's geometry at collapse time; a resize in between is the compositor's.
    },
  };
}
