#!/usr/bin/env node
/**
 * Build the publishable npm packages of the widget author tooling: `@clarkcant/widget-cli` (the `clark` command) and
 * `@clarkcant/widget-sdk`.
 *
 *     node tools/build-widget-tooling.mjs                stage both packages under dist/widget-tooling/<name>/
 *     node tools/build-widget-tooling.mjs --pack [DIR]   stage them, then `pnpm pack` each into DIR
 *                                                        (default dist/widget-tooling/archives/)
 *
 * Inside this repository both packages stay `private` and resolve to their TypeScript source, like every workspace
 * package; nothing here changes how the workspace imports them. A published package cannot work that way: Node does
 * not strip types from files under `node_modules`, the `@clarkcant/*` packages they import are private workspace
 * packages that are never published, and the CLI copies its templates from `examples/reference-apps/`. So this script
 * generates a separate, self-contained package directory for each, and that directory is what gets packed and
 * published:
 *
 *   - the code is bundled with esbuild, the workspace packages inlined from source and every third-party import left
 *     external and declared as a dependency at the exact version the importing workspace package pins;
 *   - the SDK's two entry points (`.` and `./dom`) are bundled for the browser, so a Node builtin anywhere in their
 *     graph fails the build, and ship declarations emitted by the TypeScript compiler, with workspace imports
 *     rewritten to the copies shipped beside them;
 *   - the CLI ships its reference templates under `templates/` and the dev hosts' browser modules as self-contained
 *     bundles under `runtime/`, where `packages/widget-cli/src/package-assets.ts` looks for them first.
 *
 * The generated `package.json` holds no `workspace:` specifier, no lifecycle script and no `private` flag, and the
 * build refuses to finish if a bundle imports something its owning workspace package does not declare.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** The repository these packages are published from; npm provenance checks the package's `repository` against it. */
const REPOSITORY_URL = "git+https://github.com/digitopvn/clarkcant.git";
const HOMEPAGE = "https://github.com/digitopvn/clarkcant/blob/main/docs/widget-development.md";

/** The reference apps `clark widget init` copies; see `packages/widget-cli/src/reference-templates.ts`. */
const REFERENCE_APPS = ["text-editor", "image-generator", "media-render", "connected-app"];

/** A reference app's own tests and readmes describe that app, not the package a template starts; the copier skips them. */
const TEMPLATE_SKIPPED = new Set(["test", "dist", "node_modules", "README.md", "README.vi.md"]);

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/* ------------------------------------------------------------------ pure helpers (unit-tested) */

/** The package a bare specifier names: `zod/v4` is `zod`, `@scope/name/sub` is `@scope/name`. */
export function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

export function isNodeBuiltin(specifier) {
  return specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0] ?? "");
}

/**
 * The dependencies a bundle needs: every external third-party import, at the version its importer declares.
 *
 * `imports` pairs each external specifier with the workspace manifest of the package whose source imported it. A
 * package that imports something it does not declare is an error rather than a guess, and so is a version that is not
 * exact or two importers that disagree: the published package would otherwise install something nobody pinned.
 */
export function resolveExternalDependencies(imports) {
  const versions = new Map();
  const problems = [];
  for (const { specifier, importer } of imports) {
    if (isNodeBuiltin(specifier)) continue;
    const name = packageNameOf(specifier);
    const declared = importer.dependencies?.[name] ?? importer.peerDependencies?.[name];
    if (declared === undefined) {
      problems.push(`${importer.name} imports ${specifier} but does not declare ${name} as a dependency`);
      continue;
    }
    if (!EXACT_VERSION.test(declared)) {
      problems.push(`${importer.name} declares ${name}@${declared}; a published package needs an exact version`);
      continue;
    }
    const previous = versions.get(name);
    if (previous !== undefined && previous.version !== declared) {
      problems.push(`${name} is declared as ${previous.version} by ${previous.by} and ${declared} by ${importer.name}`);
      continue;
    }
    versions.set(name, { version: declared, by: importer.name });
  }
  if (problems.length > 0) throw new Error(`the bundle's dependencies cannot be published:\n  - ${problems.join("\n  - ")}`);
  return Object.fromEntries([...versions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, { version }]) => [name, version]));
}

