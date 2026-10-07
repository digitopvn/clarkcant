/**
 * Chromium switches the desktop shell sets on itself before the app is ready.
 *
 * On Windows 11 22H2 and later, recent Chromium sets SO_RANDOMIZE_PORT on every TCP socket (the `TcpPortRandomizationWin`
 * feature, enabled by default in the Chromium that Electron 44 ships). Now and then the randomly picked local port
 * collides and connect() fails at once with WSAENOBUFS, which the renderer sees as `net::ERR_NO_BUFFER_SPACE`. Measured
 * against loopback with Playwright's Chromium, 32 of 540,000 connects failed that way with the feature on and none with
 * it off. The window talks only to its own node, usually over loopback, and a single failed connect there is a lost message or
 * action: the client's requests are not retried, because a send cannot tell "never left" from "left and failed". The
 * feature protects web pages from counting each other's connections, which a window that loads only its own node does
 * not need, so the shell turns it off.
 *
 * Chromium keeps only the last `--disable-features` value, and Electron adds its own list to whichever value that is.
 * The switch is therefore extended rather than replaced, so a list someone passed on the command line keeps working.
 * Electron reads the feature list again after the main script has run, which is what lets a switch set here take effect.
 */

const DISABLE_FEATURES = "disable-features";
const PORT_RANDOMIZATION = "TcpPortRandomizationWin";

/**
 * The `--disable-features` value the shell should run with, or `undefined` when it needs no change.
 *
 * @param {string} current the value already on the command line, empty when there is none
 * @param {string} platform `process.platform`
 * @returns {string | undefined}
 */
export function disabledFeaturesValue(current, platform) {
  // The feature exists only on Windows; elsewhere there is nothing to turn off.
  if (platform !== "win32") return undefined;
  const features = current.split(",").map((name) => name.trim()).filter((name) => name !== "");
  if (features.includes(PORT_RANDOMIZATION)) return undefined;
  return [...features, PORT_RANDOMIZATION].join(",");
}

/**
 * Apply the shell's switches to Electron's command line. Must run before the app is ready.
 *
 * @param {{ getSwitchValue(name: string): string; appendSwitch(name: string, value?: string): void }} commandLine
 * @param {string} platform `process.platform`
 */
export function applyChromiumSwitches(commandLine, platform) {
  const value = disabledFeaturesValue(commandLine.getSwitchValue(DISABLE_FEATURES), platform);
  if (value !== undefined) commandLine.appendSwitch(DISABLE_FEATURES, value);
}
