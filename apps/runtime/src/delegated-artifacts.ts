import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

import {
  type ArtifactOffer,
  type DelegatedArtifact,
  type Grant,
  type Instant,
  type MessageBlock,
  type PeerEnvelope,
  type TaskRecord,
  DELEGATED_ARTIFACT_MAX_BYTES,
  DELEGATED_ARTIFACTS_MAX,
  DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES,
  artifactDigestSchema,
  artifactOfferSchema,
  checkArtifactAcceptance,
  isTerminal,
  mimeTypePermitted,
  peerTextAsData,
} from "@clarkcant/contracts";
import { recordEvidence } from "@clarkcant/core";
import { sendEnvelope } from "@clarkcant/node-link";
import {
  type Database,
  type TaskArtifact,
  getGrant,
  getPeer,
  getPersistentIntent,
  getTask,
  getTaskArtifact,
  insertTaskArtifact,
  listAcceptedTaskArtifacts,
  listTaskArtifacts,
  livePeerAllowance,
  nextOutboundSequence,
  settleReceivedTaskArtifact,
  upsertArtifact,
} from "@clarkcant/storage";

import { extensionForMimeType, fetchArtifactFromPeer } from "./artifact-transfer.ts";
import { writeBlob } from "./blobs.ts";
import type { NodeIdentity } from "./node.ts";
import { outboundPeerToken } from "./peers.ts";
import type { TaskOutputFile } from "./task-dispatch.ts";

/**
 * The files a task handed to a paired node brings back.
 *
 * The node that ran the task offers each file its worker wrote, one `artifact.offer` per file, queued before its
 * `result` so every offer has been decided by the time the result is read. It offers files only when both owners said
 * so: the grant the task arrived under names a byte budget for files (`maxArtifactBytes`), and this node's owner's own
 * allowance for that peer names one too and covers the data class the files go back as. It offers only what it can
 * still vouch for — the file as the worker last wrote it, by digest — within the smaller of the two budgets and fixed
 * bounds on count and bytes, and never a type the other node always refuses; so nothing is copied into its blob store
 * that the other node was never going to take. It serves the bytes of a file only to the node it offered that file to.
 *
 * The node that handed the task over decides each offer against its own owner's grant for that task, the one the
 * automation was set up with: its byte budget (`maxArtifactBytes`), counted across the task, its data classes, and the
 * file types it takes. A grant that sets no byte budget takes no files. The node that ran the task never decides that
 * for it. Accepted bytes are pulled after the offer is acknowledged, checked against their digest, stored as a blob,
 * recorded as an artifact from that peer, attached to the task's run as evidence, and shown where the result is said.
 */

/**
 * The file types a node takes from a peer for a task it handed over, on top of the contract's own refusal of
 * executable, script and markup types. The node that ran the task checks the same before it offers anything.
 */
const RECEIVABLE_MIME_PREFIXES = ["text/", "image/", "application/"];

/**
 * The data class a file a task's worker wrote goes back as. The node that ran the task offers files only when its
 * owner's allowance for that peer, and the grant the task came under, both cover it.
 */
const RETURNED_FILE_CLASSIFICATION = "internal";

/**
 * Files a task's worker writes are text; a known extension says which kind, anything else is plain text. Markup and
 * script extensions are named for what they are, so they are never offered as plain text.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  svg: "image/svg+xml",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
};

function mimeTypeFor(name: string): string {
  return MIME_BY_EXTENSION[extname(name).slice(1).toLowerCase()] ?? "text/plain";
}

/** The extension a blob is stored under: the file's own, when it is a plain one. */
function blobExtensionFor(name: string): string {
  const extension = extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : "txt";
}

/** A peer's name for a file, as this node shows it: cleaned like any peer text, on one line, at most 200 characters. */
function readArtifactName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = peerTextAsData(value).replace(/\s+/gu, " ").trim();
  const bounded = [...cleaned].slice(0, 200).join("").trim();
  return bounded === "" ? undefined : bounded;
}

/* ------------------------------------------------------------------ *
 * The node that ran the task
 * ------------------------------------------------------------------ */

/** A file read back, checked and stored, ready to be offered. */
export interface PreparedArtifact {
  name: string;
  digest: string;
  sizeBytes: number;
  mimeType: string;
}

