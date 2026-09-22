import { nowInstant } from "@clarkcant/contracts";
import { credentialNames, putCredential, putSecretMetadata, secretKindOr } from "@clarkcant/storage";
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
  const at = nowInstant();
  for (const field of fields as CredentialFieldInput[]) {
    const name = typeof field.name === "string" ? field.name.trim() : "";
    const value = typeof field.value === "string" ? field.value : "";
    if (name === "" || value === "") {
      return { ok: false, code: "INVALID_SCHEMA", message: "every credential field needs a name and a value" };
    }
    putCredential(deps.db, { principalId: deps.ownerPrincipalId, name, value, at });
    /*
     * The consumer is recorded as the form said it. It is what the broker checks before handing the value to
     * anything, so it is the honest answer to "what will this be used for" rather than a label.
     */
    putSecretMetadata(deps.db, {
      secretId: deps.newId("secret"),
      principalId: deps.ownerPrincipalId,
      name,
      description: typeof field.description === "string" ? field.description.slice(0, 1_000) : "",
      kind: secretKindOr(field.kind),
      backend: "node-store",
      backendRef: name,
      allowedConsumers: typeof field.consumer === "string" && field.consumer.trim() !== "" ? [field.consumer.trim()] : [],
      injectionPolicy: "tool-only",
      nodeId: deps.nodeId,
      at,
    });
  }
  return { ok: true, names: credentialNames(deps.db, deps.ownerPrincipalId) };
}
