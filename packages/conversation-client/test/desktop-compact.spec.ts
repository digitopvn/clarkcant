import { describe, expect, it } from "vitest";

import {
  desktopBridge,
  hasCloseControl,
  hasDesktopChrome,
  hasWindowControls,
  readShellWindow,
  requestClose,
  requestFullScreen,
  requestMinimize,
  requestWindowMode,
  sessionFromBridge,
  subscribeWindowState,
} from "../src/desktop-compact.ts";

/**
 * The client's half of the desktop shell.
 *
 * The browser has no bridge, and most of these tests are about that: every function here has to answer for a
 * plain browser without pretending, because the same client is served to a browser and the difference must be
 * a missing capability rather than a crash or an invented session.
 */

/** A scope with a bridge on it, shaped the way the preload exposes one. */
function scopeWith(bridge: unknown): object {
  return { clarkcant: bridge };
}

describe("whether there is a desktop shell at all", () => {
  it("a browser without the bridge refuses compact mode instead of pretending", () => {
    expect(desktopBridge({})).toBeUndefined();
    expect(desktopBridge({ clarkcant: null })).toBeUndefined();
  });

  it("a shell that answers nothing useful is still refused rather than assumed", async () => {
    const answer = await requestWindowMode({ type: "enter-compact" }, scopeWith({}));
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.refused).toBeTruthy();
  });
});

describe("asking the shell for a window mode", () => {
  it("the compact state is derived from the shell's answer, not from the request", async () => {
    // The window reports what it actually has. If it says the window is still normal - because the OS refused,
    // or because the request never reached it - the client must believe the window rather than its own request.
    const scope = scopeWith({
      setCompactMode: async () => ({
        ok: true,
        mode: "normal",
        bounds: { x: 1, y: 2, width: 1100, height: 760 },
        alwaysOnTop: false,
      }),
    });

    const answer = await requestWindowMode({ type: "enter-compact" }, scope);
    expect(answer.ok).toBe(true);
    expect(answer.ok === true && answer.mode).toBe("normal");
    expect(answer.ok === true && answer.bounds).toEqual({ x: 1, y: 2, width: 1100, height: 760 });
  });

  it("a shell that throws is refused rather than taking the caller down with it", async () => {
    const scope = scopeWith({
      setCompactMode: async () => {
        throw new Error("the shell went away");
      },
    });

    const answer = await requestWindowMode({ type: "expand" }, scope);
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.refused).toBeTruthy();
  });

  it("a malformed answer is refused instead of believed", async () => {
    const scope = scopeWith({ setCompactMode: async () => ({ ok: true, mode: "sideways" }) });
    const answer = await requestWindowMode({ type: "enter-compact" }, scope);
    expect(answer.ok).toBe(false);
  });
});

describe("whether the client should draw window chrome", () => {
  it("the client renders no desktop chrome when no bridge is present", () => {
    // The gate the chrome renders behind, asserted without a DOM: the component returns nothing when this is
    // false, and a plain browser is exactly this case - it must not grow a window strip it cannot honour.
    expect(hasDesktopChrome({})).toBe(false);
    expect(hasDesktopChrome({ clarkcant: null })).toBe(false);
    // A shell old enough to hand over a session but not to resize is not chrome either.
    expect(hasDesktopChrome(scopeWith({ getSession: async () => ({ ok: true }) }))).toBe(false);
    expect(hasDesktopChrome(scopeWith({ setCompactMode: async () => ({ ok: true }) }))).toBe(true);
  });
});

describe("the session the shell hands over", () => {
  it("a session handed over by the bridge is used instead of a url token", async () => {
    const scope = scopeWith({
      getSession: async () => ({ ok: true, session: { baseUrl: "http://127.0.0.1:9999", token: "from-bridge" } }),
    });

    expect(await sessionFromBridge(scope)).toEqual({
      baseUrl: "http://127.0.0.1:9999",
      token: "from-bridge",
    });
  });

  it("a bridge that refuses the session leaves the token field empty rather than inventing one", async () => {
    const scope = scopeWith({ getSession: async () => ({ ok: false, refused: "no identity to read" }) });
    expect(await sessionFromBridge(scope)).toBeUndefined();
  });

  it("a session with no token is no session", async () => {
    const scope = scopeWith({ getSession: async () => ({ ok: true, session: { baseUrl: "http://x", token: "" } }) });
    expect(await sessionFromBridge(scope)).toBeUndefined();
  });

  it("a browser without a bridge has no session to hand over", async () => {
    expect(await sessionFromBridge({})).toBeUndefined();
  });
});