/**
 * How many bytes of files a task a peer handed here may send back to it, decided on this node: what the grant the task
 * came under asks for (its `maxArtifactBytes`, so a node that said it takes no files is sent none), and what this
 * node's owner's live allowance for that peer lets go back (its own `maxArtifactBytes`, and a data class covering the
 * files), whichever is smaller. `asked` says whether the peer asked for files at all, so a run it asked for files from
 * and was sent none can say why.
 */
export function returnableFileBytes(db: Database, task: TaskRecord, at: Instant): { asked: boolean; bytes: number } {
  if (task.origin?.kind !== "delegated") return { asked: false, bytes: 0 };
  const grant = getGrant(db, task.origin.delegationId);
  if (grant === undefined || grant.revokedAt !== undefined || Date.parse(at) >= Date.parse(grant.expiresAt)) {
    return { asked: false, bytes: 0 };
  }
  const asked = grant.budget?.maxArtifactBytes ?? 0;
  if (asked === 0 || !grant.allowedDataClasses.includes(RETURNED_FILE_CLASSIFICATION)) return { asked: false, bytes: 0 };
  const allowance = livePeerAllowance(db, task.origin.peerNodeId, at);
  const allowed =
    allowance !== undefined && allowance.grant.allowedDataClasses.includes(RETURNED_FILE_CLASSIFICATION)
      ? (allowance.grant.budget?.maxArtifactBytes ?? 0)
      : 0;
  return { asked: true, bytes: Math.min(asked, allowed, DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES) };
}

/**
 * Read back the files a task's worker wrote and keep the ones this node can still offer, as blobs.
 *
 * A file is offered only as the worker last wrote it: one changed since, gone, larger than one file may be, or of a
 * type the other node always refuses is left out, and so is anything past the count or `maxTotalBytes`, the bytes this
 * run may send back. What was left out is said in words, so the node that handed the task over hears it rather than
 * finding fewer files than were written. Nothing left out is stored.
 *
 * Runs before anything is queued, and reads the files at once: a task's worktree is taken away once it is reported.
 */
export function prepareDelegatedArtifacts(
  dataDir: string,
  outputs: readonly TaskOutputFile[],
  maxTotalBytes: number,
): { prepared: PreparedArtifact[]; left: string[] } {
  const prepared: PreparedArtifact[] = [];
  const left: string[] = [];
  const budget = Math.min(maxTotalBytes, DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES);
  let total = 0;
  for (const output of outputs) {
    if (prepared.length >= DELEGATED_ARTIFACTS_MAX) {
      left.push(`${output.name} (quá ${String(DELEGATED_ARTIFACTS_MAX)} tệp)`);
      continue;
    }
    const mimeType = mimeTypeFor(output.name);
    if (!mimeTypePermitted(mimeType, RECEIVABLE_MIME_PREFIXES)) {
      left.push(`${output.name} (loại ${mimeType} không được gửi về)`);
      continue;
    }
    let bytes: Buffer;
    try {
      const size = statSync(output.path).size;
      if (size > DELEGATED_ARTIFACT_MAX_BYTES) {
        left.push(`${output.name} (lớn hơn ${String(DELEGATED_ARTIFACT_MAX_BYTES)} byte)`);
        continue;
      }
      bytes = readFileSync(output.path);
    } catch {
      left.push(`${output.name} (không còn đọc được)`);
      continue;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== output.sha256) {
      left.push(`${output.name} (đã đổi sau khi việc ghi nó)`);
      continue;
    }
    if (total + bytes.byteLength > budget) {
      left.push(`${output.name} (vượt ${String(budget)} byte cho cả việc)`);
      continue;
    }
    const stored = writeBlob({ dataDir, bytes, extension: blobExtensionFor(output.name) });
    total += bytes.byteLength;
    prepared.push({ name: output.name.slice(0, 200), digest: stored.digest, sizeBytes: bytes.byteLength, mimeType });
  }
  return { prepared, left };
}

/**
 * Offer prepared files to the node that handed the task over: one `artifact.offer` each, and a row that lets that node
 * — and only it — fetch the bytes. Written inside the caller's write, before the result that names them.
 */
