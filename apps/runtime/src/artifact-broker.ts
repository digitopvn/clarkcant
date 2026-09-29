import {
  ARTIFACT_LIMITS,
  ARTIFACT_REF_VERSION,
  type ArtifactRef,
  type ArtifactRefusal,
  type ArtifactRefusalCode,
  type AttachmentRef,
  type Instant,
  artifactAcceptMatches,
  checkArtifactRange,
  classifyAttachment,
  decideArtifactAccess,
  defaultArtifactName,
  redactSecrets,
  validateAttachmentCandidate,
} from "@clarkcant/contracts";
import {
  type BrokerArtifactRecord,
  type Database,
  artifactUsageForPrincipal,
  attachmentUsageForPrincipal,
  blobStillReferenced,
  deleteArtifactsForConversation,
  deleteBrokerArtifact,
  extendArtifactGrant,
  getArtifactGrant,
  getBrokerArtifact,
  insertAttachment,
  insertBrokerArtifact,
  listExpiredWorkingArtifacts,
  putArtifactGrant,
  recordWorkingArtifactWrite,
  revokeArtifactGrant,
  sealWorkingArtifact,
  transaction,
} from "@clarkcant/storage";

import { attachmentRefFromRecord } from "./attachments.ts";
import {
  appendStagedBlob,
  createStagedBlob,
  readBlob,
  readBlobRange,
  readStagedBlob,
  removeBlob,
  removeStagedBlob,
  sealStagedBlob,
  sniffContentType,
  writeBlob,
} from "./blobs.ts";

/**
 * The ArtifactRef broker.
 *
 * Every operation a widget can ask for on a file — read a range, create, write a chunk, finalize, hand one to the
 * conversation — is one function here, and every one of them starts by re-deciding access with
 * `decideArtifactAccess`. A ref a widget holds is a pointer; the grant row is the permission, and it is read again on
 * each use so an expired or revoked grant takes effect on the next call rather than the next mount.
 *
 * Three properties the functions keep between them:
 *
 * - **Bytes only through the blob store.** Staged writes, sealing and ranged reads are `blobs.ts`'s, so there is one
 *   writer with one naming scheme and one containment check.
 * - **One quota.** An artifact's bytes count with the principal's attachments against `ATTACHMENT_LIMITS`, through
 *   `validateAttachmentCandidate` — the same arithmetic, not a copy of it.
 * - **Nothing leaves that names a place.** A result carries an `ArtifactRef` or bytes; never a blob path, a staging
 *   name or where a picked file was read from.
 */

export interface ArtifactBrokerDeps {
  db: Database;
  dataDir: string;
  nodeId: string;
  newId: (prefix: string) => string;
  now: () => Date;
}

export type BrokerResult<T> = ({ ok: true } & T) | ArtifactRefusal;

function refuse(code: ArtifactRefusalCode, message: string): ArtifactRefusal {
  return { ok: false, code, message };
}

function iso(date: Date): Instant {
  return date.toISOString() as Instant;
}

/** The ref a widget is shown. Built from the row, and deliberately from nothing that says where the bytes are. */
export function artifactRefFromRecord(record: BrokerArtifactRecord): ArtifactRef {
  return {
    v: ARTIFACT_REF_VERSION,
    artifactId: record.artifactId,
    kind: record.kind,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    name: record.name,
    ...(record.digest === undefined ? {} : { digest: record.digest }),
  } as ArtifactRef;
}

/** Bytes this principal already stores, attachments and artifacts together: the one number the quota is read from. */
export function storedBytesForPrincipal(db: Database, principalId: string): number {
  return attachmentUsageForPrincipal(db, principalId) + artifactUsageForPrincipal(db, principalId);
}

/** Map an attachment-pipeline refusal to the artifact refusal with the same meaning. */
function fromAttachmentCode(code: string): ArtifactRefusalCode {
  switch (code) {
    case "ATTACHMENT_NAME_NOT_ALLOWED":
      return "ARTIFACT_NAME_NOT_ALLOWED";
    case "ATTACHMENT_TOO_LARGE":
      return "ARTIFACT_TOO_LARGE";
    case "ATTACHMENT_QUOTA_EXCEEDED":
      return "ARTIFACT_QUOTA_EXCEEDED";
    case "ATTACHMENT_TYPE_MISMATCH":
      return "ARTIFACT_TYPE_MISMATCH";
    default:
      return "ARTIFACT_TYPE_UNSUPPORTED";
  }
}

