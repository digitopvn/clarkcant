import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { RESOURCE_PROFILES } from "@clarkcant/contracts";

import {
  detectServiceEngine,
  type EngineAnswer,
  engineEnvironment,
  type EngineRunner,
  mountSource,
  NEEDS_ENGINE_REASON,
  readEngineCapacity,
  ROOTLESS_DOCKER_USER,
  SERVICE_IMAGE,
  serviceContainerName,
  serviceRunArgs,
  serviceUser,
  sweepServiceContainers,
} from "../src/service-container.ts";

/**
 * The container a package service runs in.
 *
 * The boundary is the command line, so the command line is what is asserted: no network, a read-only root, no
 * capabilities, an unprivileged user, the package read-only and one private folder writable. A flag dropped here is a
 * boundary gone, and nothing downstream would notice.
 */

const SPEC = {
  engine: "docker" as const,
  nodeId: "node_a",
  name: "clarkcant-svc-abc",
  packageRoot: resolve("pkg-root"),
  dataDir: resolve("data-dir"),
  entry: "service/server.mjs",
  user: { uid: 1000, gid: 1000 },
};

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

describe("the service container's command line", () => {
  it("runs the pinned image with no network, a read-only root and nothing it could raise itself to", () => {
    const args = serviceRunArgs(SPEC);

    expect(args.slice(0, 3)).toEqual(["run", "-i", "--rm"]);
    expect(flag(args, "--network")).toBe("none");
    expect(args).toContain("--read-only");
    expect(flag(args, "--cap-drop")).toBe("ALL");
    expect(flag(args, "--security-opt")).toBe("no-new-privileges");
    expect(flag(args, "--user")).toBe("1000:1000");
    expect(flag(args, "--label")).toBe("clarkcant.node=node_a");
    expect(args.at(-3)).toBe(SERVICE_IMAGE);
    expect(SERVICE_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    // Fully qualified, so Podman does not resolve it through the host's short-name configuration.
    expect(SERVICE_IMAGE).toMatch(/^docker\.io\/library\/node@/);
    expect(args.slice(-2)).toEqual(["node", "/pkg/service/server.mjs"]);
  });

  it("mounts the package read-only and only the private folder writable", () => {
    const mounts = serviceRunArgs(SPEC).flatMap((value, index, all) => (all[index - 1] === "--mount" ? [value] : []));
    expect(mounts).toEqual([
      `type=bind,source=${SPEC.packageRoot},target=/pkg,readonly`,
      `type=bind,source=${SPEC.dataDir},target=/data`,
    ]);
    // Nothing of the node's own environment is passed through; the service gets exactly these.
    const env = serviceRunArgs(SPEC).flatMap((value, index, all) => (all[index - 1] === "--env" ? [value] : []));
    expect(env).toEqual(["HOME=/data", "NODE_ENV=production"]);
  });

  it("refuses a folder whose path the engine would read as more than one mount field", () => {
    // `--mount` is comma-separated: `a,readonly=false` would be a second field, and a quote would change the parsing.
    for (const packageRoot of [resolve("pkg,target=/,readonly=false"), resolve('pkg"root'), resolve("pkg\nroot")]) {
      expect(() => serviceRunArgs({ ...SPEC, packageRoot }), JSON.stringify(packageRoot)).toThrow(/cannot be given to a service/);
    }
    expect(() => serviceRunArgs({ ...SPEC, dataDir: resolve("data,dst=/etc") })).toThrow(/cannot be given to a service/);
    expect(mountSource(resolve("plain folder (1)"))).toBe(resolve("plain folder (1)"));
  });

  it("keeps no copy of what the service writes to its standard output in Docker's log files", () => {
    expect(flag(serviceRunArgs(SPEC), "--log-driver")).toBe("none");
  });

  it("gives the engine's command line only what it needs to find itself, not the node's provider keys", () => {
    const bus = "unix:path=/run/user/1000/bus";
    const env = engineEnvironment({ PATH: "/usr/bin", HOME: "/home/a", DOCKER_HOST: "unix:///x", DBUS_SESSION_BUS_ADDRESS: bus, OPENAI_API_KEY: "secret", CC_TOKEN: "t" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/a", DOCKER_HOST: "unix:///x", DBUS_SESSION_BUS_ADDRESS: bus });
  });

  it("keeps the user's ids under rootless Podman, and joins a Windows-style entry as a Linux path", () => {
    const args = serviceRunArgs({ ...SPEC, engine: "podman", entry: "service\\server.mjs" });
    expect(flag(args, "--userns")).toBe("keep-id");
    expect(args.at(-1)).toBe("/pkg/service/server.mjs");
    expect(serviceRunArgs(SPEC)).not.toContain("--userns");
  });

  it("runs as the id rootless Docker maps back to the person, keeping every other part of the boundary", () => {
    const { user: _user, ...unpinned } = SPEC;
    const args = serviceRunArgs({ ...unpinned, rootless: true });
    expect(ROOTLESS_DOCKER_USER).toEqual({ uid: 0, gid: 0 });
    expect(flag(args, "--user")).toBe("0:0");
    expect(flag(args, "--network")).toBe("none");
    expect(args).toContain("--read-only");
    expect(flag(args, "--cap-drop")).toBe("ALL");
    expect(flag(args, "--security-opt")).toBe("no-new-privileges");
    expect(args).not.toContain("--userns");
    expect(serviceRunArgs({ ...unpinned, rootless: true }).filter((arg) => arg.startsWith("type=bind"))).toEqual(
      serviceRunArgs(SPEC).filter((arg) => arg.startsWith("type=bind")),
    );

    // Only Docker is mapped this way; rootful Docker and Podman keep the node's own ids.
    expect(flag(serviceRunArgs({ ...unpinned, engine: "podman", rootless: true }), "--user")).not.toBe("0:0");
    expect(flag(serviceRunArgs({ ...unpinned, rootless: false }), "--user")).not.toBe("0:0");
    expect(flag(serviceRunArgs({ ...SPEC, rootless: true }), "--user")).toBe("1000:1000");
  });

  it("never runs a service as root", () => {
    expect(serviceUser("win32")).toEqual({ uid: 1000, gid: 1000 });
    if (process.platform !== "win32" && typeof process.getuid === "function") {
      expect(serviceUser(process.platform).uid).not.toBe(0);
    }
  });

  it("keeps the light profile, and a service that names no profile, at exactly the bounds services always had", () => {
    const pinned = ["--pids-limit", "128", "--memory", "256m", "--cpus", "1", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m"];
    const unnamed = serviceRunArgs(SPEC);
    const light = serviceRunArgs({ ...SPEC, profile: RESOURCE_PROFILES["interactive-light"] });
    expect(light).toEqual(unnamed);
    const start = unnamed.indexOf("--pids-limit");
    expect(unnamed.slice(start, start + pinned.length)).toEqual(pinned);
  });

  it("sizes the container from the granted profile and changes nothing else about the boundary", () => {
    const light = serviceRunArgs(SPEC);
    for (const profile of Object.values(RESOURCE_PROFILES)) {
      const args = serviceRunArgs({ ...SPEC, profile });
      const { memoryMib, cpus, pids, tmpfsMib } = profile.container;
      expect(flag(args, "--memory")).toBe(`${String(memoryMib)}m`);
      expect(flag(args, "--cpus")).toBe(String(cpus));
      expect(flag(args, "--pids-limit")).toBe(String(pids));
      expect(flag(args, "--tmpfs")).toBe(`/tmp:rw,noexec,nosuid,size=${String(tmpfsMib)}m`);
      const sizing = new Set(["--memory", "--cpus", "--pids-limit", "--tmpfs"]);
      const rest = (all: string[]) => all.filter((_, index) => !sizing.has(all[index] ?? "") && !sizing.has(all[index - 1] ?? ""));
      expect(rest(args)).toEqual(rest(light));
      expect(flag(args, "--network")).toBe("none");
    }
  });

  it("names a container stably per node, generation and facet", () => {
    const one = serviceContainerName({ nodeId: "node_a", generationId: "g1", facetId: "svc" });
    expect(one).toMatch(/^clarkcant-svc-[0-9a-f]{24}$/);
    expect(serviceContainerName({ nodeId: "node_a", generationId: "g1", facetId: "svc" })).toBe(one);
    expect(serviceContainerName({ nodeId: "node_b", generationId: "g1", facetId: "svc" })).not.toBe(one);
  });
});

function answering(answers: Record<string, EngineAnswer>): EngineRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = async (binary: string, args: readonly string[]): Promise<EngineAnswer> => {
    calls.push(`${binary} ${args.join(" ")}`);
    return answers[binary] ?? { status: null, stdout: "", stderr: "not found" };
  };
  return Object.assign(run, { calls });
}

describe("finding an engine that can run a service", () => {
  it("takes Docker when it runs Linux containers", async () => {
    const engine = await detectServiceEngine({ run: answering({ docker: { status: 0, stdout: "linux 29.8.0\n", stderr: "" } }) });
    expect(engine).toEqual({ available: true, engine: "docker", version: "29.8.0" });
  });

  it("says when Docker runs rootless, and only then", async () => {
    const docker = (securityOptions: EngineAnswer): EngineRunner => async (binary, args) => {
      if (binary !== "docker") return { status: null, stdout: "", stderr: "not found" };
      return args[0] === "info" ? securityOptions : { status: 0, stdout: "linux 29.8.0\n", stderr: "" };
    };
    const rootless = await detectServiceEngine({
      run: docker({ status: 0, stdout: '["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]\n', stderr: "" }),
    });
    expect(rootless).toEqual({ available: true, engine: "docker", version: "29.8.0", rootless: true });

    const rootful = await detectServiceEngine({
      run: docker({ status: 0, stdout: '["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]\n', stderr: "" }),
    });
    expect(rootful).toEqual({ available: true, engine: "docker", version: "29.8.0" });

    // An answer that cannot be read is treated as rootful, as every Docker was before this was asked.
    for (const unreadable of [
      { status: 1, stdout: "", stderr: "permission denied" },
      { status: 0, stdout: "not json", stderr: "" },
      { status: 0, stdout: '"name=rootless"', stderr: "" },
    ]) {
      expect(await detectServiceEngine({ run: docker(unreadable) })).toEqual({ available: true, engine: "docker", version: "29.8.0" });
    }
  });

  it("falls back to Podman, and says why Docker was not used", async () => {
    const engine = await detectServiceEngine({
      run: answering({
        docker: { status: 0, stdout: "windows 29.8.0", stderr: "" },
        podman: { status: 0, stdout: "5.2.1\n", stderr: "" },
      }),
    });
    expect(engine).toEqual({ available: true, engine: "podman", version: "5.2.1" });
  });

  it("names the Windows-containers case rather than advising an install", async () => {
    const engine = await detectServiceEngine({ run: answering({ docker: { status: 0, stdout: "windows 29.8.0", stderr: "" } }) });
    expect(engine.available).toBe(false);
    if (engine.available) throw new Error("unreachable");
    expect(engine.reason).toContain("Linux containers");
    expect(engine.reason).not.toBe(NEEDS_ENGINE_REASON);
  });

  it("answers with the reason a person reads when there is no engine at all", async () => {
    const engine = await detectServiceEngine({ run: answering({}) });
    expect(engine).toMatchObject({ available: false, reason: NEEDS_ENGINE_REASON });
    if (engine.available) throw new Error("unreachable");
    expect(engine.detail).toContain("docker");
    expect(engine.detail).toContain("podman");
  });
});

describe("reading what the engine can hold", () => {
  it("reads Docker's memory, CPUs and whether it enforces limits", async () => {
    const run = answering({ docker: { status: 0, stdout: "50387320832 28 true true\n", stderr: "" } });
    expect(await readEngineCapacity("docker", { run })).toEqual({ memoryBytes: 50387320832, cpus: 28, enforcesLimits: true });
    expect(run.calls[0]).toBe("docker info --format {{json .MemTotal}} {{json .NCPU}} {{json .MemoryLimit}} {{json .CPUCfsQuota}}");
    const unenforced = answering({ docker: { status: 0, stdout: "8000000000 4 false true", stderr: "" } });
    expect(await readEngineCapacity("docker", { run: unenforced })).toMatchObject({ enforcesLimits: false });
  });

  it("reads Podman's host, and says limits are not enforced without the memory and cpu controllers", async () => {
    const host = (controllers: string[]) =>
      answering({ podman: { status: 0, stdout: JSON.stringify({ memTotal: 16e9, cpus: 8, cgroupControllers: controllers }), stderr: "" } });
    expect(await readEngineCapacity("podman", { run: host(["cpu", "memory", "pids"]) })).toEqual({
      memoryBytes: 16e9,
      cpus: 8,
      enforcesLimits: true,
    });
    expect(await readEngineCapacity("podman", { run: host(["pids"]) })).toMatchObject({ enforcesLimits: false });
  });

  it("leaves what it could not read undefined rather than guessing", async () => {
    expect(await readEngineCapacity("docker", { run: answering({}) })).toEqual({});
    expect(await readEngineCapacity("docker", { run: answering({ docker: { status: 0, stdout: "<no value> x", stderr: "" } }) })).toEqual({
      memoryBytes: undefined,
      cpus: undefined,
      enforcesLimits: undefined,
    });
    expect(await readEngineCapacity("podman", { run: answering({ podman: { status: 0, stdout: "not json", stderr: "" } }) })).toEqual({});
  });
});

describe("cleaning up after a crash", () => {
  it("removes only the containers labelled with this node", async () => {
    const run = answering({ docker: { status: 0, stdout: "abc123def456\n0123456789ab\n", stderr: "" } });
    const removed = await sweepServiceContainers("docker", "node_a", { run });
    expect(removed).toEqual(["abc123def456", "0123456789ab"]);
    expect(run.calls[0]).toBe("docker ps --all --quiet --filter label=clarkcant.node=node_a");
    expect(run.calls[1]).toBe("docker rm --force abc123def456 0123456789ab");
  });
});
