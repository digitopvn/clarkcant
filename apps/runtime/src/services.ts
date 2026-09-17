import { randomBytes } from "node:crypto";

import { type Instant, type WidgetDefinition, nowInstant } from "@clarkcant/contracts";
import {
  type ConductorDeps,
  type WidgetDeps,
  getInstance,
  listCapabilitySummaries,
  listPinsForConversation,
  liveOwnerOf,
  liveStateOf,
  registerCapability,
} from "@clarkcant/core";
import {
  conversationMetadata,
  findCompositionByInstance,
  listActiveTasks,
  listSnapshotsForMessage,
  messagesSince,
  upsertDataset,
} from "@clarkcant/storage";
import { FAMILY_BY_DEFINITION, WIDGETS as CATALOG_WIDGETS } from "@clarkcant/data-canvas";
import { QUICK_PLAY_RECIPES, SAMPLE_DATASET } from "@clarkcant/data-canvas/sample";
import { CAPABILITIES as PROJECT_WORK_CAPABILITIES } from "@clarkcant/project-work";
import {
  CatalogRegistry,
  missingCompositionFamilies,
  registerCatalog,
  validateProps,
} from "@clarkcant/widget-host";

import { loadLocalEmbedder } from "./embeddings-local.ts";
import { type NodeModelInfo, type Runtime, type RuntimeOptions, bootRuntime } from "./node.ts";
import {
  type VectorIndexService,
  createVectorIndexService,
  loadVectorExtension,
  semanticSearchFromEnv,
} from "./vector-index.ts";
import { homedir } from "node:os";

import { getPreference } from "@clarkcant/core";

import { type ComposeDeps } from "./compose-mini-app.ts";
import { type ProjectFinderDeps } from "./project-finder.ts";
import { type ProjectSessionStarter, createProjectSessionStarter } from "./project-session.ts";
import {
  decideRuntimeTarget,
  decisionTimeoutMsFromEnv,
  searchDeciderFromEnv,
  searchDecisionBudget,
} from "./jev-decider.ts";
import type { RuntimeCandidate } from "./runtime-candidates.ts";
import type { SessionSearchDeps } from "./session-search.ts";
import {
  type SessionStoreDeps,
  ensureSessionsDirectory,
  registerSessionFile,
  sessionStoreDepsFrom,
  sessionsDirectory,
} from "./session-store.ts";
import {
  type JevConfig,
  type JevDeps,
  type JevTelemetry,
  createFetchTransport,
  createJevBudget,
  jevConfigFromEnv,
} from "./jev-selector.ts";

/**
 * Composition root.
 *
 * Everything the gateway needs is assembled here, so the transport layer stays thin and
 * the wiring is testable without a socket. Two decisions are deliberate:
 *
 *   - **Widget props are validated before they are stored.** The validator is injected
 *     rather than imported, because `@clarkcant/core` must not depend on
 *     `@clarkcant/widget-host`; the composition root is the right place to connect them.
 *   - **Registered capabilities start unavailable.** Declaring a capability is not the
 *     same as having a worker that can run it, and starting them healthy would let the
 *     conductor dispatch into nothing.
 */

export interface NodeServices {
  runtime: Runtime;
  conductor: ConductorDeps;
  /** The model this node is configured for, or null when it has none. */
  model: NodeModelInfo | null;
  /** The selector, its wiring, and the counters a test or the health route can read. */
  jev: JevRuntime;
  /**
   * The catalog this node can actually draw.
   *
   * Registered with families so coverage can be checked against what a composed surface needs,
   * rather than discovered by a user looking at a region that never rendered.
   */
  catalog: CatalogRegistry;
  /** Required families this catalog cannot draw yet. Empty on a complete node. */
  missingFamilies: string[];
  /** Everything the composition step needs, assembled once so the turn pipeline stays thin. */
  compose: ComposeDeps;
  /**
   * The Session Manager surface: where worker transcripts live and what is indexed.
   *
   * Here rather than inside a worker because the supervisor swaps workers while this state has to
   * survive the swap.
   */
  sessions: SessionStoreDeps;
  /** The lexical retrieval layer, scoped to this node's owner principal. */
  search: SessionSearchDeps;
  /**
   * The vector half of retrieval, when this machine can run it.
   *
   * A service rather than a flag because the model has to be loaded exactly once and the index has to
   * say whether it is current, behind, or absent — and "absent" is a state the node reports.
   */
  vectors: VectorIndexService;
  /** The workspace finder: what is on this machine, and what the user meant. */
  projects: ProjectFinderDeps;
  /** How a session starts in a directory the finder chose. */
  projectSessions: ProjectSessionStarter;
  /** Runtime description surfaced by the health route. Contains no node identity. */
  describe: () => { node: string; platform: string; arch: string };
}

