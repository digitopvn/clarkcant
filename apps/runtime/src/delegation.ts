import { isAbsolute, resolve } from "node:path";

import {
  type CapabilityRef,
  type DelegatedArtifact,
  type DelegationBrief,
  type DelegationResult,
  type EffectCategory,
  type Grant,
  type Instant,
  type IntentAction,
  type MessageBlock,
  type PeerEnvelope,
  type PersistentIntent,
  type Principal,
  type Signal,
  type TaskRecord,
  type TaskResource,
  capabilityRefSchema,
  checkGrant,
  delegationBriefSchema,
  delegationResultSchema,
  grantSchema,
  intersectGrants,
  isTerminal,
  taskIdSchema,
} from "@clarkcant/contracts";
import {
  type ConductorDeps,
  applyTaskEvent,
  automationCapabilityFor,
  createTask,
  settleDispatchedTask,
  startTaskHere,
} from "@clarkcant/core";
import { sendEnvelope } from "@clarkcant/node-link";
import {
  type Database,
  activeGrants,
  getGrant,
  getPeer,
  getTask,
  countDelegatedTasks,
  inTransaction,
  livePeerAllowance,
  nextOutboundSequence,
  revokeGrant,
  transaction,
  upsertGrant,
} from "@clarkcant/storage";

import { repositoryBindingRefusal, triggerBrief } from "./automation-service.ts";
import { hostText, type HostText } from "./host-text.ts";
import type { NodeIdentity } from "./node.ts";
import { describeResultArtifacts, prepareDelegatedArtifacts, queueArtifactOffers, returnableFileBytes } from "./delegated-artifacts.ts";
import { type TaskDispatcher, type TaskOutputFile, stopTask } from "./task-dispatch.ts";

/**
 * Handing a task to a paired Clark, and hearing back.
 *
 * Two owners decide, one on each machine. The sender's owner writes a grant that says what the peer may be asked to do
 * for them; the receiver's owner writes an allowance that says what that peer may run here. A task a peer hands over
 * runs only inside both — the grant stored when it arrived, intersected with the allowance — so a grant a peer wrote
 * can narrow what runs on this machine but never widen it, and nothing a peer sends is ever this node's owner's
 * decision. Effects outside both wait for this node's owner, in every mode.
 *
 * The sender keeps its own task, running on the peer: that task is the record, it is what a person stops, and the
 * peer's answer settles it. The task id is chosen by the sender's run before anything is sent, so the same hand-over
 * delivered twice is one task on the receiver, and the same answer delivered twice settles once.
 */

export const TASK_GRANT_LIFETIME_MS = 365 * 24 * 60 * 60_000;

export interface DelegationDeps {
  db: Database;
  identity: Pick<NodeIdentity, "nodeId" | "ownerPrincipalId" | "fingerprint">;
  now: () => Instant;
  newId: (prefix: string) => string;
}

function confirmedPeer(db: Database, peerNodeId: string): boolean {
  const peer = getPeer(db, peerNodeId);
  return peer !== undefined && peer.trustedAt !== null && peer.revokedAt === null;
}

/** A task resource as the entry a grant names it by. A repository is changed, so it is written. */
function grantResource(nodeId: string, resource: TaskResource): Grant["resources"][number] {
  return {
    nodeId,
    resourceId: resource.path,
    kind: resource.kind,
    access: resource.kind === "repository" ? "write" : resource.access,
  };
}

/** The capabilities these resources need: reading always, changing when anything is written. */
function capabilitiesFor(resources: readonly TaskResource[]): CapabilityRef[] {
  const reads = "project.file.read@1" as CapabilityRef;
  const change = automationCapabilityFor({ kind: "task", goal: "-", resources: [...resources], allowedCategories: [] });
  return change === reads ? [reads] : [reads, change];
}

/**
 * A grant for tasks on the node named, over these folders there, with these effects.
 *
 * Used for both halves: the sender's grant to its executor, and a receiver's allowance for a peer, which is a grant
 * from that peer to this node written by this node's owner.
 */
export function taskGrant(input: {
  grantId: string;
  ownerPrincipalId: string;
  senderNodeId: string;
  receiverNodeId: string;
  resources: readonly TaskResource[];
  allowedCategories: readonly EffectCategory[];
  expiresAt: Instant;
  /** How long one run may take on the receiver, at most; absent leaves it to the receiver's own limits. */
  maxWallClockMs?: number;
  /** How many bytes of files one run may bring back from the receiver; absent brings none back. */
  maxArtifactBytes?: number;
}): { ok: true; grant: Grant } | { ok: false; message: string } {
  const budget = {
    ...(input.maxWallClockMs === undefined ? {} : { maxWallClockMs: input.maxWallClockMs }),
    ...(input.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: input.maxArtifactBytes }),
  };
  const parsed = grantSchema.safeParse({
    grantId: input.grantId,
    ownerPrincipalId: input.ownerPrincipalId,
    senderNodeId: input.senderNodeId,
    receiverNodeId: input.receiverNodeId,
    capabilityRefs: capabilitiesFor(input.resources),
    resources: input.resources.map((resource) => grantResource(input.receiverNodeId, resource)),
    allowedDataClasses: ["public", "internal"],
    expiresAt: input.expiresAt,
    ...(Object.keys(budget).length === 0 ? {} : { budget }),
    maxDelegationDepth: 0,
    allowedEffectCategories: [...input.allowedCategories],
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
  }
  return { ok: true, grant: parsed.data };
}