/**
 * Load an artifact and decide whether this instance may use it for this purpose.
 *
 * The one gate every operation goes through. An expired working artifact is refused here as expired even before the
 * sweep has taken its bytes off the disk, so the refusal never depends on when the sweep last ran.
 */
function authorize(
  deps: ArtifactBrokerDeps,
  input: { principalId: string; instanceId: string; artifactId: string; need: "read" | "write" },
): BrokerResult<{ record: BrokerArtifactRecord }> {
  const record = getBrokerArtifact(deps.db, input.artifactId);
  const decision = decideArtifactAccess({
    principalId: input.principalId,
    instanceId: input.instanceId,
    need: input.need,
    artifact:
      record === undefined
        ? undefined
        : { ownerPrincipalId: record.ownerPrincipalId, state: record.state, expiresAt: record.expiresAt },
    grant: record === undefined ? undefined : getArtifactGrant(deps.db, record.artifactId, input.instanceId),
    nowMs: deps.now().getTime(),
  });
  if (!decision.ok) return decision;
  // `decideArtifactAccess` refused an absent artifact, so a record is present here.
  return { ok: true, record: record as BrokerArtifactRecord };
}

/**
 * Store a file the person picked through host chrome, and grant it to the widget that asked.
 *
 * The bytes decide the type (`sniffContentType`), the widget's accept list is checked against what the bytes are
 * rather than what they were declared as, and the name, size and quota are the attachment pipeline's rules. The
 * artifact is `external` and sealed: a snapshot, with where it was read from held only by the host that read it.
 */
export function storePickedArtifact(
  deps: ArtifactBrokerDeps,
  input: {
    principalId: string;
    conversationId: string;
    instanceId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    accept: readonly string[];
  },
): BrokerResult<{ ref: ArtifactRef }> {
  sweepExpiredArtifacts(deps);
  if (input.bytes.byteLength > ARTIFACT_LIMITS.maxBytes) {
    return refuse("ARTIFACT_TOO_LARGE", `a file must be at most ${ARTIFACT_LIMITS.maxBytes} bytes`);
  }
  const sniffed = sniffContentType(input.bytes, input.mimeType);
  if (!sniffed.ok) return refuse(fromAttachmentCode(sniffed.code), sniffed.message);
  if (!artifactAcceptMatches(input.accept, sniffed.mime)) {
    return refuse("ARTIFACT_TYPE_NOT_ACCEPTED", `the file is ${sniffed.mime}; the widget asked for ${input.accept.join(", ")}`);
  }
  const checked = validateAttachmentCandidate({
    filename: input.name,
    mime: sniffed.mime,
    sizeBytes: input.bytes.byteLength,
    usedBytes: storedBytesForPrincipal(deps.db, input.principalId),
  });
  if (!checked.ok) return refuse(fromAttachmentCode(checked.code), checked.message);

  const written = writeBlob({ dataDir: deps.dataDir, bytes: input.bytes, extension: sniffed.extension });
  const now = deps.now();
  const record: BrokerArtifactRecord = {
    artifactId: deps.newId("art"),
    ownerPrincipalId: input.principalId,
    kind: "external",
    state: "sealed",
    conversationId: input.conversationId,
    instanceId: input.instanceId,
    name: redactSecrets(checked.filename),
    mimeType: checked.mime,
    sizeBytes: input.bytes.byteLength,
    digest: written.digest,
    blobPath: written.blobPath,
    stagingRef: undefined,
    createdAt: iso(now),
    expiresAt: undefined,
  };
  transaction(deps.db, () => {
    insertBrokerArtifact(deps.db, { ...record, originNodeId: deps.nodeId });
    putArtifactGrant(deps.db, {
      artifactId: record.artifactId,
      instanceId: input.instanceId,
      principalId: input.principalId,
      access: "read",
      createdAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + ARTIFACT_LIMITS.grantTtlMs)),
    });
  });
  return { ok: true, ref: artifactRefFromRecord(record) };
}