/**
 * The selector as the rest of the node sees it.
 *
 * `providerCallCount` exists so that "this path never calls the provider" is an assertion rather
 * than a claim: rendering history, changing a filter, opening a pin and replaying a turn all have
 * to be provably silent, and the only honest way to show that is to count the calls.
 */
export interface JevRuntime {
  config: JevConfig;
  deps: JevDeps;
  providerCallCount: () => number;
  telemetry: () => readonly JevTelemetry[];
}

/**
 * A discriminator unique to this process.
 *
 * A counter alone is not enough. It restarts at one whenever the node restarts, and the rows the
 * previous process wrote are still in the database — so the first message after every restart
 * collides with an id that already exists. That is not an edge case; it is what happens every
 * time the node is started a second time against an existing data directory.
 *
 * The start time separates two runs and the random suffix separates two runs that began in the
 * same millisecond.
 */
const idDiscriminator = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
let idCounter = 0;

/**
 * Mint an identifier for a record.
 *
 * Exported so its uniqueness across restarts can be tested directly. The property is not
 * incidental: this is the function whose counter-based predecessor took the node down on the
 * first message after a restart.
 */
export function newId(prefix: string): string {
  idCounter += 1;
  // Still short, still readable, and still ordered within a run, which keeps logs and fixtures
  // legible while making the value unique across runs.
  return `${prefix}_${idDiscriminator}${idCounter.toString(36)}`;
}

/**
 * Wire the selector.
 *
 * The telemetry sink is bounded and in-memory on purpose: it is an operator's window into what the
 * node asked a provider to decide, and it holds no request body, so nothing here needs retention
 * or redaction at rest. It is also the counter the tests read.
 */
function buildJevRuntime(options: RuntimeOptions): JevRuntime {
  const config: JevConfig = { ...jevConfigFromEnv(process.env), ...(options.jev?.config ?? {}) };
  const telemetry: JevTelemetry[] = [];
  let providerCalls = 0;

  const deps: JevDeps = {
    config,
    transport: options.jev?.transport ?? createFetchTransport(),
    newRequestId: () => newId("jevreq"),
    onTelemetry: (event) => {
      if (event.event === "call" || event.event === "error" || event.event === "model_drift") {
        providerCalls += 1;
      }
      telemetry.push(event);
      if (telemetry.length > 200) telemetry.shift();
      options.jev?.onTelemetry?.(event);
    },
  };

  return { config, deps, providerCallCount: () => providerCalls, telemetry: () => telemetry };
}

