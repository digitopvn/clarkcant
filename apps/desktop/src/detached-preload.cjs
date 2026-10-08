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

/*
 * Clark's performs can reach this window as soon as it loads, and the page subscribes only once its frame's component
 * mounts. A perform pushed in between is held here rather than dropped, and handed to the page when it subscribes: the
 * page answers it, as not mounted if its frame is not open yet, so the node hears what happened instead of a silence the
 * host reports as "not answered". One held as long as the host waits for an answer (`DETACHED_PERFORM_LIMITS.
 * answerWithinMs`, which `preload-subscriptions.spec.ts` holds this to) is dropped: the host has answered the node for
 * it already, and the widget must not act on it after that.
 */
const PERFORM_HELD_MS = 7_000;
const performListeners = new Set();
let heldPerforms = [];
const unexpiredPerforms = () => {
  const now = Date.now();
  return heldPerforms.filter((held) => now - held.at < PERFORM_HELD_MS);
};
ipcRenderer.on("detached:perform", (_event, push) => {
  if (performListeners.size === 0) {
    heldPerforms = [...unexpiredPerforms(), { push, at: Date.now() }];
    return;
  }
  for (const listener of [...performListeners]) listener(push);
});
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
   * The frame's files, jobs and browser tokens, one method per verb. Each takes the frame's own request — an artifact,
   * a job or its token session, never the instance — and the host performs it against the instance it opened this
   * window for. A pick and an export open the OS dialog over this window; the bytes and the path stay in the host.
   */
  artifacts: {
    pick: (input) => ipcRenderer.invoke("detached:artifacts.pick", input),
    describe: (input) => ipcRenderer.invoke("detached:artifacts.describe", input),
    create: (input) => ipcRenderer.invoke("detached:artifacts.create", input),
    read: (input) => ipcRenderer.invoke("detached:artifacts.read", input),
    write: (input) => ipcRenderer.invoke("detached:artifacts.write", input),
    finalize: (input) => ipcRenderer.invoke("detached:artifacts.finalize", input),
    export: (input) => ipcRenderer.invoke("detached:artifacts.export", input),
    attach: (input) => ipcRenderer.invoke("detached:artifacts.attach", input),
    discard: (input) => ipcRenderer.invoke("detached:artifacts.discard", input),
  },
  jobs: {
    get: (input) => ipcRenderer.invoke("detached:jobs.get", input),
    list: () => ipcRenderer.invoke("detached:jobs.list"),
    cancel: (input) => ipcRenderer.invoke("detached:jobs.cancel", input),
  },
  tokens: {
    request: (input) => ipcRenderer.invoke("detached:tokens.request", input),
    end: (input) => ipcRenderer.invoke("detached:tokens.end", input),
  },
  /** Told when the installed packages changed, so the window re-reads its frame. Returns the unsubscribe. */
  onPackagesChanged(callback) {
    const listener = () => callback();
    ipcRenderer.on("detached:packagesChanged", listener);
    return () => ipcRenderer.removeListener("detached:packagesChanged", listener);
  },
  /**
   * Told of each action Clark asks this window's widget to perform: `{ performId, action, input }`, nothing else. The
   * window asks its frame and answers with `reportPerform`. A perform pushed while nothing listened is handed over on
   * subscribing, unless the host has stopped waiting on it. Returns the unsubscribe.
   */
  onPerform(callback) {
    const listener = (push) => callback(push);
    performListeners.add(listener);
    const held = unexpiredPerforms();
    heldPerforms = [];
    for (const { push } of held) listener(push);
    return () => {
      performListeners.delete(listener);
    };
  },
  /** What the frame answered to a pushed perform: `{ performId, report }`. The host refuses an id it did not push. */
  reportPerform(answer) {
    return ipcRenderer.invoke("detached:perform.report", answer);
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
