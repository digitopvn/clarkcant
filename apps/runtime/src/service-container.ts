import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { posix, resolve } from "node:path";

/**
 * The container a package's service facet runs in.
 *
 * A service facet is third-party code, and a separate process is not a sandbox: on the Node versions this node supports,
 * the permission model confines files and child processes but not the network, and Node itself calls it a seat belt. So
 * a service runs only inside a container, and a node without an engine does not run it at all — there is no process-only
 * fallback, because a weaker boundary the person never agreed to is exactly what "autonomy never overrides isolation"
 * rules out.
 *
 * What the container is given, and nothing else:
 *
 *   - **No network.** `--network none`: the service cannot reach the internet, the machine, or a sibling on localhost.
 *   - **Its package, read-only**, at `/pkg`, and **one private folder**, read-write, at `/data`. The root filesystem is
 *     read-only; `/tmp` is a small memory-backed scratch space that cannot hold an executable.
 *   - **No privilege.** A non-root user, every capability dropped, no privilege escalation, and bounded processes,
 *     memory and CPU.
 *   - **Standard streams only.** The host speaks the Model Context Protocol over stdin/stdout (`docker run -i`), so no
 *     port is opened and there is nothing for a widget frame, or anything else on the machine, to connect to.
 *
 * The image is Node's official one, pinned by digest, because a service facet's entry is JavaScript and an image named
 * only by a tag is whatever the registry says it is on the day it is pulled.
 */

export const SERVICE_IMAGE = "node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402";

/** Label every service container carries, so a node can find the ones it started even after it crashed. */
export const SERVICE_NODE_LABEL = "clarkcant.node";

/** The sentence a person and a readiness reason read when a node has no engine that can run a service. */
export const NEEDS_ENGINE_REASON = "needs Docker or Podman to run; this node has neither running";

export type ContainerEngineName = "docker" | "podman";

export type ServiceEngine =
  | { available: true; engine: ContainerEngineName; version: string }
  | {
      available: false;
      /** One sentence a person can act on; it is what a capability's blocked reason shows. */
      reason: string;
      /** What each engine answered, for the log. */
      detail: string;
    };

/** What running the engine's command line answered. `status` is null when it could not be run or did not finish. */
export interface EngineAnswer {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the engine's command line. Injected so a test can answer without an engine installed. */
export type EngineRunner = (binary: string, args: readonly string[], timeoutMs: number) => Promise<EngineAnswer>;

/**
 * What the engine's command line is given of this node's environment: how to find itself, its engine and its
 * credential helper, and nothing else. The node's own environment holds provider keys; the command line needs none of
 * them, and the container gets only the variables `serviceRunArgs` names.
 */
const ENGINE_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "SystemDrive",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINERS_CONF",
];

export function engineEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENGINE_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Asynchronous, so a slow engine never holds the node's event loop, and bounded, so a hung one never holds a caller. */
export const runEngine: EngineRunner = (binary, args, timeoutMs) =>
  new Promise((settle) => {
    execFile(
      binary,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, env: engineEnvironment() },
      (error, stdout, stderr) => {
        const status = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        settle({ status, stdout: `${stdout ?? ""}`, stderr: `${stderr ?? ""}` });
      },
    );
  });

export interface ServiceEngineOptions {
  timeoutMs?: number;
  run?: EngineRunner;
}

function failureOf(binary: string, answer: EngineAnswer): string {
  if (answer.status === 0) return `${binary}: answered nothing`;
  const detail = answer.stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? "";
  return `${binary}: ${answer.status === null ? "not found or did not answer" : `exit ${String(answer.status)}`}${detail === "" ? "" : ` (${detail})`}`;
}

/**
 * The first engine that can run a Linux container, found by asking it rather than by looking for a binary.
 *
 * Different from `detectContainerEngine`, which asks whether an image can be built at all: Docker on Windows can be
 * switched to Windows containers, where it answers `version` perfectly well and still cannot run the Node image. That
 * case is reported by name, because "install Docker" is the wrong advice for a person who has it installed.
 */
