import { MAP_TILE_SECRET_CONSUMER, MAP_TILE_SECRET_NAME, mapTileKeyConsumer, mapTileOriginSchema, nowInstant } from "@clarkcant/contracts";
import {
  credentialNames,
  deleteCredential,
  deleteSecretMetadata,
  putCredential,
  putSecretMetadata,
  secretKindOr,
  transaction,
} from "@clarkcant/storage";
import type { Database } from "@clarkcant/storage";

/**
 * Storing a secret a person typed.
 *
 * A flow rather than parsing: every field is validated, the value goes to the credential store and the metadata
 * row that describes it is written beside it, and the answer names what is now set. The response says what
 * happened and nothing about what was said — names, never values and never a length. A length is a fact about a
 * secret, and a card that printed one would be the first place it leaked from.
 */
export interface CredentialVaultDeps {
  db: Database;
  /** The node's owner, read here rather than from a conversation-scoped binding: a secret is stored against the
   * person who typed it, not against the thread they happened to be in. */
  ownerPrincipalId: string;
  nodeId: string;
  newId: (prefix: string) => string;
}

/** One field as the request body carried it: unknown until it is read, because the body is data. */
export interface CredentialFieldInput {
  name?: unknown;
  value?: unknown;
  kind?: unknown;
  description?: unknown;
  consumer?: unknown;
}

export type CredentialVaultOutcome = { ok: true; names: string[] } | { ok: false; code: string; message: string };

/** How many consumers one secret records. */
export const MAX_SECRET_CONSUMERS = 10;

/** The consumers a form named, comma-separated when one secret serves several: `command:gh,command:git`. */
export function consumersOf(value: unknown): string[] {
  return distinctConsumers(value).slice(0, MAX_SECRET_CONSUMERS);
}

/** Every consumer a form named, each once, before the cap `consumersOf` applies. */
export function distinctConsumers(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""))];
}

/**
 * How far the value may travel, decided by who it was asked for.
 *
 * A command can receive a secret in one way only, as a variable in its own environment, so a secret asked for a
 * `command:` consumer is stored as `process-env`: without that, the only thing the person typed it for could never
 * use it. A `package:` consumer is a package's service, which never receives the value at all: the host adds it as
 * the header the package declared to a request it makes on the service's behalf, so it is stored as `http-header`.
 * A secret asked for both a command and a package keeps `process-env`, and the package's service reads as not signed
 * in until it has one of its own. The map tile provider's key (`maps:tiles`) is the same kind of value: the node adds
 * it to a tile request it makes itself, so it is `http-header` too. Every other consumer is served by a callback that
 * runs and returns, which is `tool-only`. Nothing here can produce `agent-context`, the one exposure that puts a value
 * where it cannot be taken back from.
 */
export function injectionPolicyFor(consumers: readonly string[]): "tool-only" | "process-env" | "http-header" {
  if (consumers.some((consumer) => consumer.startsWith("command:"))) return "process-env";
  if (consumers.some((consumer) => consumer.startsWith("package:") || isMapTileConsumer(consumer))) return "http-header";
  return "tool-only";
}

/**
 * Validate the fields, store each value and its description together, and answer with the names now set.
 *
 * The value and the metadata are written together because the two halves are useless apart: a value nobody can
 * describe is a secret the agent can never be told about, and a description with no value behind it is a promise
 * this node cannot keep — which is the state `request_secret` reports as not available rather than as ready.
 */
