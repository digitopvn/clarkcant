import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Instant, nowInstant, nodeIdSchema, principalIdSchema } from "@clarkcant/contracts";
import type { ModelTurnInput, ModelTurnReply } from "@clarkcant/core";
import { type Database, migrate, openDatabase } from "@clarkcant/storage";

/**
 * Composition root for one runtime installation.
 *
 * A runtime is a node: it has its own identity, its own database, its own credentials
 * and its own resource scope. Nothing here requires Electron, a display, or a global
 * Pi installation, which is what makes the same code serve a desktop helper and a
 * headless VPS (scope item V02).
 *
 * Two behaviours are deliberate:
 *
 * - The local socket binds to a private path, never a public interface. A desktop
 *   runtime must not expose an unauthenticated listener on the network, and binding
 *   loopback is not the same as being safe if the token is guessable, so there is also
 *   a bearer token.
 * - The node identity is created once and persisted with owner-only permissions. Two
 *   nodes sharing an identity would break peer authorization entirely.
 */

export interface NodeIdentity {
  nodeId: string;
  ownerPrincipalId: string;
  label: string;
  createdAt: Instant;
  /** Bearer token required by the local gateway. Rotated by deleting the identity file. */
  localToken: string;
}

export interface RuntimeOptions {
  /** Directory holding the database, identity and blobs. */
  dataDir: string;
  /** Human label for this node, shown in pairing and status UI. */
  label: string;
  /**
   * Answers a turn with a model, when this node has one.
   *
   * Supplied by the entry point rather than constructed here, because building it is
   * asynchronous and reaching a provider is a decision the process makes at startup, not
   * something a service container should do while it is being assembled.
   */
  respondWithModel?: (input: ModelTurnInput) => Promise<ModelTurnReply>;
}

export interface Runtime {
  identity: NodeIdentity;
  db: Database;
  dataDir: string;
  close(): void;
}

function readOrCreateIdentity(dataDir: string, label: string): NodeIdentity {
  const path = join(dataDir, "identity.json");
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    try {
      return JSON.parse(raw) as NodeIdentity;
    } catch (cause) {
      // Overwriting a corrupt identity would silently orphan every grant and pairing
      // recorded against the old node id, so the operator is asked to intervene.
      throw new Error(
        `the node identity at ${path} is not valid JSON. Refusing to replace it, because a new identity would invalidate every existing pairing and grant. Restore it from a backup or delete it deliberately.`,
        { cause },
      );
    }
  }

  const identity: NodeIdentity = {
    nodeId: nodeIdSchema.parse(`node_${randomUUID().replaceAll("-", "").slice(0, 24)}`),
    ownerPrincipalId: principalIdSchema.parse(`prin_owner_${randomUUID().replaceAll("-", "").slice(0, 16)}`),
    label,
    createdAt: nowInstant(),
    localToken: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
  };

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`);
  // The token in this file authorizes local commands, so it is owner-readable only.
  chmodSync(path, 0o600);
  return identity;
}

/** Node version and platform, reported by the health endpoint. */
export function runtimeDescription(): { node: string; platform: string; arch: string } {
  return { node: process.version, platform: process.platform, arch: process.arch };
}

/**
 * Boot a node.
 *
 * Migrations run here rather than lazily on first use, so a schema problem surfaces at
 * startup instead of during a user's first command.
 */
export function bootRuntime(options: RuntimeOptions): Runtime {
  mkdirSync(options.dataDir, { recursive: true });
  const identity = readOrCreateIdentity(options.dataDir, options.label);
  const db = openDatabase({ path: join(options.dataDir, "node.sqlite") });
  migrate(db);

  return {
    identity,
    db,
    dataDir: options.dataDir,
    close: () => {
      db.close();
    },
  };
}

/**
 * @implementation-status stub
 * TODO(P1): the local Unix-socket transport. The identity, database, migrations and
 * bearer-token gate are implemented and tested; the socket listener that a desktop
 * helper would attach to is not, and only the loopback HTTP gateway is wired today.
 */
export const LOCAL_SOCKET_STATUS = "identity-and-http-implemented-socket-pending";
