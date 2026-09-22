import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { frozenBuildEnvironment, lifecycleScriptGate, readDependencyLock } from "./dependency-lock.ts";

/**
 * The staged install pipeline: quarantine, then an isolated build.
 *
 * Installing a package means running code that came from somewhere else, so the two steps that touch it are
 * the two that matter:
 *
 * 1. **Quarantine.** The artifact is fetched into a directory of its own and hashed. Nothing in quarantine
 *    is executed, imported or put on a module path — the only thing that happens to it is a checksum, and a
 *    checksum that does not match the one consent was bound to stops the install there. Advertising a digest
 *    is a claim; hashing the bytes is a check.
 * 2. **An isolated build.** The build runs in a process of its own, with its working directory inside
 *    quarantine, an environment stripped to the handful of variables a build legitimately needs, and no
 *    shell. A build script that could read the node's provider keys would be reading the user's credentials,
 *    and a build that inherited the node's environment would do exactly that.
 *
 * The unpack step is guarded twice: the archive is extracted by `tar`, which refuses absolute paths and
 * `..` on its own, and then every entry is walked and checked against the destination — and an artifact
 * carrying a symbolic link is refused outright. Not because every link escapes, but because a build creates
 * the links it needs and a rule with no exceptions is a rule that cannot be subtly wrong: resolving a link's
 * target correctly (chains, broken links, a target created later by the build itself) is exactly the kind of
 * careful reasoning that gets one case right and the next one wrong.
 */

export const QUARANTINE_STATUS = "quarantine-download-unpack-and-isolated-build-implemented";

export interface QuarantineDownloadInput {
  /** An `http(s)` URL to fetch, or a path to read. Both are verified the same way. */
  source: string;
  /** The digest consent is bound to. Recomputed from the bytes rather than trusted. */
  expectedDigest: string;
  /** Quarantine's own directory. Nothing here is ever executed or imported. */
  quarantineDir: string;
  /** The ceiling the plan agreed to. A body larger than this is refused. */
  maxBytes?: number;
  timeoutMs?: number;
  /** Injected so a test can drive a source without a socket. */
  fetchImpl?: typeof fetch;
  readFileImpl?: (path: string) => Uint8Array;
}

export type QuarantineDownloadResult =
  | { ok: true; artifactPath: string; bytes: number; digest: string }
  | { ok: false; code: "UNSAFE_SOURCE" | "DOWNLOAD_FAILED" | "TOO_LARGE" | "DIGEST_MISMATCH"; message: string };

/** A local path, or an http(s) URL with no credentials in it. Anything else is refused before a read. */
function sourceKind(source: string): { kind: "url"; url: URL } | { kind: "path" } | { kind: "refused"; reason: string } {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      return { kind: "refused", reason: `"${source}" is not a URL this node can read` };
    }
    if (url.username !== "" || url.password !== "") {
      return { kind: "refused", reason: "an artifact URL must not embed credentials" };
    }
    return { kind: "url", url };
  }
  // A scheme that is not http(s) is not a path either, and treating one as the other is how a `file:` URL
  // becomes an arbitrary read.
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) {
    return { kind: "refused", reason: `"${source}" is not a source this node reads artifacts from` };
  }
  return { kind: "path" };
}

export async function quarantineDownload(input: QuarantineDownloadInput): Promise<QuarantineDownloadResult> {
  const kind = sourceKind(input.source);
  if (kind.kind === "refused") return { ok: false, code: "UNSAFE_SOURCE", message: kind.reason };

  const maxBytes = input.maxBytes ?? 256 * 1024 * 1024;
  const timeoutMs = input.timeoutMs ?? 60_000;

  let bytes: Uint8Array;
  if (kind.kind === "path") {
    try {
      bytes = (input.readFileImpl ?? readFileSync)(input.source);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, code: "DOWNLOAD_FAILED", message: `the artifact at ${input.source} could not be read: ${detail}` };
    }
  } else {
    try {
      const response = await (input.fetchImpl ?? fetch)(kind.url, {
        method: "GET",
        // A redirect is not followed: the destination would be the source's choice, and the digest consent
        // was bound to the artifact, not to wherever it points next.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return { ok: false, code: "DOWNLOAD_FAILED", message: `the source answered ${String(response.status)}` };
      }
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > maxBytes) {
        return {
          ok: false,
          code: "TOO_LARGE",
          message: `the artifact is ${String(declared)} bytes, more than the ${String(maxBytes)} agreed`,
        };
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, code: "DOWNLOAD_FAILED", message: `the artifact could not be fetched: ${detail}` };
    }
  }

  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      code: "TOO_LARGE",
      message: `the artifact arrived as ${String(bytes.byteLength)} bytes, more than the ${String(maxBytes)} agreed`,
    };
  }

  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== input.expectedDigest) {
    return {
      ok: false,
      code: "DIGEST_MISMATCH",
      message: `the artifact is not the one that was approved: approved ${input.expectedDigest.slice(0, 23)}… received ${digest.slice(0, 23)}…`,
    };
  }

  // Written only after the digest matches, so a refusal never leaves an unverified file where a build step
  // could later find it.
  mkdirSync(input.quarantineDir, { recursive: true });
  const artifactPath = join(input.quarantineDir, "artifact.bin");
  writeFileSync(artifactPath, bytes, { mode: 0o600 });
  return { ok: true, artifactPath, bytes: bytes.byteLength, digest };
}