/** Start an empty working artifact the creating instance may write. */
export function createWorkingArtifact(
  deps: ArtifactBrokerDeps,
  input: { principalId: string; conversationId: string; instanceId: string; mimeType: string; name?: string | undefined },
): BrokerResult<{ ref: ArtifactRef }> {
  sweepExpiredArtifacts(deps);
  const mimeType = input.mimeType.trim().toLowerCase();
  if (classifyAttachment({ mime: mimeType }) === undefined) {
    return refuse("ARTIFACT_TYPE_UNSUPPORTED", `${mimeType === "" ? "an empty content type" : mimeType} is not a type a widget may create`);
  }
  const name = input.name === undefined || input.name.trim() === "" ? defaultArtifactName(mimeType) : input.name;
  const checked = validateAttachmentCandidate({
    filename: name,
    mime: mimeType,
    sizeBytes: 0,
    usedBytes: storedBytesForPrincipal(deps.db, input.principalId),
  });
  if (!checked.ok) return refuse(fromAttachmentCode(checked.code), checked.message);

  const now = deps.now();
  const artifactId = deps.newId("art");
  const stagingRef = `${artifactId}.part`;
  const staged = createStagedBlob({ dataDir: deps.dataDir, stagingRef });
  if (!staged.ok) return refuse("ARTIFACT_BYTES_MISSING", staged.message);
  const record: BrokerArtifactRecord = {
    artifactId,
    ownerPrincipalId: input.principalId,
    kind: "working",
    state: "writable",
    conversationId: input.conversationId,
    instanceId: input.instanceId,
    name: redactSecrets(checked.filename),
    mimeType: checked.mime,
    sizeBytes: 0,
    digest: undefined,
    blobPath: undefined,
    stagingRef,
    createdAt: iso(now),
    expiresAt: iso(new Date(now.getTime() + ARTIFACT_LIMITS.workingTtlMs)),
  };
  transaction(deps.db, () => {
    insertBrokerArtifact(deps.db, { ...record, originNodeId: deps.nodeId });
    putArtifactGrant(deps.db, {
      artifactId,
      instanceId: input.instanceId,
      principalId: input.principalId,
      access: "write",
      createdAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + ARTIFACT_LIMITS.grantTtlMs)),
    });
  });
  return { ok: true, ref: artifactRefFromRecord(record) };
}

/** What a widget may learn about an artifact it holds: its ref, re-checked. */
export function describeArtifact(
  deps: ArtifactBrokerDeps,
  input: { principalId: string; instanceId: string; artifactId: string },
): BrokerResult<{ ref: ArtifactRef }> {
  const allowed = authorize(deps, { ...input, need: "read" });
  if (!allowed.ok) return allowed;
  return { ok: true, ref: artifactRefFromRecord(allowed.record) };
}

/** One bounded range of an artifact's bytes. */
export function readArtifactRange(
  deps: ArtifactBrokerDeps,
  input: { principalId: string; instanceId: string; artifactId: string; offset: unknown; length: unknown },
): BrokerResult<{ ref: ArtifactRef; bytes: Uint8Array; offset: number; eof: boolean }> {
  const allowed = authorize(deps, { ...input, need: "read" });
  if (!allowed.ok) return allowed;
  const { record } = allowed;
  const range = checkArtifactRange({ offset: input.offset, length: input.length, sizeBytes: record.sizeBytes });
  if (!range.ok) return range;
  const location =
    record.state === "writable" && record.stagingRef !== undefined
      ? { stagingRef: record.stagingRef }
      : record.blobPath !== undefined
        ? { blobPath: record.blobPath }
        : undefined;
  if (location === undefined) return refuse("ARTIFACT_BYTES_MISSING", "that artifact's bytes are not on this node");
  const read = readBlobRange({ dataDir: deps.dataDir, location, offset: range.offset, length: range.length });
  if (!read.ok) return refuse("ARTIFACT_BYTES_MISSING", read.message);
  return { ok: true, ref: artifactRefFromRecord(record), bytes: read.bytes, offset: range.offset, eof: range.eof };
}

