#!/usr/bin/env node
/**
 * Install the packed widget author tooling into an empty project outside this repository and use it there.
 *
 *     node tools/smoke-widget-tooling.mjs [--archives <dir>] [--keep]
 *
 * This is the check that the published `@clarkcant/widget-cli` and `@clarkcant/widget-sdk` work without a checkout:
 *
 *   1. build and `pnpm pack` both packages (`tools/build-widget-tooling.mjs`) into a fresh temporary directory, or,
 *      with `--archives`, take the two archives already in that directory (the release smoke-tests what it publishes);
 *   2. create an empty project under the OS temporary directory and `pnpm add` the two archives — from the local
 *      files, not a registry (their third-party dependencies still come from the configured registry or pnpm's store);
 *   3. refuse an installed manifest that still names `workspace:` and a bundle that still imports `@clarkcant/*`;
 *   4. run `clark` through the project's own bin shim: `--help`, `--version`, `widget init` and `widget test` for
 *      every template the installed CLI lists, and `widget pack` (which itself runs `pnpm pack` on the generated
 *      package.json) for the blank and `pure-ui` packages;
 *   5. start `clark widget dev` for the package and for a catalog widget, and `clark theme dev` for a theme package,
 *      fetch each page and the browser module it loads over HTTP, then stop the process and wait for it to exit;
 *   6. import both SDK entry points from the project and type-check a file that uses them, under `NodeNext` and
 *      under the older `node10` resolution.
 *
 * Every process it starts is tracked and stopped before it exits, including on failure and when the smoke itself is
 * interrupted (SIGINT/SIGTERM); on POSIX each dev process leads its own process group, and the group is signalled. The
 * temporary directory is removed afterwards unless `--keep` is passed. It needs `pnpm` on PATH (`corepack enable`) and network access for the
 * third-party dependencies, so it is not part of `pnpm test`; CI and the release workflow run it on every OS.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { buildWidgetTooling, repoRoot } from "./build-widget-tooling.mjs";

/** The version of the TypeScript compiler the type check installs: the one this repository pins. */
const TYPESCRIPT_VERSION = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).devDependencies.typescript;

/** A catalog widget the dev host can show without a package, so the catalog's bundled runtime is exercised too. */
const BUILTIN_WIDGET = "canvas.line@1";

const started = new Set();

/** The smoke's temporary directory, once made, and whether `--keep` asked to leave it. */
let scratchDir;
let keepScratch = false;

function log(line) {
  process.stdout.write(`${line}\n`);
}

