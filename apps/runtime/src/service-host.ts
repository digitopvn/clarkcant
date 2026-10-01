import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import {
  type CapabilityDescriptor,
  type CapabilityReadiness,
  type CapabilityRef,
  describeUnsafePattern,
  type DirectoryEntry,
  type EffectCategory,
  type Instant,
  type PackageGeneration,
  type ServiceCapabilityDeclaration,
  type ToolsFacet,
  unsafeSchemaPattern,
} from "@clarkcant/contracts";
import {
  activeGenerations,
  getCapability,
  packageProvidedCapabilities,
  readPackage,
  registerCapability,
  type RegistryDeps,
  resolveLocalSource,
  updateReadiness,
} from "@clarkcant/core";
import {
  McpRequestCancelled,
  McpRequestNotSent,
  McpRequestTimeout,
  type McpToolFile,
  type McpToolMetadata,
  StdioMcpTransport,
  type StdioMcpTransportOptions,
} from "@clarkcant/mcp-adapters";

import {
  type ContainerEngineName,
  engineEnvironment,
  ensureServiceImage,
  NEEDS_ENGINE_REASON,
  prepareServiceDataDir,
  removeServiceContainer,
  type ServiceEngine,
  serviceContainerName,
  serviceRunArgs,
  sweepServiceContainers,
} from "./service-container.ts";

export { engineEnvironment } from "./service-container.ts";

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
 * with that as the reason, so a person reads why the button is off rather than a generic failure. So is a declared tool
 * whose input schema holds a pattern that could take unbounded time to check (`schema-patterns.ts` in `@clarkcant/contracts`): every
 * call is checked against that schema on the node's main thread, so the schema is refused rather than stored.
 *
 * A package only ever writes its own rows. A ref the registry already holds for something else — one of the node's own
 * capabilities, or another package's — is left as it is, and the facet does not serve it. Once that other package is no
 * longer active, the next reconcile claims the ref for this facet, without restarting its service.
 */

/**
 * A service that stops is restarted after one second, doubling each time; one that stops five times in ten minutes is
 * left stopped. A runtime image that cannot be fetched is not the service's fault: it is retried, backing off to a
 * minute, without counting towards that limit.
 */
const RESTART_BASE_MS = 1_000;
const RESTART_CEILING_MS = 60_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 5;
const PING_INTERVAL_MS = 30_000;
/** How long a node that found no engine waits before asking again, so starting Docker later is noticed. */
const ENGINE_RETRY_MS = 60_000;
/** A container's first answer includes Node starting inside it, which is slower than a bare process. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;
const JOB_CALL_TIMEOUT_MS = 30 * 60_000;

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
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal; onProgress?: (progress: { current: number; total?: number; message?: string }) => void },
  ): Promise<{ content: string; files?: McpToolFile[]; filesOmitted?: true }>;
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

export interface ServiceHostOptions {
  registry: RegistryDeps;
  dataDir: string;
  /** Asked on first use, so a node never waits on the engine before it can listen, and again while it finds none. */
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
  timings?: { restartBaseMs?: number; pingIntervalMs?: number; engineRetryMs?: number };
}

/**
 * Why a call did not come back with an answer.
 *
 * `SERVICE_TIMED_OUT` and `SERVICE_CANCELLED` are their own codes rather than kinds of "unreachable": the request was
 * sent and the service was reachable, so what it was asked to do may have been done. A caller that recorded an effect
 * has to say that, not that nothing happened.
 */
export type ServiceCallFailure =
  | "SERVICE_NOT_RUNNING"
  | "SERVICE_TOOL_FAILED"
  | "SERVICE_UNREACHABLE"
  | "SERVICE_TIMED_OUT"
  | "SERVICE_CANCELLED";

/** How a caller bounds one call: a deadline shorter than the host's own, and a signal that withdraws it. */
export interface ServiceCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { current: number; total?: number; message?: string }) => void;
}

