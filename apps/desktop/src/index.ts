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
  "requestCredential",
  "setKeepRunningOnWindowClose",
  "status",
] as const;

export const DESKTOP_STATUS = "implemented-thin-shell";
