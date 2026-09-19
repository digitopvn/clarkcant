import type { Instant } from "@clarkcant/contracts";

import type { Database } from "./db.ts";

/**
 * Secrets: the metadata the node keeps, and the backend the value actually lives in.
 *
 * The split is the point. Before this, a credential was a row with a value in it, and the only thing keeping
 * that value out of a model's context was care — one function named `readCredential` and a habit of not calling
 * it. With metadata separated, the agent can be told that a secret *exists*, what it is for and which consumers
 * may use it, while the value stays behind a backend interface that no tool result can reach through.
 *
 * The backend is an interface rather than a decision because the right place to keep a value differs by
 * deployment: a laptop has a keychain, a container has the environment, a company has a vault. What must not
 * differ is the metadata, because that is what the rest of the system reasons about.
 */

export type SecretKind = "api-key" | "token" | "password" | "webhook-secret" | "other";

/** The kinds this build understands, in the order a form offers them. */
export const SECRET_KINDS: readonly SecretKind[] = ["api-key", "token", "password", "webhook-secret", "other"];

/**
 * A stored kind, or the default.
 *
 * Used where the value arrives from outside — a form body, a tool call — because an unrecognised kind must cost the
 * kind and nothing else: a secret whose kind is wrong is still a secret, and refusing the write would lose the value
 * a person just typed.
 */
export function secretKindOr(value: unknown): SecretKind {
  return SECRET_KINDS.includes(value as SecretKind) ? (value as SecretKind) : "api-key";
}

/**
 * How a secret may reach the thing that needs it.
 *
 * `tool-only` is the default and the one to reach for: the value goes straight from the backend into the call
 * that needs it and never exists anywhere else. `agent-context` is the exception that must be asked for by name,
 * because it puts a value into a model's context — the one place a secret cannot be taken back from.
 */
export type InjectionPolicy = "tool-only" | "process-env" | "http-header" | "agent-context";

export type SecretBackendKind = "node-store" | "os-keychain" | "encrypted-file" | "environment" | "external-vault";

export interface SecretMetadata {
  secretId: string;
  name: string;
  description: string;
  kind: SecretKind;
  backend: SecretBackendKind;
  /** Opaque to callers: the node-store backend reads it as a credential name, a keychain backend as a path. */
  backendRef: string;
  /** Capability or command references allowed to use this secret, e.g. `command:git`. */
  allowedConsumers: string[];
  injectionPolicy: InjectionPolicy;
  nodeId?: string;
  createdAt: Instant;
  updatedAt: Instant;
  lastUsedAt?: Instant;
}

/** What anything outside the host is allowed to see. Structurally, there is no field for a value. */
export interface SecretSummary {
  name: string;
  description: string;
  kind: SecretKind;
  present: true;
  allowedConsumers: string[];
  injectionPolicy: InjectionPolicy;
  nodeId?: string;
}

interface SecretRow {
  secret_id: string;
  node_id: string | null;
  name: string;
  description: string;
  kind: string;
  backend: string;
  backend_ref: string;
  allowed_consumers: string;
  injection_policy: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

function toMetadata(row: SecretRow): SecretMetadata {
  return {
    secretId: row.secret_id,
    name: row.name,
    description: row.description,
    kind: row.kind as SecretKind,
    backend: row.backend as SecretBackendKind,
    backendRef: row.backend_ref,
    allowedConsumers: parseStringList(row.allowed_consumers),
    injectionPolicy: row.injection_policy as InjectionPolicy,
    ...(row.node_id === null ? {} : { nodeId: row.node_id }),
    createdAt: row.created_at as Instant,
    updatedAt: row.updated_at as Instant,
    ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at as Instant }),
  };
}

/** A stored list, read defensively: a hand-edited row must not crash a listing. */
function parseStringList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function putSecretMetadata(
  db: Database,
  input: {
    secretId: string;
    principalId: string;
    name: string;
    description: string;
    kind: SecretKind;
    backend: SecretBackendKind;
    backendRef: string;
    allowedConsumers: readonly string[];
    injectionPolicy: InjectionPolicy;
    nodeId?: string;
    at: Instant;
  },
): SecretMetadata {
  db.prepare(
    `INSERT INTO secrets (
       secret_id, principal_id, node_id, name, description, kind, backend, backend_ref,
       allowed_consumers, injection_policy, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (principal_id, name) DO UPDATE SET
       description = excluded.description,
       kind = excluded.kind,
       backend = excluded.backend,
       backend_ref = excluded.backend_ref,
       allowed_consumers = excluded.allowed_consumers,
       injection_policy = excluded.injection_policy,
       node_id = excluded.node_id,
       updated_at = excluded.updated_at`,
  ).run(
    input.secretId,
    input.principalId,
    input.nodeId ?? null,
    input.name,
    input.description,
    input.kind,
    input.backend,
    input.backendRef,
    JSON.stringify([...input.allowedConsumers]),
    input.injectionPolicy,
    input.at,
    input.at,
  );

  const stored = getSecretMetadata(db, input.principalId, input.name);
  if (stored === undefined) throw new Error(`secret ${input.name} was written but cannot be read back`);
  return stored;
}

