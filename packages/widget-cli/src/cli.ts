#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { definitionDigest } from "@clarkcant/widget-host";
import {
  DEFAULT_RESOURCE_PROFILE,
  PACKAGE_MANIFEST_SCHEMA_VERSION,
  declaredReachIsEmpty,
  declaredReachOf,
  directoryEntrySchema,
  riskLaneFor,
  type DirectoryEntry,
  type PackageManifest,
} from "@clarkcant/contracts";

import { runConformance, type ConformanceReport } from "./conformance.ts";
import type { FrameFacts } from "./dev-shell.ts";
import { startDevHost } from "./dev-host.ts";
import { publishedDefinitions, versionRuleViolations, type PublishedDefinitions } from "./version-rules.ts";
import { inspectNpmTarball, installedThemes, readPackage } from "@clarkcant/core";
import { credentialShaped, pnpmPack, readNpmPackageJson, scaffoldPackageJson } from "./npm-package.ts";
import { packageFiles } from "./package-files.ts";
import { REFERENCE_TEMPLATES, referenceCopy, type ReferenceTemplate } from "./reference-templates.ts";
import { runThemeCli, THEME_COMMANDS } from "./theme-cli.ts";

/**
 * `clark widget …` — the author's commands, from `docs/widget-development.md` §16.
 *
 * This comment used to say `dev` was not implemented, and the help text used to say the same thing while `runCli`
 * ran it. Both are corrected here, and the shape of the fix is the point: the list below is what the dispatch
 * accepts *and* what the help prints, so the two cannot disagree. A hand-written help block beside a chain of `if`s
 * drifts exactly as that shape invites — it already had, twice over, with `publish` missing from the help as well.
 *
 * `pack` is where the interesting decision lives. It refuses to pack a package that fails conformance, and it
 * refuses to overwrite an artifact for a version that was already packed at a different digest — because a version
 * whose bytes changed is a different package wearing the same number, and the host's install path assumes the
 * opposite.
 */

const TEMPLATES = ["blank", "form", "dashboard", ...REFERENCE_TEMPLATES] as const;
type Template = (typeof TEMPLATES)[number];

/**
 * The commands this CLI accepts, with the line each shows in the help.
 *
 * One list, read twice: `runCli` refuses a command that is not here, and `usage()` prints exactly these. That is the
 * whole design — the previous shape was a chain of `if`s plus a hand-written block of text, and the text had gone
 * stale in two ways at once (`dev` described as unimplemented while it ran, `publish` never mentioned while it also
 * ran). A list both sides read has nothing to disagree with.
 */
export const WIDGET_COMMANDS = [
  { name: "init", usage: `clark widget init <dir> [--template ${TEMPLATES.join("|")}]   scaffold a package` },
  { name: "test", usage: "clark widget test [dir]                                     run the conformance suite" },
  { name: "pack", usage: "clark widget pack [dir]                                     build the npm archive and its digests" },
  {
    name: "dev",
    usage: "clark widget dev [dir] [--port N] [--builtin <id>]          run the dev host and its browser shell",
  },
  {
    name: "publish",
    usage: "clark widget publish [dir] [--source npm|local]              prepare the directory entry (does not upload)",
  },
] as const;

function usage(): string {
  return [
    "clark widget <command> [dir]",
    "",
    ...WIDGET_COMMANDS.map((entry) => `  ${entry.usage}`),
    ...THEME_COMMANDS.map((entry) => `  ${entry.usage}`),
    "",
    // Named because it is the product decision behind the whole surface: a local path needs no account.
    "A local path needs no account. init, test, pack and dev all work without a directory or a login.",
  ].join("\n");
}

/**
 * Flags that carry a value, so the argument after one belongs to the flag rather than to the command.
 *
 * Declared once because two readers have to agree on it: `flag` reads the value that follows a name, and
 * `positional` has to step over that same value. While only the first of them knew, `clark widget dev --port 4000`
 * read `4000` as the package directory.
 */
const FLAGS_WITH_VALUES: readonly string[] = ["--template", "--frames", "--port", "--builtin", "--source"];

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * The command's positional argument: the first argument that is neither a flag nor a flag's value.
 *
 * `dev --port 4000 .` names `.`, and `dev --port 4000` names nothing at all rather than naming `4000`. What nothing
 * means is the caller's decision, because it is not the same for every command: `dev` falls back to the working
 * directory, while a command that needs a directory can refuse instead.
 */
