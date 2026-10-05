import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PackageManifest } from "@clarkcant/contracts";

/**
 * The npm side of a widget package: the `package.json` rules `clark widget pack` holds an author to, and the archive
 * it builds with `pnpm pack`.
 *
 * npm distributes the package; ClarkCant installs only the archive's bytes. So the rules below are the ones that make
 * those bytes a complete package on their own — nothing fetched later, nothing run on install — and that make a
 * listing find it (#194's keywords).
 */

/** The keyword every ClarkCant package carries, which is how a Marketplace finds it on npm. */
export const DISCOVERY_KEYWORD = "clarkcant";

/** One keyword per facet kind, so a search can narrow by what a package holds. */
export const FACET_KEYWORDS: Readonly<Record<PackageManifest["facets"][number]["kind"], string>> = {
  ui: "clarkcant-widget",
  tools: "clarkcant-service",
  skills: "clarkcant-skill",
  prompts: "clarkcant-prompt",
  themes: "clarkcant-theme",
  setup: "clarkcant-setup",
  driver: "clarkcant-driver",
  voice: "clarkcant-voice",
};

export function keywordsFor(manifest: Pick<PackageManifest, "facets">): string[] {
  return [DISCOVERY_KEYWORD, ...new Set(manifest.facets.map((facet) => FACET_KEYWORDS[facet.kind]))];
}

/** npm's own package-name rule: lower case, url-safe, optionally scoped, at most 214 characters. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** Scripts npm runs on a consumer's machine during install. The runtime never runs them; npm users would. */
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"] as const;

/**
 * Scripts npm and pnpm run while packing. Packing never runs them (anyone verifying a package with `clark widget pack`
 * would otherwise run its author's code), and a package may not declare them: an archive a script generated could not
 * be recomputed from the source by anyone else.
 */
const PACK_SCRIPTS = ["prepack", "prepare", "postpack"] as const;

/** Fields that ask an installer to fetch more code. The runtime installs the archive alone, so none may be declared. */
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"] as const;

export interface NpmPackageJson {
  name: string;
  version: string;
  license: string;
  keywords: string[];
  files: string[];
  private?: boolean;
  [key: string]: unknown;
}

export type PackageJsonRead = { kind: "absent" } | { kind: "invalid"; problems: string[] } | { kind: "ok"; packageJson: NpmPackageJson };

