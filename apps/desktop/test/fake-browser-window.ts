/**
 * A stand-in for the Electron `BrowserWindow` methods the window controllers call.
 *
 * It behaves like a window that honours every request, and records each call, so a contract test can say both what the
 * controller asked for and what it then reported. `honourPosition: false` plays a native Wayland compositor, which keeps
 * the window where it decided regardless of the position requested.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FakeWindowOptions {
  bounds?: Bounds;
  honourPosition?: boolean;
  fullScreenable?: boolean;
  minimizable?: boolean;
}

export interface FakeBrowserWindow {
  calls: string[];
  getBounds(): Bounds;
  setBounds(bounds: Bounds): void;
  getMinimumSize(): number[];
  isAlwaysOnTop(): boolean;
  setAlwaysOnTop(value: boolean): void;
  isFocused(): boolean;
  focus(): void;
  isMinimized(): boolean;
  minimize(): void;
  restore(): void;
  isMinimizable(): boolean;
  isFullScreen(): boolean;
  isFullScreenable(): boolean;
  setFullScreen(value: boolean): void;
  getTitle(): string;
  once(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
}

export function fakeBrowserWindow(options: FakeWindowOptions = {}): FakeBrowserWindow {
  let bounds: Bounds = options.bounds ?? { x: 100, y: 80, width: 1100, height: 760 };
  let alwaysOnTop = false;
  let focused = false;
  let minimized = false;
  let fullScreen = false;
  const listeners = new Map<string, Set<() => void>>();
  const calls: string[] = [];

  function emit(event: string): void {
    const set = listeners.get(event);
    if (set === undefined) return;
    listeners.delete(event);
    for (const listener of set) listener();
  }

  return {
    calls,
    getBounds: () => ({ ...bounds }),
    setBounds(next) {
      calls.push(`setBounds ${next.x},${next.y} ${next.width}x${next.height}`);
      bounds =
        options.honourPosition === false
          ? { ...bounds, width: next.width, height: next.height }
          : { x: next.x, y: next.y, width: next.width, height: next.height };
    },
    getMinimumSize: () => [20, 50],
    isAlwaysOnTop: () => alwaysOnTop,
    setAlwaysOnTop(value) {
      calls.push(`setAlwaysOnTop ${value}`);
      // Electron keeps its own flag even where nothing honours it, which is exactly why the controller must not
      // report this flag under native Wayland.
      alwaysOnTop = value;
    },
    isFocused: () => focused,
    focus() {
      calls.push("focus");
      focused = true;
    },
    isMinimized: () => minimized,
    minimize() {
      calls.push("minimize");
      minimized = true;
    },
    restore() {
      calls.push("restore");
      minimized = false;
    },
    isMinimizable: () => options.minimizable !== false,
    isFullScreen: () => fullScreen,
    isFullScreenable: () => options.fullScreenable !== false,
    setFullScreen(value) {
      calls.push(`setFullScreen ${value}`);
      fullScreen = value;
      emit(value ? "enter-full-screen" : "leave-full-screen");
    },
    getTitle: () => "clarkcant",
    once(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };
}
