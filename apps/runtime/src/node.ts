import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Instant, nowInstant, nodeIdSchema, principalIdSchema } from "@clarkcant/contracts";
import type { ConductorDeps, ModelTurnInput, ModelTurnReply } from "@clarkcant/core";
import { type Database, migrate, openDatabase } from "@clarkcant/storage";

import type { PiAdapter } from "@clarkcant/pi-adapter";

import type { JevConfig, JevTelemetry, JevTransport } from "./jev-selector.ts";
import type { ProjectSessionStarter } from "./project-session.ts";

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
  /**
   * The node's device key, in SPKI PEM.
   *
   * Published so that pairing is a comparison of keys rather than of names: a peer shows a person
   * this fingerprint, and the invite carries it, so a DNS name or a label is never the thing being
   * trusted. The key is generated locally and never leaves the node in private form — `identity.json`
   * is the only file that holds it and it is owner-readable only.
   */
  publicKey: string;
  /** sha256 of the public key, grouped so a person can read it aloud. */
  fingerprint: string;
}

/**
 * A fingerprint a person can compare by eye or read out loud.
 *
 * The first 128 bits of the digest in groups of four hex digits: long enough that a collision is not
 * something to plan around, short enough that comparing two of them on a call is realistic.
 */
export function fingerprintOf(publicKey: string): string {
  const digest = createHash("sha256").update(publicKey).digest("hex");
  return (digest.match(/.{4}/g) ?? []).slice(0, 8).join(":");
}

/** Generate the device key pair and keep only the public half. */
function createNodeKey(): { publicKey: string; fingerprint: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const exported = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { publicKey: exported, fingerprint: fingerprintOf(exported) };
}

export interface RuntimeOptions {
  /** Directory holding the database, identity and blobs. */
  dataDir: string;
  /** Human label for this node, shown in pairing and status UI. */
  label: string;
  /**
   * The runtime the entry point already opened, when it has one.
   *
   * Opened by the entry point rather than here so the stored model choice can be read *before* the model turn is
   * built: a turn built before that read decides this node has no model, and a choice made in the settings surface
   * would then be stored and never used. Passed in rather than opened a second time, because one database file is one
   * connection.
   */
  runtime?: Runtime;
  /**
   * Answers a turn with a model, when this node has one.
   *
   * Supplied by the entry point rather than constructed here, because building it is
   * asynchronous and reaching a provider is a decision the process makes at startup, not
   * something a service container should do while it is being assembled.
   */
  respondWithModel?: (input: ModelTurnInput) => Promise<ModelTurnReply>;
  /**
   * What the node is configured to run on, for the settings surface to report.
   *
   * Read separately from the turn handler because it is a different fact: the handler answers
   * turns, and this says what an operator configured. A settings screen that inferred the model
   * from the last reply would show the wrong thing until the first one arrived.
   */
  model?: NodeModelInfo;
  /**
   * Selector wiring, injectable so a test can substitute a transport instead of reaching a
   * provider. The production path builds the config from the environment and uses fetch.
   */
  /**
   * A deterministic composer the conductor consults before its recipes.
   *
   * Declared here because the conductor is assembled by `bootNodeServices`, and an option that is not
   * forwarded is an option that silently does nothing.
   */
  composeFromIntent?: ConductorDeps["composeFromIntent"];
  /**
   * Builds the adapter a project session runs on, for one directory.
   *
   * A seam rather than an import so a journey test can assert the brief it is handed without loading
   * the SDK and spawning a real session.
   */
  projectSessionAdapter?: (cwd: string) => PiAdapter;
  /**
   * Replaces the session starter entirely.
   *
   * The adapter seam above still builds a real starter around a fake adapter, which is what an
   * integration test wants. This one exists for a node that has no worker at all — the browser suite,
   * where starting a session must be provable without spawning a process — and for a host that brings
   * its own session mechanism.
   */
  projectSessions?: ProjectSessionStarter;
  jev?: {
    config?: Partial<{ [K in keyof JevConfig]: JevConfig[K] }>;
    transport?: JevTransport;
    onTelemetry?: (event: JevTelemetry) => void;
  };
}

/** The model configuration, as an operator would want to see it. */
export interface NodeModelInfo {
  provider: string;
  id: string;
  maxWallClockMs: number;
  maxTokens: number;
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
    let stored: NodeIdentity;
    try {
      stored = JSON.parse(raw) as NodeIdentity;
    } catch (cause) {
      // Overwriting a corrupt identity would silently orphan every grant and pairing
      // recorded against the old node id, so the operator is asked to intervene.
      throw new Error(
        `the node identity at ${path} is not valid JSON. Refusing to replace it, because a new identity would invalidate every existing pairing and grant. Restore it from a backup or delete it deliberately.`,
        { cause },
      );
    }
    // A node that existed before device keys did has an identity without one. The key is added in
    // place rather than by minting a new identity: the node id and the local token are what every
    // grant, preference and pairing is recorded against, so replacing them would orphan all of it.
    if (typeof stored.publicKey !== "string" || typeof stored.fingerprint !== "string") {
      const identity: NodeIdentity = { ...stored, ...createNodeKey() };
      writeIdentity(path, identity);
      return identity;
    }
    return stored;
  }

  const identity: NodeIdentity = {
    nodeId: nodeIdSchema.parse(`node_${randomUUID().replaceAll("-", "").slice(0, 24)}`),
    ownerPrincipalId: principalIdSchema.parse(`prin_owner_${randomUUID().replaceAll("-", "").slice(0, 16)}`),
    label,
    createdAt: nowInstant(),
    localToken: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    ...createNodeKey(),
  };

  mkdirSync(dataDir, { recursive: true });
  writeIdentity(path, identity);
  return identity;
}

function writeIdentity(path: string, identity: NodeIdentity): void {
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`);
  // The token in this file authorizes local commands, so it is owner-readable only.
  chmodSync(path, 0o600);
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
