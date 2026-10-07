import type { BrowserType } from "@playwright/test";

/**
 * Launch arguments that keep a test Chromium's loopback connections reliable on Windows.
 *
 * Chromium 139+ sets SO_RANDOMIZE_PORT on every TCP socket on Windows 11 22H2 and later, which includes the Windows
 * Server 2025 CI runners (the `TcpPortRandomizationWin` feature). Now and then the randomly picked local port collides
 * and connect() fails at once with WSAENOBUFS, which a page reports as `net::ERR_NO_BUFFER_SPACE`. That happens
 * against a loopback dev host with nothing leaking: the browser suites peak at about 60 loopback sockets in TIME_WAIT
 * out of a 16,384-port range. Measured on Windows 11 with Playwright's Chromium, 540,000 loopback connects failed 32
 * times that way with the feature on, and 540,000 with it off failed none. The suites test our hosts, not Chromium's
 * port privacy, so they turn it off.
 *
 * Chromium keeps only the last `--disable-features` switch, so a second one would silently re-enable everything
 * Playwright disables (third-party storage partitioning, paint holding, HTTPS upgrades, ...). The list is therefore
 * read from the command line Playwright actually launches and extended, rather than copied here and left to drift.
 * Reading it costs one short launch per process, and only on Windows; elsewhere the feature does not exist.
 */
const portRandomization = "TcpPortRandomizationWin";
const disableFeatures = "--disable-features=";
const cached = new WeakMap<BrowserType, Promise<string[]>>();

export function chromiumTestArgs(launcher: BrowserType): Promise<string[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  let args = cached.get(launcher);
  if (args === undefined) {
    args = withoutPortRandomization(launcher);
    cached.set(launcher, args);
  }
  return args;
}

async function withoutPortRandomization(launcher: BrowserType): Promise<string[]> {
  // The browser hands its command line over CDP only when started with --enable-automation; this probe is discarded.
  const browser = await launcher.launch({ headless: true, args: ["--enable-automation"] });
  try {
    const session = await browser.newBrowserCDPSession();
    const { arguments: argv } = await session.send("Browser.getBrowserCommandLine");
    const current = argv.findLast((arg) => arg.startsWith(disableFeatures));
    const features = current === undefined ? [] : current.slice(disableFeatures.length).split(",").filter((name) => name !== "");
    return [`${disableFeatures}${[...features, portRandomization].join(",")}`];
  } finally {
    await browser.close();
  }
}
