import {
  type CapabilityRef,
  type DelegationBrief,
  type DelegationResult,
  type EffectCategory,
  type Grant,
  type Instant,
  type IntentAction,
  type PeerEnvelope,
  type PersistentIntent,
  type Principal,
  type Signal,
  type TaskRecord,
  type TaskResource,
  checkGrant,
  delegationBriefSchema,
  delegationResultSchema,
  grantSchema,
  intersectGrants,
  isTerminal,
} from "@clarkcant/contracts";
import {
  type ConductorDeps,
  applyTaskEvent,
  automationCapabilityFor,
  cancelTask,
  createTask,
  runDispatchedTask,
  startTaskHere,
} from "@clarkcant/core";
import { sendEnvelope } from "@clarkcant/node-link";
import {
  type Database,
  activeGrants,
  getGrant,
  getPeer,
  getTask,
  livePeerAllowance,
  nextOutboundSequence,
  transaction,
  upsertGrant,
} from "@clarkcant/storage";

import { repositoryBindingRefusal, triggerBrief } from "./automation-service.ts";
import type { NodeIdentity } from "./node.ts";

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
}): { ok: true; grant: Grant } | { ok: false; message: string } {
  const parsed = grantSchema.safeParse({
    grantId: input.grantId,
    ownerPrincipalId: input.ownerPrincipalId,
    senderNodeId: input.senderNodeId,
    receiverNodeId: input.receiverNodeId,
    capabilityRefs: capabilitiesFor(input.resources),
    resources: input.resources.map((resource) => grantResource(input.receiverNodeId, resource)),
    allowedDataClasses: ["public", "internal"],
    expiresAt: input.expiresAt,
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

/** A live grant this node's owner wrote that covers everything this task names on the executor, or nothing. */
export function grantCovering(
  deps: Pick<DelegationDeps, "db" | "identity">,
  executor: string,
  action: Extract<IntentAction, { kind: "task" }>,
  at: Instant,
): Grant | undefined {
  const capabilityRef = automationCapabilityFor(action);
  return activeGrants(deps.db, deps.identity.nodeId, at).find(
    (grant) =>
      grant.receiverNodeId === executor &&
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
      ),
  );
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
  /** How a settled task is told, the same as one this node ran. */
  onSettled: (input: { taskId: string; conversationId: string; outcome: "succeeded" | "failed" | "uncertain" | "cancelled"; message: string }) => void;
  /** Tasks whose answer is being settled right now, so a second copy of it is not settled twice. */
  settling: Set<string>;
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
  if (isTerminal(task.state) || deps.settling.has(task.taskId)) return { accepted: true, duplicate: true };

  const peer = envelope.senderNodeId;
  const said = result.ran ? `trên ${peer}: ${result.message}` : `${peer} không chạy việc này: ${result.message}`;
  const coordination = { db: deps.db, nodeId: deps.nodeId, now: deps.now, newId: deps.conductor.newId };

  if (task.state === "cancel_requested") {
    // Stopped here while the peer was working: what the peer did is what is known now. Stopped or never started is a
    // confirmed stop; anything it finished is an outcome nobody here can vouch for, and is called that.
    const confirmed = result.outcome === "cancelled" || !result.ran;
    applyTaskEvent(coordination, task.taskId, confirmed ? "cancel.confirmed" : "effect.unknown");
    deps.onSettled({ taskId: task.taskId, conversationId: task.conversationId, outcome: confirmed ? "cancelled" : "uncertain", message: said });
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
      deps.onSettled({ taskId: task.taskId, conversationId: task.conversationId, outcome: result.outcome, message: said });
      return { accepted: true, duplicate: false };
    }
  }

  deps.settling.add(task.taskId);
  void runDispatchedTask(deps.conductor, {
    taskId: task.taskId,
    collectEvidence: async () => ({ kind: "api-receipt", summary: said.slice(0, 1000), verified: result.outcome === "succeeded" }),
  })
    .then((settled) => {
      // The peer's own outcome is what a person hears when it did not succeed there: "cancelled" on the peer is not a
      // failure of this node's.
      const outcome = settled.outcome === "succeeded" || result.outcome === "succeeded" ? settled.outcome : result.outcome;
      deps.onSettled({ taskId: task.taskId, conversationId: task.conversationId, outcome, message: said });
    })
    .catch((cause: unknown) => {
      process.stderr.write(`delegation: could not settle ${task.taskId} (${cause instanceof Error ? cause.message : String(cause)})\n`);
    })
    .finally(() => deps.settling.delete(task.taskId));
  return { accepted: true, duplicate: false };
}

/* ------------------------------------------------------------------ *
 * The receiver's side
 * ------------------------------------------------------------------ */

/** Queue this node's answer about a task a peer handed it. */
export function queueResult(
  deps: DelegationDeps,
  peerNodeId: string,
  taskId: string,
  result: { outcome: DelegationResult["outcome"]; message: string; ran: boolean },
): void {
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
    payload: { outcome: result.outcome, evidence: { message: result.message.slice(0, 1000) || result.outcome, ran: result.ran } } satisfies DelegationResult,
  });
}