export function bootNodeServices(options: RuntimeOptions): NodeServices {
  const runtime = bootRuntime(options);
  const nodeId = runtime.identity.nodeId;
  const jevRuntime = buildJevRuntime(options);
  const catalog = registerCatalog(
    new CatalogRegistry(),
    CATALOG_WIDGETS.map((definition) => ({ definition, family: FAMILY_BY_DEFINITION[definition.id] ?? "unknown" })),
  );

  // A capability is registered so the conductor can park a task on it honestly, but it
  // starts not-installed: no worker has loaded it yet.
  for (const capability of PROJECT_WORK_CAPABILITIES) {
    registerCapability(
      { db: runtime.db, nodeId },
      {
        ...capability,
        executionNodeId: nodeId as never,
        readiness: {
          installed: false,
          loaded: false,
          authenticated: false,
          authorized: false,
          healthy: false,
          blockedReason: "the pack is declared but no worker has loaded it on this node",
        },
      },
    );
  }

  // The sample dataset is registered through the same path a real one would use, so the
  // renderer never special-cases demo data and the freshness label comes from one place.
  upsertDataset(runtime.db, {
    datasetId: SAMPLE_DATASET.datasetId,
    originNodeId: nodeId,
    rowCount: SAMPLE_DATASET.rows.length,
    freshness: "sample",
    updatedAt: nowInstant() satisfies Instant,
    document: SAMPLE_DATASET,
  });

  const base = {
    db: runtime.db,
    nodeId,
    now: () => nowInstant() satisfies Instant,
    newId,
  } satisfies WidgetDeps & { db: Runtime["db"]; nodeId: string };

  const conductor: ConductorDeps = {
    ...base,
    sampleRecipes: QUICK_PLAY_RECIPES,
    ...(options.respondWithModel === undefined ? {} : { respondWithModel: options.respondWithModel }),
    // Forwarded explicitly: accepting an option in the API and not wiring it into the conductor is
    // how a test seam silently does nothing.
    ...(options.composeFromIntent === undefined ? {} : { composeFromIntent: options.composeFromIntent }),
    /**
     * Route A: when more than one capability could do the work, Jev picks which one.
     *
     * The candidates are the capabilities the conductor has already filtered as usable — this is
     * "who does this work", not "what is running" — so only the registry's own summary and effect
     * class are described to the selector. A pair that cannot be re-read from the registry when the
     * answer comes back is dropped rather than dispatched to, and anything other than a decisive
     * selection returns `undefined` so the conductor keeps its deterministic order.
     */
    chooseExecutionNode: async ({ intent, candidates }) => {
      const pairs = new Map<string, { capabilityRef: string; executionNodeId: string }>();
      const offered: RuntimeCandidate[] = candidates.map((candidate) => {
        // Opaque handle: something to echo back, never something to construct. The mapping back to
        // the pair stays here rather than being parsed out of the id, so a ref that happens to
        // contain the separator cannot be read as two fields.
        const id = `${candidate.capabilityRef}@${candidate.executionNodeId}`;
        pairs.set(id, {
          capabilityRef: candidate.capabilityRef,
          executionNodeId: candidate.executionNodeId,
        });
        return {
          id,
          kind: "capability",
          label: candidate.capabilityRef,
          describe: `${candidate.capabilityRef} — ${candidate.effectCategory}`,
          capabilities: [candidate.capabilityRef],
          live: true,
          load: 0,
        };
      });

      const decision = await decideRuntimeTarget(
        {
          jev: jevRuntime.deps,
          // Choosing which capability does the work is a decision, not a composition, so it gets the
          // decision deadline the plan sets for the selector.
          budget: searchDecisionBudget(jevRuntime.config, { timeoutMs: decisionTimeoutMsFromEnv(process.env) }),
        },
        {
          intent,
          candidates: offered,
          // Re-read the registry rather than trusting the list this closure was handed: a capability
          // can be unloaded while the selector is thinking, and dispatching to it afterwards would
          // be dispatching to something the node no longer offers.
          verify: (id) => {
            const pair = pairs.get(id);
            if (pair === undefined) return false;
            return listCapabilitySummaries({ db: runtime.db, nodeId }, { usableOnly: true }).some(
              (summary) =>
                summary.ref === pair.capabilityRef && summary.executionNodeId === pair.executionNodeId,
            );
          },
        },
      );

      if (decision.status !== "selected") return undefined;
      return pairs.get(decision.id);
    },
    validateProps: (
      definition: WidgetDefinition,
      props: Record<string, unknown>,
    ): { ok: true } | { ok: false; problems: string[] } => {
      const result = validateProps(definition, props);
      return result.ok ? { ok: true } : { ok: false, problems: result.problems };
    },
  };

  const sessions = sessionStoreDepsFrom({
    db: runtime.db,
    nodeId,
    dataDir: runtime.dataDir,
    now: () => nowInstant() satisfies Instant,
  });
  // Created before anything can write into it, so a session created later cannot be the first thing
  // to discover that the directory is missing.
  ensureSessionsDirectory(runtime.dataDir);

  // The extension is loaded into the connection the node actually uses, once. A node without it
  // searches lexically and says so, which is why this returns a status rather than throwing.
  const vectorExtension = loadVectorExtension(runtime.db);
  const vectors: VectorIndexService = createVectorIndexService(
    {
      db: runtime.db,
      principalId: runtime.identity.ownerPrincipalId,
      enabled: semanticSearchFromEnv(process.env),
      now: () => nowInstant(),
    },
    vectorExtension,
    async () => (await loadLocalEmbedder()).provider,
  );

  const search: SessionSearchDeps = {
    db: runtime.db,
    nodeId,
    // The node's own principal. Search is authorized by the transport, and this record is what the
    // repository filters on, so the two cannot disagree.
    principalId: runtime.identity.ownerPrincipalId,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    now: () => nowInstant() satisfies Instant,
    // The decision layer is wired but off by default: the Phase 8 baseline answered 96.8% of lexical
    // queries with BM25 alone, and a selector that cannot repair missing vocabulary is not worth a
    // call per search until the calibration says otherwise.
    decider: {
      jev: jevRuntime.deps,
      // The decision deadline, not the composition one: a search already has a ranked answer, and
      // the plan puts a decision at 2 s with the whole path under 2.5 s.
      budget: searchDecisionBudget(jevRuntime.config, { timeoutMs: decisionTimeoutMsFromEnv(process.env) }),
    },
    deciderMode: searchDeciderFromEnv(process.env),
    // A getter, not a snapshot: the model is loaded after boot, and a search issued in the meantime
    // must see the state as it is now rather than the state at startup.
    get semantic() {
      return vectors.semantic();
    },
  };

  // Started but deliberately not awaited. A node still opening its database has to answer searches,
  // and a model that takes ten seconds to load must not hold up the health route.
  void vectors.ensure();

  const preferences = {
    db: runtime.db,
    nodeId,
    now: () => nowInstant() satisfies Instant,
    newId,
  };
  /**
   * Approved roots and ignores, from the user's own preferences.
   *
   * The default root is the home directory — the user's decision, because this application is for
   * more than code — and the default ignore list is the system one in the scanner. A preference
   * shaped like an array of strings is read defensively: a malformed value falls back to the default
   * rather than crashing a scan.
   */
  const stringList = (key: string, fallback: readonly string[]): string[] => {
    const record = getPreference(preferences, {
      principalId: runtime.identity.ownerPrincipalId,
      key,
      scope: "global",
    });
    const value = record?.value;
    if (!Array.isArray(value)) return [...fallback];
    const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
    return strings.length === 0 ? [...fallback] : strings;
  };

  const projects: ProjectFinderDeps = {
    db: runtime.db,
    nodeId,
    now: () => nowInstant() satisfies Instant,
    newId,
    roots: () => stringList("workspace.roots", [homedir()]),
    ignore: () => stringList("workspace.ignore", []),
    home: homedir,
    decider: {
      jev: jevRuntime.deps,
      // Choosing a directory is a decision, not a composition, so it gets the decision deadline.
      budget: searchDecisionBudget(jevRuntime.config, { timeoutMs: decisionTimeoutMsFromEnv(process.env) }),
    },
  };

  const projectSessions = options.projectSessions ?? createProjectSessionStarter({
    sessionDir: sessionsDirectory(runtime.dataDir),
    ...(options.model === undefined
      ? {}
      : { model: { provider: options.model.provider, id: options.model.id } }),
    ...(process.env.CC_PI_AGENT_DIR === undefined ? {} : { agentDir: process.env.CC_PI_AGENT_DIR }),
    ...(options.projectSessionAdapter === undefined ? {} : { createAdapter: options.projectSessionAdapter }),
    onSessionFile: ({ sessionId, sessionFile }) => {
      registerSessionFile(sessions, {
        sessionId,
        principalId: runtime.identity.ownerPrincipalId,
        path: sessionFile,
      });
    },
  });

  const compose: ComposeDeps = {
    ...base,
    dataDir: runtime.dataDir,
    registry: catalog,
    jev: {
      deps: jevRuntime.deps,
      // A fresh budget per composition step, so one turn's selector calls cannot spend the next
      // turn's deadline.
      budget: () => createJevBudget(jevRuntime.config),
    },
    // The node's own display timezone, falling back to UTC so a value is always returned rather
    // than a guess dressed up as a fact.
    timezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };

  return {
    runtime,
    conductor,
    model: options.model ?? null,
    jev: jevRuntime,
    catalog,
    missingFamilies: missingCompositionFamilies(catalog),
    compose,
    sessions,
    search,
    vectors,
    projects,
    projectSessions,
    describe: () => ({ node: process.version, platform: process.platform, arch: process.arch }),
  };
}