export function storeCredentialFields(
  deps: CredentialVaultDeps,
  fields: unknown,
): CredentialVaultOutcome {
  if (!Array.isArray(fields) || fields.length === 0) {
    return { ok: false, code: "INVALID_SCHEMA", message: "a credential request must carry at least one field" };
  }
  // Every field is checked before any is stored, so a refused request leaves no half of itself behind.
  for (const field of fields as CredentialFieldInput[]) {
    const name = typeof field.name === "string" ? field.name.trim() : "";
    const value = typeof field.value === "string" ? field.value : "";
    if (name === "" || value.trim() === "") {
      return { ok: false, code: "INVALID_SCHEMA", message: "every credential field needs a name and a value" };
    }
    /*
     * The map tile key is bound to the origin a person entered it for, and only Settings binds it (`storeMapTileKey`).
     * A generic store — a form, `request_secret`, a machine surface — could otherwise replace it, or bind a value to an
     * origin nobody chose, so it is refused here whatever it is called or whichever consumer it names.
     */
    if (name === MAP_TILE_SECRET_NAME || consumersOf(field.consumer).some(isMapTileConsumer)) {
      return { ok: false, code: "MAP_TILE_KEY_IN_SETTINGS", message: MAP_TILE_KEY_IN_SETTINGS };
    }
  }
  const at = nowInstant();
  for (const field of fields as CredentialFieldInput[]) {
    const name = typeof field.name === "string" ? field.name.trim() : "";
    const value = typeof field.value === "string" ? field.value : "";
    putCredential(deps.db, { principalId: deps.ownerPrincipalId, name, value, at });
    /*
     * The consumer is recorded as the form said it. It is what the broker checks before handing the value to
     * anything, so it is the honest answer to "what will this be used for" rather than a label.
     */
    const consumers = consumersOf(field.consumer);
    putSecretMetadata(deps.db, {
      secretId: deps.newId("secret"),
      principalId: deps.ownerPrincipalId,
      name,
      description: typeof field.description === "string" ? field.description.slice(0, 1_000) : "",
      kind: secretKindOr(field.kind),
      backend: "node-store",
      backendRef: name,
      allowedConsumers: consumers,
      injectionPolicy: injectionPolicyFor(consumers),
      nodeId: deps.nodeId,
      at,
    });
  }
  return { ok: true, names: credentialNames(deps.db, deps.ownerPrincipalId) };
}

const MAP_TILE_KEY_IN_SETTINGS =
  "the map tile provider's key is entered in Settings → Extensions → Map tiles, which binds it to the provider's origin; it is not stored here";

function isMapTileConsumer(consumer: string): boolean {
  return consumer === MAP_TILE_SECRET_CONSUMER || consumer.startsWith(`${MAP_TILE_SECRET_CONSUMER}@`);
}

/**
 * Store the map tile provider's key a person typed in Settings, bound to the origin they typed it for.
 *
 * Always the host's own secret `maps:tiles`, so no other secret is ever overwritten, and always exactly one consumer,
 * `maps:tiles@<origin>`, so the node sends the key to that origin and nowhere else. Entering it again for another origin
 * moves the binding; nothing else does. The answer names the origin, never the value.
 */
export function storeMapTileKey(
  deps: CredentialVaultDeps,
  input: { origin: unknown; value: unknown },
): { ok: true; origin: string } | { ok: false; code: string; message: string } {
  const origin = mapTileOriginSchema.safeParse(input.origin);
  if (!origin.success) {
    return { ok: false, code: "INVALID_SCHEMA", message: `origin: ${origin.error.issues[0]?.message ?? "is not a tile provider origin"}` };
  }
  const value = typeof input.value === "string" ? input.value : "";
  if (value === "" || value.length > 4_096) {
    return { ok: false, code: "INVALID_SCHEMA", message: "the key must be between 1 and 4096 characters" };
  }
  const at = nowInstant();
  transaction(deps.db, () => {
    putCredential(deps.db, { principalId: deps.ownerPrincipalId, name: MAP_TILE_SECRET_NAME, value, at });
    putSecretMetadata(deps.db, {
      secretId: deps.newId("secret"),
      principalId: deps.ownerPrincipalId,
      name: MAP_TILE_SECRET_NAME,
      description: `Map tile provider key, sent only to ${origin.data}`,
      kind: "api-key",
      backend: "node-store",
      backendRef: MAP_TILE_SECRET_NAME,
      allowedConsumers: [mapTileKeyConsumer(origin.data)],
      injectionPolicy: "http-header",
      nodeId: deps.nodeId,
      at,
    });
  });
  return { ok: true, origin: origin.data };
}

/** Remove the map tile key, value and binding together. Whether there was one to remove is the answer. */
export function removeMapTileKey(deps: Pick<CredentialVaultDeps, "db" | "ownerPrincipalId">): { removed: boolean } {
  return transaction(deps.db, () => {
    const value = deleteCredential(deps.db, deps.ownerPrincipalId, MAP_TILE_SECRET_NAME);
    const metadata = deleteSecretMetadata(deps.db, deps.ownerPrincipalId, MAP_TILE_SECRET_NAME);
    return { removed: value || metadata };
  });
}