export function positional(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) return arg;
    if (FLAGS_WITH_VALUES.includes(arg)) index += 1;
  }
  return undefined;
}

/* ------------------------------------------------------------------ init */

function definitionFor(id: string, template: Template): Record<string, unknown> {
  const props =
    template === "form"
      ? { title: { type: "string", maxLength: 200 }, fields: { type: "number" } }
      : template === "dashboard"
        ? { title: { type: "string", maxLength: 200 }, series: { type: "number" } }
        : { title: { type: "string", maxLength: 200 } };
  return {
    id,
    version: "0.1.0",
    renderer: "isolated-app",
    propsSchema: {
      type: "object",
      properties: props,
      required: ["title"],
      // Declared, so the conformance suite can prove an undeclared property is refused rather than accepted.
      additionalProperties: false,
    },
    eventSchemas: {},
    stateSchema: { type: "object", properties: {}, additionalProperties: true },
    stateVersion: 0,
    semanticDescription: `A ${template} widget.`,
    requestedCapabilities: [],
    sizing: { compact: true, expanded: true, minHeight: 160 },
    textFallback: `${template} widget: nội dung chưa xem được trong chế độ chỉ có chữ.`,
    effectCategories: [],
    datasetRefs: [],
  };
}

/** The reference app's own files that describe or test that app rather than the package a person starts from. */
export function skippedFromReference(path: string): boolean {
  return path.startsWith("test/") || path.startsWith("dist/") || path === "README.md" || path === "README.vi.md" || path === "LICENSE";
}

/** Files whose text can name the reference's id — a skill names a capability ref. Anything else is copied byte for byte. */
const REFERENCE_TEXT = /\.(json|js|mjs|html|css|md)$/;

const asJson = (document: Record<string, unknown>): string => `${JSON.stringify(document, null, 2)}\n`;

/**
 * The one copier every reference template goes through (`reference-templates.ts` says what each one copies).
 *
 * The reference's id becomes the new package's everywhere its text names it — the manifest, the facets, a capability
 * ref, the frame code — so the copy is a package of its own and its capabilities are named under its own id.
 */
export function initFromReference(root: string, id: string, template: ReferenceTemplate): void {
  const copy = referenceCopy(template);
  if (!existsSync(join(copy.source, "clarkcant.json"))) {
    throw new Error(`the ${template} template is copied from ${copy.source}, which is missing from this checkout`);
  }
  for (const { path, bytes } of packageFiles(copy.source)) {
    if (skippedFromReference(path)) continue;
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    if (!REFERENCE_TEXT.test(path)) {
      writeFileSync(target, bytes);
      continue;
    }
    const text = bytes.toString("utf8").split(copy.referenceId).join(id);
    if (path === "clarkcant.json") {
      const manifest = {
        ...(JSON.parse(text) as Record<string, unknown>),
        version: "0.1.0",
        displayName: copy.displayName,
        description: copy.description,
        publisher: { id: "example", sourceUrl: copy.sourceUrl, license: "MIT" },
      };
      writeFileSync(target, asJson(copy.manifest?.(manifest) ?? manifest));
    } else if (path === "widgets/main/widget.json") {
      const definition = { ...(JSON.parse(text) as Record<string, unknown>), version: "0.1.0" };
      writeFileSync(target, asJson(copy.definition?.(definition) ?? definition));
    } else {
      writeFileSync(target, text);
    }
  }
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "README.md"), copy.readme);
  writeFileSync(join(root, "LICENSE"), "MIT\n");
  // What the archive ships: every top-level entry the copy holds except its tests and the reference's own dev
  // fixtures, which describe this repository's checks rather than the package a person installs.
  const shipped = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !["test", "dev", "dist", "README.md", "LICENSE", "package.json"].includes(entry.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
  const manifest = JSON.parse(readFileSync(join(root, "clarkcant.json"), "utf8")) as PackageManifest;
  writeFileSync(join(root, "package.json"), asJson(scaffoldPackageJson({ name: npmNameFor(id), manifest, files: shipped, repository: copy.sourceUrl })));
}

/**
 * The npm name a new package starts with: the last segment of its id, which is already lower case and hyphenated.
 * Unscoped, because a scope is an npm account the author has to own; they rename it before publishing if they want one.
 */