export function queueArtifactOffers(
  deps: { db: Database; identity: Pick<NodeIdentity, "nodeId">; now: () => Instant; newId: (prefix: string) => string },
  input: { taskId: string; peerNodeId: string; prepared: readonly PreparedArtifact[] },
): DelegatedArtifact[] {
  const at = deps.now();
  return input.prepared.map((file) => {
    const artifactId = deps.newId("art");
    const offer: ArtifactOffer = {
      artifactId,
      digest: file.digest,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      classification: RETURNED_FILE_CLASSIFICATION,
      originNodeId: deps.identity.nodeId,
    };
    insertTaskArtifact(deps.db, {
      taskId: input.taskId,
      direction: "offered",
      peerArtifactId: artifactId,
      peerNodeId: input.peerNodeId,
      name: file.name,
      digest: file.digest,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
      state: "offered",
      at,
    });
    sendEnvelope(deps, {
      protocol: "agent.nodelink",
      version: 1,
      messageId: deps.newId("msg"),
      correlationId: input.taskId,
      senderNodeId: deps.identity.nodeId,
      recipientNodeId: input.peerNodeId,
      kind: "artifact.offer",
      taskId: input.taskId,
      sourceSequence: nextOutboundSequence(deps.db, input.peerNodeId),
      sentAt: at,
      payload: { artifact: offer, digest: offer.digest, sizeBytes: offer.sizeBytes, classification: offer.classification, name: file.name },
    });
    return { artifactId, digest: file.digest, name: file.name, sizeBytes: file.sizeBytes, mimeType: file.mimeType };
  });
}

/* ------------------------------------------------------------------ *
 * The node that handed the task over
 * ------------------------------------------------------------------ */

export interface ArtifactOfferDeps {
  db: Database;
  identity: Pick<NodeIdentity, "nodeId" | "ownerPrincipalId">;
  now: () => Instant;
}

export type ArtifactOfferOutcome = { accepted: true; artifactId: string } | { accepted: false; reason: string };

/**
 * The grant a task this node handed over went under, as this node's owner wrote it: the one its automation was set up
 * with, while it still names this node, that peer and this node's owner. Never a grant the peer names.
 */
function grantForTask(deps: ArtifactOfferDeps, task: TaskRecord, peerNodeId: string): Grant | undefined {
  if (task.origin?.kind !== "persistent") return undefined;
  const intent = getPersistentIntent(deps.db, task.origin.intentId);
  if (intent?.do.kind !== "task" || intent.do.executor !== peerNodeId || intent.do.grantId === undefined) return undefined;
  const grant = getGrant(deps.db, intent.do.grantId);
  if (
    grant === undefined ||
    grant.senderNodeId !== deps.identity.nodeId ||
    grant.receiverNodeId !== peerNodeId ||
    grant.ownerPrincipalId !== deps.identity.ownerPrincipalId
  ) {
    return undefined;
  }
  return grant;
}

/** Whether this node takes an offered file, decided only by what this node's owner allowed for the task. */
function decideOffer(deps: ArtifactOfferDeps, task: TaskRecord, peerNodeId: string, offer: ArtifactOffer): ArtifactOfferOutcome {
  const refuse = (reason: string): ArtifactOfferOutcome => ({ accepted: false, reason });
  if (offer.originNodeId !== peerNodeId) return refuse("the file does not come from the node that ran the task");
  if (isTerminal(task.state)) return refuse("the task has already ended here");
  const grant = grantForTask(deps, task, peerNodeId);
  if (grant === undefined) return refuse("no grant of this node's owner for that task takes files back");
  if (grant.revokedAt !== undefined || Date.parse(deps.now()) >= Date.parse(grant.expiresAt)) {
    return refuse("the grant that task went under is no longer live");
  }
  const budget = grant.budget?.maxArtifactBytes ?? 0;
  if (budget === 0) return refuse("the automation that handed this task over allows no file bytes back");
  const allowed = checkArtifactAcceptance(offer, {
    allowedClassifications: grant.allowedDataClasses,
    maxBytes: Number.MAX_SAFE_INTEGER,
    allowedMimePrefixes: RECEIVABLE_MIME_PREFIXES,
  });
  if (!allowed.accepted) return allowed;
  const taken = listTaskArtifacts(deps.db, task.taskId, "received").filter((file) => file.state === "accepted" || file.state === "received");
  if (taken.length >= DELEGATED_ARTIFACTS_MAX) return refuse(`the task already brought back ${String(DELEGATED_ARTIFACTS_MAX)} files`);
  const used = taken.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (used + offer.sizeBytes > budget) {
    return refuse(
      `the file is ${String(offer.sizeBytes)} bytes and the automation allows ${String(budget)} bytes of files back per run` +
        (used > 0 ? `, ${String(used)} of them already taken` : ""),
    );
  }
  return { accepted: true, artifactId: offer.artifactId };
}

