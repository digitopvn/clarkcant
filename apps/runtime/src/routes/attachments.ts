import {
  ATTACHMENT_LIMITS,
  redactSecrets,
  validateAttachmentCandidate,
} from "@clarkcant/contracts";
import {
  type Database,
  attachmentUsageForPrincipal,
  getAttachment,
  getConversation,
  insertAttachment,
} from "@clarkcant/storage";

import { attachmentRefFromRecord } from "../attachments.ts";
import { readBlob, sniffContentType, writeBlob } from "../blobs.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * Files a person attached, and the bytes they point at.
 *
 * The route owns its own HTTP: parsing the upload, mapping a refusal to a status, and the headers a
 * served attachment travels with. Every dependency is a parameter — the node fields it reads are named
 * in `AttachmentRouteDeps` rather than taken from a module global, so a route cannot be handed state it
 * was not given.
 */
export interface AttachmentRouteDeps {
  services: {
    runtime: { db: Database; identity: { ownerPrincipalId: string }; dataDir: string };
    /** Identifier minting, so an attachment id is the node's rather than this module's. */
    conductor: { newId: (prefix: string) => string };
  };
  request: GatewayRequest;
  segments: string[];
  at: () => string;
}

/**
 * Files a person attached, and the bytes they point at.
 *
 * Three properties, each of which a different route would lose:
 *
 * - **The bytes decide the type.** The declared content type is a claim, and `sniffContentType` is
 *   what makes it a fact; a mismatch is refused rather than stored under the type the client asked
 *   for, so nothing here can be served back as something executable.
 * - **A reference is not a location.** The answer carries `attachmentId` and a content-addressed
 *   `blobRef`, never the path on this node. The path stays in the row and is re-checked against the
 *   blob root before anything is opened.
 * - **A name is text a person typed.** It is redacted before it is stored as well as before it is
 *   returned, because that is where a credential turns up.
 */

export function handleAttachmentRoutes(deps: AttachmentRouteDeps): GatewayResponse {
  const { request, segments, at } = deps;
  const { runtime, conductor } = deps.services;
  const principalId = runtime.identity.ownerPrincipalId;

  if (segments.length === 1 && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;

    const conversationId = typeof parsed.value.conversationId === "string" ? parsed.value.conversationId : "";
    const filename = typeof parsed.value.filename === "string" ? parsed.value.filename : "";
    const mime = typeof parsed.value.mime === "string" ? parsed.value.mime : "";
    const contentBase64 = typeof parsed.value.contentBase64 === "string" ? parsed.value.contentBase64 : "";
    if (conversationId === "" || contentBase64 === "") {
      return fail(
        400,
        "INVALID_SCHEMA",
        "an upload needs a conversationId, a filename, a content type and contentBase64",
      );
    }
    if (getConversation(runtime.db, conversationId) === undefined) {
      return fail(404, "RESOURCE_NOT_FOUND", "that conversation is not on this node");
    }

    // Refused from the encoded length alone when that is already over the ceiling: a 100 MB base64
    // string should not become a 75 MB buffer just to find out it was too big.
    if (contentBase64.length > Math.ceil((ATTACHMENT_LIMITS.maxBytes * 4) / 3) + 1024) {
      return fail(413, "ATTACHMENT_TOO_LARGE", `a file must be at most ${ATTACHMENT_LIMITS.maxBytes} bytes`);
    }

    const bytes = Buffer.from(contentBase64, "base64");
    const sniffed = sniffContentType(bytes, mime);
    if (!sniffed.ok) return fail(415, sniffed.code, sniffed.message);

    const checked = validateAttachmentCandidate({
      filename,
      mime: sniffed.mime,
      sizeBytes: bytes.byteLength,
      usedBytes: attachmentUsageForPrincipal(runtime.db, principalId),
    });
    if (!checked.ok) return fail(attachmentRefusalStatus(checked.code), checked.code, checked.message);

    const written = writeBlob({ dataDir: runtime.dataDir, bytes, extension: sniffed.extension });
    const record = {
      attachmentId: conductor.newId("att"),
      principalId,
      conversationId,
      filename: redactSecrets(checked.filename),
      mime: checked.mime,
      kind: checked.kind,
      sizeBytes: bytes.byteLength,
      sha256: written.digest,
      blobPath: written.blobPath,
      createdAt: at(),
    };
    insertAttachment(runtime.db, record);
    return { status: 201, body: { attachmentRef: attachmentRefFromRecord(record) } };
  }

  const attachmentId = decodeURIComponent(segments[1] ?? "");
  if (attachmentId === "") {
    return fail(400, "INVALID_SCHEMA", "an attachment route must name an attachment");
  }

  if (segments.length === 2 && request.method === "GET") {
    const record = getAttachment(runtime.db, attachmentId, principalId);
    // One answer for "no such attachment" and "not yours": distinguishing them would make this route
    // a way to enumerate another principal's files.
    if (record === undefined) return fail(404, "RESOURCE_NOT_FOUND", "that attachment is not on this node");
    return json(200, { attachmentRef: attachmentRefFromRecord(record) });
  }

  if (segments.length === 3 && segments[2] === "content" && request.method === "GET") {
    const record = getAttachment(runtime.db, attachmentId, principalId);
    if (record === undefined) return fail(404, "RESOURCE_NOT_FOUND", "that attachment is not on this node");

    const blob = readBlob({ dataDir: runtime.dataDir, blobPath: record.blobPath });
    if (!blob.ok) {
      return fail(blob.code === "BLOB_MISSING" ? 410 : 500, blob.code, blob.message);
    }

    // Only a picture or text may render in place. A pdf opens as a download, and nothing in the
    // allowlist can become a document the browser would execute, which is what makes `inline` safe
    // here rather than merely convenient.
    const inline = record.kind === "image" || record.mime.startsWith("text/");
    return {
      status: 200,
      body: null,
      binary: {
        bytes: blob.bytes,
        contentType: record.mime,
        headers: {
          "x-content-type-options": "nosniff",
          "content-disposition": `${inline ? "inline" : "attachment"}; filename="${dispositionName(record.filename)}"`,
        },
      },
    };
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}

/** Which status a refusal deserves, so the mapping exists once rather than at each branch. */
function attachmentRefusalStatus(code: string): number {
  if (code === "ATTACHMENT_NAME_NOT_ALLOWED") return 400;
  if (code === "ATTACHMENT_TOO_LARGE") return 413;
  if (code === "ATTACHMENT_QUOTA_EXCEEDED") return 409;
  return 415;
}

/**
 * A file name safe to put in a header.
 *
 * Quotes, backslashes and line breaks are removed rather than escaped: a name is untrusted text, and
 * a header that can be broken out of is a response-splitting bug rather than a formatting problem.
 */
function dispositionName(filename: string): string {
  return filename.replaceAll(/["\\\r\n]/g, "").slice(0, 120);
}