/**
 * Append one chunk to a working artifact.
 *
 * `offset` is the length the writer believes the artifact has, so a chunk sent twice or out of order is refused
 * instead of stored twice. The chunk size, the artifact ceiling and the quota are checked before a byte is written, and
 * each write extends both the artifact's life and the writer's grant: a widget that is still writing is not cut off.
 */
export function appendArtifactChunk(
  deps: ArtifactBrokerDeps,
  input: { principalId: string; instanceId: string; artifactId: string; offset: unknown; bytes: Uint8Array },
): BrokerResult<{ ref: ArtifactRef }> {
  const allowed = authorize(deps, { ...input, need: "write" });
  if (!allowed.ok) return allowed;
  const { record } = allowed;
  if (input.bytes.byteLength > ARTIFACT_LIMITS.chunkBytes) {
    return refuse("ARTIFACT_CHUNK_TOO_LARGE", `one chunk may be at most ${ARTIFACT_LIMITS.chunkBytes} bytes`);
  }
  if (typeof input.offset !== "number" || !Number.isInteger(input.offset) || input.offset < 0) {
    return refuse("ARTIFACT_RANGE_INVALID", "offset must be a non-negative integer");
  }
  if (input.offset !== record.sizeBytes) {
    return refuse(
      "ARTIFACT_OFFSET_MISMATCH",
      `the artifact is ${record.sizeBytes} bytes long, so a chunk for offset ${input.offset} does not follow it`,
    );
  }
  const nextSize = record.sizeBytes + input.bytes.byteLength;
  if (nextSize > ARTIFACT_LIMITS.maxBytes) {
    return refuse("ARTIFACT_TOO_LARGE", `an artifact may be at most ${ARTIFACT_LIMITS.maxBytes} bytes`);
  }
  // The artifact's own bytes are already in the usage; only the new chunk is added to it.
  const quota = validateAttachmentCandidate({
    filename: record.name,
    mime: record.mimeType,
    sizeBytes: input.bytes.byteLength,
    usedBytes: storedBytesForPrincipal(deps.db, input.principalId),
  });
  if (!quota.ok) return refuse(fromAttachmentCode(quota.code), quota.message);
  if (record.stagingRef === undefined) return refuse("ARTIFACT_BYTES_MISSING", "that artifact has no staged bytes");

  const appended = appendStagedBlob({
    dataDir: deps.dataDir,
    stagingRef: record.stagingRef,
    expectedSize: record.sizeBytes,
    bytes: input.bytes,
  });
  if (!appended.ok) {
    return refuse(appended.code === "STAGING_OFFSET_MISMATCH" ? "ARTIFACT_OFFSET_MISMATCH" : "ARTIFACT_BYTES_MISSING", appended.message);
  }
  const now = deps.now();
  const expiresAt = iso(new Date(now.getTime() + ARTIFACT_LIMITS.workingTtlMs));
  transaction(deps.db, () => {
    recordWorkingArtifactWrite(deps.db, { artifactId: record.artifactId, sizeBytes: appended.sizeBytes, expiresAt });
    extendArtifactGrant(deps.db, {
      artifactId: record.artifactId,
      instanceId: input.instanceId,
      expiresAt: iso(new Date(now.getTime() + ARTIFACT_LIMITS.grantTtlMs)),
    });
  });
  return { ok: true, ref: artifactRefFromRecord({ ...record, sizeBytes: appended.sizeBytes, expiresAt }) };
}

/**
 * Fix a working artifact's bytes.
 *
 * The bytes are sniffed against the type the artifact was created with, and a disagreement is refused with the
 * artifact left writable, so the widget can correct it: a markdown document that turned out to be a PNG is a bug to
 * report, not a file to store under the wrong type.
 */
