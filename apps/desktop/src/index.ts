/**
 * @clarkcant/app-desktop
 *
 * Thin Electron shell. It hosts the shared conversation components and exposes OS
 * dialogs, notifications and credential-store access through typed IPC. It contains no
 * scheduler and no command logic: closing the window is not the same as stopping work.
 *
 * @implementation-status stub
 * TODO(P1): `main.mjs`, `preload.mjs` and the renderer entry. The security configuration
 * is fixed and non-negotiable when it is written: `nodeIntegration: false`,
 * `contextIsolation: true`, a CSP, IPC sender validation, and no generic shell or IPC
 * bridge — the main process exposes named methods rather than a transport.
 *
 * Electron is declared in this package's `devDependencies` but its install script is
 * gated by `allowBuilds` in `pnpm-workspace.yaml`, so the platform binary is only
 * downloaded once that entry is deliberately approved.
 */

export interface DesktopBridge {
  openExternal(url: string): Promise<void>;
  showNotification(input: { title: string; body: string }): Promise<void>;
  /** Secret entry happens in a host-owned window, never in a widget frame. */
  requestCredential(input: { requestId: string; purpose: string }): Promise<{ stored: boolean }>;
  setKeepRunningOnWindowClose(keep: boolean): Promise<void>;
}

/**
 * @implementation-status stub
 * TODO(P1): see above. The macOS permissions and signing work that gates the native
 * drivers belongs to P8, not here.
 */
export const DESKTOP_STATUS = "not-implemented";