describe("minimize and full screen", () => {
  it("draws the buttons only when the shell has both verbs", () => {
    expect(hasWindowControls({})).toBe(false);
    // A shell that resizes but predates these verbs keeps its chrome and gets no buttons it cannot honour.
    expect(hasWindowControls(scopeWith({ setCompactMode: async () => ({ ok: true }) }))).toBe(false);
    expect(hasWindowControls(scopeWith({ minimizeWindow: async () => ({ ok: true }) }))).toBe(false);
    expect(
      hasWindowControls(
        scopeWith({ minimizeWindow: async () => ({ ok: true }), setFullScreen: async () => ({ ok: true }) }),
      ),
    ).toBe(true);
  });

  it("a browser is refused instead of pretending the window went anywhere", async () => {
    expect((await requestMinimize({})).ok).toBe(false);
    expect((await requestFullScreen(true, {})).ok).toBe(false);
  });

  it("full screen is what the window reports, not what was asked", async () => {
    const asked: unknown[] = [];
    const scope = scopeWith({
      setFullScreen: async (value: unknown) => {
        asked.push(value);
        // The window manager declined: the window is still not full screen.
        return { ok: true, fullScreen: false, minimized: false };
      },
    });
    const answer = await requestFullScreen(true, scope);
    expect(asked).toEqual([true]);
    expect(answer).toEqual({ ok: true, fullScreen: false, minimized: false });
  });

  it("a refusal, a throw or a malformed answer each come back as a refusal", async () => {
    const refused = await requestMinimize(
      scopeWith({ minimizeWindow: async () => ({ ok: false, refused: "this window cannot be minimized" }) }),
    );
    expect(refused).toEqual({ ok: false, refused: "this window cannot be minimized" });

    const threw = await requestMinimize(
      scopeWith({
        minimizeWindow: async () => {
          throw new Error("gone");
        },
      }),
    );
    expect(threw.ok).toBe(false);

    const malformed = await requestFullScreen(true, scopeWith({ setFullScreen: async () => ({ ok: true, fullScreen: "yes" }) }));
    expect(malformed.ok).toBe(false);
  });

  it("hears changes the OS made, drops junk, and unsubscribes", () => {
    let push: ((payload: unknown) => void) | undefined;
    let unsubscribed = false;
    const scope = scopeWith({
      onWindowStateChanged: (callback: (payload: unknown) => void) => {
        push = callback;
        return () => {
          unsubscribed = true;
        };
      },
    });
    const seen: unknown[] = [];
    const stop = subscribeWindowState((state) => seen.push(state), scope);
    push?.({ ok: true, fullScreen: true, minimized: false });
    push?.({ ok: true, fullScreen: "maybe" });
    push?.(null);
    expect(seen).toEqual([{ fullScreen: true, minimized: false }]);
    stop();
    expect(unsubscribed).toBe(true);
  });

  it("subscribing without a shell, or to one that hands back no unsubscribe, is harmless", () => {
    expect(() => subscribeWindowState(() => {}, {})()).not.toThrow();
    expect(() => subscribeWindowState(() => {}, scopeWith({ onWindowStateChanged: () => undefined }))()).not.toThrow();
  });
});

describe("the window strip's pin, mode and close", () => {
  it("reads the pin and full screen from the window rather than assuming them off", async () => {
    const scope = scopeWith({
      status: async () => ({ ok: true, window: { mode: "expanded", alwaysOnTop: true, fullScreen: true } }),
    });
    expect(await readShellWindow(scope)).toEqual({ mode: "expanded", alwaysOnTop: true, fullScreen: true });
  });

  it("a mode the strip has no control for reads as a normal window", async () => {
    const scope = scopeWith({ status: async () => ({ ok: true, window: { mode: "orb", alwaysOnTop: false } }) });
    expect(await readShellWindow(scope)).toEqual({ mode: "normal", alwaysOnTop: false, fullScreen: false });
  });

  it("a shell that does not describe its window leaves the strip on its defaults", async () => {
    expect(await readShellWindow(scopeWith({ status: async () => ({ ok: true }) }))).toBeUndefined();
    expect(await readShellWindow({})).toBeUndefined();
  });

  it("close reports what the shell said, and a shell without the verb gets no button", async () => {
    const refusing = scopeWith({ closeWindow: async () => ({ ok: false, refused: "there is no window to close" }) });
    expect(hasCloseControl(refusing)).toBe(true);
    expect(await requestClose(refusing)).toEqual({ ok: false, refused: "there is no window to close" });
    expect(await requestClose(scopeWith({ closeWindow: async () => ({ ok: true }) }))).toEqual({ ok: true });
    expect(hasCloseControl(scopeWith({}))).toBe(false);
    expect((await requestClose({})).ok).toBe(false);
  });

  it("a shell that throws is reported as not answering rather than as closed", async () => {
    const scope = scopeWith({
      closeWindow: async () => {
        throw new Error("gone");
      },
    });
    expect(await requestClose(scope)).toEqual({ ok: false, refused: "the desktop shell did not answer" });
  });
});
