import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { definitionDigest } from "@clarkcant/widget-host";

import { runConformance, type ConformanceReport } from "./conformance.ts";
import { readPackage } from "./manifest.ts";

/**
 * `clark widget …` — the author's three commands.
 *
 * The shape comes from `docs/widget-development.md` §16. `dev` is not implemented here, and that is stated rather
 * than stubbed: the dev host is a browser application (hot reload, a viewport switcher, an accessibility inspector),
 * and a command that printed "coming soon" would be a control that looks usable before its action exists.
 *
 * `pack` is where the interesting decision lives. It refuses to pack a package that fails conformance, and it
 * refuses to overwrite an artifact for a version that was already packed at a different digest — because a version
 * whose bytes changed is a different package wearing the same number, and the host's install path assumes the
 * opposite.
 */

const TEMPLATES = ["blank", "form", "dashboard"] as const;
type Template = (typeof TEMPLATES)[number];

function usage(): string {
  return [
    "clark widget init <dir> [--template blank|form|dashboard]",
    "clark widget test [dir]",
    "clark widget pack [dir]",
    "",
    "clark widget dev is not implemented: the dev host is a browser application and is not part of this CLI yet.",
  ].join("\n");
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
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

function init(root: string, template: Template): void {
  const id = `com.example.${root.split(/[\\/]/).pop() ?? "widget"}`;
  mkdirSync(join(root, "widgets", "main"), { recursive: true });
  mkdirSync(join(root, "fixtures"), { recursive: true });
  mkdirSync(join(root, "previews"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });

  const manifest = {
    schemaVersion: 1,
    id,
    version: "0.1.0",
    displayName: "My Widget",
    description: `A ${template} widget.`,
    hostApi: { min: 1, max: 1 },
    facets: [
      {
        kind: "widget",
        id: `${id}.main@1`,
        entry: "widgets/main/index.html",
        definition: "widgets/main/widget.json",
        isolation: "isolated-ui",
      },
    ],
    requestedCapabilities: [],
    // Empty by default, so a widget that reaches a network has to say so and the conformance suite can notice.
    permissions: { networkOrigins: [], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
    platforms: ["darwin-arm64", "linux-x64", "win32-x64"],
    publisher: { id: "example", sourceUrl: "https://github.com/example/my-widget", license: "MIT" },
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
  writeFileSync(join(root, "README.md"), `# My Widget\n\nRun \`clark widget test\` then \`clark widget pack\`.\n`);
  writeFileSync(join(root, "LICENSE"), "MIT\n");
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

function walk(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "dist" || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(root, path));
    else files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files.sort();
}

function pack(root: string): number {
  const result = runConformance(root);
  if (!result.ok) {
    process.stderr.write(`${report(result)}\n\nRefusing to pack a package that fails conformance.\n`);
    return 1;
  }
  const pkg = readPackage(root);
  const facet = pkg.facets[0];
  if (facet === undefined) {
    process.stderr.write("no widget facet is declared\n");
    return 1;
  }

  const files = walk(root).map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });

  /*
   * The digest covers identity and content: the manifest's id and version, the definition's own digest (which is
   * derived from its schema), and the hash of every file. Two packages with the same id and version but different
   * bytes therefore have different digests, which is what the immutability check below turns into a refusal.
   */
  const canonical = {
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    definition: definitionDigest(facet.definition),
    files,
  };
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;

  const dist = join(root, "dist");
  const artifactPath = join(dist, "artifact.json");
  if (existsSync(artifactPath)) {
    let previous: { version?: string; digest?: string } | undefined;
    try {
      previous = JSON.parse(readFileSync(artifactPath, "utf8")) as { version?: string; digest?: string };
    } catch {
      // A previous artifact that cannot be read is not a reason to overwrite it: refusing is the safe half of an
      // immutability check, since the alternative is silently replacing bytes nobody can compare against.
      process.stderr.write(`${artifactPath} exists but is not readable JSON; refusing to overwrite it.
`);
      return 1;
    }
    if (previous.version === pkg.manifest.version && previous.digest !== digest) {
      process.stderr.write(
        `version ${pkg.manifest.version} was already packed with a different digest.\n` +
          `A version whose bytes changed is a different package wearing the same number; bump the version.\n`,
      );
      return 1;
    }
  }

  mkdirSync(dist, { recursive: true });
  const artifact = {
    schemaVersion: 1,
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    digest,
    definitionDigest: definitionDigest(facet.definition),
    files,
    // Recorded rather than omitted: the artifact says what was not verified, so a reader of the metadata is not
    // left assuming the browser checks passed.
    unverifiedChecks: result.checks.filter((check) => check.status === "requires-dev-host").map((check) => check.id),
    platforms: pkg.manifest.platforms,
    publisher: pkg.manifest.publisher,
  };
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${report(result)}\n\npacked ${pkg.manifest.id}@${pkg.manifest.version}\n  ${digest}\n  ${artifactPath}\n`);
  return 0;
}

/* ------------------------------------------------------------------- run */

export function runCli(argv: readonly string[]): number {
  const [group, command, ...rest] = argv;
  if (group !== "widget" || command === undefined) {
    process.stdout.write(`${usage()}\n`);
    return 2;
  }
  const dir = rest.find((arg) => !arg.startsWith("--")) ?? process.cwd();

  if (command === "init") {
    const template = (flag(rest, "--template") ?? "blank") as Template;
    if (!TEMPLATES.includes(template)) {
      process.stderr.write(`unknown template "${template}"; expected one of ${TEMPLATES.join(", ")}\n`);
      return 2;
    }
    init(dir, template);
    process.stdout.write(`created a ${template} widget package in ${dir}\nnext: clark widget test ${dir}\n`);
    return 0;
  }
  if (command === "test") {
    const result = runConformance(dir);
    process.stdout.write(`${report(result)}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === "pack") return pack(dir);
  if (command === "dev") {
    process.stderr.write(
      "clark widget dev is not implemented yet: the dev host is a browser application, and a command that\n" +
        "printed a placeholder would be a control that looks usable before its action exists.\n",
    );
    return 2;
  }
  if (command === "publish") {
    process.stderr.write("clark widget publish arrives with the directory (phase 13); local paths need no account.\n");
    return 2;
  }
  process.stdout.write(`${usage()}\n`);
  return 2;
}

export { runConformance } from "./conformance.ts";
export { readPackage, manifestSchema } from "./manifest.ts";