export function finalizeArtifact(
  deps: ArtifactBrokerDeps,
  input: { principalId: string; instanceId: string; artifactId: string },
): BrokerResult<{ ref: ArtifactRef }> {
  const allowed = authorize(deps, { ...input, need: "write" });
  if (!allowed.ok) return allowed;
  const { record } = allowed;
  if (record.stagingRef === undefined) return refuse("ARTIFACT_BYTES_MISSING", "that artifact has no staged bytes");
  const staged = readStagedBlob({ dataDir: deps.dataDir, stagingRef: record.stagingRef });
  if (!staged.ok) return refuse("ARTIFACT_BYTES_MISSING", staged.message);
  const sniffed = sniffContentType(staged.bytes, record.mimeType);
  if (!sniffed.ok) return refuse(fromAttachmentCode(sniffed.code), sniffed.message);
  if (sniffed.mime !== record.mimeType) {
    return refuse("ARTIFACT_TYPE_MISMATCH", `the bytes are ${sniffed.mime} but the artifact was created as ${record.mimeType}`);
  }
  const sealed = sealStagedBlob({ dataDir: deps.dataDir, stagingRef: record.stagingRef, extension: sniffed.extension });
  if (!sealed.ok) return refuse("ARTIFACT_BYTES_MISSING", sealed.message);
  sealWorkingArtifact(deps.db, {
    artifactId: record.artifactId,
    digest: sealed.digest,
    blobPath: sealed.blobPath,
    sizeBytes: sealed.sizeBytes,
    mimeType: sniffed.mime,
  });
  const finalized = getBrokerArtifact(deps.db, record.artifactId);
  if (finalized === undefined) return refuse("ARTIFACT_NOT_FOUND", "that artifact is not on this node");
  return { ok: true, ref: artifactRefFromRecord(finalized) };
}

/**
 * The bytes of an artifact the person is saving.
 *
 * Reached only from a person-only route (`isPersonOnlyRoute`): Save As is the person's act, so the check here is
 * ownership and sealed bytes, not a widget's grant. A working artifact is refused because its bytes may still change
 * under the file the person thinks they saved.
 */
export function exportArtifactBytes(
  deps: ArtifactBrokerDeps,
  input: { principalId: string; artifactId: string },
): BrokerResult<{ ref: ArtifactRef; bytes: Uint8Array }> {
  const record = getBrokerArtifact(deps.db, input.artifactId);
  if (record === undefined) return refuse("ARTIFACT_NOT_FOUND", "that artifact is not on this node");
  if (record.ownerPrincipalId !== input.principalId) {
    return refuse("ARTIFACT_CROSS_PRINCIPAL", "that artifact belongs to another principal");
  }
  if (record.state !== "sealed" || record.blobPath === undefined) {
    return refuse("ARTIFACT_NOT_FINALIZED", "a working artifact is finalized before it can be saved");
  }
  const blob = readBlob({ dataDir: deps.dataDir, blobPath: record.blobPath });
  if (!blob.ok) return refuse("ARTIFACT_BYTES_MISSING", blob.message);
  return { ok: true, ref: artifactRefFromRecord(record), bytes: blob.bytes };
}

/**
 * Hand a finalized artifact to the conversation, as an attachment.
 *
 * Through the attachment pipeline, not beside it: the bytes are sniffed again, the name, type allowlist, size and
 * quota are `validateAttachmentCandidate`'s, and the row is an ordinary attachment, so the model reads it exactly as
 * it reads a file the person attached — the attachment brief, or `read_attachment`. The blob is shared, since the
 * store is content-addressed; retention removes it only once no row points at it.
 */
export function attachArtifact(
  deps: ArtifactBrokerDeps,
  input: { principalId: string; instanceId: string; artifactId: string },
): BrokerResult<{ ref: ArtifactRef; attachmentRef: AttachmentRef }> {
  const allowed = authorize(deps, { ...input, need: "read" });
  if (!allowed.ok) return allowed;
  const { record } = allowed;
  if (record.state !== "sealed" || record.blobPath === undefined || record.digest === undefined) {
    return refuse("ARTIFACT_NOT_FINALIZED", "finalize the artifact before attaching it to the conversation");
  }
  const blob = readBlob({ dataDir: deps.dataDir, blobPath: record.blobPath });
  if (!blob.ok) return refuse("ARTIFACT_BYTES_MISSING", blob.message);
  const sniffed = sniffContentType(blob.bytes, record.mimeType);
  if (!sniffed.ok) return refuse(fromAttachmentCode(sniffed.code), sniffed.message);
  const checked = validateAttachmentCandidate({
    filename: record.name,
    mime: sniffed.mime,
    sizeBytes: blob.bytes.byteLength,
    usedBytes: storedBytesForPrincipal(deps.db, input.principalId),
  });
  if (!checked.ok) return refuse(fromAttachmentCode(checked.code), checked.message);
  const attachment = {
    attachmentId: deps.newId("att"),
    principalId: input.principalId,
    conversationId: record.conversationId,
    filename: redactSecrets(checked.filename),
    mime: checked.mime,
    kind: checked.kind,
    sizeBytes: blob.bytes.byteLength,
    sha256: record.digest,
    blobPath: record.blobPath,
    createdAt: iso(deps.now()),
  };
  insertAttachment(deps.db, attachment);
  return { ok: true, ref: artifactRefFromRecord(record), attachmentRef: attachmentRefFromRecord(attachment) };
}

