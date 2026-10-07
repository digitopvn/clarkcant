import { describe, expect, it } from "vitest";

import { createHyprlandWindowController, findOwnClient } from "../src/hyprland-window-controller.mjs";
import { createElectronGeometryController, withFallbackController } from "../src/window-controller.mjs";
import { WAYLAND_GEOMETRY } from "../src/window-session.mjs";
import { fakeBrowserWindow } from "./fake-browser-window.ts";

/**
 * The Hyprland backend's command mapping, against an in-memory stand-in for Hyprland's request socket.
 *
 * The stand-in implements the handful of dispatchers the backend uses, with Hyprland's documented semantics (`pin`
 * toggles and only pins floating windows, `fullscreen` acts on the focused window), and records every request. These
 * tests prove what the backend asks Hyprland for; they do not prove what a real Hyprland does with it, which still
 * needs a live compositor.
 */

const PID = 4242;
const ADDRESS = "0x55d1c0ffee00";
const DETACHED = "0x55d1c0ffee99";

interface FakeClient {
  address: string;
  pid: number;
  title: string;
  floating: boolean;
  pinned: boolean;
  fullscreen: number;
  at: [number, number];
  size: [number, number];
}

/** `exact <a> <b>,<window>`, the only form of the pixel dispatchers the backend sends. */
function exactPair(args: string): { first: number; second: number; selector: string } {
  const match = /^exact (-?\d+) (-?\d+),(address:0x[0-9a-f]+)$/i.exec(args);
  if (match === null) throw new Error(`unexpected pixel arguments ${args}`);
  return { first: Number(match[1]), second: Number(match[2]), selector: String(match[3]) };
}

function fakeHyprland(overrides: Partial<FakeClient> = {}, extra: FakeClient[] = [], { delayMs = 0 } = {}) {
  const ours: FakeClient = {
    address: ADDRESS,
    pid: PID,
    title: "clarkcant",
    floating: false,
    pinned: false,
    fullscreen: 0,
    at: [10, 40],
    size: [1200, 800],
    ...overrides,
  };
  const clients = [ours, ...extra];
  const dispatched: string[] = [];
  /** Every request in arrival order, queries included. */
  const requests: string[] = [];
  let focused = ours.address;
  let failOn: string | undefined;

  const byAddress = (selector: string) => {
    const address = selector.replace(/^address:/, "");
    const client = clients.find((entry) => entry.address === address);
    if (client === undefined) throw new Error(`no client ${selector}`);
    return client;
  };

  async function request(text: string): Promise<string> {
    requests.push(text);
    // A socket round trip takes time; a delay lets two verbs overlap the way they would against a real compositor.
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (text === "j/clients") return JSON.stringify(clients);
    const command = text.replace(/^dispatch /, "");
    dispatched.push(command);
    if (failOn !== undefined && command.startsWith(failOn)) return "Invalid dispatcher";
    const [name, ...rest] = command.split(" ");
    const args = rest.join(" ");
    switch (name) {
      case "focuswindow":
        focused = byAddress(args).address;
        break;
      case "setfloating":
        byAddress(args).floating = true;
        break;
      case "settiled":
        byAddress(args).floating = false;
        break;
      case "pin": {
        const client = byAddress(args);
        if (client.floating) client.pinned = !client.pinned;
        break;
      }
      case "resizewindowpixel": {
        const { first, second, selector } = exactPair(args);
        byAddress(selector).size = [first, second];
        break;
      }
      case "movewindowpixel": {
        const { first, second, selector } = exactPair(args);
        byAddress(selector).at = [first, second];
        break;
      }
      case "fullscreen": {
        const [mode, action] = args.split(" ");
        const bit = mode === "1" ? 1 : 2;
        const client = byAddress(focused);
        client.fullscreen = action === "set" ? bit : client.fullscreen & ~bit;
        break;
      }
      default:
        return `unknown dispatcher ${name}`;
    }
    return "ok";
  }

  return {
    request,
    ours,
    dispatched,
    requests,
    failNext(prefix: string) {
      failOn = prefix;
    },
  };
}

function hyprlandController(hyprland: ReturnType<typeof fakeHyprland>, window = fakeBrowserWindow()) {
  return createHyprlandWindowController({ request: hyprland.request, getWindow: () => window, pid: PID });
}

