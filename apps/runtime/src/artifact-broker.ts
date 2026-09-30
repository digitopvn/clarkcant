import {
  ARTIFACT_EXTENSIONS,
  ARTIFACT_LIMITS,
  ARTIFACT_REF_VERSION,
  type ArtifactRef,
  type ArtifactRefusal,
  ARTIFACT_NOT_ON_NODE,
  type ArtifactRefusalCode,
  type AttachmentRef,
  type Instant,
  artifactAcceptMatches,
  checkArtifactRange,
  classifyAttachment,
  decideArtifactAccess,
  defaultArtifactName,
  normalizePickedType,
  redactSecrets,
  stripBidiControls,
  validateAttachmentCandidate,
} from "@clarkcant/contracts";
import {
  type BrokerArtifactRecord,
  type Database,
  artifactUsageForInstance,
  artifactUsageForPrincipal,
  attachmentUsageForInstance,
  attachmentUsageForPrincipal,
  blobStillReferenced,
  deleteArtifactsForConversation,
  deleteBrokerArtifact,
  extendArtifactGrant,
  getArtifactGrant,
  getAttachmentFromArtifact,
  getBrokerArtifact,
  instanceIsInConversation,
  insertAttachment,
  insertBrokerArtifact,
  listExpiredWorkingArtifacts,
  liveStagingRefs,
  putArtifactGrant,
  recordWorkingArtifactWrite,
  revokeArtifactGrant,
  sealWorkingArtifact,
  transaction,
} from "@clarkcant/storage";

import { readdirSync } from "node:fs";

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
  stagingDir,
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
 * - **One quota, and a share of it per widget.** An artifact's bytes count with the principal's attachments against
 *   `ATTACHMENT_LIMITS`, through `validateAttachmentCandidate` — the same arithmetic, not a copy of it — and one widget
 *   instance may hold at most `ARTIFACT_LIMITS.instanceQuotaBytes` of them, so a widget that saves often cannot leave
 *   the composer with no room. A widget frees its share with `discardArtifact`.
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

/**
 * Bytes one widget instance holds against its share: the files it made, and what it attached to a conversation from
 * them for as long as the conversation keeps the attachment. A file the person picked for it is not counted.
 */
export function storedBytesForInstance(db: Database, instanceId: string): number {
  return artifactUsageForInstance(db, instanceId) + attachmentUsageForInstance(db, instanceId);
}

/**
 * Refuse bytes that would take one widget instance past its share of the quota.
 *
 * Checked after the principal's quota, so a person whose whole quota is full is told that first: freeing space there is
 * theirs to do, whereas a widget over its own share is the widget's to fix, by discarding files it no longer needs.
 */
function checkInstanceQuota(db: Database, instanceId: string, addedBytes: number): ArtifactRefusal | undefined {
  const used = storedBytesForInstance(db, instanceId);
  if (used + addedBytes <= ARTIFACT_LIMITS.instanceQuotaBytes && (addedBytes > 0 || used < ARTIFACT_LIMITS.instanceQuotaBytes)) {
    return undefined;
  }
  return refuse(
    "ARTIFACT_INSTANCE_QUOTA_EXCEEDED",
    `this widget already holds ${used} of the ${ARTIFACT_LIMITS.instanceQuotaBytes} bytes one widget may keep; discard files it no longer needs with artifacts.discard`,
  );
}

/**
 * An attachment-pipeline refusal, as the widget hears it.
 *
 * The same code, and the same words except for a full quota: the pipeline's message names how many bytes the person
 * stores, which is the person's to know and not a widget's, so the widget is told only that the quota is full.
 */
