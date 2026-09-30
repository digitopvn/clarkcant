import {
  ARTIFACT_CHUNK_BASE64_MAX,
  ARTIFACT_LIMITS,
  type ArtifactRefusal,
  artifactAcceptSchema,
  artifactFileName,
  artifactNameSchema,
  artifactRefusalStatus,
} from "@clarkcant/contracts";
import { getInstance } from "@clarkcant/core";
import { getBrokerArtifact, getConversation, instanceIsInConversation } from "@clarkcant/storage";

import {
  type ArtifactBrokerDeps,
  appendArtifactChunk,
  attachArtifact,
  createWorkingArtifact,
  describeArtifact,
  discardArtifact,
  exportArtifactBytes,
  finalizeArtifact,
  readArtifactRange,
  storePickedArtifact,
} from "../artifact-broker.ts";
import { readBlob } from "../blobs.ts";
import type { NodeServices } from "../services.ts";
import { contentDisposition } from "./content-disposition.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * Files a widget holds by reference.
 *
 * Two families, split by who is asking:
 *
 * - `/artifacts/:id…` is the **person's**: describe, read back and save an artifact they own. `POST …/export` is
 *   person-only (`isPersonOnlyRoute`), because Save As writes a file onto the person's machine and a relay, an MCP
 *   client or a remote node must not do that on their behalf.
 * - `/conversations/:cid/widgets/:iid/artifacts…` is a **widget instance's**, reached through its host. Every call
 *   names the instance, and every call is re-judged against that instance's grant by the broker; a ref is a pointer,
 *   never a permission. `POST …/pick` is person-only for the same reason as export: a grant to a picked file is the
 *   person's choice in host chrome, not something a machine surface can make. Taking a widget's access away is the
 *   person's act too, so it has no route until host chrome offers it (#343); `revokeArtifactAccess` is what that uses.
 *
 * No answer here carries a path, a staging name or where a picked file was read from: only an `ArtifactRef`, bytes,
 * or a refusal that names what was wrong.
 */
export interface ArtifactRouteDeps {
  services: Pick<NodeServices, "runtime" | "conductor">;
  request: GatewayRequest;
  segments: string[];
}

function brokerDeps(services: ArtifactRouteDeps["services"]): ArtifactBrokerDeps {
  return {
    db: services.runtime.db,
    dataDir: services.runtime.dataDir,
    nodeId: services.runtime.identity.nodeId,
    newId: (prefix) => services.conductor.newId(prefix),
    now: () => new Date(),
  };
}

function refused(refusal: ArtifactRefusal): GatewayResponse {
  return fail(artifactRefusalStatus(refusal.code), refusal.code, refusal.message);
}

/** A string field, or undefined when it is absent or not a string. */
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Base64 decoded only once its encoded length is within bounds, so an oversized body never becomes a buffer. */
function decodeBase64(value: unknown, maxChars: number): { ok: true; bytes: Uint8Array } | { ok: false; response: GatewayResponse } {
  if (typeof value !== "string") {
    return { ok: false, response: fail(400, "INVALID_SCHEMA", "the bytes travel as a base64 string") };
  }
  if (value.length > maxChars) {
    return {
      ok: false,
      response: fail(413, "ARTIFACT_CHUNK_TOO_LARGE", `that is more than ${maxChars} base64 characters`),
    };
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return { ok: false, response: fail(400, "INVALID_SCHEMA", "the bytes are not valid base64") };
  }
  return { ok: true, bytes: new Uint8Array(Buffer.from(value, "base64")) };
}

/** A query integer, or the raw string when it is not one, so the range check can name what was wrong. */
function queryInteger(value: string | undefined): unknown {
  if (value === undefined || value === "") return undefined;
  return /^\d{1,15}$/.test(value) ? Number(value) : value;
}

export function handleArtifactRoutes(deps: ArtifactRouteDeps): GatewayResponse | undefined {
  const { segments } = deps;
  if (segments[0] === "artifacts") return personRoutes(deps);
  if (segments[0] === "conversations" && segments[2] === "widgets" && segments[4] === "artifacts") {
    return widgetRoutes(deps);
  }
  return undefined;
}