describe("finding this app's window among Hyprland's clients", () => {
  const base = { pid: PID, floating: false, pinned: false, fullscreen: 0, at: [0, 0], size: [800, 600] };

  it("picks the conversation by pid and title when the detached widget window shares the pid", () => {
    const clients = [
      { ...base, address: DETACHED, title: "Widget" },
      { ...base, address: ADDRESS, title: "clarkcant" },
    ];
    expect(findOwnClient(clients, { pid: PID, title: "clarkcant" }).address).toBe(ADDRESS);
  });

  it("refuses to guess between two windows it cannot tell apart, or when there is none", () => {
    const twins = [
      { ...base, address: DETACHED, title: "clarkcant" },
      { ...base, address: ADDRESS, title: "clarkcant" },
    ];
    expect(() => findOwnClient(twins, { pid: PID, title: "clarkcant" })).toThrow(/more than one window/);
    expect(() => findOwnClient([], { pid: PID, title: "clarkcant" })).toThrow(/no window/);
    expect(() => findOwnClient({}, { pid: PID, title: "clarkcant" })).toThrow(/not a list/);
  });

  it("never puts an address it does not recognise into a command", () => {
    const hostile = [{ ...base, address: "0x1; dispatch exec rm", title: "clarkcant" }];
    expect(() => findOwnClient(hostile, { pid: PID, title: "clarkcant" })).toThrow(/address/);
  });

  it("reads both the old boolean and the newer bit-field full-screen state", () => {
    const old = { ...base, address: ADDRESS, title: "clarkcant", fullscreen: true, fullscreenMode: 1 };
    expect(findOwnClient([old], { pid: PID, title: "clarkcant" }).fullscreen).toBe(1);
    const current = { ...base, address: ADDRESS, title: "clarkcant", fullscreen: 2 };
    expect(findOwnClient([current], { pid: PID, title: "clarkcant" }).fullscreen).toBe(2);
  });
});

describe("the four modes as Hyprland dispatchers", () => {
  it("orb floats the window at the orb's size and pins it; normal puts the tile back and takes the pin away", async () => {
    const hyprland = fakeHyprland();
    const controller = hyprlandController(hyprland);

    const orb = await controller.setMode("orb");
    expect(hyprland.dispatched).toEqual([
      `setfloating address:${ADDRESS}`,
      `resizewindowpixel exact 148 148,address:${ADDRESS}`,
      `pin address:${ADDRESS}`,
    ]);
    expect(orb).toMatchObject({
      ok: true,
      backend: "hyprland",
      mode: "orb",
      bounds: { width: 148, height: 148 },
      alwaysOnTop: true,
      applied: ["float", "size", "pin"],
      unsupported: [],
    });

    hyprland.dispatched.length = 0;
    const normal = await controller.setMode("normal");
    expect(hyprland.dispatched).toEqual([`pin address:${ADDRESS}`, `settiled address:${ADDRESS}`]);
    expect(normal).toMatchObject({ mode: "normal", alwaysOnTop: false, applied: ["pin", "tile"] });
    expect(hyprland.ours.floating).toBe(false);
  });

  it("a conversation that was floating comes back at its own size and place", async () => {
    const hyprland = fakeHyprland({ floating: true, at: [300, 200], size: [900, 700] });
    const controller = hyprlandController(hyprland);
    await controller.setMode("compact");
    await controller.setMode("orb");
    expect(controller.collapsedNormalBounds()).toEqual({ x: 300, y: 200, width: 900, height: 700 });

    const normal = await controller.setMode("normal");
    expect(normal).toMatchObject({ bounds: { x: 300, y: 200, width: 900, height: 700 }, alwaysOnTop: false });
  });

  it("leaves a pin the person chose when leaving the orb", async () => {
    const hyprland = fakeHyprland({ floating: true, pinned: true });
    const controller = hyprlandController(hyprland);
    await controller.setMode("orb");
    expect(hyprland.dispatched.some((command) => command.startsWith("pin"))).toBe(false);
    expect(await controller.setMode("normal")).toMatchObject({ alwaysOnTop: true });
  });

  it("the bar after the orb drops only the orb's pin", async () => {
    const hyprland = fakeHyprland();
    const controller = hyprlandController(hyprland);
    await controller.setMode("orb");
    expect(await controller.setMode("compact")).toMatchObject({ mode: "compact", alwaysOnTop: false, bounds: { width: 68 } });
  });

  it("expanded is Hyprland's maximize, on the focused window, and leaving it unmaximizes first", async () => {
    const hyprland = fakeHyprland();
    const controller = hyprlandController(hyprland);
    expect(await controller.setMode("expanded")).toMatchObject({ mode: "expanded", applied: ["maximize"] });
    expect(hyprland.dispatched).toEqual([`focuswindow address:${ADDRESS}`, "fullscreen 1 set"]);

    hyprland.dispatched.length = 0;
    await controller.setMode("compact");
    expect(hyprland.dispatched.slice(0, 2)).toEqual([`focuswindow address:${ADDRESS}`, "fullscreen 1 unset"]);
    expect(hyprland.ours.fullscreen).toBe(0);
  });

  it("refuses an unknown mode before asking Hyprland for anything, not even its client list", async () => {
    const hyprland = fakeHyprland();
    expect(await hyprlandController(hyprland).setMode("toast")).toEqual({
      ok: false,
      refused: '"toast" is not a window mode this build knows',
    });
    expect(hyprland.requests).toEqual([]);
  });

  it("runs overlapping verbs one after another, so a pin during the orb's collapse is not toggled twice", async () => {
    const hyprland = fakeHyprland({}, [], { delayMs: 2 });
    const controller = hyprlandController(hyprland);

    const [orb, pin] = await Promise.all([controller.setMode("orb"), controller.setPinned(true)]);
    expect(hyprland.requests).toEqual([
      "j/clients",
      `dispatch setfloating address:${ADDRESS}`,
      "dispatch resizewindowpixel exact 148 148,address:" + ADDRESS,
      `dispatch pin address:${ADDRESS}`,
      "j/clients",
      // The pin reads the window after the orb finished: already floating and pinned, so it sends nothing.
      "j/clients",
      "j/clients",
    ]);
    expect(orb).toMatchObject({ ok: true, mode: "orb", alwaysOnTop: true });
    expect(pin).toMatchObject({ ok: true, alwaysOnTop: true });

    // The person's pin now owns it: leaving the orb keeps the window pinned.
    expect(await controller.setMode("normal")).toMatchObject({ mode: "normal", alwaysOnTop: true });
  });

  it("a failed verb does not block the ones queued behind it", async () => {
    const hyprland = fakeHyprland();
    hyprland.failNext("setfloating");
    const controller = hyprlandController(hyprland);
    const failing = controller.setMode("compact");
    const next = controller.focus();
    await expect(failing).rejects.toThrow(/did not accept/);
    expect(await next).toMatchObject({ ok: true, applied: ["focus"] });
  });
});

