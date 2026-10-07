import { describe, expect, it } from "vitest";

import {
  FULL_GEOMETRY,
  WAYLAND_GEOMETRY,
  detectWindowSession,
  geometrySupportFor,
  selectWindowBackend,
} from "../src/window-session.mjs";

/**
 * Which desktop session the window is in, decided from the environment and Electron's switches without starting
 * Electron. The cases are the ones a Linux desktop actually produces: a plain X11 session, native Wayland (Electron's
 * default since 38 when the session is Wayland), XWayland forced by a switch, and Hyprland on top of either.
 */

const HYPRLAND_ENV = {
  WAYLAND_DISPLAY: "wayland-1",
  XDG_SESSION_TYPE: "wayland",
  DISPLAY: ":0",
  HYPRLAND_INSTANCE_SIGNATURE: "4520b30d498daca8079365bdb909a8dea38e8d55_1727000000_1234567890",
  XDG_RUNTIME_DIR: "/run/user/1000",
};

describe("detecting the desktop session", () => {
  it("names macOS and Windows without looking at the environment", () => {
    expect(detectWindowSession({ platform: "darwin", env: HYPRLAND_ENV }).kind).toBe("macos");
    expect(detectWindowSession({ platform: "win32", env: HYPRLAND_ENV })).toMatchObject({ kind: "windows", compositor: undefined });
  });

  it("an X11 session is X11", () => {
    expect(detectWindowSession({ platform: "linux", env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" } }).kind).toBe("x11");
  });

  it("a Wayland session runs Electron natively on Wayland unless a switch says otherwise", () => {
    expect(detectWindowSession({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" } }).kind).toBe("wayland");
    expect(detectWindowSession({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } }).kind).toBe("wayland");
  });

  it("an explicit --ozone-platform=x11 in a Wayland session is XWayland, and the explicit switch beats the hint", () => {
    const env = { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };
    expect(detectWindowSession({ platform: "linux", env, switches: { ozonePlatform: "x11" } }).kind).toBe("xwayland");
    expect(
      detectWindowSession({ platform: "linux", env, switches: { ozonePlatform: "wayland", ozonePlatformHint: "x11" } }).kind,
    ).toBe("wayland");
  });

  it("the hint switch is honoured when there is no explicit platform; the environment variable Electron dropped is not", () => {
    const env = { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" };
    expect(detectWindowSession({ platform: "linux", env, switches: { ozonePlatformHint: "x11" } }).kind).toBe("xwayland");
    // Electron 38+ ignores ELECTRON_OZONE_PLATFORM_HINT and runs native Wayland; reading it would offer a fake pin.
    expect(detectWindowSession({ platform: "linux", env: { ...env, ELECTRON_OZONE_PLATFORM_HINT: "x11" } }).kind).toBe("wayland");
    expect(detectWindowSession({ platform: "linux", env, switches: { ozonePlatform: "auto" } }).kind).toBe("wayland");
  });

  it("no display at all is headless", () => {
    expect(detectWindowSession({ platform: "linux", env: {} }).kind).toBe("headless");
  });

  it("finds Hyprland by its instance signature", () => {
    expect(detectWindowSession({ platform: "linux", env: HYPRLAND_ENV })).toEqual({
      platform: "linux",
      kind: "wayland",
      compositor: "hyprland",
      hyprland: { signature: HYPRLAND_ENV.HYPRLAND_INSTANCE_SIGNATURE, runtimeDir: "/run/user/1000" },
    });
  });

  it("refuses a signature or runtime directory that could point the socket anywhere else", () => {
    const traversal = { ...HYPRLAND_ENV, HYPRLAND_INSTANCE_SIGNATURE: "../../tmp/evil" };
    expect(detectWindowSession({ platform: "linux", env: traversal }).compositor).toBeUndefined();
    const relative = { ...HYPRLAND_ENV, XDG_RUNTIME_DIR: "run/user/1000" };
    expect(detectWindowSession({ platform: "linux", env: relative }).compositor).toBeUndefined();
    expect(detectWindowSession({ platform: "linux", env: { ...HYPRLAND_ENV, HYPRLAND_INSTANCE_SIGNATURE: "" } }).compositor).toBeUndefined();
  });
});

describe("what Electron geometry can ask for", () => {
  it("everything except under native Wayland, where neither position nor stacking is the app's", () => {
    expect(geometrySupportFor(detectWindowSession({ platform: "darwin" }))).toBe(FULL_GEOMETRY);
    expect(geometrySupportFor(detectWindowSession({ platform: "linux", env: { DISPLAY: ":0" } }))).toBe(FULL_GEOMETRY);
    expect(
      geometrySupportFor(detectWindowSession({ platform: "linux", env: HYPRLAND_ENV, switches: { ozonePlatform: "x11" } })),
    ).toBe(FULL_GEOMETRY);
    expect(geometrySupportFor(detectWindowSession({ platform: "linux", env: HYPRLAND_ENV }))).toBe(WAYLAND_GEOMETRY);
  });
});

describe("choosing the window backend", () => {
  const hyprland = detectWindowSession({ platform: "linux", env: HYPRLAND_ENV });
  const gnome = detectWindowSession({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } });

  it("is Electron geometry by default, Hyprland included, because the Hyprland backend is unverified", () => {
    expect(selectWindowBackend({ session: hyprland }).backend).toBe("electron-geometry");
    expect(selectWindowBackend({ session: detectWindowSession({ platform: "darwin" }) }).backend).toBe("electron-geometry");
  });

  it("uses Hyprland only when asked for and Hyprland is running", () => {
    expect(selectWindowBackend({ session: hyprland, requested: "hyprland" })).toEqual({
      backend: "hyprland",
      reason: "asked for, and Hyprland is running",
    });
    expect(selectWindowBackend({ session: hyprland, requested: " Hyprland " }).backend).toBe("hyprland");
    expect(selectWindowBackend({ session: gnome, requested: "hyprland" })).toEqual({
      backend: "electron-geometry",
      reason: "the Hyprland backend was asked for, but this session is not Hyprland",
    });
  });

  it("explains native Wayland's limits and an unknown request instead of guessing", () => {
    expect(selectWindowBackend({ session: gnome }).reason).toMatch(/native Wayland/);
    expect(selectWindowBackend({ session: hyprland, requested: "sway" })).toEqual({
      backend: "electron-geometry",
      reason: '"sway" is not a window backend this build knows',
    });
    expect(selectWindowBackend({ session: hyprland, requested: "electron" }).backend).toBe("electron-geometry");
  });
});