/** Quote one argument for cmd.exe, refusing a character cmd would still interpret inside quotes. */
function cmdQuote(arg) {
  if (/["%^!&|<>\r\n]/.test(arg)) throw new Error(`refusing to pass ${JSON.stringify(arg)} through the Windows shell`);
  return /[\s]/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Run a command to completion. On Windows `pnpm` is a `.cmd` shim that only a shell resolves, so the command goes
 * through cmd with every argument checked and quoted; elsewhere it is spawned directly.
 */
function run(command, args, cwd, { expectStatus = 0 } = {}) {
  const options = { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, npm_config_ignore_scripts: "true" } };
  const result =
    process.platform === "win32" && command !== process.execPath
      ? spawnSync([command, ...args].map(cmdQuote).join(" "), { ...options, shell: true })
      : spawnSync(command, args, options);
  const shown = `${basename(command)} ${args.join(" ")}`;
  if (result.error !== undefined) throw new Error(`${shown} could not start: ${result.error.message}`);
  if (result.status !== expectStatus) {
    throw new Error(`${shown} exited ${String(result.status)} (expected ${String(expectStatus)}) in ${cwd}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchText(url, expectStatus = 200) {
  const response = await fetch(url, { signal: globalThis.AbortSignal.timeout(60_000) });
  const text = await response.text();
  assert(response.status === expectStatus, `GET ${url} answered ${String(response.status)}, expected ${String(expectStatus)}:\n${text.slice(0, 400)}`);
  return { text, type: response.headers.get("content-type") ?? "" };
}

/** Signal a dev process: its whole process group on POSIX, where it was started as the group's leader. */
function signal(child, name) {
  try {
    process.kill(-child.pid, name);
  } catch {
    child.kill(name);
  }
}

/** Stop a process this script started and wait for it to be gone; the whole tree on Windows, the group elsewhere. */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    started.delete(child);
    return;
  }
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  if (process.platform === "win32") {
    // Windows has no termination signal a process can handle; end the tree so nothing it spawned outlives it.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    signal(child, "SIGTERM");
  }
  const outcome = await Promise.race([exited, delay(15_000).then(() => undefined)]);
  if (outcome === undefined) {
    signal(child, "SIGKILL");
    await exited;
    started.delete(child);
    throw new Error(`process ${String(child.pid)} ignored the termination request and was killed`);
  }
  started.delete(child);
  return outcome;
}

/**
 * Start a `clark <group> dev` command and resolve with its URL once it prints one.
 *
 * Its temporary directory is pointed inside `scratch`: Windows can only terminate the process, so the module server's
 * scratch cache it would have removed on a clean stop is removed with the rest of the smoke's files instead.
 */
async function startDev(cliEntry, cwd, scratch, args, group = "widget") {
  const temp = join(scratch, "tmp");
  mkdirSync(temp, { recursive: true });
  const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
  // Its own process group on POSIX, so stopping it reaches anything it starts; Windows ends the tree with taskkill.
  const detached = process.platform !== "win32";
  const child = spawn(process.execPath, [cliEntry, group, "dev", ...args, "--port", "0"], { cwd, env, detached, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  started.add(child);
  let output = "";
  const url = await new Promise((done, failed) => {
    const timer = setTimeout(() => failed(new Error(`clark ${group} dev printed no URL within 60s:\n${output}`)), 60_000);
    const read = (chunk) => {
      output += String(chunk);
      const match = /dev host: (http:\/\/127\.0\.0\.1:\d+)\/?/i.exec(output);
      if (match !== null) {
        clearTimeout(timer);
        done(`${match[1]}/`);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("exit", (code) => {
      clearTimeout(timer);
      failed(new Error(`clark ${group} dev exited ${String(code)} before serving:\n${output}`));
    });
  });
  return { child, url, output: () => output };
}

/**
 * Run `body` against a started dev process, then stop the process. A failure to stop is reported without hiding the
 * body's own failure: both are thrown together.
 */
async function usingDev(dev, label, body) {
  let failure;
  try {
    await body();
  } catch (error) {
    failure = error;
  }
  let outcome;
  try {
    outcome = await stop(dev.child);
  } catch (stopError) {
    throw failure === undefined ? stopError : new AggregateError([failure, stopError], `${label} failed, and so did stopping it`);
  }
  if (failure !== undefined) throw failure;
  return outcome;
}

async function devSmoke(cliEntry, project, scratch) {
  // A package: the shell, the frame's entry page, and the bridge runtime served from the bundled module.
  const dev = await startDev(cliEntry, project, scratch, [PURE_WIDGET]);
  const outcome = await usingDev(dev, "dev (package)", async () => {
    const shell = await fetchText(dev.url);
    assert(shell.type.startsWith("text/html"), `the dev shell is ${shell.type}, not HTML`);
    const prefix = /\/dev\/frame\/[0-9a-f]{32}/.exec(shell.text)?.[0];
    assert(prefix !== undefined, "the dev shell names no frame URL");
    const entry = await fetchText(new URL(`${prefix}/widgets/main/index.html`, dev.url).href);
    assert(entry.text.includes(`${prefix}/widget-runtime.js`), "the frame's entry page does not load the widget runtime");
    const runtime = await fetchText(new URL(`${prefix}/widget-runtime.js`, dev.url).href);
    assert(/javascript/.test(runtime.type), `the widget runtime is served as ${runtime.type}`);
    assert(runtime.text.includes("clarkcantWidget"), "the widget runtime module is not the bridge runtime");
    log(`  dev (package): ${dev.url} served the shell, the frame and its runtime (${String(runtime.text.length)} bytes)`);
  });
  const how = outcome === undefined ? "already exited" : process.platform === "win32" ? "terminated" : `exit ${String(outcome.code ?? outcome.signal)}`;
  log(`  dev (package): stopped (${how})`);
  // On POSIX the command handles SIGTERM by closing its host and exiting cleanly; Windows can only terminate it.
  if (process.platform !== "win32" && outcome !== undefined) {
    assert(outcome.code === 0, `clark widget dev did not close cleanly on SIGTERM (exit ${String(outcome.code ?? outcome.signal)})`);
  }

  // A catalog widget: drawn by the production renderer from the bundled catalog runtime.
  const builtin = await startDev(cliEntry, project, scratch, ["--builtin", BUILTIN_WIDGET]);
  await usingDev(builtin, "dev (catalog)", async () => {
    const page = await fetchText(new URL("catalog-runtime.html", builtin.url).href);
    const src = /<script type="module" src="([^"]+)"/.exec(page.text)?.[1];
    assert(src === "/runtime/catalog-runtime.js", `the catalog frame loads ${String(src)}, not the bundled runtime`);
    const module = await fetchText(new URL(src, builtin.url).href);
    assert(/javascript/.test(module.type), `the catalog runtime is served as ${module.type}`);
    log(`  dev (catalog ${BUILTIN_WIDGET}): served the frame and its bundled runtime (${String(module.text.length)} bytes)`);
  });
  log("  dev (catalog): stopped");

  // A theme package: the Theme Lab page and its bundled runtime.
  const theme = await startDev(cliEntry, project, scratch, ["my-theme"], "theme");
  await usingDev(theme, "theme dev", async () => {
    const page = await fetchText(theme.url);
    assert(page.text.includes("/runtime/theme-dev-runtime.js"), "the Theme Lab page does not load the bundled runtime");
    const module = await fetchText(new URL("/runtime/theme-dev-runtime.js", theme.url).href);
    assert(/javascript/.test(module.type), `the theme runtime is served as ${module.type}`);
    log(`  theme dev: served the Theme Lab and its bundled runtime (${String(module.text.length)} bytes)`);
  });
  log("  theme dev: stopped");
}

function checkInstalled(project) {
  const scope = join(project, "node_modules", "@clarkcant");
  const installed = readdirSync(scope).sort();
  assert(installed.join(",") === "widget-cli,widget-sdk", `node_modules/@clarkcant holds ${installed.join(", ")}, not exactly the two packages`);
  for (const name of installed) {
    const manifestText = readFileSync(join(scope, name, "package.json"), "utf8");
    assert(!manifestText.includes("workspace:"), `@clarkcant/${name}'s installed package.json still names a workspace: specifier`);
    const manifest = JSON.parse(manifestText);
    assert(manifest.private !== true, `@clarkcant/${name} is installed as private`);
  }
  const cliManifest = JSON.parse(readFileSync(join(scope, "widget-cli", "package.json"), "utf8"));
  const cliEntry = join(scope, "widget-cli", cliManifest.bin.clark);
  for (const file of [cliEntry, ...readdirSync(join(scope, "widget-sdk", "lib")).map((name) => join(scope, "widget-sdk", "lib", name))]) {
    const text = readFileSync(file, "utf8");
    assert(!/(?:from\s*|import\s*\(\s*)["']@clarkcant\//.test(text), `${relative(project, file)} still imports a workspace package`);
  }
  return cliEntry;
}

function sdkSmoke(project) {
  writeFileSync(
    join(project, "sdk-import.mjs"),
    [
      'import { createWidgetRuntime, BRIDGE_PROTOCOL } from "@clarkcant/widget-sdk";',
      'import { bindAppearance } from "@clarkcant/widget-sdk/dom";',
      'if (typeof createWidgetRuntime !== "function" || typeof bindAppearance !== "function") throw new Error("SDK exports are missing");',
      'console.log(`sdk ${BRIDGE_PROTOCOL}`);',
      "",
    ].join("\n"),
  );
  const imported = run(process.execPath, ["sdk-import.mjs"], project);
  assert(imported.includes("sdk agent.widgetbridge"), `the SDK import printed ${imported}`);

  writeFileSync(
    join(project, "sdk-types.ts"),
    [
      'import { createWidgetRuntime, type MessageEndpoint } from "@clarkcant/widget-sdk";',
      'import { bindAppearance } from "@clarkcant/widget-sdk/dom";',
      "",
      "export function start(endpoint: MessageEndpoint, element: HTMLElement): () => void {",
      "  const runtime = createWidgetRuntime({ endpoint });",
      "  return bindAppearance(element, runtime.api().appearance);",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(project, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          types: [],
          // Off on purpose: this checks the published declarations themselves, not only their use here.
          skipLibCheck: false,
        },
        files: ["sdk-types.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const tsc = join(project, "node_modules", "typescript", "bin", "tsc");
  run(process.execPath, [tsc, "-p", "tsconfig.json"], project);

  // The older resolution ignores `exports`: the `./dom` subpath's types then come from `typesVersions`.
  writeFileSync(
    join(project, "tsconfig.node10.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "ESNext",
          moduleResolution: "node10",
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          strict: true,
          noEmit: true,
          types: [],
          skipLibCheck: true,
        },
        files: ["sdk-types.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, [tsc, "-p", "tsconfig.node10.json"], project);
}

/** The one archive of `name` in `dir`, as `pnpm pack` names it (`clarkcant-widget-cli-<version>.tgz`). */
function archiveIn(dir, name) {
  const prefix = `${name.replace(/^@/, "").replace("/", "-")}-`;
  const found = readdirSync(dir).filter((file) => file.startsWith(prefix) && file.endsWith(".tgz") && /^\d/.test(file.slice(prefix.length)));
  assert(found.length === 1 && found[0] !== undefined, `expected exactly one ${prefix}<version>.tgz in ${dir}, found ${found.join(", ") || "none"}`);
  return join(dir, found[0]);
}

/** Stop every process this script started, then remove its temporary directory unless it is to be kept. */
async function cleanUp() {
  for (const child of [...started]) {
    await stop(child).catch((error) => process.stderr.write(`  could not stop process ${String(child.pid)}: ${error instanceof Error ? error.message : String(error)}\n`));
  }
  if (scratchDir === undefined) return;
  if (keepScratch) log(`  kept ${scratchDir}`);
  // The promise form: on Windows `rmSync` fails at once on a folder a stopped process still holds, whatever its retries.
  else await rm(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  scratchDir = undefined;
}

/** The templates `clark widget init` lists in its help, read from the installed CLI rather than from this checkout. */
function templatesIn(help) {
  const listed = /--template ([a-z0-9|-]+)\]/.exec(help)?.[1];
  assert(listed !== undefined, `clark --help lists no templates:\n${help}`);
  return listed.split("|");
}

const PURE_WIDGET = "pure-ui-widget";

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  keepScratch = keep;
  const archivesIndex = args.indexOf("--archives");
  const archivesDir = archivesIndex === -1 ? undefined : args[archivesIndex + 1];
  const unknown = args.filter((arg, index) => arg !== "--keep" && arg !== "--archives" && !(archivesIndex !== -1 && index === archivesIndex + 1));
  if (unknown.length > 0 || (archivesIndex !== -1 && (archivesDir === undefined || archivesDir.startsWith("--")))) {
    process.stderr.write("usage: node tools/smoke-widget-tooling.mjs [--archives <dir>] [--keep]\n");
    return 2;
  }
  const scratch = mkdtempSync(join(tmpdir(), "clark-tooling-smoke-"));
  scratchDir = scratch;
  // On Windows a scratch directory on another drive has no relative path to the repository: `relative` returns it whole.
  const fromRepo = relative(repoRoot, scratch);
  assert(fromRepo.startsWith("..") || isAbsolute(fromRepo), `the scratch directory ${scratch} is inside the repository`);
  log(`widget tooling smoke on ${process.platform}-${process.arch}, node ${process.version}`);
  log(`  scratch: ${scratch}`);
  try {
    // The release packs once and smoke-tests those exact archives on every runner; locally, pack them fresh.
    const archives =
      archivesDir === undefined
        ? (await buildWidgetTooling({ outRoot: join(scratch, "stage"), packInto: join(scratch, "archives") })).archives
        : { cli: archiveIn(resolve(archivesDir), "@clarkcant/widget-cli"), sdk: archiveIn(resolve(archivesDir), "@clarkcant/widget-sdk") };
    log(`  ${archivesDir === undefined ? "packed" : "using"} ${basename(archives.cli)} and ${basename(archives.sdk)}`);

    const project = join(scratch, "project");
    mkdirSync(join(project, "vendor"), { recursive: true });
    for (const archive of [archives.cli, archives.sdk]) copyFileSync(archive, join(project, "vendor", basename(archive)));
    writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "widget-tooling-smoke", version: "0.0.0", private: true, type: "module" }, null, 2)}\n`);
    // The same supply-chain hold the repository applies: no dependency published less than a day ago.
    run("pnpm", ["add", "--config.minimum-release-age=1440", "--save-exact", "-D", `./vendor/${basename(archives.cli)}`, `./vendor/${basename(archives.sdk)}`, `typescript@${TYPESCRIPT_VERSION}`], project);
    const cliEntry = checkInstalled(project);
    log("  installed both archives into an empty project outside the repository");

    const help = run("pnpm", ["exec", "clark", "--help"], project);
    assert(help.includes("clark widget init"), "clark --help did not print the widget commands");
    const version = run("pnpm", ["exec", "clark", "--version"], project).trim();
    const installedVersion = JSON.parse(readFileSync(join(project, "node_modules", "@clarkcant", "widget-cli", "package.json"), "utf8")).version;
    assert(version === installedVersion, `clark --version printed ${JSON.stringify(version)}, not ${installedVersion}`);

    // Every template the installed CLI offers starts a package that passes its own conformance suite.
    const templates = templatesIn(help);
    assert(templates.includes("blank") && templates.includes("pure-ui"), `the CLI lists ${templates.join(", ")}`);
    for (const template of templates) {
      const widget = `${template}-widget`;
      run("pnpm", ["exec", "clark", "widget", "init", widget, "--template", template], project);
      run("pnpm", ["exec", "clark", "widget", "test", widget], project);
    }
    log(`  init and test passed for every template: ${templates.join(", ")}`);
    for (const widget of ["blank-widget", PURE_WIDGET]) {
      run("pnpm", ["exec", "clark", "widget", "pack", widget], project);
      const artifact = JSON.parse(readFileSync(join(project, widget, "dist", "artifact.json"), "utf8"));
      assert(artifact.npm !== undefined && existsSync(join(project, widget, "dist", artifact.npm.tarball)), `${widget} was packed without its npm archive`);
      log(`  ${widget}: pack passed (${artifact.npm.tarball}, ${artifact.npm.integrity.slice(0, 19)}…)`);
    }
    // Refused, not silently accepted: a template the CLI does not ship.
    run("pnpm", ["exec", "clark", "widget", "init", "nope", "--template", "no-such-template"], project, { expectStatus: 2 });
    run("pnpm", ["exec", "clark", "theme", "init", "my-theme"], project);
    run("pnpm", ["exec", "clark", "theme", "test", "my-theme"], project);
    log("  my-theme: theme init and test passed");

    await devSmoke(cliEntry, project, scratch);
    sdkSmoke(project);
    log("  SDK: both entry points import from the project and its declarations type-check (NodeNext and node10)");
    log("widget tooling smoke passed");
    return 0;
  } finally {
    await cleanUp();
  }
}

function describe(error) {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map((inner) => `  - ${describe(inner)}`)].join("\n");
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // Interrupted, the smoke still stops what it started and removes its files before it exits.
  for (const name of ["SIGINT", "SIGTERM"]) {
    process.once(name, () => {
      process.stderr.write(`widget tooling smoke interrupted (${name}); stopping its processes\n`);
      void cleanUp().finally(() => process.exit(name === "SIGINT" ? 130 : 143));
    });
  }
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`widget tooling smoke failed: ${describe(error)}\n`);
    process.exitCode = 1;
  }
}