/**
 * A peer offers a file its run of a task this node handed it wrote.
 *
 * Only the peer the task was handed to, only for a task still open here, and only within this node's owner's grant
 * for it. The decision is recorded, so the same offer delivered again is answered the same way and never re-decided.
 */
export function receiveArtifactOffer(deps: ArtifactOfferDeps, envelope: PeerEnvelope): ArtifactOfferOutcome {
  const peer = envelope.senderNodeId;
  const task = envelope.taskId === undefined ? undefined : getTask(deps.db, envelope.taskId);
  if (task === undefined || task.homeNodeId !== deps.identity.nodeId || task.executionNodeId !== peer) {
    return { accepted: false, reason: "this node handed that peer no such task" };
  }
  const read = artifactOfferSchema.safeParse(envelope.payload["artifact"]);
  if (!read.success || !artifactDigestSchema.safeParse(read.data.digest).success) {
    return { accepted: false, reason: "the offer is not an artifact offer this node can read" };
  }
  const offer = read.data;
  const already = getTaskArtifact(deps.db, task.taskId, "received", offer.artifactId);
  if (already !== undefined) {
    return already.state === "refused"
      ? { accepted: false, reason: already.reason ?? "refused" }
      : { accepted: true, artifactId: offer.artifactId };
  }
  const decision = decideOffer(deps, task, peer, offer);
  insertTaskArtifact(deps.db, {
    taskId: task.taskId,
    direction: "received",
    peerArtifactId: offer.artifactId,
    peerNodeId: peer,
    name: readArtifactName(envelope.payload["name"]) ?? offer.artifactId,
    digest: offer.digest,
    sizeBytes: offer.sizeBytes,
    mimeType: offer.mimeType,
    state: decision.accepted ? "accepted" : "refused",
    ...(decision.accepted ? {} : { reason: decision.reason.slice(0, 500) }),
    at: deps.now(),
  });
  return decision;
}

export interface ArtifactIntakeDeps {
  db: Database;
  identity: Pick<NodeIdentity, "nodeId" | "localToken">;
  dataDir: string;
  now: () => Instant;
  newId: (prefix: string) => string;
  /** Say something in a task's conversation: a file that arrived, or did not, after the task's result was said. */
  say: (conversationId: string, text: string, blocks?: readonly MessageBlock[]) => void;
}

/** Fetches under way, so the same file delivered twice while its bytes are on the way is fetched once. */
const inFlight = new Set<string>();

/** How a received file is shown: the artifact it became, under its name, with the node it came from. */
export function artifactBlockFor(file: TaskArtifact): MessageBlock | undefined {
  if (file.state !== "received" || file.artifactId === undefined) return undefined;
  return {
    type: "artifact",
    artifactId: file.artifactId,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    digest: file.digest,
    label: file.name,
    originNodeId: file.peerNodeId,
  };
}

/**
 * Pull the bytes of a file this node accepted for a task, once its offer was acknowledged.
 *
 * Checked against the digest offered and bounded by the size accepted; stored, recorded as an artifact from that peer,
 * and attached to the task's run as evidence. When the task's result was already said, the file is said too, where the
 * result was, arrived or not. Nothing for a file not waiting for its bytes.
 */
