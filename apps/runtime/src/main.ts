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

import { applyEnvFile } from "@clarkcant/pi-adapter";

import { createNodeServer } from "./server.ts";
import type { ViewDescriptor } from "./model-turn.ts";
import { fixtureGatesFromEnv, loadFixtureComposition } from "./bootstrap/fixtures.ts";
import { createNodeModelTurn } from "./bootstrap/model-bootstrap.ts";
import { createRuntimeWiring, wireRuntime } from "./bootstrap/runtime-bootstrap.ts";
import { attachNodeVoice } from "./bootstrap/voice-bootstrap.ts";
import { bootRuntime } from "./node.ts";
import { detectContainerEngine } from "./container-engine.ts";
import { listenOnUnixSocket, prepareSocketPath } from "./unix-socket.ts";
import { registerNodeTools } from "./tool-catalogue.ts";
import { createNodeTools } from "./node-tools.ts";
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

  /*
   * The seams the node publishes after it is built, and what the model turn reads back through them.
   *
   * The model turn is built before the services because whether this node has a model decides how the conductor is
   * assembled, and the session store lives in the services. The turn's callbacks fire long after both exist, which is
   * why these are one object of getters rather than eight values.
   */
  const wiring = createRuntimeWiring();

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
          approvals: () => wiring.approval.deps,
          command: () => wiring.command.deps,
          search: () => wiring.search.deps,
          projects: () => wiring.project.deps,
          interactions: (conversationId) => wiring.interaction.deps?.(conversationId),
          secrets: () => wiring.secret.deps,
          compose: () => wiring.model.compose,
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
      sessionIndex: () => wiring.session.index,
      sessionPrincipalId: () => wiring.session.principalId,
      search: () => wiring.search.deps,
      projects: () => wiring.project.deps,
      command: () => wiring.command.deps,
      interactions: (conversationId) => wiring.interaction.deps?.(conversationId),
      secrets: () => wiring.secret.deps,
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

  /*
   * Publish what the node owns, and report what it is.
   *
   * After the services exist, because every seam published here reads them, and before the browser can connect,
   * because a turn arriving in the first second has to find them.
   */
  wireRuntime({
    services,
    dataDir: options.dataDir,
    wiring,
    gates: fixtureGates,
    fixtures,
    modelTurn,
    viewCatalog,
  });

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
    const bootCommand = wiring.command.deps;
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