export type UnpackResult =
  | { ok: true; root: string; entries: number }
  | { ok: false; code: "UNPACK_FAILED" | "ESCAPES_ROOT"; message: string };

/** Every entry under a root, so an escape can be found rather than hoped against. */
function walk(root: string, current = root, seen: string[] = []): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    seen.push(path);
    if (entry.isDirectory()) walk(root, path, seen);
  }
  return seen;
}

/**
 * Extract the artifact into quarantine and check that it stayed there.
 *
 * `tar` refuses absolute paths and `..` on its own, and this does not rely on that: the destination is walked
 * afterwards and any entry that resolves outside it — a symlink included, since a symlink out of the root is
 * how a later write escapes a root that looked contained — fails the install.
 */
export async function unpackQuarantine(input: {
  artifactPath: string;
  into: string;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}): Promise<UnpackResult> {
  const into = resolve(input.into);
  mkdirSync(into, { recursive: true });
  /*
   * Relative, with the destination as the working directory.
   *
   * GNU tar reads a `C:` in an absolute Windows path as a remote host and refuses to run at all
   * (`Cannot connect to C: resolve failed`), so an absolute path here makes the whole pipeline work on Linux
   * and fail on Windows. A relative path has no colon to misread.
   */
  const artifact = relative(into, resolve(input.artifactPath));
  // Collected outside the executor, because the failure message below needs it and a value declared inside a
  // promise is out of scope by the time the promise settles.
  let stderr = "";

  const exitCode = await new Promise<number | null>((resolveExit) => {
    const child = (input.spawnImpl ?? spawn)("tar", ["-xzf", artifact, "--no-same-owner"], {
      cwd: into,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), input.timeoutMs ?? 60_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolveExit(-1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });

  if (exitCode !== 0) {
    // `tar`'s own words are kept: an unpack that failed without saying why is one somebody has to reproduce by
    // hand, and the reason is usually one line of its output.
    const detail = stderr.trim().split("\n")[0] ?? "";
    return {
      ok: false,
      code: "UNPACK_FAILED",
      message: `the artifact could not be unpacked (tar exited ${String(exitCode)}${detail === "" ? "" : `: ${detail}`})`,
    };
  }

  const root = into;
  const entries = walk(root);
  const escaped = entries.filter((entry) => {
    const rel = relative(root, resolve(entry));
    return rel === "" || rel.startsWith("..") || isAbsolute(rel);
  });
  if (escaped.length > 0) {
    return { ok: false, code: "ESCAPES_ROOT", message: `the artifact contains an entry outside the quarantine root: ${escaped[0] ?? ""}` };
  }

  // Any symlink fails the install. `lstat` rather than `stat`, because `stat` follows the link and reports the
  // target's own type — so a symlink to a directory outside the root came back as a directory and passed,
  // which is the escape this check exists for and which the Linux runner in CI caught.
  const links = entries.filter((entry) => lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink() === true);
  for (const link of links) {
    return { ok: false, code: "ESCAPES_ROOT", message: `the artifact contains a symbolic link (${link}), which a later write could follow out of the root` };
  }

  return { ok: true, root, entries: entries.length };
}

export type IsolatedBuildResult =
  | { ok: true; stdout: string }
  | { ok: false; code: "REFUSED" | "BUILD_FAILED" | "TIMED_OUT"; message: string; stdout?: string };

/**
 * Run the package's build, contained, on the frozen lock and nothing else.
 *
 * `isolatedBuild` below runs a command in a contained process; this is the step in front of it that decides whether
 * the command may run at all, and it reads exactly two things:
 *
 * 1. **The lock artifact the plan consented to.** Read from the node's lock directory and re-hashed on the way in,
 *    so a missing or edited artifact stops the build. Nothing here resolves a range or asks a package manager what a
 *    version means — the pins, the declared load-time scripts and the build inputs all come from the frozen file, and
 *    the child is handed them as `CC_LOCKED_DEPENDENCIES` so it cannot resolve anything differently either.
 * 2. **The scripts this node approved.** A script the artifact declares and nobody approved is not skipped: the
 *    build does not start. Silently dropping part of a package's build would run a build the consent did not cover,
 *    and the honest answer is to stop and ask rather than to run something else.
 */
export async function isolatedLockedBuild(input: {
  /** The node's lock directory. The reference is resolved inside it and nowhere else. */
  lockDir: string;
  /** The reference and digest the install plan consented to. */
  lockRef: string;
  lockDigest: string;
  /** Load-time scripts this node approved. Nothing is approved by default. */
  approvedLifecycleScripts?: readonly string[];
  /** The build's working directory. It has to be inside quarantine, or it is not quarantine. */
  root: string;
  quarantineDir: string;
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}): Promise<LockedBuildResult> {
  const stored = readDependencyLock({ dir: input.lockDir, lockRef: input.lockRef, lockDigest: input.lockDigest });
  if (!stored.ok) return { ok: false, code: stored.code, message: stored.message };

  const gate = lifecycleScriptGate({
    declared: stored.lock.lifecycleScripts,
    approved: input.approvedLifecycleScripts ?? [],
  });
  if (gate.refused.length > 0) {
    return {
      ok: false,
      code: "LIFECYCLE_SCRIPT_NOT_APPROVED",
      message: `the artifact declares load-time script(s) this node has not approved: ${gate.refused.join(", ")}; a build that quietly skipped them would not be the build the consent covered`,
    };
  }

  const built = await isolatedBuild({
    root: input.root,
    quarantineDir: input.quarantineDir,
    command: input.command,
    ...(input.args === undefined ? {} : { args: input.args }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.spawnImpl === undefined ? {} : { spawnImpl: input.spawnImpl }),
    // From the frozen artifact, not from anything resolved now: the child sees the consented versions.
    extraEnv: frozenBuildEnvironment(stored.lock),
  });
  return built.ok ? built : { ok: false, code: built.code, message: built.message, ...(built.stdout === undefined ? {} : { stdout: built.stdout }) };
}

export type LockedBuildResult =
  | { ok: true; stdout: string }
  | {
      ok: false;
      code:
        | "REFUSED"
        | "BUILD_FAILED"
        | "TIMED_OUT"
        | "LOCK_MISSING"
        | "LOCK_MUTATED"
        | "LOCK_IMMUTABLE"
        | "LIFECYCLE_SCRIPT_NOT_APPROVED";
      message: string;
      stdout?: string;
    };

/**
 * Run the package's build, contained.
 *
 * The environment is rebuilt rather than filtered. Filtering is how a variable nobody thought of — a provider
 * key added later, a token in a CI variable — reaches a build script; a list of what a build legitimately
 * needs is short and does not grow by accident.
 *
 * `isolatedLockedBuild` above is the entry point the install pipeline uses: it checks the frozen lock and the
 * approved lifecycle scripts first. This function stays as it is — a contained process — so the isolation can be
 * read and tested without the locking rules, and the two compose rather than one absorbing the other.
 */
export async function isolatedBuild(input: {
  /** The build's working directory. It has to be inside quarantine, or it is not quarantine. */
  root: string;
  quarantineDir: string;
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  /** Passed through to the build, on top of the short list below. */
  extraEnv?: Record<string, string>;
  spawnImpl?: typeof spawn;
}): Promise<IsolatedBuildResult> {
  const quarantine = resolve(input.quarantineDir);
  const root = resolve(input.root);
  const rel = relative(quarantine, root);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      ok: false,
      code: "REFUSED",
      message: `a build may only run inside quarantine; ${root} is outside ${quarantine}`,
    };
  }

  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: root,
    TMPDIR: join(root, ".tmp"),
    NODE_ENV: "production",
    ...(input.extraEnv ?? {}),
  };
  mkdirSync(env["TMPDIR"] ?? root, { recursive: true });

  return new Promise<IsolatedBuildResult>((resolveBuild) => {
    const child = (input.spawnImpl ?? spawn)(input.command, [...(input.args ?? [])], {
      cwd: root,
      env,
      // No shell: a build command with a shell in front of it is a build command that can be re-worded by
      // whatever wrote the manifest.
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let settled = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      /*
       * Killed and then waited for. A process is gone once it has closed, not once it has been signalled, and
       * a caller that cleaned up on the signal would be removing a directory the child still holds — which is
       * what a test asserting on the quarantine directory found on Windows.
       */
      child.kill("SIGKILL");
      child.once("close", () => {
        resolveBuild({
          ok: false,
          code: "TIMED_OUT",
          message: `the build did not finish within ${String(input.timeoutMs ?? 120_000)} ms`,
          stdout,
        });
      });
    }, input.timeoutMs ?? 120_000);

    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveBuild({ ok: false, code: "BUILD_FAILED", message: `the build could not be started: ${cause.message}`, stdout });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolveBuild({ ok: true, stdout });
      else resolveBuild({ ok: false, code: "BUILD_FAILED", message: `the build exited with code ${String(code)}`, stdout });
    });
  });
}
