#!/usr/bin/env node
/**
 * Headless runtime entry point.
 *
 * Boots a node and serves the authenticated command gateway on loopback by default.
 * Binding a public interface requires an explicit flag, because a node with a public
 * listener and no TLS is the deployment mistake the blueprint calls out: application
 * authorization is required regardless of how private the network is.
 */
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { handleRequest } from "./gateway.ts";
import { bootRuntime } from "./node.ts";

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

  const runtime = bootRuntime({ dataDir: options.dataDir, label: options.label });

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const result = handleRequest(
        { runtime },
        {
          method: request.method ?? "GET",
          path: new URL(request.url ?? "/", `http://${options.host}`).pathname,
          headers: request.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString("utf8"),
        },
      );
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(`${JSON.stringify(result.body)}\n`);
    });
  });

  server.listen(options.port, options.host, () => {
    process.stderr.write(`clarkcant node "${runtime.identity.label}" listening on http://${options.host}:${options.port}\n`);
    process.stderr.write(`node id: ${runtime.identity.nodeId}\n`);
    process.stderr.write(`data dir: ${runtime.dataDir}\n`);
    process.stderr.write("commands require the bearer token stored in the node's identity.json\n");
  });

  const shutdown = (signal: string): void => {
    process.stderr.write(`received ${signal}; closing the node\n`);
    server.close(() => {
      runtime.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

await main();