/* ------------------------------------------------------------------ *
 * The sender's side
 * ------------------------------------------------------------------ */

export type WriteGrantResult =
  | { ok: true }
  | { ok: false; code: "GRANT_NOT_OURS" | "NOT_THE_OWNER" | "PEER_UNKNOWN"; message: string };

/**
 * Keep a grant this node's owner wrote, and send it to the peer it names.
 *
 * Both in one write, so a grant is never kept here and left unsent: the peer admits a hand-over only under a grant it
 * holds, and the outbox carries it however long the peer is away.
 */
export function writeGrant(deps: DelegationDeps, grant: Grant): WriteGrantResult {
  if (grant.senderNodeId !== deps.identity.nodeId) {
    return { ok: false, code: "GRANT_NOT_OURS", message: "a grant written here has to name this node as its sender" };
  }
  if (grant.ownerPrincipalId !== deps.identity.ownerPrincipalId) {
    return { ok: false, code: "NOT_THE_OWNER", message: "a grant has to be written by this node's owner" };
  }
  if (!confirmedPeer(deps.db, grant.receiverNodeId)) {
    return { ok: false, code: "PEER_UNKNOWN", message: "a grant can only be written for a peer that is paired and confirmed" };
  }
  const at = deps.now();
  transaction(deps.db, () => {
    upsertGrant(deps.db, grant, at);
    const messageId = deps.newId("msg");
    sendEnvelope(deps, {
      protocol: "agent.nodelink",
      version: 1,
      messageId,
      correlationId: grant.grantId,
      senderNodeId: deps.identity.nodeId,
      recipientNodeId: grant.receiverNodeId,
      kind: "pair.confirm",
      sourceSequence: nextOutboundSequence(deps.db, grant.receiverNodeId),
      sentAt: at,
      payload: { grant, fingerprint: deps.identity.fingerprint },
    });
  });
  return { ok: true };
}

/**
 * The live grant a run of this task automation goes under, or nothing.
 *
 * The one written for it when it was set up, while it is live and still covers everything the task names on the
 * executor: withdrawing that grant stops its runs, whatever other grants to the same node there are. An automation set
 * up before its grant was recorded goes under any live grant this node's owner wrote that covers it.
 */
export function grantCovering(
  deps: Pick<DelegationDeps, "db" | "identity">,
  executor: string,
  action: Extract<IntentAction, { kind: "task" }>,
  at: Instant,
): Grant | undefined {
  const capabilityRef = automationCapabilityFor(action);
  const covers = (grant: Grant): boolean =>
    grant.receiverNodeId === executor &&
    grant.senderNodeId === deps.identity.nodeId &&
    grant.ownerPrincipalId === deps.identity.ownerPrincipalId &&
    action.resources.every(
      (resource) =>
        checkGrant(grant, {
          capabilityRef,
          at,
          resource: grantResource(executor, resource),
          dataClass: "internal",
          delegationDepth: 0,
        }).allowed,
    );
  if (action.grantId !== undefined) {
    const own = getGrant(deps.db, action.grantId);
    return own !== undefined && covers(own) ? own : undefined;
  }
  return activeGrants(deps.db, deps.identity.nodeId, at).find(covers);
}

/**
 * Withdraw a grant this node's owner wrote, here and on the peer it names.
 *
 * Both in one write, so a grant is never withdrawn here and left live there: the outbox carries the revocation however
 * long the peer is away, and the peer refuses any later hand-over under it. Answers whether anything was withdrawn; a
 * grant already withdrawn, or not this node's, is left as it is.
 */
export function withdrawGrant(deps: DelegationDeps, grantId: string, reason: string): boolean {
  const grant = getGrant(deps.db, grantId);
  if (grant === undefined || grant.senderNodeId !== deps.identity.nodeId || grant.revokedAt !== undefined) return false;
  const at = deps.now();
  return transaction(deps.db, () => {
    if (!revokeGrant(deps.db, grantId, at)) return false;
    sendEnvelope(deps, {
      protocol: "agent.nodelink",
      version: 1,
      messageId: deps.newId("msg"),
      correlationId: grantId,
      senderNodeId: deps.identity.nodeId,
      recipientNodeId: grant.receiverNodeId,
      kind: "revoke",
      delegationId: grantId,
      sourceSequence: nextOutboundSequence(deps.db, grant.receiverNodeId),
      sentAt: at,
      payload: { grantId, reason: reason.slice(0, 300) },
    });
    return true;
  });
}

/** What started the task, in the fields a program set; a timer is nothing to tell. */
function triggerOf(signal: Signal | undefined): DelegationBrief["trigger"] {
  if (signal === undefined || signal.source.kind === "timer") return undefined;
  return {
    ...(signal.source.provider === undefined ? {} : { provider: signal.source.provider }),
    topic: signal.topic,
    ...(signal.subject === undefined ? {} : { subject: signal.subject }),
  };
}