/**
 * Rewrite the module specifiers of one emitted declaration file so it resolves inside the published package.
 *
 * - `./x.ts` and `./x.tsx` become `./x.js`, which TypeScript resolves to the `x.d.ts` beside it;
 * - `@clarkcant/<name>[/sub]` becomes a relative path to that workspace package's declarations, which ship in the
 *   same `types/` tree (`resolveWorkspace` maps a specifier to the declaration path, relative to `types/`, without
 *   its `.d.ts`);
 * - any other bare specifier is returned in `bare` so the caller can require it to be a declared dependency.
 *
 * `specifiers` are the module references the TypeScript compiler found in the file (`ts.preProcessFile`): each one's
 * text and where it starts (`pos`, which is the opening quote), so a quoted phrase in a doc comment is never mistaken
 * for an import.
 */
export function rewriteDeclarationSpecifiers(text, fileFromTypesRoot, resolveWorkspace, specifiers) {
  const bare = new Set();
  let rewritten = text;
  for (const { fileName: specifier, pos } of [...specifiers].sort((a, b) => b.pos - a.pos)) {
    const start = text[pos] === '"' || text[pos] === "'" ? pos + 1 : pos;
    const end = start + specifier.length;
    if (text.slice(start, end) !== specifier) throw new Error(`${fileFromTypesRoot}: ${specifier} is not where the compiler placed it`);
    let replacement = specifier;
    if (specifier.startsWith(".")) {
      replacement = specifier.replace(/\.tsx?$/, ".js");
    } else if (specifier.startsWith("@clarkcant/")) {
      const target = resolveWorkspace(specifier);
      if (target === undefined) throw new Error(`${fileFromTypesRoot} imports ${specifier}, which no workspace package exports`);
      replacement = posix.relative(posix.dirname(fileFromTypesRoot), `${target}.js`);
      if (!replacement.startsWith(".")) replacement = `./${replacement}`;
    } else {
      bare.add(specifier);
    }
    rewritten = `${rewritten.slice(0, start)}${replacement}${rewritten.slice(end)}`;
  }
  return { text: rewritten, bare: [...bare] };
}

/* ------------------------------------------------------------------ workspace */

/** Every workspace package by name: its directory and manifest. */
export function readWorkspace(root = repoRoot) {
  const packages = new Map();
  for (const group of ["packages", "packs"]) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const manifestPath = join(groupDir, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      packages.set(manifest.name, { dir: join(groupDir, entry.name), manifest });
    }
  }
  return packages;
}

/** The workspace package whose directory holds `file`, or undefined for a file outside every package. */
function owningPackage(workspace, file) {
  let best;
  for (const pkg of workspace.values()) {
    if ((file === pkg.dir || file.startsWith(pkg.dir + sep)) && (best === undefined || pkg.dir.length > best.dir.length)) best = pkg;
  }
  return best;
}

function exactVersionOf(manifest) {
  if (typeof manifest.version !== "string" || !EXACT_VERSION.test(manifest.version)) {
    throw new Error(`${manifest.name} has version ${JSON.stringify(manifest.version)}, which is not a publishable exact version`);
  }
  return manifest.version;
}

/* ------------------------------------------------------------------ bundling */

/**
 * An esbuild plugin that leaves every third-party import external and bundles the workspace's own packages from
 * source. `allowNodeBuiltins` is false for a browser bundle, where a builtin is a build error rather than an import.
 */
function thirdPartyExternal({ allowNodeBuiltins }) {
  return {
    name: "third-party-external",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point" || args.path.startsWith(".") || isAbsolute(args.path)) return undefined;
        if (args.path.startsWith("@clarkcant/")) return undefined;
        if (isNodeBuiltin(args.path)) {
          return allowNodeBuiltins
            ? { path: args.path, external: true }
            : { errors: [{ text: `${args.path} is a Node builtin, which a browser entry point cannot import (from ${args.importer})` }] };
        }
        return { path: args.path, external: true };
      });
    },
  };
}

/** The external imports a metafile records, each with the workspace manifest of the module that made it. */
function externalImports(metafile, workspace) {
  const imports = [];
  for (const [input, { imports: inputImports }] of Object.entries(metafile.inputs)) {
    for (const entry of inputImports) {
      if (entry.external !== true || isNodeBuiltin(entry.path)) continue;
      const importerFile = resolve(repoRoot, input);
      const owner = owningPackage(workspace, importerFile);
      if (owner === undefined) throw new Error(`${input} imports ${entry.path} but belongs to no workspace package`);
      imports.push({ specifier: entry.path, importer: owner.manifest });
    }
  }
  return imports;
}

async function loadEsbuild() {
  try {
    return await import("esbuild");
  } catch (error) {
    throw new Error("esbuild is not installed; run `pnpm install` at the repository root first", { cause: error });
  }
}

/* ------------------------------------------------------------------ declarations */