export async function collectTaskArtifact(deps: ArtifactIntakeDeps, taskId: string, peerArtifactId: string): Promise<void> {
  const file = getTaskArtifact(deps.db, taskId, "received", peerArtifactId);
  if (file?.state !== "accepted") return;
  const key = `${deps.identity.nodeId}:${taskId}:${peerArtifactId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    const peer = getPeer(deps.db, file.peerNodeId);
    const fetched =
      peer === undefined || peer.trustedAt === null || peer.revokedAt !== null
        ? ({ ok: false, message: "the node that offered it is no longer paired with this one" } as const)
        : await fetchArtifactFromPeer({
            dataDir: deps.dataDir,
            endpoint: peer.endpoint,
            token: outboundPeerToken(deps.identity.localToken, file.peerNodeId),
            digest: file.digest,
            extension: extensionForMimeType(file.mimeType),
            maxBytes: file.sizeBytes,
          });
    const at = deps.now();
    if (!fetched.ok) {
      if (!settleReceivedTaskArtifact(deps.db, { taskId, peerArtifactId, at, state: "failed", reason: fetched.message.slice(0, 500) })) return;
      tellIfSettled(deps, taskId, `Không nhận được tệp ${file.name} từ ${file.peerNodeId} cho task ${taskId}: ${fetched.message}.`);
      return;
    }
    const artifactId = deps.newId("art");
    upsertArtifact(deps.db, {
      artifactId,
      digest: file.digest,
      sizeBytes: fetched.bytes,
      mimeType: file.mimeType,
      classification: "internal",
      originNodeId: file.peerNodeId,
      blobPath: fetched.blobPath,
      createdAt: at,
    });
    if (!settleReceivedTaskArtifact(deps.db, { taskId, peerArtifactId, at, state: "received", artifactId })) return;
    // What the task produced on the peer, now held here and checked by digest: evidence on the run it came from.
    recordEvidence(
      { db: deps.db, nodeId: deps.identity.nodeId, now: deps.now, newId: deps.newId },
      {
        taskId,
        evidence: {
          kind: "file-version",
          ref: `artifact:${artifactId}`,
          digest: file.digest,
          summary: `${file.name} (${String(fetched.bytes)} byte) từ ${file.peerNodeId}, khớp digest đã đề nghị`.slice(0, 1000),
          verdict: "verified",
        },
      },
    );
    const received = getTaskArtifact(deps.db, taskId, "received", peerArtifactId);
    const block = received === undefined ? undefined : artifactBlockFor(received);
    tellIfSettled(deps, taskId, `Đã nhận tệp ${file.name} từ ${file.peerNodeId} cho task ${taskId}.`, block === undefined ? [] : [block]);
  } catch (cause) {
    process.stderr.write(
      `artifact: ${file.name} for task ${taskId} not taken in — ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
  } finally {
    inFlight.delete(key);
  }
}

/** Once the task's result was said, a file that settles after it is said on its own; before, the result says it. */
function tellIfSettled(deps: ArtifactIntakeDeps, taskId: string, text: string, blocks: readonly MessageBlock[] = []): void {
  const task = getTask(deps.db, taskId);
  if (task === undefined || !isTerminal(task.state)) return;
  deps.say(task.conversationId, text, blocks);
}

/**
 * Fetch the files this node accepted and did not receive before it stopped. Answers how many it goes after; each is
 * fetched in the background like one just accepted.
 */
export function resumeArtifactIntake(deps: ArtifactIntakeDeps): number {
  const waiting = listAcceptedTaskArtifacts(deps.db);
  for (const file of waiting) void collectTaskArtifact(deps, file.taskId, file.peerArtifactId);
  return waiting.length;
}

/**
 * What the result of a task says about the files the peer named: each one received, on its way, or not taken and why.
 * Received ones come with the block that shows them. Empty when the peer named none.
 */
export function describeResultArtifacts(
  db: Database,
  taskId: string,
  named: readonly DelegatedArtifact[],
): { text: string; blocks: MessageBlock[] } {
  if (named.length === 0) return { text: "", blocks: [] };
  const parts: string[] = [];
  const blocks: MessageBlock[] = [];
  for (const one of named) {
    const file = getTaskArtifact(db, taskId, "received", one.artifactId);
    const name = file?.name ?? readArtifactName(one.name) ?? one.artifactId;
    if (file === undefined) {
      parts.push(`chưa nhận được đề nghị gửi ${name}`);
    } else if (file.state === "received") {
      parts.push(`đã nhận ${name}`);
      const block = artifactBlockFor(file);
      if (block !== undefined) blocks.push(block);
    } else if (file.state === "accepted") {
      parts.push(`đang tải ${name} về`);
    } else {
      parts.push(`không nhận ${name}: ${file.reason ?? "không rõ lý do"}`);
    }
  }
  return { text: `Tệp: ${parts.join("; ")}.`, blocks };
}
