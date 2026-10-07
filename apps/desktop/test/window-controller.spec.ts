import { describe, expect, it } from "vitest";

import {
  type DesktopWindowController,
  type WindowAnswer,
  PIN_UNSUPPORTED,
  POSITION_UNSUPPORTED,
  createElectronGeometryController,
  withFallbackController,
} from "../src/window-controller.mjs";
import { MINIMAL_BAR, WINDOW_MODE_PRESETS } from "../src/window-mode.mjs";
import { FULL_GEOMETRY, WAYLAND_GEOMETRY } from "../src/window-session.mjs";
import { type Bounds, type FakeBrowserWindow, fakeBrowserWindow } from "./fake-browser-window.ts";

/**
 * The semantic window controller's contract, held against the Electron geometry backend.
 *
 * The UI asks for intents and the controller answers with what the window then is, read back off the window, plus which
 * parts it asked the window system for and which this desktop cannot honour. The first group pins today's macOS, Windows
 * and X11 behaviour, which moving the geometry behind the controller must not change; the second is native Wayland, where
 * the controller must say what it could not do rather than report geometry or a pin that never happened.
 */

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const NORMAL: Bounds = { x: 100, y: 80, width: 1100, height: 760 };

function controllerFor(
  window: FakeBrowserWindow | undefined,
  support: { position: boolean; alwaysOnTop: boolean } = FULL_GEOMETRY,
) {
  return createElectronGeometryController({
    getWindow: () => window,
    workAreaFor: () => WORK_AREA,
    support,
    settleMs: 10,
  });
}

describe("Electron geometry where the app owns its window (macOS, Windows, X11)", () => {
  it("collapses to the bar and the orb and restores the conversation exactly", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    const controller = controllerFor(window);

    const compact = await controller.setMode("compact");
    expect(compact).toMatchObject({
      ok: true,
      backend: "electron-geometry",
      mode: "compact",
      bounds: { x: 100, y: 80, width: MINIMAL_BAR.width, height: MINIMAL_BAR.height },
      applied: ["size", "position"],
      unsupported: [],
    });

    const orb = await controller.setMode("orb");
    expect(orb).toMatchObject({ mode: "orb", bounds: { width: WINDOW_MODE_PRESETS.orb.width } });
    expect(controller.collapsedNormalBounds()).toEqual(NORMAL);

    const normal = await controller.setMode("normal");
    expect(normal).toMatchObject({ mode: "normal", bounds: NORMAL });
    expect(controller.collapsedNormalBounds()).toBeUndefined();
  });

  it("expands to the whole work area", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    const answer = await controllerFor(window).setMode("expanded");
    expect(answer).toMatchObject({ ok: true, mode: "expanded", bounds: WORK_AREA });
  });

  it("refuses an unknown mode without touching the window", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    expect(await controllerFor(window).setMode("fullscreen")).toEqual({
      ok: false,
      refused: '"fullscreen" is not a window mode this build knows',
    });
    expect(window.calls).toEqual([]);
  });

  it("answers every verb with the same refusal the channels always gave when there is no window", async () => {
    const controller = controllerFor(undefined);
    expect(await controller.setMode("compact")).toEqual({ ok: false, refused: "there is no window to resize" });
    expect(await controller.setPinned(true)).toEqual({ ok: false, refused: "there is no window to resize" });
    expect(await controller.focus()).toEqual({ ok: false, refused: "there is no window to focus" });
    expect(await controller.minimize()).toEqual({ ok: false, refused: "there is no window to minimize" });
    expect(await controller.setFullscreen(true)).toEqual({ ok: false, refused: "there is no window to resize" });
    expect(await controller.restore()).toEqual({ ok: false, refused: "there is no window to restore" });
    expect(await controller.snapshot()).toBeUndefined();
  });

  it("the compact channel's path leaves full screen first and keeps the pin", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    const controller = controllerFor(window);
    await controller.setPinned(true);
    window.setFullScreen(true);
    window.calls.length = 0;

    const compact = await controller.setMode("compact", { exitFullScreen: true, reassertPin: true });
    expect(window.calls).toEqual(["setFullScreen false", "setBounds 100,80 68x56", "setAlwaysOnTop true"]);
    expect(compact).toMatchObject({ ok: true, mode: "compact", alwaysOnTop: true, fullScreen: false });
  });

  it("the named-mode path leaves full screen and the pin alone, as it always has", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    await controllerFor(window).setMode("compact");
    expect(window.calls).toEqual(["setBounds 100,80 68x56"]);
  });

  it("pins and unpins, reporting the pin the window has", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    const controller = controllerFor(window);
    expect(await controller.setPinned(true)).toMatchObject({ ok: true, alwaysOnTop: true, applied: ["pin"] });
    expect(await controller.setPinned(false)).toMatchObject({ ok: true, alwaysOnTop: false });
    expect(await controller.setPinned("yes")).toEqual({ ok: false, refused: "pinned must be true or false" });
  });

  it("restore refuses until the shell has moved the window, then restores it", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    const controller = controllerFor(window);
    expect(await controller.restore()).toEqual({
      ok: false,
      refused: "this window has not been moved by the shell yet, so there is nothing to restore",
    });
    await controller.setMode("orb");
    expect(await controller.restore()).toMatchObject({ ok: true, mode: "normal", bounds: NORMAL });
  });

  it("a notification click restores the bar and the orb, and leaves an expanded window alone", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    const controller = controllerFor(window);
    await controller.setMode("expanded");
    expect(await controller.restoreIfCollapsed()).toMatchObject({ mode: "expanded", bounds: WORK_AREA });
    await controller.setMode("compact");
    expect(await controller.restoreIfCollapsed()).toMatchObject({ mode: "normal", bounds: NORMAL });
  });

  it("entering full screen from the bar grows the conversation first", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    const controller = controllerFor(window);
    await controller.setMode("compact");
    window.calls.length = 0;
    const answer = await controller.setFullscreen(true);
    expect(window.calls).toEqual(["setBounds 100,80 1100x760", "setFullScreen true"]);
    expect(answer).toMatchObject({ ok: true, fullScreen: true, minimized: false, mode: "normal" });
  });

  it("refuses full screen and minimize the window cannot do", async () => {
    expect(await controllerFor(fakeBrowserWindow({ fullScreenable: false })).setFullscreen(true)).toEqual({
      ok: false,
      refused: "this window cannot go full screen",
    });
    expect(await controllerFor(fakeBrowserWindow()).setFullscreen("yes")).toEqual({
      ok: false,
      refused: "full screen must be true or false",
    });
    expect(await controllerFor(fakeBrowserWindow({ minimizable: false })).minimize()).toEqual({
      ok: false,
      refused: "this window cannot be minimized",
    });
  });

  it("focus brings a minimized window back first", async () => {
    const window = fakeBrowserWindow();
    const controller = controllerFor(window);
    expect(await controller.minimize()).toMatchObject({ ok: true, minimized: true });
    expect(await controller.focus()).toMatchObject({ ok: true, focused: true, minimized: false });
    expect(window.calls).toEqual(["minimize", "restore", "focus"]);
  });

  it("a person's resize while normal becomes the size to return to; a resize while collapsed does not", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    const controller = controllerFor(window);
    const resized = { x: 100, y: 80, width: 1300, height: 900 };
    window.setBounds(resized);
    controller.noteResize(window);
    await controller.setMode("compact");
    controller.noteResize(window);
    expect(await controller.setMode("normal")).toMatchObject({ bounds: resized });
  });

  it("a named size changes the size and leaves the mode alone", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    const controller = controllerFor(window);
    expect(await controller.resizePreset("orb")).toMatchObject({ ok: true, mode: null, bounds: { width: 148, height: 148 } });
    expect(await controller.resizePreset("huge")).toEqual({ ok: false, refused: '"huge" is not a size preset this build knows' });
  });

  it("the snapshot reports the remembered mode and a pinnable window", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL });
    const controller = controllerFor(window);
    await controller.setMode("compact");
    expect(await controller.snapshot()).toEqual({
      backend: "electron-geometry",
      mode: "compact",
      alwaysOnTop: false,
      fullScreen: false,
      pinnable: true,
    });
  });
});