/**
 * Emit declarations for `entries` and everything they import from the workspace, into `typesDir`, laid out as
 * `<package dir relative to the repository>/…d.ts`. Returns the declared third-party packages the declarations import.
 */
async function emitDeclarations({ entries, typesDir, workspace }) {
  const { default: ts } = await import("typescript");
  const configPath = join(repoRoot, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot);
  const scratch = join(typesDir, "..", ".types-scratch");
  rmSync(scratch, { recursive: true, force: true });
  const options = {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    composite: false,
    incremental: false,
    allowJs: false,
    outDir: scratch,
    rootDir: repoRoot,
    // The SDK is a browser library: declarations that needed Node's types would fail here rather than on a consumer.
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
    jsx: ts.JsxEmit.ReactJSX,
  };
  const program = ts.createProgram({ rootNames: entries, options });
  const emitted = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
  if (diagnostics.length > 0) {
    const host = { getCanonicalFileName: (name) => name, getCurrentDirectory: () => repoRoot, getNewLine: () => "\n" };
    throw new Error(`declaration emit failed:\n${ts.formatDiagnostics(diagnostics, host)}`);
  }

  /** `@clarkcant/name[/sub]` to its declaration path (relative to `types/`, without `.d.ts`). */
  const resolveWorkspace = (specifier) => {
    const name = packageNameOf(specifier);
    const pkg = workspace.get(name);
    if (pkg === undefined) return undefined;
    const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
    const target = pkg.manifest.exports?.[subpath] ?? (subpath === "." ? pkg.manifest.main : undefined);
    if (typeof target !== "string") return undefined;
    const fromRoot = relative(repoRoot, join(pkg.dir, target)).split(sep).join("/");
    return fromRoot.replace(/\.tsx?$/, "");
  };

  const bareImports = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.name.endsWith(".d.ts")) continue;
      const fromRoot = relative(scratch, full).split(sep).join("/");
      const source = readFileSync(full, "utf8");
      if (/\/\/\/\s*<reference\s+types=["']node["']/.test(source)) {
        throw new Error(`${fromRoot} references Node's types, which a browser package cannot require`);
      }
      const { importedFiles } = ts.preProcessFile(source, true, true);
      const { text, bare } = rewriteDeclarationSpecifiers(source, fromRoot, resolveWorkspace, importedFiles);
      const owner = owningPackage(workspace, join(repoRoot, fromRoot));
      if (owner === undefined) throw new Error(`${fromRoot} was emitted for a file outside every workspace package`);
      for (const specifier of bare) bareImports.push({ specifier, importer: owner.manifest });
      const target = join(typesDir, ...fromRoot.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  };
  visit(scratch);
  rmSync(scratch, { recursive: true, force: true });
  return { bareImports, resolveWorkspace };
}

/* ------------------------------------------------------------------ package files */

function readme(name, summary, usage) {
  return [
    `# ${name}`,
    "",
    summary.en,
    "",
    usage,
    "",
    `Documentation: ${HOMEPAGE}`,
    "",
    "---",
    "",
    summary.vi,
    "",
    `Tài liệu: ${HOMEPAGE.replace("widget-development.md", "widget-development.vi.md")}`,
    "",
  ].join("\n");
}

function writePackageJson(stage, packageJson) {
  const text = `${JSON.stringify(packageJson, null, 2)}\n`;
  if (text.includes("workspace:")) throw new Error(`${packageJson.name}'s generated package.json still names a workspace: specifier`);
  writeFileSync(join(stage, "package.json"), text);
}

function commonFields(manifest, directory) {
  return {
    name: manifest.name,
    version: exactVersionOf(manifest),
    description: manifest.description,
    license: manifest.license,
    type: "module",
    homepage: HOMEPAGE,
    repository: { type: "git", url: REPOSITORY_URL, directory },
    bugs: { url: "https://github.com/digitopvn/clarkcant/issues" },
    engines: { node: ">=22.19.0" },
    // The scoped packages are public, and a release from CI attests where it was built.
    publishConfig: { access: "public", provenance: true },
  };
}

/* ------------------------------------------------------------------ the two packages */