/**
 * Queue the hand-over of a task to its executor. Written inside the caller's write, never in a transaction of its own:
 * it is recorded exactly when the run is marked started.
 */
export function queueDelegate(
  deps: DelegationDeps,
  input: { task: TaskRecord; grant: Grant; intent: PersistentIntent; action: Extract<IntentAction, { kind: "task" }>; signal?: Signal },
): void {
  const trigger = triggerOf(input.signal);
  const brief: DelegationBrief = {
    goal: input.action.goal,
    summary: input.intent.summary,
    resources: input.action.resources,
    allowedCategories: input.action.allowedCategories,
    ...(trigger === undefined ? {} : { trigger }),
  };
  sendEnvelope(deps, {
    protocol: "agent.nodelink",
    version: 1,
    messageId: deps.newId("msg"),
    correlationId: input.task.taskId,
    senderNodeId: deps.identity.nodeId,
    recipientNodeId: input.grant.receiverNodeId,
    kind: "delegate",
    delegationId: input.grant.grantId,
    taskId: input.task.taskId,
    sourceSequence: nextOutboundSequence(deps.db, input.grant.receiverNodeId),
    sentAt: deps.now(),
    payload: { grant: input.grant, taskBrief: brief, dataClass: "internal" },
  });
}

export interface ResultReceiveDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
  conductor: ConductorDeps;
  /** The words this node's owner is told in, in their interface language. */
  say: HostText;
  /** How a settled task is told, the same as one this node ran; `blocks` show what came back with it. */
  onSettled: (input: {
    taskId: string;
    conversationId: string;
    outcome: "succeeded" | "failed" | "uncertain" | "cancelled";
    message: string;
    blocks?: readonly MessageBlock[];
  }) => void;
}

/**
 * A peer's answer about a task this node handed it.
 *
 * Only the peer the task was handed to can answer it, and only while it is open: a stale or repeated answer is taken as
 * already heard. The peer's word is recorded as what it is, a receipt from the machine that ran it.
 */
export function receiveResult(
  deps: ResultReceiveDeps,
  envelope: PeerEnvelope,
): { accepted: true; duplicate: boolean } | { accepted: false; reason: string } {
  const read = delegationResultSchema.safeParse(envelope.payload);
  if (!read.success || envelope.taskId === undefined) return { accepted: false, reason: "the result is not one this node can read" };
  const result = { outcome: read.data.outcome, ...read.data.evidence };
  const task = getTask(deps.db, envelope.taskId);
  if (task === undefined || task.homeNodeId !== deps.nodeId || task.executionNodeId !== envelope.senderNodeId) {
    return { accepted: false, reason: "this node handed that peer no such task" };
  }
  if (isTerminal(task.state)) return { accepted: true, duplicate: true };

  const peer = envelope.senderNodeId;
  // The files the peer named, as this node decided about each when it was offered: every offer was queued ahead of this.
  const files = describeResultArtifacts(deps.db, task.taskId, result.artifacts ?? [], deps.say.files);
  const words = result.ran ? deps.say.delegation.ranThere(peer, result.message) : deps.say.delegation.notRunThere(peer, result.message);
  const said = files.text === "" ? words : `${words} ${files.text}`;
  const shown = files.blocks.length === 0 ? {} : { blocks: files.blocks };
  const coordination = { db: deps.db, nodeId: deps.nodeId, now: deps.now, newId: deps.conductor.newId };

  if (task.state === "cancel_requested") {
    // Stopped here while the peer was working: what the peer did is what is known now. Stopped or never started is a
    // confirmed stop; anything it finished is an outcome nobody here can vouch for, and is called that.
    const confirmed = result.outcome === "cancelled" || !result.ran;
    applyTaskEvent(coordination, task.taskId, confirmed ? "cancel.confirmed" : "effect.unknown");
    deps.onSettled({ taskId: task.taskId, conversationId: task.conversationId, outcome: confirmed ? "cancelled" : "uncertain", message: said, ...shown });
    return { accepted: true, duplicate: false };
  }

  /*
   * The peer does not know how it ended, or it was stopped there: the task here is that, not a failure. Unknown stays
   * unknown for a person to reconcile, and a stop on the peer is a stop of this task, confirmed by the peer that holds it.
   */
  if (result.outcome === "uncertain" || result.outcome === "cancelled") {
    const settled =
      result.outcome === "uncertain"
        ? applyTaskEvent(coordination, task.taskId, "effect.unknown")
        : (() => {
            const requested = applyTaskEvent(coordination, task.taskId, "cancel.requested");
            return requested.ok ? applyTaskEvent(coordination, task.taskId, "cancel.confirmed") : requested;
          })();
    if (settled.ok) {
      deps.onSettled({ taskId: task.taskId, conversationId: task.conversationId, outcome: result.outcome, message: said, ...shown });
      return { accepted: true, duplicate: false };
    }
  }

  // Settled before this answer is acknowledged, so a node that stops right after it has already recorded the outcome,
  // and a second copy of the answer finds the task ended.
  const settled = settleDispatchedTask(deps.conductor, task.taskId, {
    kind: "api-receipt",
    summary: said.slice(0, 1000),
    verified: result.outcome === "succeeded",
  });
  deps.onSettled({ taskId: task.taskId, conversationId: task.conversationId, outcome: settled.outcome, message: said, ...shown });
  return { accepted: true, duplicate: false };
}

