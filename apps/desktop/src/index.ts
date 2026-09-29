/**
 * @clarkcant/app-desktop
 *
 * Thin Electron shell. It hosts the shared conversation components and exposes OS dialogs,
 * notifications and credential prompts through named IPC methods. It contains no scheduler and
 * no command logic: closing the window is not the same as stopping work.
 *
 * The security posture is fixed and is enforced in `security.mjs`, which is plain JavaScript on
 * purpose — it is imported by both the Electron main process and the Node test suite, so the
 * posture is checked by a test run rather than by reading `main.mjs`.
 *
 * Verified behaviour, by running the shell: `electron . --smoke-test` starts a real window with
 * a real preload bridge, calls the bridge from inside the renderer, and asserts that a named
 * bridge exists, that Node is unreachable from the renderer, and that http, file and script
 * schemes are all refused. The macOS permission grants and signing work that gates the native
 * drivers belongs to P8 and issue #3, not here.
 */

export interface DesktopBridge {
  openExternal(url: string): Promise<{ ok: boolean; opened?: string; refused?: string }>;
  showNotification(input: { title: string; body: string }): Promise<{ ok: boolean; shown?: unknown }>;
  /**
   * The OS directory dialog.
   *
   * Answers with the path the user picked in a host-owned window, or `canceled: true` when they
   * dismissed it. A path is the answer to the node's own "which directory?" question, so it travels
   * back as the request's text rather than as a second way to start a session.
   */
  pickDirectory(input?: { title?: string }): Promise<{ ok: boolean; path?: string; canceled?: boolean; refused?: string }>;
  /**
   * The OS file dialog, for a widget's pick. Answers with the chosen file's bare name, type and bytes and an opaque
   * handle the main process maps to its path — the path itself never reaches the renderer.
   */
  pickFile(input: { title?: string; accept?: readonly string[] }): Promise<{
    ok: boolean;
    canceled?: boolean;
    refused?: string;
    file?: { name: string; mimeType: string; contentBase64: string; handle: string };
  }>;
  /** Save As for exported bytes, or a write back over a picked file named by its handle. Desktop only. */
  saveFile(input: { suggestedName: string; contentBase64: string; replaceHandle?: string }): Promise<{
    ok: boolean;
    canceled?: boolean;
    saved?: boolean;
    name?: string;
    refused?: string;
  }>;
  /** Secret entry happens in a host-owned window, never in a widget frame. */
  requestCredential(input: { requestId: string; purpose: string }): Promise<{ ok: boolean; stored?: boolean }>;
  setKeepRunningOnWindowClose(keep: boolean): Promise<{ ok: boolean; keepRunningOnWindowClose?: boolean }>;
  status(): Promise<Record<string, unknown>>;
}

/**
 * The named methods the preload exposes.
 *
 * Listed here as well as in `preload.mjs` so a reviewer can see the renderer's whole reach in
 * one place. `IPC_CHANNELS` in `security.mjs` remains the enforcing copy.
 */
export const DESKTOP_BRIDGE_METHODS = [
  "openExternal",
  "notify",
  "pickDirectory",
  "pickFile",
  "saveFile",
  "requestCredential",
  "setKeepRunningOnWindowClose",
  "status",
] as const;

export const DESKTOP_STATUS = "implemented-thin-shell";