export class ServiceCallError extends Error {
  readonly code: ServiceCallFailure;
  /**
   * Whether the request was written to the service before it failed. `false` means nothing reached it — it was not
   * running, or the call was withdrawn before it was written — so nothing can have happened; `true` means the service
   * may have acted, whatever came back.
   */
  readonly sent: boolean;
  constructor(code: ServiceCallFailure, message: string, sent = code !== "SERVICE_NOT_RUNNING") {
    super(message);
    this.code = code;
    this.sent = sent;
  }
}

export interface ServiceHost {
  /** Bring the running services in line with what is installed. Serialised: a second call waits for the first. */
  reconcile(): Promise<void>;
  /** Call a registered service capability. The caller has already asked the policy; this only runs it. */
  call(ref: CapabilityRef, args: Record<string, unknown>, options?: ServiceCallOptions): Promise<{ content: string; files?: McpToolFile[]; filesOmitted?: true }>;
  /**
   * The active generation whose service facet declares this ref and owns its registry row, whatever state the service
   * is in.
   *
   * What makes a capability a service capability of this node: a ref some other part of the node registered, one
   * another package holds, or one a package no longer active declared, is not something this host runs.
   */
  serves(ref: CapabilityRef): { packageId: string; generationId: string } | undefined;
  /** The manifest's explicit execution mode; omission preserves synchronous capability calls. */
  execution?(ref: CapabilityRef): { kind: "job"; version: 1 } | undefined;
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
  /** The stable part of the container's name; each run adds its epoch, so a late cleanup never removes a newer run. */
  containerName: string;
  state: ServiceState;
  reason?: string | undefined;
  connection?: ServiceConnection | undefined;
  /** The container of the run in progress or running, so a stop removes exactly that one. */
  runName?: string | undefined;
  /** Declared ref → the tool it runs, once matched against what the service listed. */
  tools: Map<CapabilityRef, string>;
  /** What the running service listed, by name, so a ref freed later is served without restarting it. */
  listed?: ReadonlyMap<string, McpToolMetadata> | undefined;
  crashes: number[];
  /** Consecutive image fetches that failed, for their own backoff. */
  fetchFailures: number;
  restartTimer?: ReturnType<typeof setTimeout> | undefined;
  pingTimer?: ReturnType<typeof setInterval> | undefined;
  /** Bumped on every start and stop, so a late answer from a previous run cannot change the current one. */
  epoch: number;
  /** Refs this facet declares that the registry holds for something else, already logged. */
  refused: Set<CapabilityRef>;
}

/**
 * A folder name for a package's or a facet's private data: readable, unique even when the id is a local path, and a
 * single segment every platform reads as a plain name — no separator, no dot (so no `..` and no `CON.x` device name),
 * never empty.
 */