/**
 * A hand-over or a stop this node gave up delivering: the task that waits on it is settled here, since no answer comes.
 *
 * A hand-over the peer refused was never run there, and neither was one that never left this node (it only waited behind
 * a message that could not reach the peer): the task failed. One nobody answered may have been run, and a
 * stop that never arrived may not have stopped anything: both are outcomes nobody here can vouch for, and are called
 * that. Anything else, or a task already settled, is left alone. Answers whether a task was settled.
 */
export function settleUndelivered(
  deps: ResultReceiveDeps,
  letter: { peerNodeId: string; kind: PeerEnvelope["kind"]; taskId?: string; refusedByPeer: boolean; neverSent?: boolean },
): boolean {
  if (letter.kind !== "delegate" && letter.kind !== "cancel.request") return false;
  const task = letter.taskId === undefined ? undefined : getTask(deps.db, letter.taskId);
  if (task === undefined || task.homeNodeId !== deps.nodeId || task.executionNodeId !== letter.peerNodeId || isTerminal(task.state)) {
    return false;
  }
  const coordination = { db: deps.db, nodeId: deps.nodeId, now: deps.now, newId: deps.conductor.newId };
  const peer = letter.peerNodeId;
  let settled: { outcome: "succeeded" | "failed" | "uncertain" | "cancelled"; message: string } | undefined;

  if (letter.kind === "delegate" && (letter.refusedByPeer || letter.neverSent === true)) {
    const message = letter.refusedByPeer ? deps.say.delegation.refusedByPeer(peer) : deps.say.delegation.neverSent(peer);
    if (task.state === "cancel_requested") {
      if (applyTaskEvent(coordination, task.taskId, "cancel.confirmed").ok) settled = { outcome: "cancelled", message };
    } else {
      // Recorded through the run's own settlement, which fails it; what the owner is told is only why, in their words.
      // The success gate's own English, which that settlement adds for an unverified report, would say nothing more
      // about a task that never ran and could not have succeeded.
      settled = { outcome: settleDispatchedTask(deps.conductor, task.taskId, { kind: "api-receipt", summary: message, verified: false }).outcome, message };
    }
  } else {
    const message = letter.kind === "delegate" ? deps.say.delegation.undeliveredHandOver(peer) : deps.say.delegation.undeliveredStop(peer);
    if (applyTaskEvent(coordination, task.taskId, "effect.unknown").ok) settled = { outcome: "uncertain", message };
  }
  if (settled === undefined) return false;
  deps.onSettled({ taskId: task.taskId, conversationId: task.conversationId, outcome: settled.outcome, message: settled.message });
  return true;
}

/**
 * A result the peer gave up delivering, and skipped: the task that waits on it is settled here, since the answer never
 * comes. How it ended there is not known here, so it is called uncertain. Only a task this node handed that very peer,
 * still open; anything else is left alone. Answers whether a task was settled.
 */
export function settleLostResult(deps: ResultReceiveDeps, lost: { peerNodeId: string; taskId: string }): boolean {
  const task = getTask(deps.db, lost.taskId);
  if (task === undefined || task.homeNodeId !== deps.nodeId || task.executionNodeId !== lost.peerNodeId || isTerminal(task.state)) {
    return false;
  }
  const coordination = { db: deps.db, nodeId: deps.nodeId, now: deps.now, newId: deps.conductor.newId };
  if (!applyTaskEvent(coordination, task.taskId, "effect.unknown").ok) return false;
  deps.onSettled({
    taskId: task.taskId,
    conversationId: task.conversationId,
    outcome: "uncertain",
    message: deps.say.delegation.resultLost(lost.peerNodeId),
  });
  return true;
}

/* ------------------------------------------------------------------ *
 * The receiver's side
 * ------------------------------------------------------------------ */

/** Queue this node's answer about a task a peer handed it, naming the files offered back ahead of it, when there are. */
export function queueResult(
  deps: DelegationDeps,
  peerNodeId: string,
  taskId: string,
  result: { outcome: DelegationResult["outcome"]; message: string; ran: boolean; artifacts?: readonly DelegatedArtifact[] },
): void {
  const evidence: DelegationResult["evidence"] = {
    message: result.message.slice(0, 1000) || result.outcome,
    ran: result.ran,
    ...(result.artifacts === undefined || result.artifacts.length === 0 ? {} : { artifacts: [...result.artifacts] }),
  };
  sendEnvelope(deps, {
    protocol: "agent.nodelink",
    version: 1,
    messageId: deps.newId("msg"),
    correlationId: taskId,
    senderNodeId: deps.identity.nodeId,
    recipientNodeId: peerNodeId,
    kind: "result",
    taskId,
    sourceSequence: nextOutboundSequence(deps.db, peerNodeId),
    sentAt: deps.now(),
    payload: { outcome: result.outcome, evidence } satisfies DelegationResult,
  });
}