/* ------------------------------------------------------------------ *
 * Timeline assembly
 * ------------------------------------------------------------------ */

export interface TimelineInstanceView {
  instanceId: string;
  definitionId: string;
  definitionVersion: string;
  /** Digest of the exact definition this instance was created against. */
  definitionDigest: string;
  lifecycle: string;
  revision: number;
  props: Record<string, unknown>;
  dataRefs: string[];
  actionBindingIds: string[];
  /** Live state, so a control renders at the value the server holds rather than a guess. */
  state?: Record<string, unknown>;
  stateRevision?: number;
  /**
   * Which surface currently owns the live instance.
   *
   * The surface only, never the owner token: a token in a payload is a token that ends up in a log,
   * and holding one is what authorizes releasing somebody else's claim.
   */
  ownerSurface?: "inline" | "pin";
  /** Set when this instance is a composed surface, so the client can fetch its spec and bundle. */
  compositionId?: string;
}

/**
 * A historical capture, separate from the live instance above.
 *
 * They are deliberately two lists. A message renders a snapshot — immutable values at a revision —
 * while the live instance is wherever the data has got to since. Merging them is exactly how a
 * transcript ends up showing today's numbers under yesterday's timestamp.
 */
export interface TimelineSnapshotView {
  snapshotId: string;
  messageId: string;
  instanceId?: string;
  capturedRevision: number;
  capturedAt: string;
  stale: boolean;
  presentationRef: string;
  bundleRef?: string;
  catalogDigest?: string;
  textAlternative: string;
}