async function buildSdk({ esbuild, workspace, outRoot }) {
  const pkg = workspace.get("@clarkcant/widget-sdk");
  if (pkg === undefined) throw new Error("the @clarkcant/widget-sdk workspace package is missing");
  const stage = join(outRoot, "widget-sdk");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const entries = { index: join(pkg.dir, "src", "index.ts"), dom: join(pkg.dir, "src", "dom.ts") };
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: entries,
    outdir: join(stage, "lib"),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
    logLevel: "silent",
    plugins: [thirdPartyExternal({ allowNodeBuiltins: false })],
  });
  const typesDir = join(stage, "types");
  const { bareImports, resolveWorkspace } = await emitDeclarations({ entries: Object.values(entries), typesDir, workspace });
  const dependencies = resolveExternalDependencies([...externalImports(result.metafile, workspace), ...bareImports]);

  const typesOf = (specifier) => `./types/${resolveWorkspace(specifier)}.d.ts`;
  for (const specifier of ["@clarkcant/widget-sdk", "@clarkcant/widget-sdk/dom"]) {
    if (!existsSync(join(stage, typesOf(specifier)))) throw new Error(`no declarations were emitted for ${specifier}`);
  }
  cpSync(join(repoRoot, "LICENSE"), join(stage, "LICENSE"));
  writeFileSync(
    join(stage, "README.md"),
    readme(
      pkg.manifest.name,
      {
        en: "The ClarkCant widget author SDK: the props, state, events, actions and semantic-surface contracts, and the bridge runtime a widget frame uses to talk to its host. Browser-safe ES modules with type declarations.",
        vi: "SDK cho tác giả widget ClarkCant: hợp đồng props, state, sự kiện, hành động và bề mặt ngữ nghĩa, cùng runtime cầu nối mà khung widget dùng để giao tiếp với host. Mô-đun ES an toàn cho trình duyệt, kèm khai báo kiểu.",
      },
      [
        "```ts",
        'import { createWidgetRuntime } from "@clarkcant/widget-sdk";',
        'import { bindAppearance } from "@clarkcant/widget-sdk/dom";',
        "```",
      ].join("\n"),
    ),
  );
  writePackageJson(stage, {
    ...commonFields(pkg.manifest, "packages/widget-sdk"),
    sideEffects: false,
    main: "./lib/index.js",
    types: typesOf("@clarkcant/widget-sdk"),
    exports: {
      ".": { types: typesOf("@clarkcant/widget-sdk"), default: "./lib/index.js" },
      "./dom": { types: typesOf("@clarkcant/widget-sdk/dom"), default: "./lib/dom.js" },
      "./package.json": "./package.json",
    },
    files: ["lib/", "types/", "README.md", "LICENSE"],
    keywords: ["clarkcant", "widget", "sdk"],
    dependencies,
  });
  return stage;
}

async function buildCli({ esbuild, workspace, outRoot }) {
  const pkg = workspace.get("@clarkcant/widget-cli");
  if (pkg === undefined) throw new Error("the @clarkcant/widget-cli workspace package is missing");
  const stage = join(outRoot, "widget-cli");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  // The command: Node code, workspace packages inlined, third-party packages installed beside it.
  const node = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: { cli: join(pkg.dir, "src", "cli.ts") },
    outdir: join(stage, "lib"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    jsx: "automatic",
    metafile: true,
    logLevel: "silent",
    plugins: [thirdPartyExternal({ allowNodeBuiltins: true })],
  });
  const dependencies = resolveExternalDependencies(externalImports(node.metafile, workspace));

  // The dev hosts' browser modules: everything inlined, React included, so Vite serves them without resolving anything.
  await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: {
      "dev-frame-runtime": join(pkg.dir, "src", "dev-frame-runtime.ts"),
      "catalog-runtime": join(pkg.dir, "src", "catalog-runtime.tsx"),
      "theme-dev-runtime": join(pkg.dir, "src", "theme-dev-runtime.tsx"),
    },
    outdir: join(stage, "runtime"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });

  for (const app of REFERENCE_APPS) {
    const source = join(repoRoot, "examples", "reference-apps", app);
    if (!existsSync(join(source, "clarkcant.json"))) throw new Error(`the ${app} reference app is missing from ${source}`);
    cpSync(source, join(stage, "templates", app), {
      recursive: true,
      filter: (path) => {
        const fromApp = relative(source, path).split(sep);
        return !fromApp.includes("node_modules") && !(fromApp.length >= 1 && TEMPLATE_SKIPPED.has(fromApp[0] ?? ""));
      },
    });
  }

  cpSync(join(repoRoot, "LICENSE"), join(stage, "LICENSE"));
  writeFileSync(
    join(stage, "README.md"),
    readme(
      pkg.manifest.name,
      {
        en: "`clark`, the ClarkCant widget author CLI: scaffold a widget package, run the conformance suite, preview it in the local dev host, and pack the npm archive with its digests. A local package needs no account.",
        vi: "`clark`, CLI cho tác giả widget ClarkCant: tạo gói widget, chạy bộ kiểm tra tuân thủ, xem trước trong dev host cục bộ và đóng gói tệp npm kèm các digest. Gói cục bộ không cần tài khoản.",
      },
      [
        "```sh",
        "pnpm add -D @clarkcant/widget-cli",
        "pnpm exec clark widget init my-widget --template pure-ui",
        "pnpm exec clark widget test my-widget",
        "pnpm exec clark widget dev my-widget",
        "pnpm exec clark widget pack my-widget",
        "```",
      ].join("\n"),
    ),
  );
  writePackageJson(stage, {
    ...commonFields(pkg.manifest, "packages/widget-cli"),
    bin: { clark: "./lib/cli.js" },
    // The command is the supported surface; its modules are not a library API.
    exports: { "./package.json": "./package.json" },
    files: ["lib/", "runtime/", "templates/", "README.md", "LICENSE"],
    keywords: ["clarkcant", "widget", "cli"],
    dependencies,
  });
  return stage;
}