/**
 * Answer the peer that handed a task over, once it settled here. Nothing for a task no peer handed over.
 *
 * `ran` is false for a task that ended before its worker did anything, such as one whose approval was refused here.
 * `files` are what its worker wrote, read from `dataDir`'s side of the disk: each one this node can still vouch for is
 * offered back ahead of the answer, which names them, to a peer that said it takes them — only when the grant the task
 * came under asks for files and this node's owner's allowance lets them go back, within both budgets. Read before this
 * returns, since a task's worktree goes once it is reported; a run that may send nothing back reads and stores nothing.
 */
export function reportDelegatedOutcome(
  deps: DelegationDeps,
  input: {
    taskId: string;
    outcome: DelegationResult["outcome"];
    message: string;
    ran?: boolean;
    files?: { dataDir: string; outputs: readonly TaskOutputFile[] };
  },
): boolean {
  const task = getTask(deps.db, input.taskId);
  if (task?.origin?.kind !== "delegated") return false;
  const peer = task.origin.peerNodeId;
  const ran = input.ran ?? true;
  const returnable =
    ran && input.files !== undefined && input.files.outputs.length > 0 && (getPeer(deps.db, peer)?.features ?? []).includes("artifacts")
      ? returnableFileBytes(deps.db, task, deps.now())
      : undefined;
  const offering =
    input.files !== undefined && returnable !== undefined && returnable.bytes > 0
      ? prepareDelegatedArtifacts(input.files.dataDir, input.files.outputs, returnable.bytes)
      : undefined;
  // The peer asked for files and this node's owner has not let any go back: said, so no one waits for them there.
  const kept = returnable?.asked === true && returnable.bytes === 0 ? " Tệp việc này ghi vẫn ở lại máy này: chủ máy này chưa cho phép gửi tệp về." : "";
  const left = offering === undefined || offering.left.length === 0 ? kept : ` Không gửi về: ${offering.left.join("; ")}.`;
  const message = (input.message.slice(0, 1000 - left.length) || input.outcome) + left;
  const answer = (): void => {
    const artifacts =
      offering === undefined || offering.prepared.length === 0
        ? []
        : queueArtifactOffers(deps, { taskId: task.taskId, peerNodeId: peer, prepared: offering.prepared });
    queueResult(deps, peer, task.taskId, { outcome: input.outcome, message, ran, artifacts });
  };
  // The offers and the answer that names them are queued together, so a peer never reads an answer whose files were
  // never offered.
  if (inTransaction(deps.db)) answer();
  else transaction(deps.db, answer);
  return true;
}

/** The states a peer is told about while a task it handed over is still open here. */
export type DelegatedStatus = "waiting_approval" | "waiting_capability" | "running";

/**
 * Tell the peer that handed a task over that it now waits — for this node's owner, or for a capability this node cannot
 * run yet — or goes on after that.
 *
 * Only a fact about this node: the peer's owner hears it, and can stop the task, but the decision stays with this node's
 * owner. `capabilityRef` names the capability waited for, or the one that became usable; that news goes only to a peer
 * that said it reads it (`capabilities`), since an older build would take "running" for its owner's approval. Nothing
 * for a task no peer handed over.
 */
export function reportDelegatedStatus(
  deps: DelegationDeps,
  input: { taskId: string; state: DelegatedStatus; message: string; capabilityRef?: string },
): boolean {
  const task = getTask(deps.db, input.taskId);
  if (task?.origin?.kind !== "delegated") return false;
  if (input.capabilityRef !== undefined && !hearsCapabilityWaits(deps.db, task.origin.peerNodeId)) return false;
  sendEnvelope(deps, {
    protocol: "agent.nodelink",
    version: 1,
    messageId: deps.newId("msg"),
    correlationId: task.taskId,
    senderNodeId: deps.identity.nodeId,
    recipientNodeId: task.origin.peerNodeId,
    kind: "status",
    taskId: task.taskId,
    sourceSequence: nextOutboundSequence(deps.db, task.origin.peerNodeId),
    sentAt: deps.now(),
    payload: {
      taskState: input.state,
      taskRevision: task.revision,
      message: input.message.slice(0, 500),
      ...(input.capabilityRef === undefined ? {} : { capabilityRef: input.capabilityRef }),
    },
  });
  return true;
}

export interface StatusReceiveDeps {
  db: Database;
  nodeId: string;
  /** The words this node's owner is told in, in their interface language. */
  say: HostText;
  /**
   * Tell this node's owner, in the task's conversation and — while it waits — the inbox, under `title`. `about` makes the
   * same news one notice.
   */
  tell: (input: { taskId: string; conversationId: string; text: string; about: string; waiting: boolean; title: string }) => void;
}

/**
 * A peer's word on a task this node handed it, while that task is still open.
 *
 * Only the peer the task was handed to, and only for a task still open here. The task here stays as it is: waiting on
 * the peer's owner is not something this node's owner can decide, so it is told, never offered as a decision.
 */
