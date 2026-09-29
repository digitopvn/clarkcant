import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import type {
  CapabilityDescriptor,
  CapabilityReadiness,
  CapabilityRef,
  DirectoryEntry,
  EffectCategory,
  Instant,
  PackageGeneration,
  ServiceCapabilityDeclaration,
  ToolsFacet,
} from "@clarkcant/contracts";
import {
  activeGenerations,
  getCapability,
  readPackage,
  registerCapability,
  type RegistryDeps,
  resolveLocalSource,
  updateReadiness,
} from "@clarkcant/core";
import { type McpToolMetadata, StdioMcpTransport, type StdioMcpTransportOptions } from "@clarkcant/mcp-adapters";

import {
  type ContainerEngineName,
  ensureServiceImage,
  prepareServiceDataDir,
  removeServiceContainer,
  type ServiceEngine,
  serviceContainerName,
  serviceRunArgs,
  sweepServiceContainers,
} from "./service-container.ts";

/**
 * The host for packages' service facets.
 *
 * One container per `tools` facet of every active generation, started when the node boots and whenever what is
 * installed changes, and stopped when the generation stops being active. The host is the only thing that talks to a
 * service: a widget, the agent and voice reach one through `invokeCapability`, which asks the policy first and calls
 * `call` here only once the answer is to go ahead.
 *
 * What the registry says about a service capability is what the host has seen, never what the manifest hoped:
 *
 *   - `installed` — the generation that declares it is active on this node.
 *   - `loaded` — the service started, completed the handshake, and lists the tool under the declared name.
 *   - `authenticated` — true: a service holds no connection of its own yet.
 *   - `authorized` — true: installing the package was the person's consent to what its manifest declares, and every
 *     call is still decided by the execution policy on its own.
 *   - `healthy` — the container is running and answers `ping`.
 *
 * A tool the service lists but the manifest does not declare is never registered: consent covered the declaration,
 * not whatever the code turned out to offer. A declared tool the service does not list is registered as not loaded,
 * with that as the reason, so a person reads why the button is off rather than a generic failure.
 */

/** A pending restart backs off from one second to a minute, and a service that keeps dying is left stopped. */
const RESTART_BASE_MS = 1_000;
const RESTART_CEILING_MS = 60_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 5;
const PING_INTERVAL_MS = 30_000;
/** A container's first answer includes Node starting inside it, which is slower than a bare process. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;

/** The four categories that order by reach. The others are different axes and are never rewritten. */
const EFFECT_RANK: Partial<Record<EffectCategory, number>> = {
  read: 0,
  "local-write": 1,
  "external-write": 2,
  destructive: 3,
};

/**
 * The effect a call is decided under: the manifest's declaration, raised by what the tool says about itself.
 *
 * Both are the package author's words, so neither may lower the other. A tool that does not claim `readOnlyHint` may
 * write, whatever the manifest calls it; one that claims `destructiveHint` is destructive. A declaration outside the
 * read-to-destructive scale (financial, communication, media capture) is kept as declared: it already asks more than
 * any of those.
 */
export function serviceEffectCategory(declared: EffectCategory, tool: McpToolMetadata): EffectCategory {
  const declaredRank = EFFECT_RANK[declared];
  if (declaredRank === undefined) return declared;
  const annotations = tool.annotations ?? {};
  const implied: EffectCategory =
    annotations.destructiveHint === true ? "destructive" : annotations.readOnlyHint === true ? "read" : "local-write";
  return (EFFECT_RANK[implied] ?? 0) > declaredRank ? implied : declared;
}