/** `pnpm pack` one staged package into `destination`, returning the archive's path. */
export function packStage(stage, destination) {
  mkdirSync(destination, { recursive: true });
  const before = new Set(readdirSync(destination));
  const options = { cwd: stage, encoding: "utf8", windowsHide: true, env: { ...process.env, npm_config_ignore_scripts: "true" } };
  // Windows resolves `pnpm.cmd` only through a shell; the one path in the command is refused if cmd would interpret it.
  if (process.platform === "win32" && /["%^!]/.test(destination)) throw new Error(`${destination} holds a character the Windows shell would interpret`);
  const result =
    process.platform === "win32"
      ? spawnSync(`pnpm pack --pack-destination "${destination}"`, { ...options, shell: true })
      : spawnSync("pnpm", ["pack", "--pack-destination", destination], options);
  if (result.error !== undefined) throw new Error(`could not run pnpm: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`pnpm pack failed in ${stage}:\n${(result.stderr || result.stdout).trim()}`);
  const written = readdirSync(destination).filter((name) => name.endsWith(".tgz") && !before.has(name));
  if (written.length !== 1 || written[0] === undefined) {
    const manifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
    const expected = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
    if (existsSync(join(destination, expected))) return join(destination, expected);
    throw new Error(`pnpm pack did not write exactly one archive into ${destination}`);
  }
  return join(destination, written[0]);
}

/** Where the packages are staged, and where `--pack` without a directory writes the archives. */
export const DEFAULT_STAGE_ROOT = join(repoRoot, "dist", "widget-tooling");
export const DEFAULT_ARCHIVES = join(DEFAULT_STAGE_ROOT, "archives");

/** Stage both packages under `outRoot`; with `packInto`, also pack each and return the archives. */
export async function buildWidgetTooling({ outRoot = DEFAULT_STAGE_ROOT, packInto } = {}) {
  const esbuild = await loadEsbuild();
  const workspace = readWorkspace();
  mkdirSync(outRoot, { recursive: true });
  const sdk = await buildSdk({ esbuild, workspace, outRoot });
  const cli = await buildCli({ esbuild, workspace, outRoot });
  const stages = { sdk, cli };
  if (packInto === undefined) return { stages };
  // Packed fresh: an archive left from an earlier build of the same version would otherwise be the one installed.
  for (const stage of [sdk, cli]) {
    const manifest = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
    rmSync(join(packInto, `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`), { force: true });
  }
  return { stages, archives: { sdk: packStage(sdk, packInto), cli: packStage(cli, packInto) } };
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const packIndex = args.indexOf("--pack");
  const packValue = packIndex === -1 ? undefined : args[packIndex + 1];
  const packDir = packValue === undefined || packValue.startsWith("--") ? undefined : packValue;
  const unknown = args.filter((arg, index) => arg !== "--pack" && !(packDir !== undefined && index === packIndex + 1));
  if (unknown.length > 0) {
    process.stderr.write("usage: node tools/build-widget-tooling.mjs [--pack [dir]]\n");
    process.exit(2);
  }
  try {
    const packInto = packIndex === -1 ? undefined : resolve(packDir ?? DEFAULT_ARCHIVES);
    const { stages, archives } = await buildWidgetTooling({ ...(packInto === undefined ? {} : { packInto }) });
    process.stdout.write(`staged ${stages.sdk}\nstaged ${stages.cli}\n`);
    if (archives !== undefined) process.stdout.write(`packed ${archives.sdk}\npacked ${archives.cli}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
