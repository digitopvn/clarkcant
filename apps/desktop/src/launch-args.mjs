/**
 * The arguments the desktop shell is launched with.
 *
 * `--` goes straight after the app path, before any flag. Electron on Windows refuses to start - it exits `-1` with no
 * output - when any argument follows a URL-shaped one and no `--` came earlier: its guard against a protocol handler
 * smuggling switches into the command line. `--renderer-url http://…` followed by `--data-dir` is exactly that shape.
 * After `--`, Chromium stops reading switches, and `main.mjs` still finds every flag, because it looks them up in
 * `process.argv` by name rather than by position.
 *
 * Built here rather than inline in each launcher, so every launcher gets the separator and a test can pin it.
 *
 * @param {string} appDir the desktop app's directory (the one holding its `package.json`)
 * @param {readonly string[]} flags the shell's own flags, such as `--renderer-url <url>`
 * @returns {string[]}
 */
export function shellLaunchArgs(appDir, flags) {
  return [appDir, "--", ...flags];
}
