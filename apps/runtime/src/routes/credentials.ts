import { credentialNames, deleteCredential } from "@clarkcant/storage";

import { type NodeServices } from "../services.ts";
import { storeCredentialFields } from "../application/credential-vault.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The secrets a person typed, and the ones they take back.
 *
 * The route owns the HTTP; storing a value and the metadata that describes it is a flow, and it lives in
 * `application/credential-vault.ts`. Nothing in this module can read a secret back: both answers name what is
 * set and never a value, and there is no route here that returns one.
 *
 * `undefined` means "not one of mine", which is how the dispatch keeps the route order it had when these
 * branches lived in the gateway.
 */
export interface CredentialRouteDeps {
  services: Pick<NodeServices, "runtime" | "conductor">;
  request: GatewayRequest;
  segments: string[];
}

/**
 * The credential family. `undefined` means the request is not one of these routes.
 */
export function handleCredentialRoutes(deps: CredentialRouteDeps): GatewayResponse | undefined {
  const { request, segments } = deps;
  const { runtime } = deps.services;

  /*
   * A secret a person typed.
   *
   * The response says what happened and nothing about what was said: the names that are now set, never the values
   * and never how long they were. Nothing here logs the body either, which is why an invalid request names the
   * shape it wanted rather than echoing what it got.
   */
  if (segments.length === 1 && segments[0] === "credentials" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const stored = storeCredentialFields(
      {
        db: runtime.db,
        ownerPrincipalId: runtime.identity.ownerPrincipalId,
        nodeId: runtime.identity.nodeId,
        newId: deps.services.conductor.newId,
      },
      parsed.value.fields,
    );
    if (!stored.ok) return fail(400, stored.code, stored.message);
    return json(201, { ok: true, names: stored.names });
  }

  /*
   * A secret a person takes back.
   *
   * This is what logging out of a provider is: the key is the only thing the node holds, so a node that has forgotten
   * it stops using that provider on the next turn. The answer names what remains, never a value and never a length.
   */
  if (segments.length === 2 && segments[0] === "credentials" && request.method === "DELETE") {
    const name = decodeURIComponent(segments[1] ?? "").trim();
    if (name === "") return fail(400, "INVALID_SCHEMA", "a credential name is required");
    const owner = runtime.identity.ownerPrincipalId;
    const removed = deleteCredential(runtime.db, owner, name);
    // 404 rather than a cheerful 200 for a name that was not there: "I removed it" and "there was nothing to remove"
    // are different answers, and a surface that cannot tell them apart cannot say why nothing changed.
    if (!removed) return fail(404, "RESOURCE_NOT_FOUND", `no credential named ${name}`);
    return json(200, { ok: true, names: credentialNames(runtime.db, owner) });
  }

  return undefined;
}