/** What a running service does, as a unit test can stand in for it. */
export interface ServiceConnection {
  listTools(): Promise<McpToolMetadata[]>;
  callTool(name: string, args: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<{ content: string }>;
  ping(): Promise<void>;
  close(): Promise<void>;
  readonly stderrTail: string;
}

/**
 * How a service process is launched.
 *
 * Production passes the container engine's command line and nothing else; there is no other launcher in the node. A
 * test gives a plain process so the host's own logic — matching, readiness, restart — is exercised without an engine.
 */
export type ServiceLauncher = (spec: {
  engine: ContainerEngineName;
  nodeId: string;
  name: string;
  packageRoot: string;
  dataDir: string;
  entry: string;
}) => { command: string; args: string[] };

export const containerLauncher: ServiceLauncher = (spec) => ({ command: spec.engine, args: serviceRunArgs(spec) });

/**
 * What the engine's command line is given of this node's environment: how to find itself and its engine, and nothing
 * else. The node's own environment holds provider keys; the command line needs none of them, and the container gets
 * only the variables `serviceRunArgs` names.
 */
const ENGINE_ENV_ALLOWLIST = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "SystemRoot",
  "SYSTEMROOT",
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

export interface ServiceHostOptions {
  registry: RegistryDeps;
  dataDir: string;
  /** Detected once, on first use, so a node never waits on the engine before it can listen. */
  engine: () => Promise<ServiceEngine>;
  /** Where an active generation's files are on this machine, or undefined when this node does not have them. */
  packageRoot: (generation: PackageGeneration) => string | undefined;
  now?: () => Instant;
  log?: (line: string) => void;
  launcher?: ServiceLauncher;
  connect?: (options: StdioMcpTransportOptions) => Promise<ServiceConnection>;
  /** Container housekeeping. Absent in a test whose launcher starts no container. */
  containers?: {
    ensureImage: (engine: ContainerEngineName) => Promise<{ ok: true } | { ok: false; reason: string }>;
    remove: (engine: ContainerEngineName, name: string) => Promise<void>;
    sweep: (engine: ContainerEngineName, nodeId: string) => Promise<string[]>;
  };
  timings?: { restartBaseMs?: number; pingIntervalMs?: number };
}

export type ServiceCallFailure = "SERVICE_NOT_RUNNING" | "SERVICE_TOOL_FAILED" | "SERVICE_UNREACHABLE";

export class ServiceCallError extends Error {
  readonly code: ServiceCallFailure;
  constructor(code: ServiceCallFailure, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ServiceHost {
  /** Bring the running services in line with what is installed. Serialised: a second call waits for the first. */
  reconcile(): Promise<void>;
  /** Call a registered service capability. The caller has already asked the policy; this only runs it. */
  call(ref: CapabilityRef, args: Record<string, unknown>): Promise<{ content: string }>;
  /**
   * The active generation whose service facet declares this ref, whatever state the service is in.
   *
   * What makes a capability a service capability of this node: a ref some other part of the node registered, or one a
   * package no longer active declared, is not something this host runs.
   */
  serves(ref: CapabilityRef): { packageId: string; generationId: string } | undefined;
  /** Stop every service. With `restart`, they are started again from scratch; without, the host stays stopped. */
  stopAll(options?: { restart?: boolean }): Promise<number>;
  /** What each facet is doing, for diagnostics and tests. */
  status(): { key: string; packageId: string; state: ServiceState; reason?: string; refs: CapabilityRef[] }[];
}

type ServiceState = "starting" | "running" | "restarting" | "stopped" | "failed";

interface ServiceEntry {
  key: string;
  generation: PackageGeneration;
  facet: ToolsFacet;
  packageRoot: string;
  containerName: string;
  state: ServiceState;
  reason?: string | undefined;
  connection?: ServiceConnection | undefined;
  /** Declared ref → the tool it runs, once matched against what the service listed. */
  tools: Map<CapabilityRef, string>;
  crashes: number[];
  restartTimer?: ReturnType<typeof setTimeout> | undefined;
  pingTimer?: ReturnType<typeof setInterval> | undefined;
  /** Bumped on every start and stop, so a late answer from a previous run cannot change the current one. */
  epoch: number;
}

/** A folder name for a package's private data: readable, and unique even when the id is a local path. */
function dataFolderFor(packageId: string): string {
  const readable = packageId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-60) || "package";
  return `${readable}-${createHash("sha256").update(packageId).digest("hex").slice(0, 8)}`;
}

export function createServiceHost(options: ServiceHostOptions): ServiceHost {
  const { registry } = options;
  const now = options.now ?? (() => new Date().toISOString() as Instant);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const launcher = options.launcher ?? containerLauncher;
  const connect =
    options.connect ??
    (async (transportOptions: StdioMcpTransportOptions) => {
      const transport = new StdioMcpTransport(transportOptions);
      await transport.start();
      return transport;
    });
  const restartBaseMs = options.timings?.restartBaseMs ?? RESTART_BASE_MS;
  const pingIntervalMs = options.timings?.pingIntervalMs ?? PING_INTERVAL_MS;

  const entries = new Map<string, ServiceEntry>();
  let engine: ServiceEngine | undefined;
  let swept = false;
  let queue: Promise<void> = Promise.resolve();
  let halted = false;

  async function engineOnce(): Promise<ServiceEngine> {
    if (engine === undefined) {
      engine = await options.engine();
      if (engine.available) log(`services: ${engine.engine} ${engine.version} runs package services on this node`);
      else log(`services: not started — ${engine.reason} (${engine.detail})`);
    }
    return engine;
  }

  function readiness(change: Partial<CapabilityReadiness>): CapabilityReadiness {
    return {
      installed: true,
      loaded: false,
      authenticated: true,
      authorized: true,
      healthy: false,
      ...change,
      lastProbeAt: now(),
    };
  }

  function register(
    entry: Pick<ServiceEntry, "generation">,
    declaration: ServiceCapabilityDeclaration,
    state: { readiness: CapabilityReadiness; effectCategory?: EffectCategory; inputSchema?: Record<string, unknown> },
  ): void {
    const descriptor: CapabilityDescriptor = {
      ref: declaration.ref,
      providedBy: {
        packageId: entry.generation.packageId.slice(0, 160),
        version: entry.generation.version,
        digest: entry.generation.digest,
        generation: entry.generation.generationId,
      },
      executionNodeId: registry.nodeId,
      summary: declaration.summary,
      ...(state.inputSchema === undefined ? {} : { inputSchema: state.inputSchema }),
      resourceKinds: [],
      effectCategory: state.effectCategory ?? declaration.effectCategory,
      supportsCancellation: false,
      requiresConnection: false,
      readiness: state.readiness,
      uiAffordances: [],
    };
    registerCapability(registry, descriptor);
  }

  /** Mark every capability of a facet with one readiness change, keeping what was learned about each tool. */
  function markAll(entry: ServiceEntry, change: Partial<CapabilityReadiness>): void {
    for (const declaration of entry.facet.capabilities) {
      if (getCapability(registry, declaration.ref, registry.nodeId) === undefined) {
        register(entry, declaration, { readiness: readiness(change) });
        continue;
      }
      updateReadiness(registry, { ref: declaration.ref, executionNodeId: registry.nodeId, change, at: now() });
    }
  }

  function desired(): Map<string, Omit<ServiceEntry, "state" | "tools" | "crashes" | "epoch">> {
    const wanted = new Map<string, Omit<ServiceEntry, "state" | "tools" | "crashes" | "epoch">>();
    for (const generation of activeGenerations(registry)) {
      const root = options.packageRoot(generation);
      if (root === undefined) continue;
      let manifest;
      try {
        manifest = readPackage(root).manifest;
      } catch {
        continue;
      }
      for (const facet of manifest.facets ?? []) {
        if (facet.kind !== "tools") continue;
        const key = `${generation.generationId}#${facet.id}`;
        wanted.set(key, {
          key,
          generation,
          facet,
          packageRoot: resolve(root),
          containerName: serviceContainerName({
            nodeId: registry.nodeId,
            generationId: generation.generationId,
            facetId: facet.id,
          }),
        });
      }
    }
    return wanted;
  }

  function clearTimers(entry: ServiceEntry): void {
    if (entry.restartTimer !== undefined) clearTimeout(entry.restartTimer);
    if (entry.pingTimer !== undefined) clearInterval(entry.pingTimer);
    entry.restartTimer = undefined;
    entry.pingTimer = undefined;
  }

  async function stop(entry: ServiceEntry, finalState: ServiceState, reason: string): Promise<void> {
    entry.epoch += 1;
    clearTimers(entry);
    entry.state = finalState;
    entry.reason = reason;
    const connection = entry.connection;
    entry.connection = undefined;
    await connection?.close().catch(() => undefined);
    const current = engine;
    if (current?.available === true && options.containers !== undefined) {
      await options.containers.remove(current.engine, entry.containerName).catch(() => undefined);
    }
  }

  function scheduleRestart(entry: ServiceEntry, why: string): void {
    const at = Date.now();
    entry.crashes = [...entry.crashes.filter((time) => at - time < CRASH_WINDOW_MS), at];
    if (entry.crashes.length >= CRASH_LIMIT) {
      const reason = `the service stopped ${String(CRASH_LIMIT)} times in 10 minutes and was left stopped: ${why}`;
      entry.state = "failed";
      entry.reason = reason;
      markAll(entry, { healthy: false, blockedReason: reason.slice(0, 500) });
      log(`services: ${entry.key} ${reason}`);
      return;
    }
    const delay = Math.min(RESTART_CEILING_MS, restartBaseMs * 2 ** (entry.crashes.length - 1));
    entry.state = "restarting";
    entry.reason = `the service stopped and restarts in ${String(Math.round(delay / 1000))}s: ${why}`;
    markAll(entry, { healthy: false, blockedReason: entry.reason.slice(0, 500) });
    const epoch = entry.epoch;
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined;
      if (halted || entry.epoch !== epoch || !entries.has(entry.key)) return;
      void start(entry);
    }, delay);
    entry.restartTimer.unref?.();
  }