export function listSecretMetadata(db: Database, principalId: string): SecretMetadata[] {
  const rows = db.prepare("SELECT * FROM secrets WHERE principal_id = ? ORDER BY name").all(principalId);
  // SAFETY: the driver types every column as `SQLOutputValue` because SQLite has no static schema. These rows come
  // from the table this module's own migration created, and every field is read through `toMetadata`, which narrows
  // each one rather than trusting it.
  return (rows as unknown as SecretRow[]).map(toMetadata);
}

export function getSecretMetadata(db: Database, principalId: string, name: string): SecretMetadata | undefined {
  const row = db.prepare("SELECT * FROM secrets WHERE principal_id = ? AND name = ?").get(principalId, name) as
    | SecretRow
    | undefined;
  return row === undefined ? undefined : toMetadata(row);
}

export function deleteSecretMetadata(db: Database, principalId: string, name: string): boolean {
  const result = db.prepare("DELETE FROM secrets WHERE principal_id = ? AND name = ?").run(principalId, name);
  return Number(result.changes) > 0;
}

/** Record that a secret was used, for the one question an operator actually asks: is this still needed? */
export function markSecretUsed(db: Database, principalId: string, name: string, at: Instant): void {
  db.prepare("UPDATE secrets SET last_used_at = ? WHERE principal_id = ? AND name = ?").run(at, principalId, name);
}

/**
 * The metadata as anything outside the host may see it.
 *
 * Written as a projection rather than a cast, so a column added to the table later cannot leak into a payload by
 * default. A new field is invisible until somebody decides it should be visible, which is the right direction for
 * this particular table.
 */
export function summarizeSecret(metadata: SecretMetadata): SecretSummary {
  return {
    name: metadata.name,
    description: metadata.description,
    kind: metadata.kind,
    present: true,
    allowedConsumers: [...metadata.allowedConsumers],
    injectionPolicy: metadata.injectionPolicy,
    ...(metadata.nodeId === undefined ? {} : { nodeId: metadata.nodeId }),
  };
}

/**
 * Where a value lives.
 *
 * Four operations and no listing: a backend that could enumerate its values would be a backend whose contents
 * could be logged, and nothing in this system has a use for that.
 */
export interface SecretBackend {
  readonly kind: SecretBackendKind;
  has(ref: string): boolean;
  /** The only way a value leaves a backend, and it is called at the moment of use rather than at load. */
  read(ref: string): string | undefined;
  write(ref: string, value: string, at: Instant): void;
  remove(ref: string): void;
}

/**
 * The backend this node starts with: the credentials table it already had.
 *
 * Chosen first not because it is the most secure place for a value but because it is the one that already
 * exists and already has the property that matters — a value goes in, and only one host-only function takes it
 * out. Moving the value to a keychain later is a second backend and a metadata row pointing at it; nothing above
 * this interface has to change.
 */
export function nodeStoreSecretBackend(db: Database, principalId: string): SecretBackend {
  return {
    kind: "node-store",
    has: (ref) => db.prepare("SELECT 1 AS present FROM credentials WHERE principal_id = ? AND name = ?").get(principalId, ref) !== undefined,
    read: (ref) => {
      const row = db.prepare("SELECT value FROM credentials WHERE principal_id = ? AND name = ?").get(principalId, ref) as
        | { value: string }
        | undefined;
      return row?.value;
    },
    write: (ref, value, at) => {
      db.prepare(
        `INSERT INTO credentials (principal_id, name, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (principal_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(principalId, ref, value, at);
    },
    remove: (ref) => {
      db.prepare("DELETE FROM credentials WHERE principal_id = ? AND name = ?").run(principalId, ref);
    },
  };
}

/**
 * The backend a metadata row names.
 *
 * Returns nothing for a backend this build does not have, rather than falling back to the node store: a row that
 * says `os-keychain` and a node that reads it from SQLite would be a silent downgrade of exactly the promise the
 * row makes.
 */
export function secretBackendFor(
  db: Database,
  principalId: string,
  kind: SecretBackendKind,
): SecretBackend | undefined {
  if (kind === "node-store") return nodeStoreSecretBackend(db, principalId);
  return undefined;
}