export function receiveStatus(
  deps: StatusReceiveDeps,
  envelope: PeerEnvelope,
): { accepted: true; told: boolean } | { accepted: false; reason: string } {
  const task = envelope.taskId === undefined ? undefined : getTask(deps.db, envelope.taskId);
  if (task === undefined || task.homeNodeId !== deps.nodeId || task.executionNodeId !== envelope.senderNodeId) {
    return { accepted: false, reason: "this node handed that peer no such task" };
  }
  if (isTerminal(task.state)) return { accepted: true, told: false };
  const state = envelope.payload["taskState"];
  const revision = envelope.payload["taskRevision"];
  const peer = envelope.senderNodeId;
  const about = `${task.taskId}:${String(state)}:${typeof revision === "number" ? String(revision) : "?"}`;
  // The capability the peer names, read as a capability ref and nothing else: the peer's words are shown here.
  const named = capabilityRefSchema.safeParse(envelope.payload["capabilityRef"]);
  const capability = named.success ? named.data : undefined;
  if (state === "waiting_approval") {
    const why = typeof envelope.payload["message"] === "string" ? quotedPeerText(envelope.payload["message"]) : "";
    deps.tell({
      taskId: task.taskId,
      conversationId: task.conversationId,
      text: deps.say.delegation.waitingApproval(task.taskId, peer, why),
      about,
      waiting: true,
      title: deps.say.delegation.waitingApprovalTitle,
    });
    return { accepted: true, told: true };
  }
  if (state === "waiting_capability" && capability !== undefined) {
    deps.tell({
      taskId: task.taskId,
      conversationId: task.conversationId,
      text: deps.say.delegation.waitingCapability(task.taskId, peer, capability),
      about,
      waiting: true,
      title: deps.say.delegation.waitingCapabilityTitle,
    });
    return { accepted: true, told: true };
  }
  if (state === "running") {
    deps.tell({
      taskId: task.taskId,
      conversationId: task.conversationId,
      text:
        capability === undefined
          ? deps.say.delegation.approvedThere(task.taskId, peer)
          : deps.say.delegation.capabilityReadyThere(task.taskId, peer, capability),
      about,
      waiting: false,
      title: "",
    });
    return { accepted: true, told: true };
  }
  return { accepted: true, told: false };
}

/**
 * The peer that wrote a grant to this node withdraws it. Only that peer, and only its own grant: the grant stays
 * withdrawn, and a later hand-over under it is answered with why it does not run.
 */
export function receiveRevoke(
  deps: Pick<DelegationDeps, "db" | "now">,
  envelope: PeerEnvelope,
): { accepted: true; revoked: boolean } | { accepted: false; reason: string } {
  const grantId = envelope.payload["grantId"];
  const grant = typeof grantId === "string" ? getGrant(deps.db, grantId) : undefined;
  if (grant === undefined || grant.senderNodeId !== envelope.senderNodeId) {
    return { accepted: false, reason: "that peer gave this node no such grant" };
  }
  return { accepted: true, revoked: revokeGrant(deps.db, grant.grantId, deps.now()) };
}

export interface DelegateReceiveDeps extends DelegationDeps {
  /** The `origin` remote of a clone here, for the same repository check a local automation has. */
  readRemote: (path: string) => string | undefined;
  /** Hand an acknowledged task to this node's dispatcher. Called after the envelope is recorded. */
  startTask: (taskId: string, capabilityRef: CapabilityRef) => void;
  /**
   * Tell this node's owner something about a peer's request, where they set up what it may do, or in the inbox. `about`
   * names the hand-over, so the same one told twice is one notice.
   */
  tell: (text: string, about: string, conversationId?: string) => void;
  /** The words this node's owner is told in, in their interface language. */
  say: HostText;
}

export type DelegateOutcome = { accepted: true; taskId: string; duplicate: boolean } | { accepted: false; reason: string };

/**
 * A task a peer hands over.
 *
 * Runs here only inside the peer's grant as this node holds it, intersected with what this node's owner allows that
 * peer. Every refusal is also said back to the peer as a result, since the peer's outbox does not read this answer.
 */