export async function detectServiceEngine(options: ServiceEngineOptions = {}): Promise<ServiceEngine> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const run = options.run ?? runEngine;
  const failures: string[] = [];
  let dockerOs: string | undefined;

  const docker = await run("docker", ["version", "--format", "{{.Server.Os}} {{.Server.Version}}"], timeoutMs);
  if (docker.status === 0 && docker.stdout.trim() !== "") {
    const [os, version] = docker.stdout.trim().split(/\s+/);
    if (os === "linux") return { available: true, engine: "docker", version: version ?? "unknown" };
    dockerOs = os ?? "unknown";
    failures.push(`docker runs ${dockerOs} containers, and a service needs Linux ones`);
  } else {
    failures.push(failureOf("docker", docker));
  }

  // Podman runs Linux containers everywhere it runs: natively on Linux, in its own machine on macOS and Windows.
  const podman = await run("podman", ["version", "--format", "{{.Client.Version}}"], timeoutMs);
  if (podman.status === 0 && podman.stdout.trim() !== "") {
    return { available: true, engine: "podman", version: podman.stdout.trim().split("\n")[0] ?? "unknown" };
  }
  failures.push(failureOf("podman", podman));

  return {
    available: false,
    reason:
      dockerOs === undefined
        ? NEEDS_ENGINE_REASON
        : `needs Docker switched to Linux containers, or Podman; Docker here runs ${dockerOs} containers`,
    detail: failures.join("; "),
  };
}

/** A container name that is stable for one facet of one generation on one node, and valid for both engines. */
export function serviceContainerName(input: { nodeId: string; generationId: string; facetId: string }): string {
  const digest = createHash("sha256")
    .update(`${input.nodeId}\n${input.generationId}\n${input.facetId}`)
    .digest("hex")
    .slice(0, 24);
  return `clarkcant-svc-${digest}`;
}

export interface ServiceContainerSpec {
  engine: ContainerEngineName;
  nodeId: string;
  name: string;
  /** The package's own directory on this machine, mounted read-only. */
  packageRoot: string;
  /** The facet's private folder on this machine, mounted read-write. `prepareServiceDataDir` creates it. */
  dataDir: string;
  /** The facet's entry, relative to the package root, as the manifest declares it. */
  entry: string;
  /** The user the container runs as. Defaults to `serviceUser()`. */
  user?: { uid: number; gid: number };
  image?: string;
}

/**
 * The user a service runs as.
 *
 * On Linux the private folder is owned by whoever runs the node, and a container user with a different id could not
 * write it, so the node's own ids are used — unless the node runs as root, which a service must never be. Docker Desktop
 * and Podman machines on macOS and Windows map file ownership for their mounts, so a fixed unprivileged id works there.
 */
export function serviceUser(platform: NodeJS.Platform = process.platform): { uid: number; gid: number } {
  if (platform === "win32" || typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return { uid: 1000, gid: 1000 };
  }
  const uid = process.getuid();
  const gid = process.getgid();
  return uid === 0 ? { uid: 65534, gid: 65534 } : { uid, gid };
}

/**
 * The arguments that start one service container.
 *
 * Pure, so a test can read exactly what the boundary is without an engine. The entry is joined as a POSIX path under
 * `/pkg`, because the path inside the container is Linux whatever the host is, and a manifest's entry has already been
 * checked to stay inside the package.
 */
/**
 * A folder as a `--mount` source.
 *
 * The engine reads `--mount` as comma-separated fields, quoted CSV-style, so a folder whose path holds a comma or a quote
 * would be read as more fields than it is — a second `source=` or a dropped `readonly`. Such a path is refused rather
 * than escaped: the boundary is the one thing here that must mean exactly what it says.
 */
