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
};

contextBridge.exposeInMainWorld("clarkcant", bridge);