describe("pin, focus, full screen and minimize", () => {
  it("pinning floats a tiled window first, because Hyprland pins only floating windows", async () => {
    const hyprland = fakeHyprland();
    const controller = hyprlandController(hyprland);
    expect(await controller.setPinned(true)).toMatchObject({ ok: true, alwaysOnTop: true });
    expect(hyprland.dispatched).toEqual([`setfloating address:${ADDRESS}`, `pin address:${ADDRESS}`]);
    hyprland.dispatched.length = 0;
    expect(await controller.setPinned(true)).toMatchObject({ alwaysOnTop: true });
    expect(hyprland.dispatched).toEqual([]);
    expect(await controller.setPinned(false)).toMatchObject({ alwaysOnTop: false });
  });

  it("focus names the window instead of trusting whichever is active", async () => {
    const hyprland = fakeHyprland();
    expect(await hyprlandController(hyprland).focus()).toMatchObject({ ok: true, applied: ["focus"] });
    expect(hyprland.dispatched).toEqual([`focuswindow address:${ADDRESS}`]);
  });

  it("full screen grows the bar back into the conversation first and reads the result back", async () => {
    const hyprland = fakeHyprland();
    const controller = hyprlandController(hyprland);
    await controller.setMode("compact");
    hyprland.dispatched.length = 0;
    expect(await controller.setFullscreen(true)).toMatchObject({ ok: true, mode: "normal", fullScreen: true });
    expect(hyprland.dispatched).toEqual([
      `settiled address:${ADDRESS}`,
      `focuswindow address:${ADDRESS}`,
      "fullscreen 0 set",
    ]);
    expect(await controller.setFullscreen(false)).toMatchObject({ fullScreen: false });
  });

  it("minimize is refused, because Hyprland has no minimized state", async () => {
    const hyprland = fakeHyprland();
    expect(await hyprlandController(hyprland).minimize()).toEqual({
      ok: false,
      refused: "Hyprland has no minimized windows, so the window was left where it is",
    });
    expect(hyprland.dispatched).toEqual([]);
  });

  it("answers with no window when the conversation window is gone", async () => {
    const controller = createHyprlandWindowController({ request: fakeHyprland().request, getWindow: () => undefined, pid: PID });
    expect(await controller.setMode("orb")).toEqual({ ok: false, refused: "there is no window to resize" });
    expect(await controller.focus()).toEqual({ ok: false, refused: "there is no window to focus" });
    expect(await controller.snapshot()).toBeUndefined();
  });
});

describe("degrading to Electron geometry", () => {
  it("a dispatcher Hyprland does not accept throws, and the window falls back to Electron geometry", async () => {
    const hyprland = fakeHyprland();
    hyprland.failNext("setfloating");
    const window = fakeBrowserWindow({ bounds: { x: 0, y: 0, width: 1200, height: 800 }, honourPosition: false });
    const fallback = createElectronGeometryController({
      getWindow: () => window,
      workAreaFor: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
      support: WAYLAND_GEOMETRY,
    });
    const controller = withFallbackController(hyprlandController(hyprland, window), fallback);

    const answer = await controller.setMode("orb");
    expect(answer).toMatchObject({
      ok: true,
      backend: "electron-geometry",
      mode: "orb",
      bounds: { width: 148, height: 148 },
      unsupported: [{ part: "position" }],
      degradedFrom: { backend: "hyprland" },
    });
    expect(controller.backend).toBe("electron-geometry");
  });

  it("a socket that fails or answers nonsense degrades the same way", async () => {
    const window = fakeBrowserWindow();
    const fallback = createElectronGeometryController({
      getWindow: () => window,
      workAreaFor: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
      support: WAYLAND_GEOMETRY,
    });
    const broken = createHyprlandWindowController({
      request: async () => "not json",
      getWindow: () => window,
      pid: PID,
    });
    const controller = withFallbackController(broken, fallback);
    expect(await controller.snapshot()).toMatchObject({
      backend: "electron-geometry",
      pinnable: false,
      degradedFrom: { backend: "hyprland", reason: "Hyprland's client list was not JSON" },
    });
  });
});
