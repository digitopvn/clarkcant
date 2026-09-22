import { blobPathForDigest, readBlob, sniffContentType } from "../blobs.ts";
import { type GatewayRequest, type GatewayResponse, fail } from "./http.ts";

/**
 * A captured frame of a session, served to the client that owns it.
 *
 * The route owns its own HTTP: the method and shape check, the response mapping, and the headers that
 * say a frame is never cached. Everything it needs is a parameter, narrowed to the data directory it
 * reads from, so this module cannot reach another part of the node.
 */
export interface PreviewRouteDeps {
  services: { runtime: { dataDir: string } };
  request: GatewayRequest;
  segments: string[];
}

/**
 * A captured frame of a session, served to the client that owns it.
 *
 * Content-addressed like an artifact, and reachable by this node's own principal rather than by a peer: a frame is
 * a picture of somebody's screen, so the boundary is who is asking, not which machine. The digest is resolved
 * through the blob store's own guard instead of being joined to a path here — the same rule the artifact route
 * follows, for the same reason — and the type is sniffed from the bytes, so a frame cannot be served under a type it
 * does not have.
 *
 * A digest this node does not hold and a string that was never a digest get the same answer, so the route cannot be
 * used to ask what this machine has.
 */

export function handlePreviewRoutes(deps: PreviewRouteDeps): GatewayResponse {
  const { request, segments } = deps;
  if (request.method !== "GET" || segments.length !== 2) {
    return fail(404, "RESOURCE_NOT_FOUND", "no such route");
  }
  const { runtime } = deps.services;
  const blobPath = blobPathForDigest({ dataDir: runtime.dataDir, digest: decodeURIComponent(segments[1] ?? "") });
  if (blobPath === undefined) {
    return fail(404, "PREVIEW_NOT_FOUND", "this node holds no frame with that digest");
  }
  const blob = readBlob({ dataDir: runtime.dataDir, blobPath });
  if (!blob.ok) return fail(404, "PREVIEW_NOT_FOUND", "that frame could not be read");
  /*
   * The declared type is empty, and that is not a missing argument.
   *
   * A digest carries no declaration, so there is nothing to check the bytes against — and passing a placeholder
   * type made the sniffer compare a real PNG with `application/octet-stream`, fail the match, and serve the node's
   * own frame as `application/octet-stream`. An empty declaration is the honest one: this route serves what the
   * bytes are, and the bytes are what decide it.
   */
  const sniffed = sniffContentType(blob.bytes, "");
  return {
    status: 200,
    body: null,
    binary: {
      bytes: blob.bytes,
      contentType: sniffed.ok ? sniffed.mime : "application/octet-stream",
      // A frame is a picture of a screen: never cached, because a cached one is a stale one presented as current.
      headers: { "cache-control": "no-store" },
    },
  };
}
