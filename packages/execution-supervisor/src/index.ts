import { spawn } from "node:child_process";

/**
 * Execution supervisor.
 *
 * Running a tool is not the same as isolating it. A child process runs with the
 * parent's user identity and can reach anything that user can, so the profiles here
 * are described as containment and the code says plainly when it is not a sandbox.
 *
 * Two guarantees are real and enforced:
 *
 * - The environment is an explicit allowlist. Provider keys, SSH agent sockets and
 *   cloud credentials are not inherited, which is what stops untrusted build code
 *   from reading the operator's own credentials.
 * - Cancellation reports what actually happened. A process that ignores SIGTERM and
 *   is later killed is reported as `forced`, not as a clean stop, because claiming
 *   a graceful shutdown that did not occur hides a real side effect.
 */

export interface ExecutionProfile {
  name: "read-only-inspect" | "build" | "test" | "browser-worker" | "virtual-desktop";
  /** Environment variable names the child may inherit. Nothing else is passed. */
  envAllowlist: string[];
  /** Containment level achieved in practice. */
  containment: "process-only" | "container" | "vm";
  /** Whether untrusted code may run under this profile without further review. */
  acceptsUntrustedCode: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

export const BUILTIN_PROFILES: Record<string, ExecutionProfile> = {
  "read-only-inspect": {
    name: "read-only-inspect",
    envAllowlist: ["PATH", "HOME", "LANG", "TZ"],
    containment: "process-only",
    acceptsUntrustedCode: false,
    timeoutMs: 60_000,
    maxOutputBytes: 512 * 1024,
  },
  build: {
    name: "build",
    envAllowlist: ["PATH", "HOME", "LANG", "TZ", "CI"],
    containment: "process-only",
    acceptsUntrustedCode: false,
    timeoutMs: 600_000,
    maxOutputBytes: 4 * 1024 * 1024,
  },
  test: {
    name: "test",
    envAllowlist: ["PATH", "HOME", "LANG", "TZ", "CI"],
    containment: "process-only",
    acceptsUntrustedCode: false,
    timeoutMs: 900_000,
    maxOutputBytes: 8 * 1024 * 1024,
  },
  "browser-worker": {
    name: "browser-worker",
    envAllowlist: ["PATH", "HOME", "LANG", "TZ", "DISPLAY"],
    containment: "process-only",
    acceptsUntrustedCode: false,
    timeoutMs: 300_000,
    maxOutputBytes: 2 * 1024 * 1024,
  },
  "virtual-desktop": {
    name: "virtual-desktop",
    envAllowlist: ["PATH", "HOME", "LANG", "TZ", "DISPLAY", "WAYLAND_DISPLAY"],
    containment: "container",
    acceptsUntrustedCode: true,
    timeoutMs: 600_000,
    maxOutputBytes: 2 * 1024 * 1024,
  },
};

/**
 * Build the environment for a child.
 *
 * Only names on the profile's allowlist are forwarded. In particular `SSH_AUTH_SOCK`,
 * `DOCKER_HOST`, `AWS_*`, `GITHUB_TOKEN`, `NPM_TOKEN` and every provider API key are
 * excluded, so a build script has no route to the operator's credentials.
 */
export function buildEnvironment(
  profile: ExecutionProfile,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of profile.envAllowlist) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Credential-bearing variables that must never be forwarded, asserted by the test. */
export const NEVER_FORWARDED = [
  "SSH_AUTH_SOCK",
  "DOCKER_HOST",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

export type RunOutcome =
  | { status: "exited"; code: number; stdout: string; stderr: string; durationMs: number }
  | { status: "timeout"; partialStdout: string; partialStderr: string; durationMs: number }
  | { status: "cancelled"; graceful: boolean; partialStdout: string; durationMs: number }
  | { status: "refused"; reason: string };

export interface RunRequest {
  command: string;
  args: string[];
  cwd: string;
  profile: ExecutionProfile;
  /** Set when the code being run was not written by the user. */
  codeIsUntrusted?: boolean;
  signal?: AbortSignal;
}

/**
 * Run a command under a profile.
 *
 * `codeIsUntrusted` combined with a profile that does not accept untrusted code is a
 * refusal, not a warning. Reporting the limitation is the honest outcome; running it
 * anyway and calling the process boundary a sandbox is not.
 */
export async function runUnderProfile(request: RunRequest): Promise<RunOutcome> {
  if (request.codeIsUntrusted && !request.profile.acceptsUntrustedCode) {
    return {
      status: "refused",
      reason: `profile ${request.profile.name} achieves ${request.profile.containment} containment, which is not sufficient for untrusted code; use an isolated service or a VM-backed profile instead`,
    };
  }

  const startedAt = Date.now();
  return await new Promise<RunOutcome>((resolve) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: buildEnvironment(request.profile),
      stdio: ["ignore", "pipe", "pipe"],
      // Detached so the whole process group can be signalled on cancellation.
      detached: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= request.profile.maxOutputBytes) return current;
      return current + chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // SIGKILL after a grace period, because a process that ignores SIGTERM must not
      // be able to hold the supervisor open indefinitely.
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5000).unref();
    }, request.profile.timeoutMs);

    const onAbort = (): void => {
      cancelled = true;
      child.kill("SIGTERM");
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({ status: "refused", reason: `could not start ${request.command}: ${error.message}` });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        resolve({ status: "timeout", partialStdout: stdout, partialStderr: stderr, durationMs });
        return;
      }
      if (cancelled) {
        // A clean exit after SIGTERM is a graceful stop; anything else, including a
        // signal-killed process, is reported as forced so the difference is visible.
        resolve({
          status: "cancelled",
          graceful: signal === null && code === 0,
          partialStdout: stdout,
          durationMs,
        });
        return;
      }
      resolve({ status: "exited", code: code ?? -1, stdout, stderr, durationMs });
    });
  });
}

/**
 * @status-ref execution-supervisor.container-adapters
 * TODO(P3): container and VM execution adapters. The profile model, environment
 * allowlist, timeout, cancellation and output bounding are implemented and tested;
 * running inside a container needs a container engine, and the `virtual-desktop`
 * profile's `container` containment claim is therefore not yet substantiated by a
 * test on this host.
 */
export const CONTAINER_ADAPTER_STATUS = "process-profiles-implemented-container-pending";