/** Take one instance's access to an artifact away. The person's act, and it takes effect on the widget's next use. */
export function revokeArtifactAccess(
  deps: ArtifactBrokerDeps,
  input: { principalId: string; instanceId: string; artifactId: string },
): BrokerResult<{ revoked: boolean }> {
  const record = getBrokerArtifact(deps.db, input.artifactId);
  if (record === undefined) return refuse("ARTIFACT_NOT_FOUND", "that artifact is not on this node");
  if (record.ownerPrincipalId !== input.principalId) {
    return refuse("ARTIFACT_CROSS_PRINCIPAL", "that artifact belongs to another principal");
  }
  return {
    ok: true,
    revoked: revokeArtifactGrant(deps.db, { artifactId: input.artifactId, instanceId: input.instanceId, at: iso(deps.now()) }),
  };
}

/** Remove bytes nobody points at any more. A blob another row shares is left where it is. */
function releaseBytes(deps: Pick<ArtifactBrokerDeps, "db" | "dataDir">, blobPaths: readonly string[], stagingRefs: readonly string[]): void {
  for (const stagingRef of stagingRefs) removeStagedBlob({ dataDir: deps.dataDir, stagingRef });
  for (const blobPath of new Set(blobPaths)) {
    if (!blobStillReferenced(deps.db, blobPath)) removeBlob({ dataDir: deps.dataDir, blobPath });
  }
}

/**
 * Remove working artifacts whose time ran out.
 *
 * An expired artifact is already refused by `decideArtifactAccess`; this is what takes its row and bytes away, on the
 * node's periodic sweep (`startArtifactSweep`) and before a new artifact is stored, so the quota a new one is checked
 * against never counts bytes that have already run out.
 */
export function sweepExpiredArtifacts(deps: Pick<ArtifactBrokerDeps, "db" | "dataDir" | "now">): { removed: number } {
  const expired = listExpiredWorkingArtifacts(deps.db, iso(deps.now()));
  for (const record of expired) {
    deleteBrokerArtifact(deps.db, record.artifactId);
    releaseBytes(deps, [], record.stagingRef === undefined ? [] : [record.stagingRef]);
  }
  return { removed: expired.length };
}

/**
 * Delete a conversation's artifacts and the bytes nothing else points at.
 *
 * What a conversation-delete policy calls, with `releaseConversationAttachments`; finalized artifacts follow their
 * conversation, so this is their end of life.
 */
export function releaseConversationArtifacts(deps: {
  db: Database;
  dataDir: string;
  conversationId: string;
}): { removed: number } {
  const deleted = deleteArtifactsForConversation(deps.db, deps.conversationId);
  releaseBytes(deps, deleted.blobPaths, deleted.stagingRefs);
  return { removed: deleted.removed };
}

/**
 * Start the periodic sweep of expired working artifacts. Unref'd and stopped by the caller when the node closes, like
 * every other background interval on this node.
 */
export function startArtifactSweep(
  deps: Pick<ArtifactBrokerDeps, "db" | "dataDir">,
  options: { intervalMs?: number; now?: () => Date } = {},
): { stop: () => void } {
  const now = options.now ?? ((): Date => new Date());
  const timer = setInterval(() => {
    try {
      sweepExpiredArtifacts({ ...deps, now });
    } catch (cause) {
      process.stderr.write(
        `artifact sweep: could not run (${cause instanceof Error ? cause.message : String(cause)})\n`,
      );
    }
  }, options.intervalMs ?? 10 * 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
