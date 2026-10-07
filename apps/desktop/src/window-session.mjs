/**
 * Which kind of desktop session the shell's window lives in, and therefore which window backend can honour it.
 *
 * Pure on purpose: everything it needs (the platform, the environment, Electron's own switches) is handed in, so the
 * decision is a unit test rather than a guess made on somebody's Linux machine.
 *
 * Why it matters. On macOS, Windows and X11 an app owns its window's position and stacking, so the shell can move the
 * window into the bar or the orb and keep it above others. Under native Wayland the compositor owns placement: a
 * client cannot put its window at an absolute position, and there is no standard protocol for "always on top". The
 * shell must then say so in the state it reports, rather than pretend the geometry was applied.
 */

/** The opt-in names a person can give `--window-backend` or `CLARKCANT_WINDOW_BACKEND`. */
export const WINDOW_BACKEND_REQUESTS = Object.freeze(["electron", "hyprland"]);

/** What the Electron geometry backend can ask the window system for, everywhere except native Wayland. */
export const FULL_GEOMETRY = Object.freeze({ position: true, alwaysOnTop: true });

/**
 * What it can ask for under native Wayland: a size, which the compositor may still override (a tiled window keeps
 * the tile), but neither a position nor a stacking order.
 */
export const WAYLAND_GEOMETRY = Object.freeze({ position: false, alwaysOnTop: false });

/**
 * Hyprland instance signatures are hashes and timestamps joined by underscores. Anything else is refused, because the
 * signature becomes a path segment of the IPC socket and must not be able to point anywhere else.
 */
const HYPRLAND_SIGNATURE = /^[A-Za-z0-9_]{1,200}$/;

const BSD_LIKE = new Set(["linux", "freebsd", "openbsd", "netbsd"]);

/**
 * Describe the session.
 *
 * @param {{
 *   platform: string,
 *   env?: Record<string, string | undefined>,
 *   switches?: { ozonePlatform?: string, ozonePlatformHint?: string },
 * }} input `platform` is `process.platform`; `switches` are the values Electron was started with, empty when absent
 * @returns {{
 *   platform: string,
 *   kind: "macos" | "windows" | "x11" | "xwayland" | "wayland" | "headless" | "other",
 *   compositor: "hyprland" | undefined,
 *   hyprland: { signature: string, runtimeDir: string } | undefined,
 * }}
 */
export function detectWindowSession({ platform, env = {}, switches = {} }) {
  if (platform === "darwin") return { platform, kind: "macos", compositor: undefined, hyprland: undefined };
  if (platform === "win32") return { platform, kind: "windows", compositor: undefined, hyprland: undefined };
  if (!BSD_LIKE.has(platform)) return { platform, kind: "other", compositor: undefined, hyprland: undefined };

  const waylandSession = nonEmpty(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
  const ozone = resolveOzonePlatform({ switches, env, waylandSession });
  const kind = ozone === "wayland" ? "wayland" : ozone === "x11" ? (waylandSession ? "xwayland" : "x11") : "headless";
  const hyprland = hyprlandInstance(env);
  return { platform, kind, compositor: hyprland === undefined ? undefined : "hyprland", hyprland };
}

/**
 * What the Electron geometry backend can honestly ask for in this session.
 *
 * @param {ReturnType<typeof detectWindowSession>} session
 */
export function geometrySupportFor(session) {
  return session.kind === "wayland" ? WAYLAND_GEOMETRY : FULL_GEOMETRY;
}

/**
 * Pick the window backend.
 *
 * Electron geometry is the default everywhere, including Hyprland: the Hyprland adapter has not been verified on a
 * real compositor, so it runs only when a person asks for it and Hyprland is actually there. Asking for it anywhere
 * else is answered with the reason it was not used, never with a backend that cannot reach a compositor.
 *
 * @param {{ session: ReturnType<typeof detectWindowSession>, requested?: string }} input
 * @returns {{ backend: "electron-geometry" | "hyprland", reason: string }}
 */
export function selectWindowBackend({ session, requested }) {
  const wanted = requested === undefined || requested === "" ? undefined : requested.trim().toLowerCase();
  if (wanted !== undefined && !WINDOW_BACKEND_REQUESTS.includes(wanted)) {
    return { backend: "electron-geometry", reason: `"${requested}" is not a window backend this build knows` };
  }
  if (wanted === "hyprland") {
    if (session.compositor === "hyprland") return { backend: "hyprland", reason: "asked for, and Hyprland is running" };
    return { backend: "electron-geometry", reason: "the Hyprland backend was asked for, but this session is not Hyprland" };
  }
  if (session.kind === "wayland") {
    return {
      backend: "electron-geometry",
      reason: "native Wayland: the compositor owns window position and stacking, so only a size request takes effect",
    };
  }
  return { backend: "electron-geometry", reason: "the app owns its window geometry in this session" };
}

/**
 * The Ozone platform Electron will run on, as far as the inputs say.
 *
 * An explicit `--ozone-platform` wins. Otherwise the `--ozone-platform-hint` switch is honoured, and failing that
 * Electron's own default since version 38, `auto`: Wayland when the session is Wayland, X11 when there is an X display,
 * nothing when there is neither.
 *
 * `ELECTRON_OZONE_PLATFORM_HINT` is deliberately not read: Electron 38 stopped honouring it, so trusting it would report
 * XWayland (and offer a pin) while Electron actually runs native Wayland.
 */
function resolveOzonePlatform({ switches, env, waylandSession }) {
  const explicit = normalizeOzone(switches.ozonePlatform);
  if (explicit !== undefined) return explicit;
  const hint = normalizeOzone(switches.ozonePlatformHint);
  if (hint !== undefined) return hint;
  if (waylandSession) return "wayland";
  if (nonEmpty(env.DISPLAY)) return "x11";
  return undefined;
}

/** `wayland` or `x11`; `auto`, empty and anything else defer to the next source. */
function normalizeOzone(value) {
  const lowered = typeof value === "string" ? value.trim().toLowerCase() : "";
  return lowered === "wayland" || lowered === "x11" ? lowered : undefined;
}

/** The Hyprland instance this process can talk to, or nothing when the environment does not name a safe one. */
function hyprlandInstance(env) {
  const signature = env.HYPRLAND_INSTANCE_SIGNATURE;
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (typeof signature !== "string" || !HYPRLAND_SIGNATURE.test(signature)) return undefined;
  // The socket lives under the runtime directory, which must be absolute: a relative one would resolve against
  // whatever directory the shell happened to start in.
  if (typeof runtimeDir !== "string" || !runtimeDir.startsWith("/")) return undefined;
  return { signature, runtimeDir };
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}
