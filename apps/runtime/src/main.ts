#!/usr/bin/env node
/**
 * Headless runtime entry point.
 *
 * Boots a node and serves the authenticated command gateway on loopback by default.
 * Binding a public interface requires an explicit flag, because a node with a public
 * listener and no TLS is the deployment mistake the blueprint names: application
 * authorization is required regardless of how private the network looks.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Instant } from "@clarkcant/contracts";
import { applyEnvFile } from "@clarkcant/pi-adapter";

import { interactionDepsFor } from "./gateway.ts";
import { createNodeServer } from "./server.ts";
import { machineRoots } from "./fs-search.ts";
import { refreshProjectIndex } from "./project-finder.ts";
import { readExecutionPolicy, type CoordinationDeps } from "@clarkcant/core";
import { appendAuditEvent } from "@clarkcant/storage";
import { createModelCatalogue, type ViewDescriptor } from "./model-turn.ts";
import { fixtureGatesFromEnv, loadFixtureComposition } from "./bootstrap/fixtures.ts";
import { createNodeModelTurn } from "./bootstrap/model-bootstrap.ts";
import { attachNodeVoice } from "./bootstrap/voice-bootstrap.ts";
import { bootRuntime } from "./node.ts";
import { detectContainerEngine } from "./container-engine.ts";
import { listenOnUnixSocket, prepareSocketPath } from "./unix-socket.ts";
import { buildViewCatalog } from "./view-catalog.ts";
import { registerNodeTools } from "./tool-catalogue.ts";
import { createNodeTools, type CommandToolDeps } from "./node-tools.ts";
import type { InteractionDeps } from "./interactions.ts";
import { guardOperation } from "./jev-decider.ts";
import { ownedResources } from "./preflight.ts";
import { DEFAULT_NARROWING } from "./autonomy-settings.ts";
import { createSecretBroker } from "./secret-broker.ts";
import type { RequestSecretDeps } from "./request-secret.ts";
import { sessionsDirectory } from "./session-store.ts";
import { bootNodeServices, type NodeServices } from "./services.ts";

interface CliOptions {
  dataDir: string;
  host: string;
  port: number;
  label: string;
  allowPublicBind: boolean;
  /** When set, the node listens on a Unix socket instead of a port. */
  socket: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dataDir: get("data-dir") ?? join(homedir(), ".clarkcant"),
    host: get("host") ?? "127.0.0.1",
    port: Number.parseInt(get("port") ?? "8765", 10),
    label: get("label") ?? "local runtime",
    allowPublicBind: argv.includes("--allow-public-bind"),
    socket: get("socket"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  /*
   * A socket path replaces the port, so the public-bind refusal does not apply: there is no port to reach
   * from the network, and the file's mode is the boundary instead.
   */
  const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(options.host);
  if (options.socket === undefined && !isLoopback && !options.allowPublicBind) {
    process.stderr.write(
      `Refusing to bind ${options.host}.\n` +
        "A node reachable from the network needs TLS and an explicit acknowledgement that you have it.\n" +
        "Pass --allow-public-bind only when that is true.\n",
    );
    process.exit(2);
  }

  // Credentials are read from a local file before anything is assembled, because whether the
  // node has a model decides whether the conductor is built with a way to answer at all. A
  // variable already present in the environment wins, so a deployment that sets the real
  // secret does not have it replaced by a file in the checkout. Only the names taken are
  // reported; no value is ever written to a log.
  const envFile = applyEnvFile(join(process.cwd(), ".env"), process.env, (path) => readFileSync(path, "utf8"));
  if (envFile.loaded.length > 0) {
    process.stderr.write(`read ${envFile.loaded.length} variable(s) from .env: ${envFile.loaded.join(", ")}\n`);
  }

  // Filled after the node boots. The catalog is built from widget dependencies that only exist
  // once `bootNodeServices` has run, and the node is created with the model turn already in hand,
  // so the turn reads this lazily at the moment a conversation starts rather than at startup.
  const viewCatalog: ViewDescriptor[] = [];
  /**
   * Filled once the node has booted.
   *
   * The model turn is built before the services because whether the node has a model decides how
   * the conductor is assembled, and the session store lives in the services. The callback fires on
   * the first session creation, long after both exist, so the ordering is a fact about startup
   * rather than a race.
   */
  const sessionWiring: { index?: NodeServices["sessions"]; principalId?: string } = {};
  const searchWiring: { deps?: NodeServices["search"] } = {};
  const projectWiring: { deps?: NodeServices["projects"] } = {};
  /**
   * Where an approval request is recorded, filled once the node has booted.
   *
   * Only the `confirm` policy needs these. `run_command` no longer depends on them to exist: a node whose
   * policy is `guarded` runs commands without recording a decision, so tying the tool's existence to the
   * approval route — as it used to be — would leave the default policy with no executor at all.
   */
  const approvalWiring: { deps?: CoordinationDeps } = {};
  /**
   * The command path, filled once the node has booted.
   *
   * Lazily for the same reason as everything else here: the folders this node owns, the settings it runs
   * under and the policy layer it consults all live on `services`, which is built below this line, while
   * the tool list has to exist before it.
   */
  const commandWiring: { deps?: CommandToolDeps } = {};
  /**
   * The interaction manager, per conversation, filled once the node has booted.
   *
   * A function of the conversation rather than a value, because a question belongs to the transcript it was
   * asked in: two conversations waiting on two different answers must not share one manager.
   */
  const interactionWiring: { deps?: (conversationId: string) => InteractionDeps } = {};
  /** The secret broker's read side, filled once the node has booted. */
  const secretWiring: { deps?: RequestSecretDeps } = {};
  /** Filled once the node has booted, so the scripted turn below can compose a real surface. */
  const modelWiring: { compose?: NodeServices["compose"] } = {};

  /**
  /*
   * The fixture gates, and the deterministic composition behind them.
   *
   * Read after `.env` has been applied, and named here rather than inferred anywhere else: a node either says it is
   * running a fixture — and says so at startup — or it is a node. The composition is loaded through
   * `bootstrap/fixtures.ts`, which reaches `test-support/` only when a gate matched, so this process never carries
   * fixture code it is not running.
   */
  const fixtureGates = fixtureGatesFromEnv(process.env);
  const fixtures = await loadFixtureComposition(fixtureGates);
  const modelFixture = fixtureGates.model;
  const sessionFixture = fixtureGates.session;

  /**
   * The deterministic composer, for the browser suite.
   *
   * The wiring is handed over as getters because the node publishes most of it only after the services are built,
   * and this composer is handed to `bootNodeServices` before they exist: it is called once a message arrives, long
   * after everything it reads has been assigned.
   */
  const fixtureCompose = modelFixture
    ? fixtures?.createModelComposer({
        services: () => services,
        dataDir: options.dataDir,
        wiring: {
          approvals: () => approvalWiring.deps,
          command: () => commandWiring.deps,
          search: () => searchWiring.deps,
          projects: () => projectWiring.deps,
          interactions: (conversationId) => interactionWiring.deps?.(conversationId),
          secrets: () => secretWiring.deps,
          compose: () => modelWiring.compose,
        },
      })
    : undefined;

  /**
   * A session starter that starts nothing, when the session fixture is on.
   *
   * The flow that starts a session in a chosen directory has a browser half, and proving it must not spawn a worker
   * process — which would need a provider, a longer wait than any test should take, and would leave a session behind
   * on the machine running the suite.
   */
  const fixtureProjectSessions = sessionFixture ? fixtures?.fixtureProjectSessions() : undefined;

  /*
   * The model a person chose, read when a session is created rather than at boot.
   *
   * Lazily because `services` - which owns the database and the identity the preference is keyed by - is built below
   * this line; a value would be the same ordering mistake the typecheck refused twice. By the time anybody sends a
   * message this node is fully built, so the read happens against a node that exists.
   */
  /*
   * The runtime is opened here, before the model turn is built, so the model somebody chose can be read first.
   *
   * It is the same handle the service container would have opened, handed to it below rather than opened twice: one
   * database file is one connection. Opening it later would mean the turn had already decided this node has no model,
   * which is exactly how a choice made in Settings came to be stored and never used.
   */
  const runtime = bootRuntime({ dataDir: options.dataDir, label: options.label });

  /*
   * The model a person chose, the background routing, and the turn itself.
   *
   * Built here because whether this node has a model decides how the conductor is assembled below, and because the
   * node publishes most of what a turn reads only after the services exist: the seams are getters for exactly that
   * reason, and the model and the instructions are read per turn rather than captured.
   */
  const modelTurn = await createNodeModelTurn({
    env: process.env,
    dataDir: options.dataDir,
    runtime,
    services: () => services,
    viewCatalog: () => viewCatalog,
    wiring: {
      sessionIndex: () => sessionWiring.index,
      sessionPrincipalId: () => sessionWiring.principalId,
      search: () => searchWiring.deps,
      projects: () => projectWiring.deps,
      command: () => commandWiring.deps,
      interactions: (conversationId) => interactionWiring.deps?.(conversationId),
      secrets: () => secretWiring.deps,
    },
  });

  const services: NodeServices = bootNodeServices({
    dataDir: options.dataDir,
    label: options.label,
    // The handle opened above, so the container does not open a second connection to the same file.
    runtime,
    ...(modelTurn === undefined ? {} : { respondWithModel: modelTurn.answer }),
    // The fixture is a composer rather than a model: it never displaces the model turn, and the
    // recipes still answer everything it declines.
    ...(fixtureCompose === undefined ? {} : { composeFromIntent: fixtureCompose }),
    ...(fixtureProjectSessions === undefined ? {} : { projectSessions: fixtureProjectSessions }),
    ...(modelTurn === undefined
      ? {}
      : {
          model: {
            provider: modelTurn.selection.provider,
            id: modelTurn.selection.id,
            maxWallClockMs: modelTurn.budget.maxWallClockMs,
            maxTokens: modelTurn.budget.maxTokens,
          },
        }),
  });

  sessionWiring.index = services.sessions;
  sessionWiring.principalId = services.runtime.identity.ownerPrincipalId;
  searchWiring.deps = services.search;
  // The turn control the gateway needs to answer a message that arrives while something is running. Assigned here
  // rather than passed into bootNodeServices, because the model turn is built above and the services just below it,
  // and this is the first line where both exist.
  if (modelTurn !== undefined) {
    services.turnControl = {
      running: () => modelTurn.running(),
      interrupt: (conversationId) => modelTurn.interrupt(conversationId),
      steer: (conversationId, text) => modelTurn.steer(conversationId, text),
      runInBackground: (input) => modelTurn.runInBackground(input),
    };
    // The same line, for the same reason: the adapter exists above this and the services below it.
    services.extensions = modelTurn.extensions;
    services.piSettings = modelTurn.piSettings;
  }
  /*
   * A turn control for a fixture node.
   *
   * Starting a background session is the one path a node cannot answer from a recipe: it goes through the turn control,
   * which only exists when a model turn does — and a fixture node has none by design, because it answers with scripts
   * rather than a provider. Without this, the browser half of that path is untestable: the client would report the
   * node's refusal, which is correct behaviour and not the thing a test of the selection menu should be measuring.
   *
   * It is not a model. It says so, waits a moment, and answers with a fixture sentence. The wait is the point: a session
   * that starts and finishes inside the same millisecond is a session no client can ever draw, and drawing it — the
   * chip in the header, the reply in the conversation — is exactly what the browser test asserts.
   */
  if (modelFixture) {
    fixtures?.applyScriptedTurnControl(services);
  }

  /*
   * The catalogue is published whether or not a turn exists, because it is how a node stops having no model: the
   * picker that fills that gap reads it, and publishing it only alongside a turn is what left every fresh node with an
   * empty list and no way to choose. Published as a function rather than a snapshot, so a provider added by upgrading
   * pi is visible without restarting the node.
   *
   * Not on a fixture node. That one deliberately reports no model and no catalogue, and other journeys assert exactly
   * that; reading whatever pi the machine running the suite happens to have would also make the suite depend on the
   * machine it runs on.
   */
  if (modelTurn !== undefined) {
    services.modelCatalogue = modelTurn.catalogue;
  } else if (!modelFixture) {
    services.modelCatalogue = createModelCatalogue({ cwd: process.cwd() });
  }
  projectWiring.deps = services.projects;
  approvalWiring.deps = {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => new Date().toISOString() as never,
    // The conductor's own id generator, so an approval id looks like every other id this node writes.
    newId: services.conductor.newId,
  };
  commandWiring.deps = {
    // Omitted when the node has no approval route at all, so `confirm` refuses honestly instead of
    // throwing from inside the tool.
    ...(approvalWiring.deps === undefined ? {} : { approvals: () => approvalWiring.deps as CoordinationDeps }),
    // The one canonical reader, at the proposal rather than at boot: a mode change has to change what happens to
    // the next command, not the next process. It answers whether or not this node has ever stored a policy — a node
    // that stored one of the two legacy families gets that family, joined pointwise and stored.
    autonomy: () =>
      readExecutionPolicy(
        { db: services.runtime.db, now: () => new Date().toISOString() as Instant },
        services.runtime.identity.ownerPrincipalId,
      ),
    // The folders this node owns, which is the whole of the containment check: the workspace roots from
    // settings, the node's own data directory, and the directory the operator launched it from. The last
    // one matters because a node started inside a checkout is being pointed at that checkout by a person.
    resources: () => ownedResources([...services.projects.roots(), services.runtime.dataDir, process.cwd()]),
    fallbackCwd: () => process.cwd(),
    // The same decision layer the finder uses: one adapter, one policy, one fallback chain. A node with
    // no configured selector reports `unavailable`, and the person's fail-open setting decides what that
    // means — which is not the same thing as a guardrail that said yes.
    guardrails: (input) => {
      const decider = services.projects.decider;
      if (decider === undefined) {
        return Promise.resolve({ status: "unavailable" as const, reason: "node này chưa nối policy layer nào" });
      }
      return guardOperation(decider, input);
    },
    narrowing: DEFAULT_NARROWING,
    /**
     * The secret broker, with the trail attached.
     *
     * Wired here rather than inside the tool because the broker is the only thing that reads a value: every use of a
     * secret passes through `withSecret` or `environmentFor`, so this is the one place an audit entry cannot be
     * forgotten.
     */
    broker: createSecretBroker({
      db: services.runtime.db,
      principalId: services.runtime.identity.ownerPrincipalId,
      now: () => new Date().toISOString() as Instant,
      audit: (event) =>
        appendAuditEvent(services.runtime.db, {
          auditId: services.conductor.newId("audit"),
          principalId: services.runtime.identity.ownerPrincipalId,
          nodeId: services.runtime.identity.nodeId,
          kind: "secret-use",
          summary: event.summary,
          outcome: "done",
          ref: event.ref,
          at: new Date().toISOString() as Instant,
        }),
    }),
    newId: () => services.conductor.newId("run"),
    // Where a finished command is written down. The trail is the node's, and the sink is how a tool that does not know
    // about the database still ends up in it.
    audit: (event) =>
      appendAuditEvent(services.runtime.db, {
        auditId: services.conductor.newId("audit"),
        principalId: services.runtime.identity.ownerPrincipalId,
        nodeId: services.runtime.identity.nodeId,
        kind: "command",
        summary: event.summary,
        outcome: event.outcome,
        ...(event.ref === undefined ? {} : { ref: event.ref }),
        at: new Date().toISOString() as Instant,
      }),
  };
  interactionWiring.deps = (conversationId) => interactionDepsFor(services, conversationId);
  secretWiring.deps = {
    db: services.runtime.db,
    principalId: services.runtime.identity.ownerPrincipalId,
    newId: services.conductor.newId,
    now: () => new Date().toISOString() as Instant,
    nodeId: services.runtime.identity.nodeId,
  };

  // A fixture node arranges its own precondition: the scripted command proposal has to have somewhere to
  // run, and a browser run must never depend on a developer's real approved folders.
  if (modelFixture) {
    fixtures?.arrangeModelNode({ services, dataDir: options.dataDir });
  }
  modelWiring.compose = services.compose;

  if (sessionFixture) {
    process.stderr.write(
      "project sessions: FIXTURE starter loaded — a session is reported, and no worker is spawned\n",
    );
  }

  if (modelFixture) {
    // Said out loud, because a fixture that is indistinguishable from a model is worse than no
    // fixture: a screenshot from this node must not be read as model output.
    process.stderr.write(
      "overview: FIXTURE composer loaded — overview requests are scripted, and no provider is called for them\n",
    );
    fixtures?.applyScriptedBackgroundControl(services);
  }

  // The model may now ask for these views. When there are none the `show_view` tool is not
  // registered at all, which is why this is reported rather than left to be discovered: a node
  // that cannot show anything should say so once at startup, not fail a turn later.
  viewCatalog.push(...buildViewCatalog(services.conductor, services.compose));
  // Said out loud because it is a capability with a privacy shape: the model may search this machine's
  // files, the walk is read-only and bounded, and the lines it finds go to the provider as the tool's
  // result. An operator who did not want that should be able to learn it from the startup line.
  process.stderr.write(
    `filesystem search: read-only over ${machineRoots().join(", ")} — no index is built; matches are sent to the model provider\n`,
  );

  /*
   * Build the project index, in the background and after the node is listening.
   *
   * Nothing at runtime ever refreshed it before this: it was written only when somebody picked a project, so
   * asking which projects are on this machine answered with the two folders that had already been opened, and an
   * agent looking for a folder it could see on disk found nothing.
   *
   * Bounded in time as well as in entries, because one of this machine's roots is a cloud drive and a scan that
   * waits for it can run for minutes. An aborted scan is not allowed to prune - the finder checks that itself -
   * so stopping early leaves the previous index alone rather than emptying it.
   */
  const indexScan = new AbortController();
  const indexBudget = setTimeout(() => indexScan.abort(), 60_000);
  void refreshProjectIndex(services.projects, { signal: indexScan.signal })
    .then((outcome) => {
      clearTimeout(indexBudget);
      process.stderr.write(
        `project index: ${outcome.scanned} scanned, ${outcome.kept} kept, ${outcome.removed} removed` +
          (outcome.truncated || outcome.stoppedEarly ? " — the scan stopped early, so the index is partial\n" : "\n"),
      );
    })
    .catch((cause: unknown) => {
      clearTimeout(indexBudget);
      process.stderr.write(
        `project index: not built — ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    });

  /*
   * Load the project-work pack, in the background and after the node is listening.
   *
   * The pack's capabilities are registered at boot and used to stay exactly as they were registered:
   * `loaded: false` for the life of the process, with the reason "the pack is declared but no worker
   * has loaded it on this node". That sentence was true only because nothing ever tried. This is the
   * thing that tries — one worker session with the pack's capabilities granted, and then the
   * readiness written from the record that came back rather than from the intention behind it.
   *
   * Not on a fixture node. `CC_SESSION_FIXTURE` exists so that a scripted node never spawns a worker,
   * and that reason does not stop applying because this spawn happens once at boot instead of per
   * request. A fixture node keeps reporting the pack as one no worker has loaded, which is the truth
   * about it.
   *
   * Bounded, because a wedged worker must not hold a boot open; and reported rather than thrown,
   * because a node whose pack cannot be loaded is still a node.
   */
  if (process.env.CC_SESSION_FIXTURE !== "1") {
    void services
      .loadProjectWorkPack({ timeoutMs: 60_000 })
      .then((outcome) => {
        if (!outcome.ran) {
          process.stderr.write(
            `project-work pack: not loaded — ${outcome.readiness.blockedReason ?? "no reason given"}\n`,
          );
          return;
        }
        process.stderr.write(
          outcome.readiness.healthy
            ? "project-work pack: loaded; a run demonstrated something\n"
            : `project-work pack: loaded; ${outcome.readiness.blockedReason ?? "no run demonstrated anything"}\n`,
        );
      })
      .catch((cause: unknown) => {
        process.stderr.write(
          `project-work pack: not loaded — ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
      });
  }
  process.stderr.write(
    viewCatalog.length === 0
      ? "no widget definitions on this node; the model can answer in words only\n"
      : `views: ${viewCatalog.length} definition(s) the model may show — ${viewCatalog.map((view) => view.id).join(", ")}\n`,
  );
  process.stderr.write(
    services.missingFamilies.length === 0
      ? "catalog: every family a composed surface needs is drawable\n"
      : `catalog: a composed surface would be missing ${services.missingFamilies.join(", ")}\n`,
  );
  process.stderr.write(`session transcripts: ${sessionsDirectory(options.dataDir)}\n`);
  process.stderr.write(
    services.jev.config.enabled
      ? `selector: ${services.jev.config.model} pinned, ${services.jev.config.timeoutMs} ms per turn\n`
      : "selector: disabled (no credential or local-only); composed surfaces use the deterministic path\n",
  );

  const server = createNodeServer({
    services,
    origin: `http://${options.host}:${options.port}`,
  });

  /*
   * The voice socket, attached to the same server as the command gateway.
   *
   * One origin and one token rather than a second service for a browser to discover. What is wired here is the
   * whole attachment: the credential read, the scripted provider when the gate is on, every answer that goes
   * through the same function its click goes through, and the startup line that says which provider this is.
   */
  const voiceFixture = fixtureGates.voice;
  const fixtureVoice = voiceFixture ? fixtures?.createVoiceFixture() : undefined;
  const voice = attachNodeVoice({
    server,
    services,
    fixtureVoice,
    env: process.env,
  });

  /**
   * A port that is already taken, reported plainly.
   *
   * Node's default is an unhandled `'error'` event: twenty lines of stack trace and no
   * statement of the problem or what to do about it. This is the failure an operator of a
   * local node meets most often — a second node, or one left over from last time — so it is
   * worth four lines of plain language rather than a stack trace to interpret.
   */
  server.on("error", (cause: NodeJS.ErrnoException) => {
    if (cause.code === "EADDRINUSE" && options.socket !== undefined) {
      process.stderr.write(
        `Another node is already listening on ${options.socket}.\n` +
          "Two nodes on one socket would be one node answering for the other's identity. Stop it, or start" +
          " this one on a different path with --socket <path>.\n",
      );
      process.exit(1);
    }
    if (cause.code === "EADDRINUSE") {
      process.stderr.write(
        `Port ${options.port} on ${options.host} is already in use.\n` +
          "Another node is probably running. Stop it, or start this one on a different port with" +
          ` --port <number>.\n`,
      );
      process.exit(1);
    }
    process.stderr.write(
      options.socket === undefined
        ? `The node could not listen on ${options.host}:${options.port}: ${cause.message}\n`
        : `The node could not listen on ${options.socket}: ${cause.message}\n`,
    );
    process.exit(1);
  });

  /*
   * A failure nobody caught is written down rather than fatal, and this is the one that was actually killing the node.
   *
   * The evidence was narrow: a full browser suite saw the process disappear partway through and every request after it
   * fail with "connection refused", while a guard on unhandled *rejections* caught nothing at all. No rejection means
   * an exception - a thrown error on a path nobody wrapped, most likely a child process reporting a failure of its own
   * - and Node's default for that is also to exit.
   *
   * A node that exits takes every connected client with it, which is strictly worse than a line of stderr. The node's
   * job is to stay up and answer; a bad turn should end that turn, not every conversation at once.
   */
  const noteFailure = (what: string, reason: unknown): void => {
    process.stderr.write(
      `${what} (the node stays up): ${reason instanceof Error ? reason.message : String(reason)}\n`,
    );
  };
  process.on("unhandledRejection", (reason) => noteFailure("unhandled rejection", reason));
  process.on("uncaughtException", (error) => noteFailure("uncaught exception", error));

  const reportListening = (): void => {
    /*
     * Publish what this node can do, at boot rather than at the first turn.
     *
     * The tools are built on demand for a turn, and that is the right time for a turn. It is the wrong time for the
     * Tools tab, which asks the question before anything has been sent: publishing only inside the lazy builder meant
     * the answer was "none" exactly when somebody looked, which is what a probe against a running node showed.
     *
     * Built from the same wirings the turn uses, and without the folder-resolution refinement, which changes how
     * run_command picks a folder rather than whether it exists.
     */
    const bootCommand = commandWiring.deps;
    if (bootCommand !== undefined) {
      registerNodeTools(
        createNodeTools({ search: services.search, projects: services.projects, command: bootCommand }).map(
          (tool) => ({ name: tool.name, label: tool.label, description: tool.description }),
        ),
      );
    }
    process.stderr.write(
      options.socket === undefined
        ? `clarkcant node "${services.runtime.identity.label}" listening on http://${options.host}:${options.port}\n`
        : `clarkcant node "${services.runtime.identity.label}" listening on unix socket ${options.socket} (owner-only)\n`,
    );
    process.stderr.write(`node id: ${services.runtime.identity.nodeId}\n`);
    process.stderr.write(`data dir: ${services.runtime.dataDir}\n`);
    /*
     * Whether this machine can build the image, said at boot rather than left to be discovered when
     * somebody tries. A node that cannot build it is still a node; it just cannot be deployed that way here.
     */
    const engine = detectContainerEngine();
    process.stderr.write(
      engine.available
        ? `container engine: ${engine.engine} ${engine.version} — the OCI image can be built on this machine\n`
        : `container engine: none (${engine.reason}) — the OCI image cannot be built here: ${engine.detail}\n`,
    );
    process.stderr.write("commands require the bearer token stored in the node's identity.json\n");
  };

  /*
   * A socket path, when one was asked for, and a port otherwise.
   *
   * The stale-file handling and the owner-only mode live in `unix-socket.ts`, because both are about the
   * file rather than the server: `listen` refuses a path left behind by a crash, and a socket created
   * with a permissive umask is connectable by every process on the host.
   */
  if (options.socket !== undefined) {
    void prepareSocketPath(options.socket).then((prepared) => {
      if (!prepared.ok) {
        process.stderr.write(`${prepared.reason}\n`);
        process.exit(1);
      }
      if (prepared.removedStaleFile) {
        process.stderr.write(
          `removed the socket file at ${options.socket} left by a node that did not shut down\n`,
        );
      }
      listenOnUnixSocket(server, {
        path: options.socket as string,
        onListening: reportListening,
        onError: (cause) => {
          process.stderr.write(`The node could not listen on ${options.socket}: ${cause.message}\n`);
          process.exit(1);
        },
      });
    });
  } else {
    server.listen(options.port, options.host, reportListening);
  }

  const shutdown = (signal: string): void => {
    process.stderr.write(`received ${signal}; closing the node\n`);
    void voice.close();
    server.close(() => {
      void modelTurn?.dispose();
      services.runtime.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

await main();
