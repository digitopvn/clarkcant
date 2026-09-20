import { spawnSync } from "node:child_process";

/**
 * Whether this machine can build and run the container image.
 *
 * The OCI image is how a node is deployed where there is no Node runtime to start one with, and building
 * it needs an engine. This answers whether one is present rather than assuming it, because an image
 * definition that has never been built is a plan — and a node that reported "container-ready" without an
 * engine would be claiming a deployment path that does not exist on the machine it is running on.
 *
 * The probe runs the engine's own version command rather than looking for a binary on `PATH`: a file
 * named `docker` is not a working engine, and `PATH` is not a promise. It is bounded in time, because a
 * wedged engine must not hold a boot open.
 */

export const CONTAINER_ENGINE_STATUS = "probe-implemented-image-not-built-in-ci";

export type ContainerEngine =
  | { available: true; engine: "docker" | "podman"; version: string }
  | { available: false; reason: "requires-container-engine"; detail: string };

export interface ContainerEngineOptions {
  timeoutMs?: number;
  /** Injected so a test can answer without an engine installed. */
  run?: (binary: string, args: readonly string[]) => { status: number | null; stdout: string };
}

function runBinary(binary: string, args: readonly string[], timeoutMs: number) {
  const result = spawnSync(binary, [...args], { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  return { status: result.status, stdout: `${result.stdout ?? ""}` };
}

/** The first engine that answers, in the order the two are usually installed. */
export function detectContainerEngine(options: ContainerEngineOptions = {}): ContainerEngine {
  const timeoutMs = options.timeoutMs ?? 5000;
  const run = options.run ?? ((binary: string, args: readonly string[]) => runBinary(binary, args, timeoutMs));
  const attempts: { engine: "docker" | "podman"; args: readonly string[] }[] = [
    { engine: "docker", args: ["version", "--format", "{{.Server.Version}}"] },
    { engine: "podman", args: ["version", "--format", "{{.Version}}"] },
  ];
  const failures: string[] = [];

  for (const attempt of attempts) {
    const result = run(attempt.engine, attempt.args);
    if (result.status === 0 && result.stdout.trim() !== "") {
      return { available: true, engine: attempt.engine, version: result.stdout.trim().split("\n")[0] ?? "unknown" };
    }
    failures.push(`${attempt.engine}: ${result.status === 0 ? "answered nothing" : `exit ${String(result.status)}`}`);
  }

  return {
    available: false,
    reason: "requires-container-engine",
    // Both attempts are named, because "no engine" and "an engine that is installed but not running"
    // need different things done about them.
    detail: failures.join("; "),
  };
}
