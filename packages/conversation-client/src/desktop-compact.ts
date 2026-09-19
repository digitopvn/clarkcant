/**
 * The client's half of the desktop shell.
 *
 * The same client is served to a plain browser and into the Electron window, so everything here has to answer
 * for a browser without pretending: no bridge means no capability, not a crash and not an invented session.
 *
 * The shell's answers are treated as the state of the world. A window that says it is still expanded after
 * being asked to shrink is a window that is expanded - the OS may have refused, or the request may never have
 * arrived - and a client that echoed its own request instead would draw a bar over a full-size window.
 */

/** What a window is: the same four numbers Electron reports from `getBounds()`. */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WindowMode = "normal" | "compact";

/** What the client may ask the window to become. */
export type WindowModeAction =
  | { type: "enter-compact" }
  | { type: "expand" }
  | { type: "set-always-on-top"; value: boolean };

/** The window's state as the shell reported it, after doing whatever it did. */
export type WindowModeAnswer =
  | { ok: true; mode: WindowMode; bounds: WindowBounds; alwaysOnTop: boolean }
  | { ok: false; refused: string };

/** The node this window belongs to, handed over by the shell rather than read from the URL. */
export interface SessionHandover {
  baseUrl: string;
  token: string;
}

/**
 * The bridge as this client may use it.
 *
 * Every method is optional: an older shell, or a browser, simply does not have some of them, and each caller
 * asks for the one it needs. There is deliberately no generic invoke here either - the preload does not expose
 * one, so a client that wanted one would have to be changed rather than worked around.
 */
interface DesktopBridge {
  getSession?: () => Promise<unknown>;
  setCompactMode?: (input: WindowModeAction) => Promise<unknown>;
}

/**
 * The desktop bridge, or nothing when this is a browser.
 *
 * `scope` is a parameter so a test can hand in a scope instead of a global, and so nothing here reads a global
 * at import time.
 */
export function desktopBridge(scope: unknown = globalThis): DesktopBridge | undefined {
  if (typeof scope !== "object" || scope === null) return undefined;
  const candidate = (scope as { clarkcant?: unknown }).clarkcant;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  return candidate as DesktopBridge;
}

/**
 * The session the shell holds for this window, or nothing.
 *
 * Nothing covers every way this can fail - no bridge, a shell that refused because the node's identity file
 * was missing, a session with an empty token. All of them mean the same thing to the caller: there is no
 * session from here, so fall back to whatever the page was given. Nothing is ever invented, because a token
 * that was made up is a token that will fail later and look like a broken node.
 */
export async function sessionFromBridge(scope: unknown = globalThis): Promise<SessionHandover | undefined> {
  const bridge = desktopBridge(scope);
  if (bridge?.getSession === undefined) return undefined;

  let answer: unknown;
  try {
    answer = await bridge.getSession();
  } catch {
    return undefined;
  }

  const session = readSession(answer);
  return session;
}

/** Ask the window to change, and answer with the window's own state rather than with the request. */
export async function requestWindowMode(
  action: WindowModeAction,
  scope: unknown = globalThis,
): Promise<WindowModeAnswer> {
  const bridge = desktopBridge(scope);
  if (bridge?.setCompactMode === undefined) {
    return { ok: false, refused: "this window has no desktop shell to resize" };
  }

  let answer: unknown;
  try {
    answer = await bridge.setCompactMode(action);
  } catch {
    return { ok: false, refused: "the desktop shell did not answer" };
  }

  return readModeAnswer(answer);
}

/** The session out of an untrusted answer, or nothing. */
function readSession(answer: unknown): SessionHandover | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const envelope = answer as { ok?: unknown; session?: unknown };
  if (envelope.ok !== true) return undefined;

  const session = envelope.session;
  if (typeof session !== "object" || session === null) return undefined;
  const { baseUrl, token } = session as { baseUrl?: unknown; token?: unknown };
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return undefined;
  if (typeof token !== "string" || token.length === 0) return undefined;
  return { baseUrl, token };
}

/**
 * The window's state out of an untrusted answer.
 *
 * A mode this build does not know is refused rather than passed on: a client that rendered an unknown mode
 * would be guessing at what the window looks like, and the whole point of the answer is that it is not a guess.
 */
function readModeAnswer(answer: unknown): WindowModeAnswer {
  if (typeof answer !== "object" || answer === null) return { ok: false, refused: "the shell said nothing" };
  const envelope = answer as { ok?: unknown; refused?: unknown; mode?: unknown; bounds?: unknown; alwaysOnTop?: unknown };
  if (envelope.ok !== true) {
    return {
      ok: false,
      refused: typeof envelope.refused === "string" ? envelope.refused : "the shell refused without saying why",
    };
  }

  const mode = envelope.mode === "compact" || envelope.mode === "normal" ? envelope.mode : undefined;
  const bounds = readBounds(envelope.bounds);
  if (mode === undefined || bounds === undefined) {
    return { ok: false, refused: "the shell's answer did not describe a window" };
  }
  return { ok: true, mode, bounds, alwaysOnTop: envelope.alwaysOnTop === true };
}

/** Four finite numbers, or nothing. */
function readBounds(value: unknown): WindowBounds | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const numbers = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (!numbers.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return undefined;
  return {
    x: candidate.x as number,
    y: candidate.y as number,
    width: candidate.width as number,
    height: candidate.height as number,
  };
}