export function npmNameFor(id: string): string {
  return id.split(".").at(-1) ?? "widget";
}

const isReferenceTemplate = (template: Template): template is ReferenceTemplate => (REFERENCE_TEMPLATES as readonly string[]).includes(template);

function init(root: string, template: Template): void {
  // Lower-case letters, digits and hyphens, starting with a letter: the shape a capability name's segments take, so a
  // service facet added later can name its capabilities under this id.
  const slug = (root.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "");
  const id = `com.example.${slug === "" ? "widget" : slug}`;
  if (isReferenceTemplate(template)) {
    initFromReference(root, id, template);
    return;
  }
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  mkdirSync(join(root, "fixtures"), { recursive: true });
  mkdirSync(join(root, "previews"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });

  const manifest = {
    schemaVersion: PACKAGE_MANIFEST_SCHEMA_VERSION,
    id,
    version: "0.1.0",
    displayName: "My Widget",
    description: `A ${template} widget.`,
    hostApi: { min: 1, max: 1 },
    facets: [
      {
        kind: "ui",
        id: `${id}.main@1`,
        entry: "widgets/main/index.html",
        definition: "widgets/main/widget.json",
        isolation: "isolated-ui",
      },
    ],
    requestedCapabilities: [],
    // Empty by default, so a widget that reaches a network has to say so and the conformance suite can notice.
    permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
    // Windows is listed because this repository's own desktop app is Electron on Windows: a template that could
    // not declare it would scaffold a package unable to say where it runs.
    platforms: ["darwin-arm64", "linux-x64", "win32-x64"],
    publisher: { id: "example", sourceUrl: "https://github.com/example/my-widget", license: "MIT" },
    dependencies: [],
  };
  const definition = { ...definitionFor(`${id}.main@1`, template), id: `${id}.main@1` };

  writeFileSync(join(root, "clarkcant.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(root, "widgets", "main", "widget.json"), `${JSON.stringify(definition, null, 2)}\n`);
  writeFileSync(
    join(root, "widgets", "main", "index.html"),
    `<!doctype html>\n<html lang="vi">\n  <head><meta charset="utf-8" /><title>My Widget</title></head>\n  <body>\n    <main id="root"></main>\n    <!-- The runtime is imported from the SDK; nothing here reaches the host directly. -->\n    <script type="module" src="./main.js"></script>\n  </body>\n</html>\n`,
  );
  // The four states the standard requires, because a widget that has only ever been seen with data is a widget
  // whose empty and error paths have never been looked at.
  writeFileSync(join(root, "fixtures", "default.json"), `${JSON.stringify({ title: "Xin chào" }, null, 2)}\n`);
  writeFileSync(join(root, "fixtures", "empty.json"), `${JSON.stringify({ title: "" }, null, 2)}\n`);
  writeFileSync(join(root, "fixtures", "error.json"), `${JSON.stringify({ title: "Không tải được" }, null, 2)}\n`);
  writeFileSync(join(root, "fixtures", "compact.json"), `${JSON.stringify({ title: "Gọn" }, null, 2)}\n`);
  writeFileSync(
    join(root, "README.md"),
    "# My Widget\n\nRun `clark widget test`, then `clark widget pack` to build the npm archive in `dist/`, then\n" +
      "`clark widget publish` to prepare its directory entry. Publishing to npm is `npm publish dist/<archive>.tgz`.\n",
  );
  writeFileSync(join(root, "LICENSE"), "MIT\n");
  writeFileSync(
    join(root, "package.json"),
    asJson(
      scaffoldPackageJson({
        name: npmNameFor(id),
        manifest: manifest as unknown as PackageManifest,
        files: ["clarkcant.json", "widgets/", "fixtures/", "previews/"],
      }),
    ),
  );
}

/* ------------------------------------------------------------------ test */

function report(result: ConformanceReport): string {
  const lines: string[] = [];
  for (const group of ["schema", "security", "lifecycle", "interaction", "rendering"] as const) {
    const checks = result.checks.filter((check) => check.group === group);
    if (checks.length === 0) continue;
    lines.push(`\n${group}`);
    for (const check of checks) {
      const mark = check.status === "pass" ? "ok  " : check.status === "fail" ? "FAIL" : "n/a ";
      lines.push(`  ${mark} ${check.name} — ${check.detail}`);
    }
  }
  lines.push(
    `\n${String(result.summary.pass)} passed, ${String(result.summary.fail)} failed, ` +
      `${String(result.summary["requires-dev-host"])} need the dev host`,
  );
  if (result.summary["requires-dev-host"] > 0) {
    // Named, because "n/a" without a reason reads as "not important" rather than "not verified here".
    lines.push("The checks marked n/a are not verified by this command: they need a rendered frame.");
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ pack */

/**
 * Frame facts a browser collected, read from a file.
 *
 * This is how the checks that need a rendered frame are answered: the dev host collects the facts in the page and
 * posts them, and the suite reads them here. Without a file they stay `requires-dev-host`, which is the honest
 * answer — the check has not been performed — rather than a guess about what the browser would have shown.
 */
function readFrames(path: string): FrameFacts | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as FrameFacts) : undefined;
  } catch {
    return undefined;
  }
}

function pack(root: string, result = runConformance(root), conform: (root: string) => ConformanceReport = runConformance): number {
  if (!result.ok) {
    process.stderr.write(`${report(result)}\n\nRefusing to pack a package that fails conformance.\n`);
    return 1;
  }
  const pkg = readPackage(root);
  const facet = pkg.facets[0];
  const themes = installedThemes({ source: { kind: "local", path: root } });
  if (facet === undefined && (!themes.ok || themes.themes.length === 0)) {
    process.stderr.write("no widget or theme facet is declared\n");
    return 1;
  }

  let files: { path: string; bytes: number; sha256: string }[];
  try {
    files = packageFiles(root).map(({ path, bytes }) => ({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const definition = facet === undefined ? undefined : definitionDigest(facet.definition);
  const themeDigests = themes.ok && themes.themes.length > 0 ? Object.fromEntries(themes.themes.map((theme) => [
    theme.facetId, `sha256:${createHash("sha256").update(JSON.stringify(theme.document)).digest("hex")}`,
  ])) : undefined;

  /*
   * The digest covers identity and content: the manifest's id and version, the definition's own digest (which is
   * derived from its schema), and the hash of every file. Two packages with the same id and version but different
   * bytes therefore have different digests, which is what the immutability check below turns into a refusal.
   */
  const canonical = {
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    ...(definition === undefined ? {} : { definition }),
    ...(themeDigests === undefined ? {} : { themes: themeDigests }),
    files,
  };
  const authorDigest = `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;

  // The npm archive, when the package has a package.json. Without one the package stays a local/git package and
  // the artifact describes the author bytes alone, as it always has.
  const npmJson = readNpmPackageJson(root, pkg.manifest);
  if (npmJson.kind === "invalid") {
    process.stderr.write(`package.json is not ready for npm:\n${npmJson.problems.map((problem) => `  - ${problem}`).join("\n")}\n`);
    return 1;
  }
  let npm: { artifact: NpmArtifact; bytes: Buffer } | undefined;
  if (npmJson.kind === "ok") {
    const archived = packNpmArchive(root, pkg.manifest.version, npmJson.packageJson.name, conform);
    if (!archived.ok) {
      process.stderr.write(`${archived.message}\n`);
      return 1;
    }
    npm = archived;
  }

  const dist = join(root, "dist");
  const artifactPath = join(dist, "artifact.json");
  if (existsSync(artifactPath)) {
    let previous: { version?: string; digest?: string; authorDigest?: string; npm?: { contentDigest?: string } } | undefined;
    try {
      previous = JSON.parse(readFileSync(artifactPath, "utf8")) as typeof previous;
    } catch {
      // A previous artifact that cannot be read is not a reason to overwrite it: refusing is the safe half of an
      // immutability check, since the alternative is silently replacing bytes nobody can compare against.
      process.stderr.write(`${artifactPath} exists but is not readable JSON; refusing to overwrite it.
`);
      return 1;
    }
    // `digest` is what a schemaVersion 1 artifact called the author digest.
    const previousAuthor = previous?.authorDigest ?? previous?.digest;
    const previousContent = previous?.npm?.contentDigest;
    const contentChanged = previousContent !== undefined && npm !== undefined && previousContent !== npm.artifact.contentDigest;
    if (previous?.version === pkg.manifest.version && (previousAuthor !== authorDigest || contentChanged)) {
      process.stderr.write(
        `version ${pkg.manifest.version} was already packed with a different digest.\n` +
          `A version whose bytes changed is a different package wearing the same number; bump the version.\n`,
      );
      return 1;
    }
  }

  mkdirSync(dist, { recursive: true });
  if (npm !== undefined) writeFileSync(join(dist, npm.artifact.tarball), npm.bytes);
  const artifact = {
    schemaVersion: 2,
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    authorDigest,
    ...(definition === undefined ? {} : { definitionDigest: definition }),
    ...(themeDigests === undefined ? {} : { themeDigests }),
    files,
    ...(npm === undefined ? {} : { npm: npm.artifact }),
    // Recorded rather than omitted: the artifact says what was not verified, so a reader of the metadata is not
    // left assuming the browser checks passed.
    unverifiedChecks: result.checks.filter((check) => check.status === "requires-dev-host").map((check) => check.id),
    platforms: pkg.manifest.platforms,
    publisher: pkg.manifest.publisher,
  };
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(
    `${report(result)}\n\npacked ${pkg.manifest.id}@${pkg.manifest.version}\n  author digest:  ${authorDigest}\n` +
      (npm === undefined
        ? "  no package.json, so no npm archive (a local or git package needs none)\n"
        : `  npm archive:    ${join(dist, npm.artifact.tarball)}\n  integrity:      ${npm.artifact.integrity}\n  content digest: ${npm.artifact.contentDigest}\n`) +
      `  ${artifactPath}\n`,
  );
  return 0;
}

/**
 * The npm block of `dist/artifact.json`: what `pnpm pack` produced, measured the way a node measures it.
 *
 * Three digests, three questions. `integrity` is npm's: are these the bytes the registry serves? `contentDigest` is
 * the runtime's: is what was extracted the package the directory entry named? The artifact's `authorDigest` is the
 * author's own: did this version's files change since it was last packed?
 */
export interface NpmArtifact {
  name: string;
  version: string;
  /** The archive's file name inside `dist/`. */
  tarball: string;
  /** npm's `dist.integrity` for exactly these bytes. */
  integrity: string;
  /** The runtime content digest of the extracted archive: what an npm directory entry publishes as `digest`. */
  contentDigest: string;
  fileCount: number;
  unpackedBytes: number;
}

/**
 * Build the npm archive and check it the way an install will see it: extracted by the runtime's own reader, with
 * nothing credential-shaped inside, the same `clarkcant.json` as the source, and passing the conformance suite on
 * its own — so a `files` list that forgot a runtime asset is caught here rather than on someone else's machine.
 */
function packNpmArchive(
  root: string,
  version: string,
  name: string,
  conform: (root: string) => ConformanceReport,
): { ok: true; artifact: NpmArtifact; bytes: Buffer } | { ok: false; message: string } {
  const packed = pnpmPack(root);
  if (!packed.ok) return packed;
  const problems: string[] = [];
  const inspected = inspectNpmTarball(packed.bytes, join(tmpdir(), "clark-pack-inspect"), (extracted) => {
    const archivedManifest = join(extracted, "clarkcant.json");
    if (!existsSync(archivedManifest)) {
      problems.push('the archive has no clarkcant.json; add it to package.json "files"');
      return;
    }
    if (!readFileSync(archivedManifest).equals(readFileSync(join(root, "clarkcant.json")))) {
      problems.push("the archived clarkcant.json differs from the package's own");
    }
    const archivedReport = conform(extracted);
    if (!archivedReport.ok) {
      const failed = archivedReport.checks.filter((check) => check.status === "fail").map((check) => `${check.name} — ${check.detail}`);
      problems.push(
        `the archive does not pass the conformance suite on its own, so package.json "files" leaves out something it needs:\n    ${failed.join("\n    ")}`,
      );
    }
  });
  if (!inspected.ok) return { ok: false, message: `the npm archive is unsafe: ${inspected.message}` };
  const credentials = inspected.facts.files.filter((file) => credentialShaped(file.path)).map((file) => file.path);
  if (credentials.length > 0) {
    problems.push(`the archive would publish ${credentials.join(", ")}; narrow package.json "files" so it does not`);
  }
  if (problems.length > 0) return { ok: false, message: `Refusing to pack the npm archive:\n  - ${problems.join("\n  - ")}` };
  return {
    ok: true,
    bytes: packed.bytes,
    artifact: {
      name,
      version,
      tarball: packed.filename,
      integrity: inspected.facts.integrity,
      contentDigest: inspected.facts.contentDigest,
      fileCount: inspected.facts.files.length,
      unpackedBytes: inspected.facts.files.reduce((sum, file) => sum + file.bytes, 0),
    },
  };
}

/* --------------------------------------------------------------- publish */

function requestedSummary(permissions: PackageManifest["permissions"]): string[] {
  const out = permissions.networkOrigins.map((origin) => "network: " + origin);
  for (const { path, access } of permissions.filesystem) out.push(`filesystem (${access}): ${path}`);
  if (permissions.microphone) out.push("microphone");
  if (permissions.camera) out.push("camera");
  return out;
}

/** Whether a resource request says anything an absent one does not: another profile, or a GPU. */
function requestsMoreThanDefault(resources: PackageManifest["resources"]): resources is NonNullable<PackageManifest["resources"]> {
  return resources !== undefined && (resources.profile !== DEFAULT_RESOURCE_PROFILE || resources.gpu === true);
}

/**
 * `clark widget publish` — prepare the directory entry.
 *
 * "Prepare" is the whole of it. It writes the entry a directory would carry — every field the standard requires,
 * plus the digest of the packed artifact — and stops there. It never uploads to npm and never submits to a
 * Marketplace, and it says so in its output, because a command that looked as though it had already published would
 * be a control whose action does not exist. npm publication is the author's `npm publish` of the packed archive.
 *
 * It reads `dist/artifact.json` rather than recomputing anything, so the digest in the entry is by construction
 * the digest of the artifact that was packed. Two computations of the same thing is how a listing comes to name
 * an artifact nobody can produce. An npm entry names the archive's runtime content digest — what a node computes
 * after fetching that exact version — and a local entry keeps the author digest it always named.
 */
function publish(root: string, requested: "npm" | "local" | undefined): number {
  const result = runConformance(root);
  if (!result.ok) {
    process.stderr.write(report(result));
    process.stderr.write("Refusing to publish a package that fails conformance.");
    return 1;
  }
  if (pack(root) !== 0) return 1;

  const artifactPath = join(root, "dist", "artifact.json");
  let artifact: { authorDigest?: string; files?: { bytes: number }[]; npm?: NpmArtifact } | undefined;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as typeof artifact;
  } catch {
    process.stderr.write(artifactPath + " is missing or unreadable, so there is nothing to describe.");
    return 1;
  }
  const npm = artifact?.npm;
  if (requested === "npm" && npm === undefined) {
    process.stderr.write("--source npm needs a package.json, so that pack builds an npm archive to name.\n");
    return 1;
  }
  const source = requested ?? (npm === undefined ? "local" : "npm");
  const digest = (source === "npm" ? npm?.contentDigest : artifact?.authorDigest) ?? "";
  if (digest === "") {
    // An entry with no digest names bytes nobody can check, and "no digest" must never behave like a match.
    process.stderr.write("the packed artifact carries no digest, so an entry would name bytes nobody can check.");
    return 1;
  }

  const pkg = readPackage(root);
  const publisher = pkg.manifest.publisher;
  if (publisher === undefined) {
    // Optional for a private package, required for a listing: a directory names who a package comes from.
    process.stderr.write("clarkcant.json declares no publisher, and a directory entry has to say who a package comes from.");
    return 1;
  }
  const reach = declaredReachOf(pkg.manifest);
  const entry: DirectoryEntry = {
    packageId: pkg.manifest.id,
    version: pkg.manifest.version,
    displayName: pkg.manifest.displayName,
    description: pkg.manifest.description,
    // The exact npm version the archive will be published as, or the package's own directory for a local entry.
    source: source === "npm" && npm !== undefined ? { kind: "npm", name: npm.name, version: npm.version } : { kind: "local", path: root },
    // The signature is verified against the artifact, never listed as though the listing vouched for it.
    publisher: { id: publisher.id, sourceUrl: publisher.sourceUrl, license: publisher.license },
    // Empty rather than absent: a package without preview media is listed, not hidden.
    preview: {},
    // The manifest and the directory share one facet vocabulary, so what a listing advertises is what the package holds.
    facets: [...new Set(pkg.manifest.facets.map((facet) => facet.kind))],
    // From the manifest, one entry per facet: the install supervisor plans isolation per facet, and this is the
    // only place that knows the answer without guessing it back out of the strongest lane.
    isolations: pkg.manifest.facets.map((facet) => ({ facetKind: facet.kind, isolation: facet.isolation })),
    platforms: pkg.manifest.platforms,
    hostApi: pkg.manifest.hostApi,
    permissionsSummary: requestedSummary(pkg.manifest.permissions),
    // What it reaches beyond its sandbox, shown before install. Binding: an install refuses an artifact that differs.
    ...(declaredReachIsEmpty(reach) ? {} : { declaredReach: reach }),
    // The resource profile it requests, so an update can say what changes before it is fetched. Binding in the same way.
    // Only when it is not the default, which an absent field already means: a node from before this field refuses an
    // index holding an entry field it does not know, so a default request stays readable by it.
    ...(requestsMoreThanDefault(pkg.manifest.resources) ? { resources: pkg.manifest.resources } : {}),
    // From the isolation the facets declare, never from what the publisher says about their own package.
    riskTier: riskLaneFor(pkg.manifest.facets.map((facet) => facet.isolation)),
    sizeBytes: source === "npm" && npm !== undefined ? npm.unpackedBytes : (artifact?.files ?? []).reduce((sum, file) => sum + file.bytes, 0),
    digest,
  };

  const parsed = directoryEntrySchema.safeParse(entry);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    process.stderr.write(
      "the entry this package would produce is not valid: " +
        (first?.path.join(".") ?? "") +
        " " +
        (first?.message ?? "does not match the schema"),
    );
    return 1;
  }

  const entryPath = join(root, "dist", "directory-entry.json");
  if (existsSync(entryPath)) {
    let previous: { version?: string; digest?: string; source?: { kind?: string } } | undefined;
    try {
      previous = JSON.parse(readFileSync(entryPath, "utf8")) as typeof previous;
    } catch {
      process.stderr.write(entryPath + " exists but is not readable JSON; refusing to overwrite it.");
      return 1;
    }
    // The same rule as packing: a version whose bytes changed is a different package wearing the same number. An
    // npm entry and a local entry name different digests of the same version, so only like is held against like.
    if (previous?.version === entry.version && previous.source?.kind === entry.source.kind && previous.digest !== digest) {
      process.stderr.write("version " + entry.version + " was already prepared with a different digest; bump the version.");
      return 1;
    }
  }

  // What this version promises about stored state and bindings, held against what the last prepared version promised.
  const definitionsPath = join(root, "dist", "published-definitions.json");
  const nextDefinitions = publishedDefinitions(entry.version, pkg.facets.map((facet) => facet.definition));
  if (existsSync(definitionsPath)) {
    let previousDefinitions: PublishedDefinitions;
    try {
      previousDefinitions = JSON.parse(readFileSync(definitionsPath, "utf8")) as PublishedDefinitions;
    } catch {
      process.stderr.write(definitionsPath + " exists but is not readable JSON; refusing to overwrite it.");
      return 1;
    }
    const violations = versionRuleViolations(previousDefinitions, nextDefinitions);
    if (violations.length > 0) {
      process.stderr.write("Refusing to publish " + entry.packageId + "@" + entry.version + ":\n");
      for (const violation of violations) process.stderr.write("  " + violation + "\n");
      return 1;
    }
  } else if (existsSync(entryPath)) {
    // An entry was prepared before but its definitions are gone (a fresh clone, a cleaned dist): say the rules were
    // not applied rather than let a pass here read as "this version keeps its promises".
    process.stderr.write(
      "warning: " + definitionsPath + " is missing, so this version was not checked against the last one; keep that file under version control.\n",
    );
  }
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(entryPath, JSON.stringify(parsed.data, null, 2));
  writeFileSync(definitionsPath, JSON.stringify(nextDefinitions, null, 2));
  const lines = [
    `prepared the directory entry for ${entry.packageId}@${entry.version}`,
    `  source:    ${source === "npm" && npm !== undefined ? `npm ${npm.name}@${npm.version}` : "local"}`,
    `  risk lane: ${entry.riskTier}`,
    `  digest:    ${digest}`,
    `  ${entryPath}`,
    "",
    // Three outcomes, stated separately, so preparing is never read as having published or submitted anything.
    "  prepared:               yes",
  ];
  if (source === "npm" && npm !== undefined) {
    lines.push(
      `  published to npm:       no; publish this exact archive with: npm publish ${join(root, "dist", npm.tarball)}`,
      `                          (its integrity is ${npm.integrity})`,
      '  Marketplace submission: no; a Marketplace indexes npm packages carrying the "clarkcant" keyword, or takes a submission',
    );
  } else {
    // Named, so the limit is not mistaken for a failure: a local path needs no account, which is why dev and pack do not.
    lines.push("  published to npm:       not applicable (local entry)", "  Marketplace submission: no; a local path needs no account");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
/* ------------------------------------------------------------------- run */

export async function runCli(argv: readonly string[]): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === "theme") return runThemeCli(argv.slice(1), { pack, report });
  // Help that was asked for is a success; help shown because the command was wrong is not.
  if (group === "--help" || group === "-h" || group === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (group !== "widget" || command === undefined) {
    process.stdout.write(`${usage()}\n`);
    return 2;
  }
  const dir = positional(rest) ?? process.cwd();

  /*
   * The list is the gate, not just the help text. An unknown command is refused here rather than falling through
   * the chain of `if`s to the same help output, so "is this a command?" has exactly one answer and adding one means
   * editing one place.
   */
  if (!WIDGET_COMMANDS.some((entry) => entry.name === command)) {
    process.stdout.write(`${usage()}\n`);
    return 2;
  }

  if (command === "init") {
    const template = (flag(rest, "--template") ?? "blank") as Template;
    if (!TEMPLATES.includes(template)) {
      process.stderr.write(`unknown template "${template}"; expected one of ${TEMPLATES.join(", ")}\n`);
      return 2;
    }
    try {
      init(dir, template);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    process.stdout.write(`created a ${template} widget package in ${dir}\nnext: clark widget test ${dir}\n`);
    return 0;
  }
  if (command === "test") {
    const framesPath = flag(rest, "--frames");
    const frames = framesPath === undefined ? undefined : readFrames(framesPath);
    if (framesPath !== undefined && frames === undefined) {
      // Reported rather than ignored: a suite that silently fell back would call a package unchecked when somebody
      // had already checked it, which is the one thing this report exists to distinguish.
      process.stderr.write(`--frames ${framesPath} could not be read as frame facts\n`);
      return 2;
    }
    const result = runConformance(dir, frames === undefined ? {} : { frames });
    process.stdout.write(`${report(result)}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === "pack") return pack(dir);
  if (command === "dev") {
    const requested = Number(flag(rest, "--port") ?? "0");
    const builtin = flag(rest, "--builtin");
    const host = await startDevHost({
      ...(builtin === undefined ? { root: dir } : { builtin }),
      port: Number.isInteger(requested) ? requested : 0,
    });
    process.stdout.write(`dev host: ${host.url}
  ${builtin === undefined ? `package: ${dir}` : `catalog widget: ${builtin}`}
  ctrl-c để dừng
`);
    // Stay alive until ctrl-c: the listening server keeps the event loop busy, which is the whole of "running".
    await new Promise(() => {});
    return 0;
  }
  if (command === "publish") {
    const source = flag(rest, "--source");
    if (source !== undefined && source !== "npm" && source !== "local") {
      process.stderr.write(`unknown source "${source}"; expected npm or local\n`);
      return 2;
    }
    return publish(dir, source);
  }
  process.stdout.write(`${usage()}\n`);
  return 2;
}

export { runConformance } from "./conformance.ts";
export { startDevHost } from "./dev-host.ts";
export { applyShellAction, auditFrame, initialState, renderShell } from "./dev-shell.ts";

/*
 * The bin entry.
 *
 * Guarded by comparing this module's file to argv[1], so importing this file — which the exports above exist for —
 * does not start a server or run a command.
 *
 * Both sides are compared as real paths. Started through a package manager's bin shim, argv[1] is the path inside
 * the consumer's dependency folder, a symlink or junction into this workspace, while `import.meta.url` is the
 * resolved file — so comparing the two URLs made `clark` a silent no-op. Windows paths are case-insensitive, and a
 * drive letter can arrive in either case.
 */
export function isMainModule(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined) return false;
  let entryPath: string;
  try {
    entryPath = realpathSync(entry);
  } catch {
    return false;
  }
  const modulePath = realpathSync(fileURLToPath(moduleUrl));
  return process.platform === "win32"
    ? entryPath.toLowerCase() === modulePath.toLowerCase()
    : entryPath === modulePath;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
export { readPackage, parseManifest, widgetManifestV1Schema } from "@clarkcant/core";
