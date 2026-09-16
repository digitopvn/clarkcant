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
import { createModelTurn } from "./model-turn.ts";
import { bootNodeServices } from "./services.ts";

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

  const modelTurn = await createModelTurn({ env: process.env, cwd: process.cwd() });
  process.stderr.write(
    modelTurn === undefined
      ? "no model configured; the node will answer with scripts and capabilities only\n"
      : `model: ${modelTurn.selection.provider}/${modelTurn.selection.id}\n`,
  );

  const services = bootNodeServices({
    dataDir: options.dataDir,
    label: options.label,
    ...(modelTurn === undefined ? {} : { respondWithModel: modelTurn.answer }),
  });

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
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

      response.writeHead(result.status, {
        "content-type": "application/json",
        // The browser client is served from a different origin during development, and the
        // gateway is token-authenticated rather than cookie-authenticated, so a wildcard
        // origin here grants nothing a caller does not already need the token for.
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      });
      response.end(`${JSON.stringify(result.body)}\n`);
    });
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
