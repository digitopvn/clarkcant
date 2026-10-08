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
  onAppearance(callback) {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("detached:appearance", listener);
    return () => ipcRenderer.removeListener("detached:appearance", listener);
  },
  /**
   * Asks the host to perform an action on this instance.
   *
   * The window holds no token, so it cannot invoke anything itself — and it must not, because the credential that
   * would let it is the credential that reads the whole conversation. So the intent travels to the host, which
   * performs it with its own credentials and resolves the binding digest from the composition it handed over.
   *
   * This method was missing until the desktop smoke test asked a real detached window what it could reach: the host
   * implemented the channel and the UI called this function, so the window drew correctly and threw on the first
   * press. A bridge that is one verb short looks entirely healthy until somebody uses it.
   */
  intent(input) {
    return ipcRenderer.invoke("detached:intent", input);
  },
  /*
   * The relays a widget in its own frame needs. Each takes only what the frame said — never an instance, a
   * conversation, a gateway or a token — and the host performs it against the instance it opened this window for.
   */
  /** A fresh read of this instance: a new frame URL and the bindings, state and status the node holds now. */
  frameRead() {
    return ipcRenderer.invoke("detached:frame.read");
  },
  /** Commit a state write the frame made: `{ expectedRevision, patch }`. */
  saveState(write) {
    return ipcRenderer.invoke("detached:state.save", write);
  },
  /** Tell the node what the frame says it shows: `{ proposal }`. */
  publishSemantic(input) {
    return ipcRenderer.invoke("detached:semantic.publish", input);
  },
  /** The build status of the widget dev session this frame runs, without the developer's folder path. */
  devSession() {
    return ipcRenderer.invoke("detached:dev.session");
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