export function receiveDelegate(deps: DelegateReceiveDeps, envelope: PeerEnvelope): DelegateOutcome {
  const peer = envelope.senderNodeId;
  const named = taskIdSchema.safeParse(envelope.taskId);
  // Nothing is answered for an id this node would not use: the answer would carry it back.
  if (!named.success) return { accepted: false, reason: "a hand-over has to name the task by a task id" };
  const taskId: string = named.data;
  const about = `${peer}:${taskId}`;

  const existing = getTask(deps.db, taskId);
  if (existing !== undefined) {
    if (existing.origin?.kind !== "delegated" || existing.origin.peerNodeId !== peer) {
      return refuse(deps, peer, taskId, "a task with that id already exists here");
    }
    // The same hand-over again, under any message id: the task it made is the answer. A node that stopped between
    // recording the task and starting it hears it again because its answer was never sent, and starts it now.
    if (existing.state === "queued") {
      const capabilityRef = automationCapabilityFor({ kind: "task", goal: existing.goal, resources: existing.resources ?? [], allowedCategories: [] });
      const coordination = { db: deps.db, nodeId: deps.identity.nodeId, now: deps.now, newId: deps.newId };
      const started = startTaskHere(coordination, taskId, capabilityRef, { park: hearsCapabilityWaits(deps.db, peer) });
      if (!started.ok) return refuse(deps, peer, taskId, started.reason);
      if (started.parked) reportWaitingForCapability(deps, taskId, capabilityRef);
      else setImmediate(() => deps.startTask(taskId, capabilityRef));
    }
    return { accepted: true, taskId, duplicate: true };
  }

  const read = delegationBriefSchema.safeParse(envelope.payload["taskBrief"]);
  if (!read.success) return refuse(deps, peer, taskId, "the hand-over is not one this node can read");
  const brief = read.data;
  // Written by the peer: shown to this node's owner only as a quoted line, never as text of this node's own.
  const summary = quotedPeerText(brief.summary);

  const at = deps.now();
  // The grant as it arrived and was checked then, never a copy in this envelope.
  const grant = envelope.delegationId === undefined ? undefined : getGrant(deps.db, envelope.delegationId);
  if (grant === undefined || grant.senderNodeId !== peer || grant.receiverNodeId !== deps.identity.nodeId) {
    return refuse(deps, peer, taskId, "this node holds no grant from that peer under that id");
  }
  if (grant.revokedAt !== undefined || Date.parse(at) >= Date.parse(grant.expiresAt)) {
    return refuse(deps, peer, taskId, grant.revokedAt !== undefined ? "the grant this hand-over names was revoked" : "the grant this hand-over names has expired");
  }
  const allowance = livePeerAllowance(deps.db, peer, at);
  if (allowance === undefined) {
    deps.tell(deps.say.delegation.notAllowed(peer, summary), about);
    return refuse(deps, peer, taskId, "this node's owner has not allowed that peer to run tasks here");
  }

  const effective = intersectGrants(grant, { ...allowance.grant, grantId: grant.grantId });
  // The runs either owner allowed under this grant, counted by the tasks it already made here.
  const maxRuns = effective.budget?.maxRuns;
  if (maxRuns !== undefined && countDelegatedTasks(deps.db, grant.grantId) >= maxRuns) {
    return refuse(deps, peer, taskId, `the grant this hand-over names allows ${String(maxRuns)} run(s), and they are used up`);
  }
  const resources = localResources(brief.resources, effective);
  if (!resources.ok) return refuse(deps, peer, taskId, resources.reason);
  const capabilityRef = automationCapabilityFor({ kind: "task", goal: brief.goal, resources: resources.resources, allowedCategories: [] });
  for (const resource of resources.resources) {
    const check = checkGrant(effective, {
      capabilityRef,
      at,
      resource: grantResource(deps.identity.nodeId, resource),
      dataClass: "internal",
      delegationDepth: 0,
    });
    if (!check.allowed) {
      deps.tell(deps.say.delegation.outsideAllowance(peer, summary, resource.path), about, allowance.conversationId);
      return refuse(deps, peer, taskId, `${resource.path}: ${check.message}`);
    }
  }

  const trigger: Pick<Signal, "source" | "topic" | "subject"> | undefined =
    brief.trigger === undefined
      ? undefined
      : {
          source: { kind: "peer", sourceId: peer, ...(brief.trigger.provider === undefined ? {} : { provider: brief.trigger.provider }) },
          topic: brief.trigger.topic,
          ...(brief.trigger.subject === undefined ? {} : { subject: brief.trigger.subject }),
        };
  const repositories = resources.resources.flatMap((resource) => (resource.kind === "repository" ? [resource.path] : []));
  // Sent back to the peer as its reason, worded like every other reason this node sends a peer.
  const refusal = repositoryBindingRefusal(trigger, repositories, deps.readRemote, hostText("en").automation);
  if (refusal !== undefined) return refuse(deps, peer, taskId, refusal);

  // What both owners allowed; any effect outside it waits for this node's owner, in every execution mode.
  const allowedCategories = brief.allowedCategories.filter((category) => (effective.allowedEffectCategories ?? []).includes(category));
  const principal: Principal = {
    principalId: grant.ownerPrincipalId,
    kind: "peer-node",
    nodeId: deps.identity.nodeId,
    peer: { senderNodeId: peer, delegationId: grant.grantId, delegationDepth: 1 },
  };
  const told = triggerBrief(trigger);
  const coordination = { db: deps.db, nodeId: deps.identity.nodeId, now: deps.now, newId: deps.newId };
  createTask(coordination, {
    taskId: taskId as TaskRecord["taskId"],
    conversationId: allowance.conversationId as TaskRecord["conversationId"],
    goal: (told === undefined ? brief.goal : `${brief.goal}\n\n${told}`).slice(0, 4000),
    principal,
    origin: { kind: "delegated", principalId: grant.ownerPrincipalId, peerNodeId: peer, delegationId: grant.grantId, allowedCategories },
    resources: resources.resources,
    // The time and tokens either owner gave one run; the worker is stopped when either runs out, as for any task here.
    ...(effective.budget?.maxWallClockMs === undefined && effective.budget?.maxTokens === undefined
      ? {}
      : {
          budget: {
            ...(effective.budget.maxWallClockMs === undefined ? {} : { maxWallClockMs: effective.budget.maxWallClockMs }),
            ...(effective.budget.maxTokens === undefined ? {} : { maxTokens: effective.budget.maxTokens }),
            maxDelegationDepth: 0,
          },
        }),
  });
  const started = startTaskHere(coordination, taskId, capabilityRef, { park: hearsCapabilityWaits(deps.db, peer) });
  if (!started.ok) return refuse(deps, peer, taskId, started.reason);

  if (started.parked) {
    // Kept here, not refused: it goes on by itself once this node can run it, and the peer hears at once that it waits.
    deps.tell(deps.say.delegation.handedOverWaiting(peer, summary, taskId, capabilityRef), about, allowance.conversationId);
    reportWaitingForCapability(deps, taskId, capabilityRef);
    return { accepted: true, taskId, duplicate: false };
  }
  deps.tell(deps.say.delegation.handedOverRunning(peer, summary, taskId), about, allowance.conversationId);
  // After this answer is recorded, so a node that stops first finds the task and the boot calls it uncertain.
  setImmediate(() => deps.startTask(taskId, capabilityRef));
  return { accepted: true, taskId, duplicate: false };
}