/** Answer the peer that handed a task over, once it settled here. Nothing for a task no peer handed over. */
export function reportDelegatedOutcome(
  deps: DelegationDeps,
  input: { taskId: string; outcome: DelegationResult["outcome"]; message: string },
): boolean {
  const task = getTask(deps.db, input.taskId);
  if (task?.origin?.kind !== "delegated") return false;
  queueResult(deps, task.origin.peerNodeId, task.taskId, {
    outcome: input.outcome,
    message: input.message.slice(0, 1000) || input.outcome,
    ran: true,
  });
  return true;
}

export interface DelegateReceiveDeps extends DelegationDeps {
  /** The `origin` remote of a clone here, for the same repository check a local automation has. */
  readRemote: (path: string) => string | undefined;
  /** Hand an acknowledged task to this node's dispatcher. Called after the envelope is recorded. */
  startTask: (taskId: string, capabilityRef: CapabilityRef) => void;
  /** Tell this node's owner something about a peer's request, where they set up what it may do, or in the inbox. */
  tell: (text: string, conversationId?: string) => void;
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
  const taskId = envelope.taskId;
  if (taskId === undefined) return { accepted: false, reason: "a hand-over has to name the task" };

  const existing = getTask(deps.db, taskId);
  if (existing !== undefined) {
    // The same hand-over again, under any message id: the task it made is the answer.
    if (existing.origin?.kind === "delegated" && existing.origin.peerNodeId === peer) {
      return { accepted: true, taskId, duplicate: true };
    }
    return refuse(deps, peer, taskId, "a task with that id already exists here");
  }

  const read = delegationBriefSchema.safeParse(envelope.payload["taskBrief"]);
  if (!read.success) return refuse(deps, peer, taskId, "the hand-over is not one this node can read");
  const brief = read.data;

  const at = deps.now();
  // The grant as it arrived and was checked then, never a copy in this envelope.
  const grant = envelope.delegationId === undefined ? undefined : getGrant(deps.db, envelope.delegationId);
  if (grant === undefined || grant.senderNodeId !== peer || grant.receiverNodeId !== deps.identity.nodeId) {
    return refuse(deps, peer, taskId, "this node holds no grant from that peer under that id");
  }
  const allowance = livePeerAllowance(deps.db, peer, at);
  if (allowance === undefined) {
    deps.tell(
      `${peer} muốn chạy việc "${brief.summary}" trên máy này, nhưng bạn chưa cho phép node đó chạy việc ở đây nên việc không chạy. ` +
        "Nếu muốn, hãy nói với Clark những thư mục và quyền node đó được dùng.",
    );
    return refuse(deps, peer, taskId, "this node's owner has not allowed that peer to run tasks here");
  }

  const effective = intersectGrants(grant, { ...allowance.grant, grantId: grant.grantId });
  const capabilityRef = automationCapabilityFor({ kind: "task", goal: brief.goal, resources: brief.resources, allowedCategories: [] });
  for (const resource of brief.resources) {
    const check = checkGrant(effective, {
      capabilityRef,
      at,
      resource: grantResource(deps.identity.nodeId, resource),
      dataClass: "internal",
      delegationDepth: 0,
    });
    if (!check.allowed) {
      deps.tell(`${peer} muốn chạy việc "${brief.summary}" ở ${resource.path}, ngoài những gì bạn cho node đó, nên việc không chạy.`, allowance.conversationId);
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
  const repositories = brief.resources.flatMap((resource) => (resource.kind === "repository" ? [resource.path] : []));
  const refusal = repositoryBindingRefusal(trigger, repositories, deps.readRemote);
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
    resources: brief.resources,
  });
  const started = startTaskHere(coordination, taskId, capabilityRef);
  if (!started.ok) return refuse(deps, peer, taskId, started.reason);

  deps.tell(`${peer} giao việc "${brief.summary}" (task ${taskId}); nó đang chạy trên máy này trong phạm vi bạn đã cho phép.`, allowance.conversationId);
  // After this answer is recorded, so a node that stops first finds the task and the boot calls it uncertain.
  setImmediate(() => deps.startTask(taskId, capabilityRef));
  return { accepted: true, taskId, duplicate: false };
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
  deps: DelegationDeps,
  envelope: PeerEnvelope,
): { accepted: true; confirmed: boolean } | { accepted: false; reason: string } {
  const task = envelope.taskId === undefined ? undefined : getTask(deps.db, envelope.taskId);
  if (task?.origin?.kind !== "delegated" || task.origin.peerNodeId !== envelope.senderNodeId) {
    return { accepted: false, reason: "that peer handed this node no such task" };
  }
  const outcome = cancelTask({ db: deps.db, nodeId: deps.identity.nodeId, now: deps.now, newId: deps.newId }, task.taskId);
  if (!outcome.ok) return { accepted: false, reason: outcome.message };
  // A task nothing was running for stops at once, and the peer hears it here; a running one is answered when it settles.
  if (outcome.confirmed) queueResult(deps, envelope.senderNodeId, task.taskId, { outcome: "cancelled", message: "đã dừng theo yêu cầu", ran: true });
  return { accepted: true, confirmed: outcome.confirmed };
}
