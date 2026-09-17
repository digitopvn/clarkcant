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
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { applyEnvFile } from "@clarkcant/pi-adapter";

import { handleRequest, type GatewayResponse } from "./gateway.ts";
import { attachVoiceGateway } from "./voice-session.ts";
import { FixtureLiveAdapter } from "./voice-fixture.ts";
import { SAMPLE_DATASET } from "@clarkcant/data-canvas/sample";

import { createModelTurn, type ViewDescriptor } from "./model-turn.ts";
import { buildViewCatalog } from "./view-catalog.ts";
import { createFindRuntimeTool } from "./runtime-candidates.ts";
import { createSearchHistoryTool } from "./session-search.ts";
import { registerSessionFile, sessionsDirectory } from "./session-store.ts";
import { bootNodeServices, type NodeServices } from "./services.ts";

interface CliOptions {
  dataDir: string;
  host: string;
  port: number;
  label: string;
  allowPublicBind: boolean;
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
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(options.host);
  if (!isLoopback && !options.allowPublicBind) {
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

  const modelTurn = await createModelTurn({
    env: process.env,
    cwd: process.cwd(),
    sessionDir: join(options.dataDir, "sessions"),
    onSessionFile: ({ sessionId, sessionFile }) => {
      if (sessionWiring.index === undefined || sessionWiring.principalId === undefined) return;
      const registered = registerSessionFile(sessionWiring.index, {
        sessionId,
        principalId: sessionWiring.principalId,
        path: sessionFile,
      });
      if (!registered.ok) {
        process.stderr.write(`session ${sessionId}: ${registered.message}\n`);
      }
    },
    views: () => viewCatalog,
    // The node registers the sample dataset itself, so this is the complete set it holds rather
    // than a guess. The model is told these names because a view over data that is not there
    // renders as nothing, which reads as a broken widget instead of a missing fact.
    datasetRefs: () => [SAMPLE_DATASET.datasetId],
    // The Session Manager's search surface, exposed to the main model as its own tool. Read from a
    // closure so the services it needs, which are assembled below, exist by the time a turn runs.
    extraTools: () =>
      searchWiring.deps === undefined
        ? []
        : [
            createSearchHistoryTool(searchWiring.deps),
            // Read-only: the model can see what is running, not start or stop it.
            createFindRuntimeTool({
              db: searchWiring.deps.db,
              nodeId: searchWiring.deps.nodeId,
              now: searchWiring.deps.now,
            }),
          ],
  });
  process.stderr.write(
    modelTurn === undefined
      ? "no model configured; the node will answer with scripts and capabilities only\n"
      : `model: ${modelTurn.selection.provider}/${modelTurn.selection.id}` +
          ` (turn limit ${modelTurn.budget.maxWallClockMs} ms, ${modelTurn.budget.maxTokens} tokens)\n`,
  );

  const services: NodeServices = bootNodeServices({
    dataDir: options.dataDir,
    label: options.label,
    ...(modelTurn === undefined ? {} : { respondWithModel: modelTurn.answer }),
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

  // The model may now ask for these views. When there are none the `show_view` tool is not
  // registered at all, which is why this is reported rather than left to be discovered: a node
  // that cannot show anything should say so once at startup, not fail a turn later.
  viewCatalog.push(...buildViewCatalog(services.conductor, services.compose));
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

  const server = createServer((request, response) => {    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const url = new URL(request.url ?? "/", `http://${options.host}:${options.port}`);

      // The handler is guarded. A request that cannot be satisfied is the request's problem, and
      // answering it with a 500 is the whole job of this boundary — letting it reach the process
      // means one bad message takes the node down and every other conversation with it. That is
      // exactly how this was found: a duplicate id killed the node the user was reviewing.
      let result: GatewayResponse;
      try {
        result = await handleRequest(
          { services },
          {
            method: request.method ?? "GET",
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            headers: request.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          },
        );
      } catch (cause) {
        // The message is reported rather than swallowed, because a caller that cannot see why a
        // request failed will retry it unchanged.
        process.stderr.write(
          `request ${request.method ?? "GET"} ${url.pathname} failed: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`,
        );
        result = {
          status: 500,
          body: {
            error: {
              code: "INTERNAL_ERROR",
              message: cause instanceof Error ? cause.message : String(cause),
            },
          },
        };
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
        // The browser client is served from a different origin during development, and the
        // gateway is token-authenticated rather than cookie-authenticated, so a wildcard
        // origin here grants nothing a caller does not already need the token for.
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      };

      // Imported images are served as their own bytes under the content type the host verified
      // from the file's magic bytes, rather than wrapped in a JSON envelope the client would have
      // to decode and re-type.
      if (result.binary !== undefined) {
        headers["content-type"] = result.binary.contentType;
        headers["content-length"] = String(result.binary.bytes.byteLength);
        // Private: an image URL is authorized by a token, and a shared cache in front of a node
        // must not hand one principal's image to another.
        headers["cache-control"] = "private, max-age=300";
        response.writeHead(result.status, headers);
        response.end(Buffer.from(result.binary.bytes));
        return;
      }

      response.writeHead(result.status, headers);
      response.end(`${JSON.stringify(result.body)}\n`);
    });
  });

  /**
   * The voice socket.
   *
   * Attached to the same server as the command gateway, so a browser needs one origin and one
   * token rather than a second service to discover. The credential is read here and handed to the
   * gateway as a function, which is what keeps it out of the module that serves the browser.
   */
  const voiceModel = process.env.CC_VOICE_MODEL;
  /**
   * A provider that answers on a script, so the browser-to-node path can be verified end to end
   * without an account and without spending quota on every run. A node running it says so, because
   * a fake that is indistinguishable from the real thing is worse than having no fake at all.
   */
  const voiceFixture = process.env.CC_VOICE_FIXTURE === "1";
  const voice = attachVoiceGateway({
    server,
    services,
    credential: () => (voiceFixture ? "fixture-credential" : process.env.GEMINI_API_KEY),
    ...(voiceFixture ? { createAdapter: () => new FixtureLiveAdapter() } : {}),
    ...(voiceModel === undefined ? {} : { model: voiceModel }),
  });
  process.stderr.write(
    voiceFixture
      ? "voice: FIXTURE provider loaded — audio and transcripts on /voice are scripted, not model output\n"
      : process.env.GEMINI_API_KEY === undefined
        ? "voice: no GEMINI_API_KEY, so a voice session will be refused with the reason rather than failing silently\n"
        : `voice: live voice sessions available on /voice (model ${voiceModel ?? "the pinned default"})\n`,
  );

  /**
   * A port that is already taken, reported plainly.
   *
   * Node's default is an unhandled `'error'` event: twenty lines of stack trace and no
   * statement of the problem or what to do about it. This is the failure an operator of a
   * local node meets most often — a second node, or one left over from last time — so it is
   * worth four lines of plain language rather than a stack trace to interpret.
   */
  server.on("error", (cause: NodeJS.ErrnoException) => {
    if (cause.code === "EADDRINUSE") {
      process.stderr.write(
        `Port ${options.port} on ${options.host} is already in use.\n` +
          "Another node is probably running. Stop it, or start this one on a different port with" +
          ` --port <number>.\n`,
      );
      process.exit(1);
    }
    process.stderr.write(`The node could not listen on ${options.host}:${options.port}: ${cause.message}\n`);
    process.exit(1);
  });

  server.listen(options.port, options.host, () => {
    process.stderr.write(
      `clarkcant node "${services.runtime.identity.label}" listening on http://${options.host}:${options.port}\n`,
    );
    process.stderr.write(`node id: ${services.runtime.identity.nodeId}\n`);
    process.stderr.write(`data dir: ${services.runtime.dataDir}\n`);
    process.stderr.write("commands require the bearer token stored in the node's identity.json\n");
  });

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