function dataFolderFor(id: string): string {
  const readable = id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(-60) || "id";
  return `${readable}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

/** The facet's private folder, refused if it would resolve anywhere but under the node's own services folder. */
function serviceDataDir(dataDir: string, packageId: string, facetId: string): string {
  const servicesRoot = resolve(dataDir, "services");
  const folder = resolve(servicesRoot, dataFolderFor(packageId), dataFolderFor(facetId));
  const inside = relative(servicesRoot, folder);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`the service's private folder would be outside ${servicesRoot}`);
  }
  return folder;
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
  const engineRetryMs = options.timings?.engineRetryMs ?? ENGINE_RETRY_MS;

  const entries = new Map<string, ServiceEntry>();
  let engine: ServiceEngine | undefined;
  let engineAskedAt = 0;
  let detecting: Promise<ServiceEngine> | undefined;
  let swept = false;
  let queue: Promise<unknown> = Promise.resolve();
  let halted = false;

  /*
   * What the registry said about a service when the node last ran is not what is true now: nothing has started yet on
   * this run. Rows a package service registered are marked so before anything reads them, and each is brought up to
   * date as its service starts.
   */
  for (const row of packageProvidedCapabilities(registry)) {
    updateReadiness(registry, {
      ref: row.ref,
      executionNodeId: registry.nodeId,
      change: { loaded: false, healthy: false, blockedReason: "the service has not started yet" },
      at: now(),
    });
  }

  /**
   * The engine that runs services. One that was found is kept; an answer that there is none is asked again once it is
   * a minute old, so a person who starts Docker after the node does not have to restart the node too.
   */
  function currentEngine(): Promise<ServiceEngine> {
    if (engine?.available === true) return Promise.resolve(engine);
    if (engine !== undefined && Date.now() - engineAskedAt < engineRetryMs) return Promise.resolve(engine);
    detecting ??= options
      .engine()
      .catch(
        (cause: unknown): ServiceEngine => ({
          available: false,
          reason: NEEDS_ENGINE_REASON,
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      )
      .then((found) => {
        const changed = engine === undefined || engine.available !== found.available;
        engine = found;
        engineAskedAt = Date.now();
        if (changed) {
          if (found.available) {
        log(`services: ${found.engine} ${found.version}${found.rootless === true ? " (rootless)" : ""} runs package services on this node`);
      }
          else log(`services: not started — ${found.reason} (${found.detail})`);
        }
        return found;
      })
      .finally(() => {
        detecting = undefined;
      });
    return detecting;
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

  function providerIdOf(entry: Pick<ServiceEntry, "generation">): string {
    return entry.generation.packageId.slice(0, 160);
  }

  /**
   * Whether a ref's registry row is free or already this package's. Read only; `claim` is the one that reports.
   *
   * A row another package wrote outlives that package: it stays, marked not installed, after the package is removed. It
   * is free again once that package has no active generation on this node; an update of it still holds the row. A row
   * the node wrote itself is never free.
   */
  function owns(entry: Pick<ServiceEntry, "generation">, ref: CapabilityRef): boolean {
    const existing = getCapability(registry, ref, registry.nodeId);
    if (existing === undefined || existing.providedBy?.packageId === providerIdOf(entry)) return true;
    const holder = existing.providedBy?.packageId;
    return holder !== undefined && !activeGenerations(registry).some((generation) => providerIdOf({ generation }) === holder);
  }

  /**
   * Whether this facet may write a ref's row. A row the node or another package holds is not overwritten: the facet
   * does not serve that ref, and the log says so once per facet. A ref refused once stays refused until a reconcile
   * finds it free (`reclaimFreed`), so a restart in between does not quietly take it.
   */
  function claim(entry: ServiceEntry, ref: CapabilityRef): boolean {
    if (entry.refused.has(ref)) return false;
    if (owns(entry, ref)) return true;
    if (!entry.refused.has(ref)) {
      entry.refused.add(ref);
      log(`services: ${entry.key} declares ${ref}, which is already registered by something else on this node; not served`);
    }
    return false;
  }

  function register(
    entry: ServiceEntry,
    declaration: ServiceCapabilityDeclaration,
    state: { readiness: CapabilityReadiness; effectCategory?: EffectCategory; inputSchema?: Record<string, unknown> },
  ): void {
    if (!claim(entry, declaration.ref)) return;
    const descriptor: CapabilityDescriptor = {
      ref: declaration.ref,
      providedBy: {
        packageId: providerIdOf(entry),
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

  /** Register one declared tool against what the running service listed: ready, or not loaded with the reason. */
  function registerListed(
    entry: ServiceEntry,
    declaration: ServiceCapabilityDeclaration,
    listed: ReadonlyMap<string, McpToolMetadata>,
  ): void {
    const tool = listed.get(declaration.tool);
    if (tool === undefined) {
      register(entry, declaration, {
        readiness: readiness({
          loaded: false,
          healthy: true,
          blockedReason: `the service does not provide the tool ${declaration.tool} its package declares`,
        }),
      });
      return;
    }
    const unsafe = unsafeSchemaPattern(tool.inputSchema);
    if (unsafe !== undefined) {
      // Not run, and its schema not kept: every call would be checked against it on the node's main thread.
      const reason = `the input schema the service lists for ${declaration.tool} was refused, and a version of the package with a simpler pattern will load: ${describeUnsafePattern(unsafe)}`;
      register(entry, declaration, { readiness: readiness({ loaded: false, healthy: true, blockedReason: reason.slice(0, 500) }) });
      log(`services: ${entry.key} ${reason}`);
      return;
    }
    if (!claim(entry, declaration.ref)) return;
    entry.tools.set(declaration.ref, declaration.tool);
    register(entry, declaration, {
      readiness: readiness({ loaded: true, healthy: true }),
      effectCategory: serviceEffectCategory(declaration.effectCategory, tool),
      inputSchema: tool.inputSchema,
    });
  }

  /**
   * Claim the refs a facet was refused because something else held them, once that owner is gone.
   *
   * A running service is not restarted for it: the ref is registered against what the service already listed. One that
   * is not running registers the ref with its own current reason, and its next start registers it like the others.
   */
  function reclaimFreed(entry: ServiceEntry): void {
    for (const declaration of entry.facet.capabilities) {
      if (!entry.refused.has(declaration.ref) || !owns(entry, declaration.ref)) continue;
      entry.refused.delete(declaration.ref);
      log(`services: ${entry.key} now serves ${declaration.ref}; what registered it before is no longer on this node`);
      if (entry.state === "running" && entry.listed !== undefined) {
        registerListed(entry, declaration, entry.listed);
        continue;
      }
      const reason = (entry.reason ?? "the service has not started yet").slice(0, 500);
      register(entry, declaration, { readiness: readiness({ loaded: false, healthy: false, blockedReason: reason }) });
    }
  }

  /** Mark every capability of a facet with one readiness change, keeping what was learned about each tool. */
  function markAll(entry: ServiceEntry, change: Partial<CapabilityReadiness>): void {
    for (const declaration of entry.facet.capabilities) {
      if (!claim(entry, declaration.ref)) continue;
      if (getCapability(registry, declaration.ref, registry.nodeId) === undefined) {
        register(entry, declaration, { readiness: readiness(change) });
        continue;
      }
      updateReadiness(registry, { ref: declaration.ref, executionNodeId: registry.nodeId, change, at: now() });
    }
  }

  /** Say why a generation's service is not started, on the rows it registered on an earlier run. */
  function markGeneration(generationId: string, reason: string): void {
    for (const row of packageProvidedCapabilities(registry)) {
      if (row.generation !== generationId) continue;
      updateReadiness(registry, {
        ref: row.ref,
        executionNodeId: registry.nodeId,
        change: { loaded: false, healthy: false, blockedReason: reason.slice(0, 500) },
        at: now(),
      });
    }
  }

  type Wanted = Pick<ServiceEntry, "key" | "generation" | "facet" | "packageRoot" | "containerName">;

  function desired(): Map<string, Wanted> {
    const wanted = new Map<string, Wanted>();
    for (const generation of activeGenerations(registry)) {
      const root = options.packageRoot(generation);
      if (root === undefined) {
        markGeneration(generation.generationId, "the package's files are not on this node");
        continue;
      }
      let manifest;
      try {
        manifest = readPackage(root).manifest;
      } catch (cause) {
        const why = cause instanceof Error ? cause.message : String(cause);
        markGeneration(generation.generationId, `the package's manifest could not be read: ${why}`);
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

  /** Whether an entry is still the one the host runs for its key, and the host is not stopped. */
  function current(entry: ServiceEntry, epoch: number): boolean {
    return !halted && entries.get(entry.key) === entry && entry.epoch === epoch;
  }

  function clearTimers(entry: ServiceEntry): void {
    if (entry.restartTimer !== undefined) clearTimeout(entry.restartTimer);
    if (entry.pingTimer !== undefined) clearInterval(entry.pingTimer);
    entry.restartTimer = undefined;
    entry.pingTimer = undefined;
  }

  async function removeContainer(name: string | undefined): Promise<void> {
    const known = engine;
    if (name === undefined || known?.available !== true || options.containers === undefined) return;
    await options.containers.remove(known.engine, name).catch(() => undefined);
  }

  async function stop(entry: ServiceEntry, finalState: ServiceState, reason: string): Promise<void> {
    entry.epoch += 1;
    clearTimers(entry);
    entry.state = finalState;
    entry.reason = reason;
    const connection = entry.connection;
    const runName = entry.runName;
    entry.connection = undefined;
    entry.runName = undefined;
    entry.listed = undefined;
    await connection?.close().catch(() => undefined);
    // Closing the engine's command line does not stop the container on every engine; removing it does.
    await removeContainer(runName);
  }

  /** Start the entry again after `delay`, unless something else started or stopped it in the meantime. */
  function later(entry: ServiceEntry, delay: number): void {
    const epoch = entry.epoch;
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined;
      if (!current(entry, epoch)) return;
      void start(entry);
    }, delay);
    entry.restartTimer.unref?.();
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
    later(entry, delay);
  }

  function onGone(entry: ServiceEntry, epoch: number, runName: string, reason: Error): void {
    if (!current(entry, epoch)) return;
    entry.epoch += 1;
    const next = entry.epoch;
    clearTimers(entry);
    entry.connection = undefined;
    entry.runName = undefined;
    entry.state = "restarting";
    log(`services: ${entry.key} stopped: ${reason.message.slice(0, 300)}`);
    // What a person reads: the MCP client names the server by its internal generation id, which says nothing to them.
    const why = reason.message.replace(/^mcp server \S+ /u, "").slice(0, 300);
    entry.reason = `the service stopped: ${why}`;
    // Down from this moment, not from when the container is gone: a call in between would be sent nowhere.
    markAll(entry, { healthy: false, blockedReason: entry.reason.slice(0, 500) });
    // The container may outlive its command line on some engines; it is removed before a new run starts.
    void removeContainer(runName).then(() => {
      if (current(entry, next)) scheduleRestart(entry, why);
    });
  }

  async function start(entry: ServiceEntry): Promise<void> {
    const found = await currentEngine();
    if (halted || entries.get(entry.key) !== entry) return;
    entry.epoch += 1;
    const epoch = entry.epoch;
    clearTimers(entry);
    if (!found.available) {
      entry.state = "stopped";
      entry.reason = found.reason;
      markAll(entry, { loaded: false, healthy: false, blockedReason: found.reason });
      // Asked again later: an engine started after the node is picked up without a restart.
      later(entry, engineRetryMs);
      return;
    }

    entry.state = "starting";
    entry.reason = "the service is starting";
    markAll(entry, { installed: true, loaded: false, healthy: false, blockedReason: "the service is starting" });

    if (options.containers !== undefined) {
      const image = await options.containers.ensureImage(found.engine);
      if (!current(entry, epoch)) return;
      if (!image.ok) {
        const delay = Math.min(RESTART_CEILING_MS, restartBaseMs * 2 ** entry.fetchFailures);
        entry.fetchFailures += 1;
        entry.state = "restarting";
        entry.reason = `${image.reason}; trying again in ${String(Math.round(delay / 1000))}s`;
        markAll(entry, { loaded: false, healthy: false, blockedReason: entry.reason.slice(0, 500) });
        later(entry, delay);
        return;
      }
      entry.fetchFailures = 0;
    }

    const runName = `${entry.containerName}-${String(epoch)}`;
    let launch: { command: string; args: string[] };
    let dataDir: string;
    try {
      dataDir = serviceDataDir(options.dataDir, entry.generation.packageId, entry.facet.id);
      prepareServiceDataDir(dataDir);
      launch = launcher({
        engine: found.engine,
        ...(found.rootless === true ? { rootless: true } : {}),
        nodeId: registry.nodeId,
        name: runName,
        packageRoot: entry.packageRoot,
        dataDir,
        entry: entry.facet.entry,
      });
    } catch (cause) {
      // Not something a restart changes: the package's folder or the node's data folder cannot be given to a container.
      const why = cause instanceof Error ? cause.message : String(cause);
      entry.state = "failed";
      entry.reason = why.slice(0, 500);
      markAll(entry, { loaded: false, healthy: false, blockedReason: entry.reason });
      log(`services: ${entry.key} cannot start: ${why}`);
      return;
    }
    entry.runName = runName;

    let connection: ServiceConnection | undefined;
    let listed: McpToolMetadata[];
    try {
      connection = await connect({
        serverId: entry.key,
        command: launch.command,
        args: launch.args,
        env: engineEnvironment(),
        inheritEnv: false,
        requestTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        onExit: (reason) => onGone(entry, epoch, runName, reason),
      });
      if (!current(entry, epoch)) throw new Error("superseded");
      listed = await connection.listTools();
    } catch (cause) {
      await connection?.close().catch(() => undefined);
      // This run's container, and only this run's: a newer run has its own name.
      await removeContainer(runName);
      if (!current(entry, epoch)) return;
      const why = cause instanceof Error ? cause.message : String(cause);
      entry.epoch += 1;
      entry.runName = undefined;
      scheduleRestart(entry, why.slice(0, 300));
      return;
    }
    if (!current(entry, epoch)) {
      await connection.close().catch(() => undefined);
      await removeContainer(runName);
      return;
    }

    entry.connection = connection;
    entry.state = "running";
    entry.reason = undefined;
    entry.tools.clear();
    entry.listed = new Map(listed.map((tool) => [tool.name, tool]));
    const declaredNames = new Set(entry.facet.capabilities.map((declaration) => declaration.tool));
    for (const declaration of entry.facet.capabilities) registerListed(entry, declaration, entry.listed);
    const undeclared = listed.filter((tool) => !declaredNames.has(tool.name)).map((tool) => tool.name);
    if (undeclared.length > 0) {
      log(`services: ${entry.key} offers ${undeclared.join(", ")}, which its package does not declare; not registered`);
    }
    entry.pingTimer = setInterval(() => {
      if (!current(entry, epoch) || entry.connection === undefined) return;
      const pinged = entry.connection;
      pinged.ping().catch((cause: unknown) => {
        if (!current(entry, epoch)) return;
        const why = `it stopped answering: ${cause instanceof Error ? cause.message : String(cause)}`;
        onGone(entry, epoch, runName, new Error(why));
        void pinged.close().catch(() => undefined);
      });
    }, pingIntervalMs);
    entry.pingTimer.unref?.();
  }

  async function reconcileNow(): Promise<void> {
    if (halted) return;
    const wanted = desired();
    const found = wanted.size > 0 || entries.size > 0 ? await currentEngine() : engine;
    if (!swept && found?.available === true && options.containers !== undefined) {
      swept = true;
      const removed = await options.containers.sweep(found.engine, registry.nodeId).catch(() => []);
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
        // Only the rows this generation wrote: a ref it was refused is someone else's, and stays as it is.
        const existing = getCapability(registry, declaration.ref, registry.nodeId);
        if (existing?.providedBy?.generation !== entry.generation.generationId) continue;
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

    // A ref a running facet was refused is claimed once what held it is gone, in this reconcile rather than at a restart.
    for (const entry of entries.values()) reclaimFreed(entry);

    for (const [key, next] of wanted) {
      if (entries.has(key)) continue;
      const entry: ServiceEntry = {
        ...next,
        state: "starting",
        tools: new Map(),
        crashes: [],
        fetchFailures: 0,
        epoch: 0,
        refused: new Set(),
      };
      entries.set(key, entry);
      // Each service starts on its own: one that takes a minute to fetch its image does not hold the others.
      void start(entry).catch((cause: unknown) => {
        log(`services: ${key} could not start: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    }
  }

  /** Run one step after every step already asked for, so a stop and a reconcile never interleave. */
  function serialised<T>(step: () => Promise<T>): Promise<T> {
    const run = queue.then(step, step);
    queue = run.catch(() => undefined);
    return run;
  }

  async function stopNow(): Promise<number> {
    const running = [...entries.values()].filter((entry) => entry.connection !== undefined).length;
    await Promise.all(
      [...entries.values()].map(async (entry) => {
        await stop(entry, "stopped", "the node stopped its services");
        markAll(entry, { loaded: false, healthy: false, blockedReason: "the node stopped its services" });
      }),
    );
    entries.clear();
    return running;
  }

  return {
    reconcile: () => serialised(reconcileNow),

    async call(ref, args, options = {}) {
      const entry = [...entries.values()].find((candidate) => candidate.tools.has(ref));
      const tool = entry?.tools.get(ref);
      if (entry === undefined || tool === undefined || entry.state !== "running" || entry.connection === undefined) {
        const reason = entry?.reason ?? "no running service provides it on this node";
        throw new ServiceCallError("SERVICE_NOT_RUNNING", `${ref} cannot run now: ${reason}`);
      }
      try {
        // A caller may ask for less time than the host allows, never for more.
        const jobMode = entry.facet.capabilities.some((declaration) => declaration.ref === ref && declaration.execution?.kind === "job");
        const ceiling = jobMode ? JOB_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS;
        const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? ceiling, ceiling));
        return await entry.connection.callTool(tool, args, {
          timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        // A tool that answered with an error is the service's own verdict; a request that ran out of time or was
        // withdrawn was sent and never answered; anything else is the service failing.
        // A request that never reached the service changed nothing, whatever else is true, so it is said first.
        if (cause instanceof McpRequestNotSent || (cause instanceof McpRequestCancelled && !cause.sent)) {
          throw new ServiceCallError(
            cause instanceof McpRequestNotSent ? "SERVICE_NOT_RUNNING" : "SERVICE_CANCELLED",
            message.slice(0, 500),
            false,
          );
        }
        const code: ServiceCallFailure =
          cause instanceof McpRequestCancelled || options.signal?.aborted === true
            ? "SERVICE_CANCELLED"
            : cause instanceof McpRequestTimeout
              ? "SERVICE_TIMED_OUT"
              : message.includes("reported an error")
                ? "SERVICE_TOOL_FAILED"
                : "SERVICE_UNREACHABLE";
        throw new ServiceCallError(code, message.slice(0, 500), true);
      }
    },

    serves(ref) {
      for (const entry of entries.values()) {
        if (!entry.facet.capabilities.some((declaration) => declaration.ref === ref)) continue;
        // Another facet may declare the same ref and hold it; this one does not serve it, that one might. A ref this
        // facet was refused stays refused until a reconcile claims it.
        if (entry.refused.has(ref) || !owns(entry, ref)) continue;
        return { packageId: entry.generation.packageId, generationId: entry.generation.generationId };
      }
      return undefined;
    },

    execution(ref) {
      for (const entry of entries.values()) {
        if (!entry.facet.capabilities.some((declaration) => declaration.ref === ref) || entry.refused.has(ref) || !owns(entry, ref)) continue;
        return entry.facet.capabilities.find((declaration) => declaration.ref === ref)?.execution;
      }
      return undefined;
    },

    async stopAll(stopOptions = {}) {
      // Halted at once, so a restart timer that fires while earlier steps finish starts nothing.
      halted = true;
      const stopped = await serialised(stopNow);
      if (stopOptions.restart === true) {
        halted = false;
        await serialised(reconcileNow);
      }
      return stopped;
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