describe("Electron geometry under native Wayland", () => {
  it("requests only the size and says the position is the compositor's", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL, honourPosition: false });
    const answer = await controllerFor(window, WAYLAND_GEOMETRY).setMode("orb");
    expect(answer).toMatchObject({
      ok: true,
      mode: "orb",
      bounds: { width: 148, height: 148 },
      applied: ["size"],
      unsupported: [POSITION_UNSUPPORTED],
    });
  });

  it("refuses a pin it cannot honour, and never reports Electron's own flag as a pin", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL, honourPosition: false });
    const controller = controllerFor(window, WAYLAND_GEOMETRY);
    expect(await controller.setPinned(true)).toEqual({
      ok: false,
      refused: `${PIN_UNSUPPORTED.reason}; the window was left as it was`,
    });
    expect(window.calls).toEqual([]);

    // Even if something set Electron's flag, the state does not claim a pin nothing keeps.
    window.setAlwaysOnTop(true);
    expect(await controller.focus()).toMatchObject({ alwaysOnTop: false });
    expect(await controller.snapshot()).toMatchObject({ alwaysOnTop: false, pinnable: false });
  });

  it("the compact channel's path does not touch the pin it cannot honour", async () => {
    const window = fakeBrowserWindow({ bounds: NORMAL, honourPosition: false });
    await controllerFor(window, WAYLAND_GEOMETRY).setMode("compact", { exitFullScreen: true, reassertPin: true });
    expect(window.calls).toEqual(["setBounds 100,80 68x56"]);
  });
});

describe("falling back from a backend that cannot reach its desktop", () => {
  function brokenPrimary(answer: () => Promise<WindowAnswer>): DesktopWindowController {
    const geometry = controllerFor(fakeBrowserWindow());
    return {
      ...geometry,
      backend: "hyprland",
      currentMode: () => "orb",
      collapsedNormalBounds: () => undefined,
      noteResize: () => undefined,
      setMode: answer,
      focus: answer,
    };
  }

  it("passes a refusal straight through: an answer is not a failure", async () => {
    const refusal: WindowAnswer = { ok: false, refused: "no" };
    const fallback = controllerFor(fakeBrowserWindow());
    const controller = withFallbackController(brokenPrimary(async () => refusal), fallback);
    expect(await controller.setMode("compact")).toEqual(refusal);
    expect(controller.backend).toBe("hyprland");
  });

  it("degrades for good on the first failure and says so in every answer after", async () => {
    const reasons: string[] = [];
    const fallback = controllerFor(fakeBrowserWindow({ bounds: NORMAL }));
    const controller = withFallbackController(
      brokenPrimary(async () => {
        throw new Error("socket gone");
      }),
      fallback,
      { onDegrade: (reason) => reasons.push(reason) },
    );
    expect(controller.currentMode()).toBe("orb");

    const first = await controller.setMode("compact");
    expect(first).toMatchObject({
      ok: true,
      backend: "electron-geometry",
      mode: "compact",
      degradedFrom: { backend: "hyprland", reason: "socket gone" },
    });
    expect(controller.backend).toBe("electron-geometry");
    expect(controller.currentMode()).toBe("compact");
    expect(await controller.focus()).toMatchObject({ degradedFrom: { reason: "socket gone" } });
    expect(reasons).toEqual(["socket gone"]);
  });
});