export interface Timeline {
  conversationId: string;
  /** Client replay cursor: the highest event sequence already reflected. */
  cursor: number;
  messages: unknown[];
  pins: ReturnType<typeof listPinsForConversation>;
  /**
   * Widget instances the messages reference, with the props needed to render them.
   *
   * The client resolves the renderer from its own catalog bundle rather than being sent
   * component code, so a definition reference stays a reference instead of becoming a
   * delivery mechanism for executable payloads.
   */
  instances: TimelineInstanceView[];
  snapshots: TimelineSnapshotView[];
  metadata: { messageCount: number; taskCount: number; updatedAt: string };
  /** Tasks the client should show as in flight, so it never invents a status. */
  activeTaskIds: string[];
}

/** Widget dependencies for read-only lookups. */
function readDeps(services: NodeServices): WidgetDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => nowInstant() satisfies Instant,
    newId,
  };
}

/**
 * Build a timeline page.
 *
 * Messages and the instances they reference are returned together. A message rendering a
 * widget whose props are missing would show an empty surface, and fetching the two halves
 * separately would let them disagree while the user is looking at them.
 */
export function buildTimeline(
  services: NodeServices,
  input: { conversationId: string; afterSequence: number; limit?: number },
): Timeline {
  const { db } = services.runtime;
  const deps = readDeps(services);
  const messages = messagesSince(db, input.conversationId, input.afterSequence, input.limit ?? 200);

  const instanceIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "widget-ref") instanceIds.add(block.instanceId);
      if (block.type === "surface" && block.snapshot.instanceId) instanceIds.add(block.snapshot.instanceId);
    }
  }

  const instances: TimelineInstanceView[] = [];
  for (const instanceId of instanceIds) {
    const instance = getInstance(deps, instanceId);
    if (!instance) continue;
    const state = liveStateOf(deps, instance.instanceId);
    const owner = liveOwnerOf(deps, instance.instanceId);
    const composition = findCompositionByInstance(db, instance.instanceId, instance.ownerPrincipalId);
    instances.push({
      instanceId: instance.instanceId,
      definitionId: instance.definitionRef.id,
      definitionVersion: instance.definitionRef.version,
      definitionDigest: instance.definitionRef.packageDigest,
      lifecycle: instance.lifecycle,
      revision: instance.revision,
      props: instance.props,
      dataRefs: instance.dataRefs,
      actionBindingIds: instance.actionBindingIds,
      ...(state === undefined ? {} : { state: state.body, stateRevision: state.revision }),
      ...(owner === undefined ? {} : { ownerSurface: owner.surface }),
      ...(composition === undefined ? {} : { compositionId: composition.compositionId }),
    });
  }

  const snapshots: TimelineSnapshotView[] = [];
  for (const message of messages) {
    for (const snapshot of listSnapshotsForMessage(db, message.messageId)) {
      snapshots.push({
        snapshotId: snapshot.snapshotId,
        messageId: snapshot.messageId,
        ...(snapshot.instanceId === undefined ? {} : { instanceId: snapshot.instanceId }),
        capturedRevision: snapshot.capturedRevision,
        capturedAt: snapshot.capturedAt,
        stale: snapshot.stale,
        presentationRef: snapshot.presentationRef,
        ...(snapshot.bundleRef === undefined ? {} : { bundleRef: snapshot.bundleRef }),
        ...(snapshot.catalogDigest === undefined ? {} : { catalogDigest: snapshot.catalogDigest }),
        textAlternative: snapshot.textAlternative,
      });
    }
  }

  const metadata = conversationMetadata(db, input.conversationId);

  return {
    conversationId: input.conversationId,
    cursor: metadata.cursor,
    messages,
    pins: listPinsForConversation(deps, input.conversationId),
    instances,
    snapshots,
    metadata: {
      messageCount: metadata.messageCount,
      taskCount: metadata.taskCount,
      updatedAt: metadata.updatedAt,
    },
    activeTaskIds: listActiveTasks(db, input.conversationId).map((task) => task.taskId),
  };
}