/** Read and check `package.json` against the manifest. Absent is not a problem: it keeps the local workflow. */
export function readNpmPackageJson(root: string, manifest: PackageManifest): PackageJsonRead {
  const path = join(root, "package.json");
  if (!existsSync(path)) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { kind: "invalid", problems: [`package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", problems: ["package.json must be a JSON object"] };
  }
  const json = parsed as Record<string, unknown>;
  const problems: string[] = [];

  const name = json["name"];
  if (typeof name !== "string" || name.length > 214 || !NPM_NAME.test(name)) {
    problems.push(`package.json "name" must be a valid npm package name (lower case, optionally @scope/name), got ${JSON.stringify(name)}`);
  }
  const version = json["version"];
  if (version !== manifest.version) {
    problems.push(
      `package.json "version" is ${JSON.stringify(version)} but clarkcant.json says "${manifest.version}"; ` +
        "they name the same release, so set both to the same version",
    );
  }
  const license = json["license"];
  if (typeof license !== "string" || license.trim() === "") {
    problems.push('package.json needs a "license" (an SPDX id such as "MIT")');
  } else if (manifest.publisher !== undefined && manifest.publisher.license !== license) {
    problems.push(`package.json "license" is "${license}" but clarkcant.json publisher.license is "${manifest.publisher.license}"`);
  }
  const keywords = Array.isArray(json["keywords"]) ? (json["keywords"] as unknown[]).filter((k): k is string => typeof k === "string") : [];
  const missing = keywordsFor(manifest).filter((keyword) => !keywords.includes(keyword));
  if (missing.length > 0) {
    problems.push(`package.json "keywords" must include ${missing.map((k) => `"${k}"`).join(", ")} so a Marketplace can find it on npm`);
  }
  const files = json["files"];
  if (!Array.isArray(files) || files.length === 0 || !files.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
    problems.push('package.json needs an explicit "files" list naming what the archive ships (e.g. "clarkcant.json", "widgets/", "fixtures/")');
  }
  for (const field of DEPENDENCY_FIELDS) {
    const value = json[field];
    const declared = Array.isArray(value) ? value.length > 0 : typeof value === "object" && value !== null ? Object.keys(value).length > 0 : value === true;
    if (declared) {
      problems.push(`package.json declares "${field}", but ClarkCant installs the archive alone and never fetches them; bundle what the package needs into its files`);
    }
  }
  const scripts = typeof json["scripts"] === "object" && json["scripts"] !== null ? (json["scripts"] as Record<string, unknown>) : {};
  for (const script of INSTALL_SCRIPTS) {
    if (scripts[script] !== undefined) problems.push(`package.json declares a "${script}" script, which would run on every machine that installs it from npm`);
  }
  for (const script of PACK_SCRIPTS) {
    if (scripts[script] !== undefined) {
      problems.push(`package.json declares a "${script}" script; ship the files it would generate instead, so the archive can be rebuilt from the source`);
    }
  }
  if (problems.length > 0) return { kind: "invalid", problems };
  return { kind: "ok", packageJson: json as NpmPackageJson };
}

/** A `package.json` for a package `clark widget init` creates. */
export function scaffoldPackageJson(input: { name: string; manifest: PackageManifest; files: string[]; repository?: string }): NpmPackageJson {
  return {
    name: input.name,
    version: input.manifest.version,
    description: input.manifest.description,
    license: input.manifest.publisher?.license ?? "MIT",
    keywords: keywordsFor(input.manifest),
    files: input.files,
    ...(input.repository === undefined ? {} : { repository: { type: "git", url: input.repository } }),
  };
}

/**
 * Paths that look like a credential or a local environment. An archive holding one is refused even when `files`
 * named it, because a published version can never be taken back.
 */
export function credentialShaped(path: string): boolean {
  const segments = path.split("/");
  const base = (segments.at(-1) ?? "").toLowerCase();
  if (segments.some((segment) => segment === "node_modules" || segment === ".git")) return true;
  return (
    base === ".npmrc" ||
    base === ".yarnrc" ||
    base === ".yarnrc.yml" ||
    base === ".netrc" ||
    base === ".dev.vars" ||
    base === ".git-credentials" ||
    base === ".pypirc" ||
    base.startsWith(".env") ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(base) ||
    /\.(pem|key|p12|pfx|keystore)$/.test(base)
  );
}

/**
 * Build the archive with `pnpm pack`, into a fresh scratch directory, and return its bytes and npm's file name.
 *
 * pnpm writes the same bytes for the same files (it fixes every entry's mtime), so packing twice is reproducible and
 * the integrity of what an author publishes can be recomputed by anyone holding the source.
 */
export function pnpmPack(root: string): { ok: true; bytes: Buffer; filename: string } | { ok: false; message: string } {
  const scratch = mkdtempSync(join(tmpdir(), "clark-pack-"));
  try {
    const missing = { ok: false as const, message: 'could not run pnpm; install it with "corepack enable pnpm"' };
    const options = {
      cwd: root,
      encoding: "utf8" as const,
      windowsHide: true,
      // Belt and braces with the PACK_SCRIPTS rule: packing runs no package code.
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    };
    // Windows resolves `pnpm.cmd` only through a shell. The command is one fixed string, and the one path in it is a
    // directory this function just created, refused if it holds a character cmd would interpret inside quotes.
    if (process.platform === "win32" && /["%^!]/.test(scratch)) {
      return { ok: false, message: `the temporary directory ${scratch} holds a character the Windows shell would interpret` };
    }
    const result =
      process.platform === "win32"
        ? spawnSync(`pnpm pack --pack-destination "${scratch}"`, { ...options, shell: true })
        : spawnSync("pnpm", ["pack", "--pack-destination", scratch], options);
    if (result.error !== undefined) return missing;
    // cmd's "is not recognized" exit status.
    if (process.platform === "win32" && result.status === 9009) return missing;
    if (result.status !== 0) {
      return { ok: false, message: `pnpm pack failed:\n${(result.stderr || result.stdout).trim()}` };
    }
    // The scratch directory is fresh, so the archive pnpm wrote is the one .tgz in it; nothing printed is parsed.
    const written = readdirSync(scratch).filter((name) => name.endsWith(".tgz"));
    if (written.length !== 1 || written[0] === undefined) {
      return { ok: false, message: `pnpm pack did not write exactly one archive:\n${result.stdout.trim()}` };
    }
    return { ok: true, bytes: readFileSync(join(scratch, written[0])), filename: written[0] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