export function mountSource(path: string): string {
  const absolute = resolve(path);
  if (/[,"\r\n]/u.test(absolute)) {
    throw new Error(`the folder ${absolute} cannot be given to a service: its path holds a comma, a quote or a line break`);
  }
  return absolute;
}

export function serviceRunArgs(spec: ServiceContainerSpec): string[] {
  const user = spec.user ?? serviceUser();
  const entry = posix.join("/pkg", spec.entry.replaceAll("\\", "/"));
  return [
    "run",
    "-i",
    "--rm",
    "--name",
    spec.name,
    "--label",
    `${SERVICE_NODE_LABEL}=${spec.nodeId}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
    // Rootless Podman maps the container's ids into the user's own namespace; keeping the id is what lets the private
    // folder stay writable. Docker has no such flag and needs none.
    ...(spec.engine === "podman" ? ["--userns", "keep-id"] : []),
    // The service's stdout is the protocol, which carries what a person gave it. Docker would also keep a copy in its
    // log files, unrotated, for as long as the container lives; the host reads the stream itself and needs no copy.
    ...(spec.engine === "docker" ? ["--log-driver", "none"] : []),
    "--user",
    `${String(user.uid)}:${String(user.gid)}`,
    // `--mount` rather than `--volume`: its fields are named, so a Windows path's drive-letter colon is not read as a
    // separator, and a missing source is refused instead of being created as an empty root-owned directory.
    "--mount",
    `type=bind,source=${mountSource(spec.packageRoot)},target=/pkg,readonly`,
    "--mount",
    `type=bind,source=${mountSource(spec.dataDir)},target=/data`,
    "--workdir",
    "/pkg",
    "--env",
    "HOME=/data",
    "--env",
    "NODE_ENV=production",
    spec.image ?? SERVICE_IMAGE,
    "node",
    entry,
  ];
}

/** Create the facet's private folder before it is mounted, so the engine does not create it as root. */
export function prepareServiceDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
}

export interface ContainerControlOptions {
  run?: EngineRunner;
  timeoutMs?: number;
}

/**
 * Make sure the pinned image is on this machine, fetching it once if it is not.
 *
 * Separate from starting a service because the first fetch can take minutes on a slow connection, and a handshake
 * timed for a process that is already there would read that as a service that never answered.
 */
export async function ensureServiceImage(
  engine: ContainerEngineName,
  options: ContainerControlOptions & { image?: string } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const run = options.run ?? runEngine;
  const image = options.image ?? SERVICE_IMAGE;
  const present = await run(engine, ["image", "inspect", "--format", "{{.Id}}", image], 20_000);
  if (present.status === 0) return { ok: true };
  const pulled = await run(engine, ["pull", "--quiet", image], options.timeoutMs ?? 600_000);
  if (pulled.status === 0) return { ok: true };
  const detail = pulled.stderr.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
  return { ok: false, reason: `the service runtime image could not be fetched${detail === "" ? "" : `: ${detail}`}` };
}

/**
 * Remove one container by name, whether or not it is still running.
 *
 * `rm --force` rather than `kill`: a container started with `--rm` removes itself once it stops, and one that is
 * already gone answers with an error that means the same thing as success here.
 */
export async function removeServiceContainer(
  engine: ContainerEngineName,
  name: string,
  options: ContainerControlOptions = {},
): Promise<void> {
  await (options.run ?? runEngine)(engine, ["rm", "--force", name], options.timeoutMs ?? 15_000);
}

/**
 * Remove every service container this node left behind.
 *
 * A node that crashed cannot stop what it started, and a container is not a child process the operating system reaps
 * with its parent. The label is how the next boot finds exactly this node's containers and no one else's.
 */
export async function sweepServiceContainers(
  engine: ContainerEngineName,
  nodeId: string,
  options: ContainerControlOptions = {},
): Promise<string[]> {
  const run = options.run ?? runEngine;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const listed = await run(engine, ["ps", "--all", "--quiet", "--filter", `label=${SERVICE_NODE_LABEL}=${nodeId}`], timeoutMs);
  if (listed.status !== 0) return [];
  const ids = listed.stdout
    .split(/\s+/)
    .map((id) => id.trim())
    .filter((id) => /^[0-9a-f]{6,64}$/i.test(id));
  if (ids.length > 0) await run(engine, ["rm", "--force", ...ids], timeoutMs);
  return ids;
}
