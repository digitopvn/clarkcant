import { describe, expect, it } from "vitest";

import { desktopBridge, requestWindowMode, sessionFromBridge } from "../src/desktop-compact.ts";

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