  function onGone(entry: ServiceEntry, epoch: number, reason: Error): void {
    if (halted || entry.epoch !== epoch) return;
    entry.epoch += 1;
    clearTimers(entry);
    entry.connection = undefined;
    log(`services: ${entry.key} stopped: ${reason.message.slice(0, 300)}`);
    // What a person reads: the MCP client names the server by its internal generation id, which says nothing to them.
    const why = reason.message.replace(/^mcp server \S+ /u, "").slice(0, 300);
    // The container may outlive its command line on some engines; it is removed before a new one takes the name.
    const current = engine;
    const removal =
      current?.available === true && options.containers !== undefined
        ? options.containers.remove(current.engine, entry.containerName).catch(() => undefined)
        : Promise.resolve();
    void removal.then(() => scheduleRestart(entry, why));
  }

  async function start(entry: ServiceEntry): Promise<void> {
    const current = await engineOnce();
    entry.epoch += 1;
    const epoch = entry.epoch;
    clearTimers(entry);
    if (!current.available) {
      entry.state = "stopped";
      entry.reason = current.reason;
      markAll(entry, { loaded: false, healthy: false, blockedReason: current.reason });
      return;
    }

    entry.state = "starting";
    entry.reason = "the service is starting";
    markAll(entry, { installed: true, loaded: false, healthy: false, blockedReason: "the service is starting" });

    if (options.containers !== undefined) {
      const image = await options.containers.ensureImage(current.engine);
      if (entry.epoch !== epoch) return;
      if (!image.ok) {
        scheduleRestart(entry, image.reason);
        return;
      }
      // A container left from a crash holds the name; it is this node's own and is removed.
      await options.containers.remove(current.engine, entry.containerName).catch(() => undefined);
      if (entry.epoch !== epoch) return;
    }

    const dataDir = join(options.dataDir, "services", dataFolderFor(entry.generation.packageId), entry.facet.id);
    prepareServiceDataDir(dataDir);
    const launch = launcher({
      engine: current.engine,
      nodeId: registry.nodeId,
      name: entry.containerName,
      packageRoot: entry.packageRoot,
      dataDir,
      entry: entry.facet.entry,
    });

    let connection: ServiceConnection;
    let listed: McpToolMetadata[];
    try {
      connection = await connect({
        serverId: entry.key,
        command: launch.command,
        args: launch.args,
        env: engineEnvironment(),
        inheritEnv: false,
        requestTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        onExit: (reason) => onGone(entry, epoch, reason),
      });
      if (entry.epoch !== epoch) {
        await connection.close().catch(() => undefined);
        return;
      }
      listed = await connection.listTools();
    } catch (cause) {
      if (entry.epoch !== epoch) return;
      const why = cause instanceof Error ? cause.message : String(cause);
      entry.epoch += 1;
      if (options.containers !== undefined) {
        await options.containers.remove(current.engine, entry.containerName).catch(() => undefined);
      }
      scheduleRestart(entry, why.slice(0, 300));
      return;
    }
    if (entry.epoch !== epoch) {
      await connection.close().catch(() => undefined);
      return;
    }

    entry.connection = connection;
    entry.state = "running";
    entry.reason = undefined;
    entry.tools.clear();
    const byName = new Map(listed.map((tool) => [tool.name, tool]));
    const declaredNames = new Set(entry.facet.capabilities.map((declaration) => declaration.tool));
    for (const declaration of entry.facet.capabilities) {
      const tool = byName.get(declaration.tool);
      if (tool === undefined) {
        register(entry, declaration, {
          readiness: readiness({
            loaded: false,
            healthy: true,
            blockedReason: `the service does not provide the tool ${declaration.tool} its package declares`,
          }),
        });
        continue;
      }
      entry.tools.set(declaration.ref, declaration.tool);
      register(entry, declaration, {
        readiness: readiness({ loaded: true, healthy: true }),
        effectCategory: serviceEffectCategory(declaration.effectCategory, tool),
        inputSchema: tool.inputSchema,
      });
    }
    const undeclared = listed.filter((tool) => !declaredNames.has(tool.name)).map((tool) => tool.name);
    if (undeclared.length > 0) {
      log(`services: ${entry.key} offers ${undeclared.join(", ")}, which its package does not declare; not registered`);
    }
    entry.pingTimer = setInterval(() => {
      if (entry.epoch !== epoch || entry.connection === undefined) return;
      entry.connection.ping().catch((cause: unknown) => {
        if (entry.epoch !== epoch) return;
        const why = `it stopped answering: ${cause instanceof Error ? cause.message : String(cause)}`;
        const stale = entry.connection;
        onGone(entry, epoch, new Error(why));
        void stale?.close().catch(() => undefined);
      });
    }, pingIntervalMs);
    entry.pingTimer.unref?.();
  }