/**
 * Whether a peer reads that a task it handed over waits here for a capability. One that does not — a build from before
 * it — would never hear it, so its hand-over is refused at once instead, as it always was, rather than kept waiting
 * without a word. The same answer is what this node tells that peer, asked what it can run for it, about whether a run
 * waits here.
 */
export function hearsCapabilityWaits(db: Database, peerNodeId: string): boolean {
  return (getPeer(db, peerNodeId)?.features ?? []).includes("capabilities");
}

/** Tell the peer that handed a task over that it waits here for a capability this node cannot run yet. */
function reportWaitingForCapability(deps: DelegationDeps, taskId: string, capabilityRef: CapabilityRef): void {
  reportDelegatedStatus(deps, {
    taskId,
    state: "waiting_capability",
    message: `this node cannot run ${capabilityRef} right now; the task waits here and runs once it can`,
    capabilityRef,
  });
}

/**
 * The peer's paths as this machine names them: absolute, resolved, and spelled the way this node's owner allowed them
 * where the filesystem does not tell case apart, so the grant's exact match compares the same folder.
 */
function localResources(
  resources: readonly TaskResource[],
  grant: Grant,
): { ok: true; resources: TaskResource[] } | { ok: false; reason: string } {
  const caseless = process.platform === "win32" || process.platform === "darwin";
  const same = (a: string, b: string): boolean => (caseless ? a.toLowerCase() === b.toLowerCase() : a === b);
  const local: TaskResource[] = [];
  for (const resource of resources) {
    if (!isAbsolute(resource.path)) return { ok: false, reason: `${resource.path} is not an absolute path on this node` };
    const path = resolve(resource.path);
    const allowed = grant.resources.find((entry) => entry.kind === resource.kind && same(entry.resourceId, path));
    local.push({ ...resource, path: allowed?.resourceId ?? path });
  }
  return { ok: true, resources: local };
}

/** A peer's own words, as one quoted line: no line breaks or control characters, and not longer than a notice needs. */
function quotedPeerText(text: string): string {
  const line = text.replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").replaceAll('"', "'").trim().slice(0, 160);
  return `"${line}"`;
}

function refuse(deps: DelegationDeps, peer: string, taskId: string, reason: string): DelegateOutcome {
  queueResult(deps, peer, taskId, { outcome: "failed", message: reason.slice(0, 1000), ran: false });
  return { accepted: false, reason };
}

/**
 * The peer that handed a task over asks it to stop: the same stop this node's owner would give it. Only that peer, and
 * only for a task it handed over.
 */
export function receiveCancel(
  deps: DelegationDeps & { taskDispatch?: TaskDispatcher },
  envelope: PeerEnvelope,
): { accepted: true; confirmed: boolean } | { accepted: false; reason: string } {
  const task = envelope.taskId === undefined ? undefined : getTask(deps.db, envelope.taskId);
  if (task?.origin?.kind !== "delegated" || task.origin.peerNodeId !== envelope.senderNodeId) {
    return { accepted: false, reason: "that peer handed this node no such task" };
  }
  // The worker this node runs for it is stopped, and its run answers the peer when it settles.
  const outcome = stopTask({ db: deps.db, nodeId: deps.identity.nodeId, now: deps.now, newId: deps.newId }, deps.taskDispatch, task.taskId);
  if (!outcome.ok) return { accepted: false, reason: outcome.message };
  // A task nothing was running for stops at once, and the peer hears it here; a running one is answered when it settles.
  if (outcome.confirmed) queueResult(deps, envelope.senderNodeId, task.taskId, { outcome: "cancelled", message: "đã dừng theo yêu cầu", ran: true });
  return { accepted: true, confirmed: outcome.confirmed };
}
