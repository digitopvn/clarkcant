/**
 * The detached window's preload bridge.
 *
 * Narrower than the main bridge, and the narrowness is the point: no `openExternal`, no `requestCredential`, no
 * `getSession`. A detached window is a view of one widget instance, and the local token is what would turn that
 * view into the whole conversation — so the token is not reachable from this bridge at all, rather than being
 * reachable and refused.
 *
 * CommonJS because a sandboxed preload cannot be an ES module, the same trade the main bridge makes.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clarkcantDetached", {
  /**
   * The instance this window is a view of.
   *
   * The host answers, and it answers with the three fields in `detachedBootstrap` and nothing else. The renderer
   * asks; it never holds a credential with which it could ask for more.
   */
  bootstrap() {
    return ipcRenderer.invoke("detached:bootstrap");
  },
  /**
   * Hands the instance back to the window that owns the conversation.
   *
   * The host performs the ownership handoff in both directions, so closing this window is a request rather than a
   * claim: the renderer cannot leave the instance ownerless by disappearing.
   */
  release() {
    return ipcRenderer.invoke("detached:release");
  },
});