function refuseAsAttachment(refusal: { code: string; message: string }): ArtifactRefusal {
  const code = fromAttachmentCode(refusal.code);
  if (code === "ARTIFACT_QUOTA_EXCEEDED") {
    return refuse(
      code,
      "the person's storage on this node is full, so these bytes were not stored and the widget's files are unchanged; the person can free space, and the widget can discard files it no longer needs with artifacts.discard",
    );
  }
  return refuse(code, refusal.message);
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
        : {
            ownerPrincipalId: record.ownerPrincipalId,
            state: record.state,
            expiresAt: record.expiresAt,
            kind: record.kind,
            instanceId: record.instanceId,
          },
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
  // What the person's system called the file, under the name this node uses for it; a generic type is left to the bytes.
  const sniffed = sniffContentType(input.bytes, normalizePickedType(input.mimeType, input.name));
  if (!sniffed.ok) return refuseAsAttachment(sniffed);
  if (!artifactAcceptMatches(input.accept, sniffed.mime)) {
    return refuse("ARTIFACT_TYPE_NOT_ACCEPTED", `the file is ${sniffed.mime}; the widget asked for ${input.accept.join(", ")}`);
  }
  const checked = validateAttachmentCandidate({
    // Without the characters that reverse how a name reads, so what is shown is what the file is called.
    filename: stripBidiControls(input.name),
    mime: sniffed.mime,
    sizeBytes: input.bytes.byteLength,
    usedBytes: storedBytesForPrincipal(deps.db, input.principalId),
  });
  // Not checked against the widget's share: the person chose this file, and the widget cannot discard it.
  if (!checked.ok) return refuseAsAttachment(checked);

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
  const suggested = stripBidiControls(input.name ?? "");
  const name = suggested.trim() === "" ? defaultArtifactName(mimeType) : suggested;
  const checked = validateAttachmentCandidate({
    filename: name,
    mime: mimeType,
    sizeBytes: 0,
    usedBytes: storedBytesForPrincipal(deps.db, input.principalId),
  });
  if (!checked.ok) return refuseAsAttachment(checked);
  // An empty artifact costs nothing, but one the widget could not write a byte to would only fail later.
  const overShare = checkInstanceQuota(deps.db, input.instanceId, 0);
  if (overShare !== undefined) return overShare;

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

/** Types whose bytes are text a model can be shown as an excerpt. Everything else is described, never quoted. */
const EXCERPT_TYPES: ReadonlySet<string> = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

/** How much of a text file an agent button's context quotes, in bytes, before the per-reference character clip. */
export const ARTIFACT_CONTEXT_EXCERPT_BYTES = 3_000;

export interface ArtifactContextRead {
  ref: ArtifactRef;
  /** The start of a text file, decoded; absent for a type that is not text. */
  excerpt?: { text: string; bytes: number; complete: boolean };
}

/**
 * What an agent button's `artifact:<id>` reference reads: the file's name, type and size, and for a text file the start
 * of its contents.
 *
 * The same decision as every other use of a ref, for the instance whose button was pressed — its grant, the principal,
 * the conversation — and nothing more: a button cannot read a file its widget could not. The artifact must belong to
 * the conversation the press happened in, and the instance must be one that conversation holds, so a reference cannot
 * carry a file from one conversation into another's turn. Bounded twice: a fixed number of bytes is read, never the
 * whole file, and the caller clips the rendered text again.
 */
export function readArtifactForContext(
  deps: ArtifactBrokerDeps,
  input: { principalId: string; instanceId: string; conversationId: string; artifactId: string },
): BrokerResult<ArtifactContextRead> {
  const allowed = authorize(deps, { ...input, need: "read" });
  if (!allowed.ok) return allowed;
  const { record } = allowed;
  if (
    record.conversationId !== input.conversationId ||
    !instanceIsInConversation(deps.db, { conversationId: input.conversationId, instanceId: input.instanceId })
  ) {
    return refuse("ARTIFACT_NOT_GRANTED", "that artifact belongs to another conversation");
  }
  const ref = artifactRefFromRecord(record);
  if (!EXCERPT_TYPES.has(record.mimeType)) return { ok: true, ref };
  if (record.sizeBytes === 0) return { ok: true, ref, excerpt: { text: "", bytes: 0, complete: true } };

  const length = Math.min(record.sizeBytes, ARTIFACT_CONTEXT_EXCERPT_BYTES);
  const read = readArtifactRange(deps, { ...input, offset: 0, length });
  if (!read.ok) return read;
  // Streaming decode, so a cut through the middle of a character leaves that character out instead of a U+FFFD.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(read.bytes, { stream: !read.eof });
  return { ok: true, ref, excerpt: { text, bytes: read.bytes.byteLength, complete: read.eof } };
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
  if (!quota.ok) return refuseAsAttachment(quota);
  const overShare = checkInstanceQuota(deps.db, input.instanceId, input.bytes.byteLength);
  if (overShare !== undefined) return overShare;
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

/** Types an empty working artifact may be finalized as. */
const EMPTY_TEXT_TYPES: ReadonlySet<string> = new Set(["text/plain", "text/markdown", "text/csv"]);

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
  /*
   * An empty text file is a real file — a cleared note, a CSV with no rows yet — and text has no magic bytes to sniff, so
   * an empty one is taken as the text type it was created as. An empty picture or PDF is not a picture or a PDF, and the
   * sniff refuses it as before.
   */
  const emptyText = staged.bytes.byteLength === 0 && EMPTY_TEXT_TYPES.has(record.mimeType);
  const sniffed = emptyText
    ? { ok: true as const, mime: record.mimeType, extension: ARTIFACT_EXTENSIONS[record.mimeType]?.[0] ?? "txt" }
    : sniffContentType(staged.bytes, record.mimeType);
  if (!sniffed.ok) return refuseAsAttachment(sniffed);
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
  if (finalized === undefined) return refuse("ARTIFACT_NOT_FOUND", ARTIFACT_NOT_ON_NODE);
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
  if (record === undefined) return refuse("ARTIFACT_NOT_FOUND", ARTIFACT_NOT_ON_NODE);
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
 *
 * A file is attached once: asking again returns the attachment already made, since a finalized file's bytes cannot
 * change. The attachment counts against the widget's share as well as the person's quota, and keeps counting after the
 * widget discards the file, because the conversation still keeps the bytes. Without both, one finalized file attached
 * over and over would fill the person's quota with copies of itself.
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
  const existing = getAttachmentFromArtifact(deps.db, record.artifactId, input.principalId);
  if (existing !== undefined) {
    return { ok: true, ref: artifactRefFromRecord(record), attachmentRef: attachmentRefFromRecord(existing) };
  }
  const blob = readBlob({ dataDir: deps.dataDir, blobPath: record.blobPath });
  if (!blob.ok) return refuse("ARTIFACT_BYTES_MISSING", blob.message);
  const sniffed = sniffContentType(blob.bytes, record.mimeType);
  if (!sniffed.ok) return refuseAsAttachment(sniffed);
  const checked = validateAttachmentCandidate({
    filename: record.name,
    mime: sniffed.mime,
    sizeBytes: blob.bytes.byteLength,
    usedBytes: storedBytesForPrincipal(deps.db, input.principalId),
  });
  if (!checked.ok) return refuseAsAttachment(checked);
  const overShare = checkInstanceQuota(deps.db, input.instanceId, blob.bytes.byteLength);
  if (overShare !== undefined) return overShare;
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
    sourceArtifactId: record.artifactId,
    sourceInstanceId: input.instanceId,
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
  if (record === undefined) return refuse("ARTIFACT_NOT_FOUND", ARTIFACT_NOT_ON_NODE);
  if (record.ownerPrincipalId !== input.principalId) {
    return refuse("ARTIFACT_CROSS_PRINCIPAL", "that artifact belongs to another principal");
  }
  return {
    ok: true,
    revoked: revokeArtifactGrant(deps.db, { artifactId: input.artifactId, instanceId: input.instanceId, at: iso(deps.now()) }),
  };
}

/**
 * Let go of a file the widget made: its row, its grants, and the bytes nothing else points at.
 *
 * Only the instance that created a working or finalized artifact may discard it, and only while the person has not
 * taken its access away. A file the person chose (`external`) is not the widget's to delete; neither is one another
 * widget made. A file the widget attached to the conversation stays attached — the attachment points at the same bytes,
 * so they are kept — and a file the person saved stays where they saved it.
 */
export function discardArtifact(
  deps: ArtifactBrokerDeps,
  input: { principalId: string; instanceId: string; artifactId: string },
): BrokerResult<object> {
  const record = getBrokerArtifact(deps.db, input.artifactId);
  if (record === undefined) return refuse("ARTIFACT_NOT_FOUND", ARTIFACT_NOT_ON_NODE);
  if (record.ownerPrincipalId !== input.principalId) {
    return refuse("ARTIFACT_CROSS_PRINCIPAL", "that artifact belongs to another principal");
  }
  if (record.instanceId !== input.instanceId || (record.kind !== "working" && record.kind !== "finalized")) {
    return refuse(
      "ARTIFACT_NOT_CREATOR",
      record.kind === "external"
        ? "a file the person chose is theirs; a widget cannot discard it"
        : "only the widget that made a file can discard it",
    );
  }
  const grant = getArtifactGrant(deps.db, record.artifactId, input.instanceId);
  if (grant?.revokedAt !== undefined) {
    return refuse("ARTIFACT_GRANT_REVOKED", "this widget's access to that artifact was revoked");
  }
  deleteBrokerArtifact(deps.db, record.artifactId);
  // The widget's own file: only its conversation's transcript can hold a frame of the same bytes (`blobStillReferenced`).
  releaseBytes(
    deps,
    record.blobPath === undefined ? [] : [record.blobPath],
    record.stagingRef === undefined ? [] : [record.stagingRef],
    record.conversationId,
  );
  return { ok: true };
}

/** Remove bytes nobody points at any more. A blob another row shares is left where it is. */
function releaseBytes(
  deps: Pick<ArtifactBrokerDeps, "db" | "dataDir">,
  blobPaths: readonly string[],
  stagingRefs: readonly string[],
  messagesOf?: string,
): void {
  for (const stagingRef of stagingRefs) removeStagedBlob({ dataDir: deps.dataDir, stagingRef });
  for (const blobPath of new Set(blobPaths)) {
    if (!blobStillReferenced(deps.db, blobPath, messagesOf === undefined ? {} : { messagesOf })) {
      removeBlob({ dataDir: deps.dataDir, blobPath });
    }
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
 * Remove staged files no writable artifact points at.
 *
 * Run once when the node starts. A node that stopped between creating a staging file and recording its row, or between
 * sealing one and clearing the row's staging name, leaves a file in `blobs/staging/` nothing will ever read or sweep;
 * this is what takes it away. A file whose name is not one the node makes is left alone: it is not the node's to judge.
 */
export function sweepOrphanedStaging(deps: Pick<ArtifactBrokerDeps, "db" | "dataDir">): { removed: number } {
  let entries: string[];
  try {
    entries = readdirSync(stagingDir(deps.dataDir));
  } catch {
    return { removed: 0 };
  }
  const live = liveStagingRefs(deps.db);
  let removed = 0;
  for (const entry of entries) {
    if (live.has(entry)) continue;
    if (removeStagedBlob({ dataDir: deps.dataDir, stagingRef: entry })) removed += 1;
  }
  return { removed };
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
 *
 * Before the first interval, once: staged files a previous process left behind (`sweepOrphanedStaging`). That runs
 * here, at start, because only then can no widget be half-way through creating one.
 */
export function startArtifactSweep(
  deps: Pick<ArtifactBrokerDeps, "db" | "dataDir">,
  options: { intervalMs?: number; now?: () => Date } = {},
): { stop: () => void } {
  const now = options.now ?? ((): Date => new Date());
  try {
    sweepOrphanedStaging(deps);
  } catch (cause) {
    process.stderr.write(
      `artifact sweep: could not clear leftover staged files (${cause instanceof Error ? cause.message : String(cause)}); they stay on disk until the next start\n`,
    );
  }
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