function personRoutes(deps: ArtifactRouteDeps): GatewayResponse {
  const { request, segments, services } = deps;
  const principalId = services.runtime.identity.ownerPrincipalId;
  const artifactId = decodeURIComponent(segments[1] ?? "");
  if (artifactId === "") return fail(400, "INVALID_SCHEMA", "an artifact route must name an artifact");

  const record = getBrokerArtifact(services.runtime.db, artifactId);
  // One answer for "no such artifact" and "not yours", as for attachments: the difference would enumerate ids.
  if (record === undefined || record.ownerPrincipalId !== principalId) {
    return fail(404, "ARTIFACT_NOT_FOUND", "that artifact is not on this node");
  }

  // `GET /artifacts/:id` itself is the record-read route's, which answers a widget's file with its ref as well.

  // What the host's own Open shows: sealed bytes, rendered in place only when they are a picture or text.
  if (segments.length === 3 && segments[2] === "content" && request.method === "GET") {
    if (record.state !== "sealed" || record.blobPath === undefined) {
      return fail(409, "ARTIFACT_NOT_FINALIZED", "a working artifact is finalized before it can be opened");
    }
    const blob = readBlob({ dataDir: services.runtime.dataDir, blobPath: record.blobPath });
    if (!blob.ok) return fail(410, "ARTIFACT_BYTES_MISSING", blob.message);
    const inline = record.mimeType.startsWith("image/") || record.mimeType.startsWith("text/") || record.mimeType === "application/json";
    return {
      status: 200,
      body: null,
      binary: {
        bytes: blob.bytes,
        contentType: record.mimeType,
        headers: {
          "x-content-type-options": "nosniff",
          "content-disposition": contentDisposition(inline ? "inline" : "attachment", record.name),
        },
      },
    };
  }

  // Save As. Person-only: see `isPersonOnlyRoute`.
  if (segments.length === 3 && segments[2] === "export" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const suggested = text(parsed.value.suggestedName);
    let name = record.name;
    if (suggested !== undefined && suggested.trim() !== "") {
      const checked = artifactNameSchema.safeParse(suggested.trim());
      if (!checked.success) return fail(400, "ARTIFACT_NAME_NOT_ALLOWED", "a suggested name must be a file name, not a path or a URL");
      name = checked.data;
    }
    const exported = exportArtifactBytes(brokerDeps(services), { principalId, artifactId });
    if (!exported.ok) return refused(exported);
    // The extension is the bytes' type's, whatever the suggestion said: see `artifactFileName`.
    const saved = artifactFileName(name, exported.ref.mimeType);
    return {
      status: 200,
      body: null,
      binary: {
        bytes: exported.bytes,
        contentType: exported.ref.mimeType,
        cache: "no-store",
        headers: {
          "x-content-type-options": "nosniff",
          "content-disposition": contentDisposition("attachment", saved),
          // The web host reads the name back to give the download the name the person chose.
          "access-control-expose-headers": "content-disposition",
        },
      },
    };
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}

function widgetRoutes(deps: ArtifactRouteDeps): GatewayResponse {
  const { request, segments, services } = deps;
  const { runtime } = services;
  const principalId = runtime.identity.ownerPrincipalId;
  const conversationId = decodeURIComponent(segments[1] ?? "");
  const instanceId = decodeURIComponent(segments[3] ?? "");

  if (getConversation(runtime.db, conversationId) === undefined) {
    return fail(404, "RESOURCE_NOT_FOUND", "that conversation is not on this node");
  }
  const instance = getInstance(services.conductor, instanceId);
  if (instance === undefined) return fail(404, "RESOURCE_NOT_FOUND", "that instance is not on this node");
  if (instance.ownerPrincipalId !== principalId) {
    return fail(403, "NOT_AUTHORIZED", "that instance belongs to another principal");
  }
  // The path pairs a conversation with an instance; the pair is checked, not trusted. The same answer as a missing
  // instance, so the route cannot be used to learn which conversation an instance is in.
  if (!instanceIsInConversation(runtime.db, { conversationId, instanceId })) {
    return fail(404, "RESOURCE_NOT_FOUND", "that instance is not on this node");
  }
  const broker = brokerDeps(services);
  const scope = { principalId, instanceId };

  // POST …/artifacts — a new working artifact the instance may write.
  if (segments.length === 5 && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const mimeType = text(parsed.value.mimeType);
    if (mimeType === undefined) return fail(400, "INVALID_SCHEMA", "a new artifact names its content type as mimeType");
    const created = createWorkingArtifact(broker, {
      ...scope,
      conversationId,
      mimeType,
      name: text(parsed.value.name),
    });
    return created.ok ? json(201, { artifactRef: created.ref }) : refused(created);
  }

  // POST …/artifacts/pick — a file the person chose in host chrome. Person-only: see `isPersonOnlyRoute`.
  if (segments.length === 6 && segments[5] === "pick" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const accept = parsed.value.accept ?? [];
    if (!Array.isArray(accept) || accept.length > ARTIFACT_LIMITS.maxAccept || !accept.every((entry) => artifactAcceptSchema.safeParse(entry).success)) {
      return fail(400, "INVALID_SCHEMA", `accept is a list of at most ${ARTIFACT_LIMITS.maxAccept} MIME types such as text/plain or image/*`);
    }
    const bytes = decodeBase64(parsed.value.contentBase64, Math.ceil((ARTIFACT_LIMITS.maxBytes * 4) / 3) + 4);
    if (!bytes.ok) {
      return bytes.response.status === 413
        ? fail(413, "ARTIFACT_TOO_LARGE", `a file must be at most ${ARTIFACT_LIMITS.maxBytes} bytes`)
        : bytes.response;
    }
    const stored = storePickedArtifact(broker, {
      ...scope,
      conversationId,
      name: text(parsed.value.name) ?? "",
      mimeType: text(parsed.value.mimeType) ?? "",
      bytes: bytes.bytes,
      accept: accept as string[],
    });
    return stored.ok ? json(201, { artifactRef: stored.ref }) : refused(stored);
  }

  const artifactId = decodeURIComponent(segments[5] ?? "");
  if (artifactId === "") return fail(400, "INVALID_SCHEMA", "an artifact route must name an artifact");
  const target = { ...scope, artifactId };

  if (segments.length === 6 && request.method === "GET") {
    const described = describeArtifact(broker, target);
    return described.ok ? json(200, { artifactRef: described.ref }) : refused(described);
  }

  // DELETE …/artifacts/:id — the widget lets go of a file it made, and the bytes nothing else points at go with it.
  if (segments.length === 6 && request.method === "DELETE") {
    const discarded = discardArtifact(broker, target);
    return discarded.ok ? json(200, { discarded: true, artifactId }) : refused(discarded);
  }

  if (segments.length === 7 && segments[6] === "content" && request.method === "GET") {
    const read = readArtifactRange(broker, {
      ...target,
      offset: queryInteger(request.query.offset) ?? 0,
      length: queryInteger(request.query.length) ?? ARTIFACT_LIMITS.maxReadBytes,
    });
    if (!read.ok) return refused(read);
    return json(200, {
      artifactRef: read.ref,
      offset: read.offset,
      eof: read.eof,
      contentBase64: Buffer.from(read.bytes).toString("base64"),
    });
  }

  if (segments.length === 7 && segments[6] === "chunks" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const bytes = decodeBase64(parsed.value.contentBase64, ARTIFACT_CHUNK_BASE64_MAX);
    if (!bytes.ok) return bytes.response;
    const written = appendArtifactChunk(broker, { ...target, offset: parsed.value.offset, bytes: bytes.bytes });
    return written.ok ? json(200, { artifactRef: written.ref }) : refused(written);
  }

  if (segments.length === 7 && segments[6] === "finalize" && request.method === "POST") {
    const finalized = finalizeArtifact(broker, target);
    return finalized.ok ? json(200, { artifactRef: finalized.ref }) : refused(finalized);
  }

  if (segments.length === 7 && segments[6] === "attach" && request.method === "POST") {
    const attached = attachArtifact(broker, target);
    return attached.ok
      ? json(201, { artifactRef: attached.ref, attachmentRef: attached.attachmentRef })
      : refused(attached);
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}
