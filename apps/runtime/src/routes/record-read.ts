import { getArtifact, getDatasetForPrincipal } from "@clarkcant/storage";

import { type NodeServices } from "../services.ts";
import { type GatewayRequest, type GatewayResponse, fail, json } from "./http.ts";

/**
 * The node-local records a client fetches by id.
 *
 * An artifact's description and a dataset's freshness are both read one record at a time, and both are scoped to
 * the principal at the query rather than checked afterwards, so asking for somebody else's row resolves to
 * `404` — the same answer as a row that does not exist. That is what keeps these routes from being a way to
 * enumerate what else is on the node.
 *
 * `undefined` means "not one of mine", which is how the dispatch keeps the route order it had when these branches
 * lived in the gateway.
 */
export interface RecordReadRouteDeps {
  services: Pick<NodeServices, "runtime">;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
}

/**
 * The artifact and dataset family. `undefined` means the request is not one of these routes.
 */
export function handleRecordReadRoutes(deps: RecordReadRouteDeps): GatewayResponse | undefined {
  const { request, segments } = deps;
  const { runtime } = deps.services;

  // /datasets/:id
  if (segments[0] === "datasets" && segments.length === 2 && request.method === "GET") {
    const dataset = getDatasetForPrincipal(
      runtime.db,
      segments[1] ?? "",
      runtime.identity.ownerPrincipalId,
    );
    if (!dataset) return fail(404, "RESOURCE_NOT_FOUND", "that dataset is not available on this node");
    // The freshness travels with the data so a cached read cannot be presented as live.
    return json(200, dataset);
  }

  /*
   * Open an artifact.
   *
   * Expiry is reported rather than folded into "not found": an artifact that reads as missing tells the user
   * their file never existed, when the truth is that the node had it and a retention window passed. That
   * difference decides whether they ask for it again or go looking for a fault.
   *
   * The reply describes the artifact and never says where its bytes live — the node's data directory is not
   * something a client needs in order to show a file, and handing it over would only describe somebody's disk.
   */
  if (segments.length === 2 && segments[0] === "artifacts" && request.method === "GET") {
    const artifactId = decodeURIComponent(segments[1] ?? "");
    const artifact = getArtifact(runtime.db, artifactId);
    if (artifact === undefined) {
      return fail(404, "ARTIFACT_NOT_FOUND", "Không có artifact nào với id này trên node.", { artifactId });
    }
    return json(200, {
      artifact: {
        artifactId: artifact.artifactId,
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes,
        mimeType: artifact.mimeType,
        originNodeId: artifact.originNodeId,
        createdAt: artifact.createdAt,
        expiresAt: artifact.expiresAt ?? null,
        // ISO instants compare correctly as strings, and both sides are UTC.
        expired: artifact.expiresAt !== undefined && artifact.expiresAt <= deps.at(),
      },
    });
  }

  return undefined;
}