  async function reconcileNow(): Promise<void> {
    if (halted) return;
    const wanted = desired();
    const current = wanted.size > 0 || entries.size > 0 ? await engineOnce() : engine;
    if (!swept && current?.available === true && options.containers !== undefined) {
      swept = true;
      const removed = await options.containers.sweep(current.engine, registry.nodeId).catch(() => []);
      if (removed.length > 0) log(`services: removed ${String(removed.length)} container(s) a previous run left behind`);
    }

    // Stopped first, so a new generation's registration of the same ref is the one that remains.
    for (const [key, entry] of entries) {
      if (wanted.has(key)) continue;
      entries.delete(key);
      await stop(entry, "stopped", "the package that provides it is no longer active");
      const stillProvided = new Set(
        [...wanted.values()].flatMap((next) => next.facet.capabilities.map((declaration) => declaration.ref)),
      );
      for (const declaration of entry.facet.capabilities) {
        if (stillProvided.has(declaration.ref)) continue;
        if (getCapability(registry, declaration.ref, registry.nodeId) === undefined) continue;
        updateReadiness(registry, {
          ref: declaration.ref,
          executionNodeId: registry.nodeId,
          change: {
            installed: false,
            loaded: false,
            healthy: false,
            blockedReason: "the package that provides it is no longer installed",
          },
          at: now(),
        });
      }
    }

    for (const [key, next] of wanted) {
      if (entries.has(key)) continue;
      const entry: ServiceEntry = { ...next, state: "starting", tools: new Map(), crashes: [], epoch: 0 };
      entries.set(key, entry);
      // Each service starts on its own: one that takes a minute to fetch its image does not hold the others.
      void start(entry).catch((cause: unknown) => {
        log(`services: ${key} could not start: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    }
  }

  function reconcile(): Promise<void> {
    queue = queue.then(reconcileNow, reconcileNow);
    return queue;
  }

  return {
    reconcile,

    async call(ref, args) {
      const entry = [...entries.values()].find((candidate) => candidate.tools.has(ref));
      const tool = entry?.tools.get(ref);
      if (entry === undefined || tool === undefined || entry.state !== "running" || entry.connection === undefined) {
        const reason = entry?.reason ?? "no running service provides it on this node";
        throw new ServiceCallError("SERVICE_NOT_RUNNING", `${ref} cannot run now: ${reason}`);
      }
      try {
        return await entry.connection.callTool(tool, args, { timeoutMs: CALL_TIMEOUT_MS });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // A tool that answered with an error is the service's own verdict; anything else is the service failing.
        const code: ServiceCallFailure = message.includes("reported an error") ? "SERVICE_TOOL_FAILED" : "SERVICE_UNREACHABLE";
        throw new ServiceCallError(code, message.slice(0, 500));
      }
    },

    serves(ref) {
      for (const entry of entries.values()) {
        if (entry.facet.capabilities.some((declaration) => declaration.ref === ref)) {
          return { packageId: entry.generation.packageId, generationId: entry.generation.generationId };
        }
      }
      return undefined;
    },

    async stopAll(stopOptions = {}) {
      halted = true;
      const running = [...entries.values()].filter((entry) => entry.connection !== undefined).length;
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          await stop(entry, "stopped", "the node stopped its services");
          markAll(entry, { loaded: false, healthy: false, blockedReason: "the node stopped its services" });
        }),
      );
      entries.clear();
      if (stopOptions.restart === true) {
        halted = false;
        await reconcile();
      }
      return running;
    },

    status() {
      return [...entries.values()].map((entry) => ({
        key: entry.key,
        packageId: entry.generation.packageId,
        state: entry.state,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        refs: entry.facet.capabilities.map((declaration) => declaration.ref),
      }));
    },
  };
}

/**
 * Where an active generation's files are, from the node's directory listing.
 *
 * The same join the frame route makes: a local entry is its own path, and a git or npm entry is the cache folder the
 * install fetched it into. Matched on version and digest, because a listing that now names different bytes for the
 * same version is not the code that was consented to.
 */
export function packageRootFrom(entries: readonly DirectoryEntry[], cacheRoot: string) {
  return (generation: PackageGeneration): string | undefined => {
    const entry = entries.find(
      (candidate) =>
        candidate.version === generation.version &&
        candidate.digest === generation.digest &&
        (candidate.packageId === generation.packageId ||
          (candidate.source.kind === "local" && candidate.source.path === generation.packageId)),
    );
    if (entry === undefined) return undefined;
    const source = entry.source.kind === "local" ? entry.source : resolveLocalSource(entry, cacheRoot);
    return source.kind === "local" ? source.path : undefined;
  };
}

/** The production housekeeping, bound to the engine's command line. */
export const engineContainers: NonNullable<ServiceHostOptions["containers"]> = {
  ensureImage: (engine) => ensureServiceImage(engine),
  remove: (engine, name) => removeServiceContainer(engine, name),
  sweep: (engine, nodeId) => sweepServiceContainers(engine, nodeId),
};
