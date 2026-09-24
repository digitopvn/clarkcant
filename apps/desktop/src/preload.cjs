/**
 * Preload bridge.
 *
 * CommonJS, and it has to be: a sandboxed preload script cannot be an ES module. The sandbox is
 * what removes Node primitives from the renderer, so the trade goes the right way round — the
 * bridge gives up ESM syntax in exchange for keeping the sandbox. Loading this file as `.mjs`
 * produces a bridge that never appears, which is why `electron . --smoke-test` asserts that
 * `window.clarkcant` exists rather than assuming the file loaded.
 *
 * Named methods only. There is deliberately no `invoke(channel, ...args)` passthrough: a generic
 * bridge would expose every channel to any script running in the renderer, which makes the main
 * process's channel allowlist decorative.
 */

const { contextBridge, ipcRenderer } = require("electron");

const bridge = {
  openExternal(url) {
    return ipcRenderer.invoke("desktop:openExternal", url);
  },
  notify(input) {
    return ipcRenderer.invoke("desktop:notify", input);
  },
  /**
   * Told when the person clicks an OS notification the shell showed, so the renderer that is actually
   * displaying the conversation can open the inbox through its own `inbox.open` intent.
   *
   * A named subscription rather than a generic `on(channel)`, for the same reason `onWidgetReattached` is one.
   * Returns the unsubscribe: the polling hook that calls this remounts on every client change, and an
   * `ipcRenderer.on` this preload never removes would pile up one live listener per remount, each still firing
   * its now-stale closure on every future click.
   */
  onNotificationClicked(callback) {
    const listener = () => callback();
    ipcRenderer.on("desktop:notificationClicked", listener);
    return () => ipcRenderer.removeListener("desktop:notificationClicked", listener);
  },
  /** Opens the OS directory dialog. Answers with the chosen path, or `canceled` when dismissed. */
  pickDirectory(input) {
    return ipcRenderer.invoke("desktop:pickDirectory", input);
  },
  requestCredential(input) {
    return ipcRenderer.invoke("desktop:requestCredential", input);
  },
  setKeepRunningOnWindowClose(keep) {
    return ipcRenderer.invoke("desktop:setKeepRunning", keep);
  },
  status() {
    return ipcRenderer.invoke("desktop:getStatus");
  },
  /**
   * The node this window belongs to, or a refusal saying why there is none.
   *
   * The token comes through here rather than through the window's URL, where it would end up in history and
   * in the address bar, and rather than through the command line, where it would end up in a process list.
   */
  getSession() {
    return ipcRenderer.invoke("desktop:getSession");
  },
  /**
   * Move a widget instance into its own window.
   *
   * The widget's composition travels with the request because the shell already has it, and the host decides
   * whether it may: the window that opens receives that composition and no credential, so it can draw the
   * instance without being able to read the conversation it came from.
   */
  detachWidget(input) {
    return ipcRenderer.invoke("desktop:detachWidget", input);
  },
  /** Hand the instance back, closing its window. */
  attachWidget() {
    return ipcRenderer.invoke("desktop:attachWidget");
  },
  /**
   * Told when a detached window closes, so the shell can take the instance back.
   *
   * A named subscription rather than a generic `on(channel)`: a generic listener would hand the renderer every
   * channel the main process can push, which is the same mistake as a generic `invoke`.
   */
  onWidgetReattached(callback) {
    ipcRenderer.on("desktop:widgetReattached", (_event, payload) => callback(payload));
  },
  /**
   * Shrink the window to the voice bar, grow it back, or pin it above other windows.
   *
   * Answers with the bounds and the pin state the window actually has afterwards, not with what was asked for,
   * because the operating system may clamp either one.
   */
  setCompactMode(input) {
    return ipcRenderer.invoke("desktop:setCompactMode", input);
  },
  /**
   * The window's named modes: normal, expanded, compact, orb.
   *
   * A mode rather than pixel numbers, because bounds live in the main process: a renderer that could ask for
   * arbitrary geometry could ask for a window off the edge of the screen or larger than the display, and the
   * work-area arithmetic that prevents that is on the other side of this boundary.
   */
  setWindowMode(mode) {
    return ipcRenderer.invoke("desktop:setWindowMode", mode);
  },
  /** Resize to one of the named presets, leaving the mode alone. */
  resizeWindowPreset(name) {
    return ipcRenderer.invoke("desktop:resizeWindowPreset", name);
  },
  /** Return the window to the size and place it had before it was collapsed. */
  restoreWindow() {
    return ipcRenderer.invoke("desktop:restoreWindow");
  },
  /** Bring the window forward, for a request that came from voice or from another surface. */
  focusWindow() {
    return ipcRenderer.invoke("desktop:focusWindow");
  },
};

contextBridge.exposeInMainWorld("clarkcant", bridge);
