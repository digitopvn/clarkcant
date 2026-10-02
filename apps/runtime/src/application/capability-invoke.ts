import {
  type CapabilityRef,
  describeUnsafePattern,
  type EffectCategory,
  effectCategorySchema,
  type Instant,
  MAX_PATTERN_INPUT_LENGTH,
  type MessageBlock,
  type JobRecord,
  nowInstant,
  overlongPatternInput,
  unsafeSchemaPattern,
} from "@clarkcant/contracts";
import {
  type ApprovalRecord,
  decideExecution,
  getCapability,
  readExecutionPolicy,
  recordEffectExecution,
  requestApproval,
} from "@clarkcant/core";
import { asJsonValue, type Database, oneRow, payloadDigest } from "@clarkcant/storage";
import { z } from "zod";

import { ServiceCallError, type ServiceHost } from "../service-host.ts";
import type { NodeServices } from "../services.ts";
import type { PackageJobHost, JobRunOutcome } from "../job-host.ts";

/**
 * Calling a package's service capability, whoever asked.
 *
 * A button in a widget, a sentence to the agent and a spoken command are three ways of asking for the same thing, and
 * they end here so that there is one answer to "may this run": the registry says whether it can, the capability's own
 * input schema says whether these arguments are ones it accepts, and the execution policy says whether it may. Only
 * then is the service called. A second path would not be a second interface to that gate; it would be a way around it.
 *
 * What this refuses, before anything runs:
 *
 *   - a ref this node's service host does not serve — another node's capability, a built-in one, or one whose package
 *     is no longer active;
 *   - a call made on behalf of a binding compiled against a generation that is no longer the active one;
 *   - a capability the registry reports as not usable, with the registry's own reason;
 *   - arguments its schema does not accept, and any argument at all when the schema holds a pattern that could take
 *     unbounded time to check (`schema-patterns.ts` in `@clarkcant/contracts`).
 *
 * When the policy asks, the question is a host-owned approval card in the conversation, bound to a digest of exactly
 * this ref and these arguments; nothing a widget or the model says can answer it.
 */

export type CapabilityInvokeSource = "widget" | "agent" | "voice";

export type CapabilityInvokeRefusal =
  | "CAPABILITY_MISSING"
  | "CAPABILITY_NOT_READY"
  | "CAPABILITY_NOT_AUTHENTICATED"
  | "NOT_A_SERVICE_CAPABILITY"
  | "BINDING_STALE"
  | "INVALID_INPUT"
  | "POLICY_REFUSED"
  | "APPROVAL_UNAVAILABLE"
  | "APPROVAL_STALE"
  | "SERVICE_NOT_RUNNING"
  | "SERVICE_TOOL_FAILED"
  | "SERVICE_UNREACHABLE"
  | "SERVICE_TIMED_OUT"
  | "SERVICE_CANCELLED"
  | "LEDGER_UNAVAILABLE"
  | "JOB_HOST_UNAVAILABLE"
  | "JOB_LIMIT_REACHED";

export type CapabilityInvokeOutcome =
  | { kind: "done"; ref: CapabilityRef; effectCategory: EffectCategory; output: string; description: string }
  | { kind: "job"; ref: CapabilityRef; effectCategory: EffectCategory; job: JobRecord; description: string }
  | {
      kind: "approval-required";
      approval: ApprovalRecord;
      /** The card to show; it carries the payload an approval runs. */
      card: Extract<MessageBlock, { type: "approval-card" }>;
    }
  | {
      kind: "refused";
      status: number;
      code: CapabilityInvokeRefusal;
      message: string;
      /**
       * Whether the call was written to the service before it failed. Every refusal decided on this node is `false`;
       * a service failure is `true` unless the transport knows the request never left (`ServiceCallError.sent`).
       */
      sent: boolean;
      /** The category the call was decided under, once it got that far. */
      effectCategory?: EffectCategory;
    };

export interface CapabilityInvokeDeps {
  db: Database;
  nodeId: string;
  principalId: string;
  newId: (prefix: string) => string;
  now?: () => Instant;
  serviceHost: ServiceHost | undefined;
  packageJobs?: PackageJobHost;
}

/** The node's own answer to every field, read at the call so a service started a moment ago is the one reached. */
export function capabilityInvokeDeps(
  services: Pick<NodeServices, "runtime" | "conductor" | "serviceHost" | "packageJobs">,
): CapabilityInvokeDeps {
  return {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    principalId: services.runtime.identity.ownerPrincipalId,
    newId: services.conductor.newId,
    serviceHost: services.serviceHost,
    ...(services.packageJobs === undefined ? {} : { packageJobs: services.packageJobs }),
  };
}

export interface CapabilityInvokeRequest {
  ref: string;
  args: Record<string, unknown>;
  source: CapabilityInvokeSource;
  conversationId?: string;
  /**
   * What a widget binding recorded as its package generation.
   *
   * When it names a generation of the package that provides the capability, the binding was made against that code
   * and does not reach a newer one. A binding that recorded something else — a widget definition's digest, which is
   * what a binding compiled without knowing the provider records — pinned no generation, and the registry alone decides.
   */
  bindingGeneration?: string;
  /**
   * Whether the policy's question has already been answered by a person on the host's approval card.
   *
   * Set only by `runApprovedCapability`, after `decideApproval` checked the decider and the digest.
   */
  approvedBy?: { approvalId: string; generation: string; effectCategory: EffectCategory };
  /** How long the service may take to answer, within the host's own ceiling. */
  timeoutMs?: number;
  /** Withdraws the call once it was sent: a person's Stop, or a workflow's deadline. */
  signal?: AbortSignal;
  /**
   * Called once the call is decided and about to be sent, with nothing awaited in between.
   *
   * The caller's chance to write down what is about to happen — a widget press opens its effect-ledger entry here — so
   * that a node which dies mid-call still has that record. When it throws, the call is not sent and the answer is
   * `LEDGER_UNAVAILABLE` with nothing sent.
   */
  beforeSend?: (call: { effectCategory: EffectCategory; description: string }) => void;
  /** Jobs are only started by a host-validated widget binding with a durable origin tuple. */
  jobOrigin?: JobOrigin;
  onJobSettled?: (outcome: JobRunOutcome) => void;
}

/**
 * The widget press a long-running capability call came from: its instance, its binding and the invocation id the
 * widget used. An approval for a job covers this too, so the job it starts belongs to that press and nothing else.
 */
export interface JobOrigin {
  instanceId: string;
  actionBindingId: string;
  invocationId?: string;
}

/** What an approval is also bound to besides the call: the code that would run it, and the effect it was shown as. */
export interface CapabilityApprovalContext {
  generation: string;
  effectCategory: EffectCategory;
  /** Present only for a long-running capability: the widget press whose job an approval would start. */
  jobOrigin?: JobOrigin;
}

/**
 * What an approval for a capability call is bound to: the ref, the arguments, the generation that would run them and
 * the effect the card showed. A newer package, or a service that now says it does more, is not what was approved.
 */
export function capabilityDigest(ref: string, args: Record<string, unknown>, context: CapabilityApprovalContext): string {
  return payloadDigest(
    asJsonValue({
      capabilityRef: ref,
      args,
      generation: context.generation,
      effectCategory: context.effectCategory,
      // Added only when present, so an approval for a request/response call keeps the digest it always had.
      ...(context.jobOrigin === undefined ? {} : { jobOrigin: canonicalOrigin(context.jobOrigin) }),
    }),
  );
}

function canonicalOrigin(origin: { instanceId: string; actionBindingId: string; invocationId?: string | undefined }): JobOrigin {
  return {
    instanceId: origin.instanceId,
    actionBindingId: origin.actionBindingId,
    ...(origin.invocationId === undefined ? {} : { invocationId: origin.invocationId }),
  };
}

const jobOriginSchema = z.strictObject({
  instanceId: z.string().min(1).max(128),
  actionBindingId: z.string().min(1).max(128),
  invocationId: z.string().min(1).max(128).optional(),
});

/** An approval card is left long enough to read and decide, and not so long it can be approved for a stale reason. */
const APPROVAL_TTL_MS = 15 * 60_000;
/** The card's payload field has a ceiling; arguments too large to show are too large to ask about. */
const PAYLOAD_LIMIT = 4000;
const OUTPUT_LIMIT = 16_000;

/** A refusal decided on this node, before anything was sent. */
function refused(status: number, code: CapabilityInvokeRefusal, message: string): CapabilityInvokeOutcome {
  return { kind: "refused", status, code, message, sent: false };
}

/** Why a schema refused the arguments, in one line a person or a model can act on. */
function schemaProblem(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length === 0 ? "input" : issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

export function validateArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): { ok: true } | { ok: false; message: string } {
  // A service that listed no schema accepts an object; that is all MCP promises about arguments.
  if (schema === undefined) return { ok: true };
  // Checked on every use, not only when the service registered the schema: a row an earlier version of the node wrote,
  // or a binding compiled against it, reaches here too, and a backtracking pattern would stall the node's main thread.
  const unsafe = unsafeSchemaPattern(schema);
  if (unsafe !== undefined) {
    return { ok: false, message: `the capability's input schema was refused: ${describeUnsafePattern(unsafe)}` };
  }
  const overlong = overlongPatternInput(schema, args);
  if (overlong !== undefined) {
    return {
      ok: false,
      message: `${overlong === "" ? "input" : overlong}: is longer than the ${String(MAX_PATTERN_INPUT_LENGTH)} characters a value checked against a pattern may have`,
    };
  }
  let parser: z.ZodType;
  try {
    parser = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    // A schema this node cannot read is not a reason to trust any input: the call is refused rather than unchecked.
    return { ok: false, message: "the capability's input schema could not be read, so no input can be checked against it" };
  }
  const parsed = parser.safeParse(args);
  return parsed.success ? { ok: true } : { ok: false, message: schemaProblem(parsed.error) };
}

/** Whether an id is one of the generations this node has recorded for a package, active or not. */
export function isGenerationOf(db: Database, packageId: string, generationId: string): boolean {
  return (
    oneRow(db, "SELECT 1 AS found FROM package_generations WHERE package_id = ? AND generation_id = ? LIMIT 1", packageId, generationId) !==
    undefined
  );
}

export async function invokeCapability(
  deps: CapabilityInvokeDeps,
  request: CapabilityInvokeRequest,
): Promise<CapabilityInvokeOutcome> {
  const now = deps.now ?? nowInstant;
  const ref = request.ref as CapabilityRef;
  const host = deps.serviceHost;
  const served = host?.serves(ref);
  if (host === undefined || served === undefined) {
    return refused(
      404,
      "NOT_A_SERVICE_CAPABILITY",
      `${request.ref} is not a service capability of an active package on this node`,
    );
  }
  if (
    request.bindingGeneration !== undefined &&
    request.bindingGeneration !== served.generationId &&
    isGenerationOf(deps.db, served.packageId, request.bindingGeneration)
  ) {
    return refused(
      409,
      "BINDING_STALE",
      "the package behind this action changed since the action was made; ask for the widget again",
    );
  }

  const descriptor = getCapability({ db: deps.db, nodeId: deps.nodeId }, ref, deps.nodeId);
  if (descriptor === undefined) {
    return refused(404, "CAPABILITY_MISSING", `capability ${request.ref} is not registered on this node yet`);
  }
  const { readiness } = descriptor;
  const execution = host.execution?.(ref);
  if (execution?.kind === "job") {
    if (deps.packageJobs === undefined || request.jobOrigin === undefined || request.bindingGeneration === undefined) {
      return refused(503, "JOB_HOST_UNAVAILABLE", "this long-running capability needs its originating widget binding and node job host");
    }
    if (!deps.packageJobs.canAdmit()) {
      return refused(429, "JOB_LIMIT_REACHED", "the node is at its active package job limit; this job was not sent");
    }
  }
  if (!readiness.authenticated) {
    return refused(409, "CAPABILITY_NOT_AUTHENTICATED", `capability ${request.ref} needs its connection signed in`);
  }
  if (!(readiness.installed && readiness.loaded && readiness.authorized && readiness.healthy)) {
    return refused(
      503,
      "CAPABILITY_NOT_READY",
      `${descriptor.summary} is not available: ${readiness.blockedReason ?? "the service is not ready"}`,
    );
  }

  const checked = validateArgs(descriptor.inputSchema, request.args);
  if (!checked.ok) return refused(400, "INVALID_INPUT", `${request.ref} does not accept that input: ${checked.message}`);

  const context: CapabilityApprovalContext = {
    generation: served.generationId,
    effectCategory: descriptor.effectCategory,
    ...(execution?.kind === "job" && request.jobOrigin !== undefined ? { jobOrigin: request.jobOrigin } : {}),
  };
  const approvedBy = request.approvedBy;
  if (
    approvedBy !== undefined &&
    (approvedBy.generation !== context.generation || approvedBy.effectCategory !== context.effectCategory)
  ) {
    const change =
      approvedBy.generation !== context.generation ? "its package was updated" : `it is now ${context.effectCategory}`;
    return refused(409, "APPROVAL_STALE", `${request.ref} changed since it was approved (${change}); nothing was run — ask again`);
  }
  const operationDigest = capabilityDigest(request.ref, request.args, context);
  const description = `${descriptor.summary} (${request.ref}, ${request.source})`;
  const policy = readExecutionPolicy({ db: deps.db, now }, deps.principalId);
  const policyDecision = decideExecution({
    policy,
    action: { kind: "effect", category: descriptor.effectCategory, operationDigest },
    // A click, a sentence or a spoken command is the person asking; the policy still decides whether that is
    // enough, and a prohibition or a hard boundary is read before the intent matters.
    intent: { kind: "interactive" },
  });
  // An approval answers the policy's question; it does not outrank a refusal the person set after the card was shown.
  const decided =
    approvedBy === undefined || policyDecision.kind === "deny"
      ? policyDecision
      : ({
          kind: "execute",
          reason: `approved by the person on the host's card ${approvedBy.approvalId}`,
          audit: true,
        } as const);

  if (decided.kind === "deny") return refused(403, "POLICY_REFUSED", decided.reason);

  if (decided.kind === "ask") {
    // `source` is for the receipt only; the digest covers the ref and the arguments, which are what would run.
    const payload = JSON.stringify({
      kind: "capability",
      capabilityRef: request.ref,
      args: request.args,
      source: request.source,
      generation: context.generation,
      effectCategory: context.effectCategory,
      ...(context.jobOrigin === undefined ? {} : { jobOrigin: canonicalOrigin(context.jobOrigin) }),
    });
    if (payload.length > PAYLOAD_LIMIT) {
      return refused(
        400,
        "APPROVAL_UNAVAILABLE",
        `${decided.reason}; the input is too large to show on an approval card, so nothing was run`,
      );
    }
    const approval = requestApproval(
      { db: deps.db, nodeId: deps.nodeId, now, newId: deps.newId },
      {
        operationDigest,
        operationDescription: `Gọi ${descriptor.summary} (${request.ref})`,
        effectCategory: descriptor.effectCategory,
        ttlMs: APPROVAL_TTL_MS,
      },
    );
    return {
      kind: "approval-required",
      approval,
      card: {
        type: "approval-card",
        owner: "host",
        approvalId: approval.approvalId,
        operationDescription: approval.operationDescription,
        operationDigest: approval.operationDigest,
        payload,
        effectCategory: descriptor.effectCategory,
        expiresAt: approval.expiresAt,
        decider: approval.decider,
        decision: approval.decision,
      } as Extract<MessageBlock, { type: "approval-card" }>,
    };
  }

  if (request.beforeSend !== undefined) {
    try {
      request.beforeSend({ effectCategory: descriptor.effectCategory, description });
    } catch (cause) {
      return refused(
        503,
        "LEDGER_UNAVAILABLE",
        `this node could not record the call before sending it (${cause instanceof Error ? cause.message : String(cause)}); nothing was sent`,
      );
    }
  }

  // Written before the call, so a node that dies mid-call still shows what it started.
  recordEffectExecution(
    { db: deps.db, nodeId: deps.nodeId, now, newId: deps.newId },
    {
      principalId: deps.principalId,
      mode: policy.mode,
      decision: decided,
      category: descriptor.effectCategory,
      operationDigest,
      description,
      ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
    },
  );

  try {
    if (execution?.kind === "job") {
      const origin = request.jobOrigin;
      const packageJobs = deps.packageJobs;
      if (origin === undefined || packageJobs === undefined) {
        return refused(503, "JOB_HOST_UNAVAILABLE", "the node could not start this package job; nothing was sent");
      }
      let job: JobRecord;
      try {
        job = packageJobs.start({
        job: {
          jobId: deps.newId("job") as JobRecord["jobId"],
          nodeId: deps.nodeId,
          ownerPrincipalId: deps.principalId as JobRecord["ownerPrincipalId"],
          ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId as JobRecord["conversationId"] }),
          instanceId: origin.instanceId,
          actionBindingId: origin.actionBindingId,
          packageId: served.packageId as JobRecord["packageId"],
          // The generation of the binding that authorized the press, so every later read is checked against the same
          // tuple the press was. A binding made for another known generation was refused as stale above.
          packageGeneration: request.bindingGeneration ?? served.generationId,
          capabilityRef: ref,
          effectCategory: descriptor.effectCategory,
        },
        // A press's deadline bounds how long the press waits for an answer, and a job answers at once with its ref; the
        // job itself runs under the service host's job ceiling, and Stop, emergency Stop and shutdown still end it.
        run: (signal, onProgress) => host.call(ref, request.args, { signal, onProgress }),
        ...(request.onJobSettled === undefined ? {} : { onSettled: request.onJobSettled }),
        });
      } catch (cause) {
        // The job host refuses before the service request is dispatched, so nothing reached the service.
        return refused(
          503,
          "JOB_HOST_UNAVAILABLE",
          `the node could not start this package job (${cause instanceof Error ? cause.message : String(cause)}); nothing was sent`,
        );
      }
      return { kind: "job", ref, effectCategory: descriptor.effectCategory, job, description };
    }
    const result = await host.call(ref, request.args, {
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    return {
      kind: "done",
      ref,
      effectCategory: descriptor.effectCategory,
      output: result.content.slice(0, OUTPUT_LIMIT),
      description,
    };
  } catch (cause) {
    if (cause instanceof ServiceCallError) {
      const status =
        cause.code === "SERVICE_TOOL_FAILED"
          ? 502
          : cause.code === "SERVICE_NOT_RUNNING"
            ? 503
            : cause.code === "SERVICE_CANCELLED"
              ? 409
              : 504;
      return { kind: "refused", status, code: cause.code, message: cause.message, sent: cause.sent, effectCategory: descriptor.effectCategory };
    }
    // An error this layer does not know came from inside the call, so the request may have left: said as sent.
    return {
      kind: "refused",
      status: 504,
      code: "SERVICE_UNREACHABLE",
      message: cause instanceof Error ? cause.message : String(cause),
      sent: true,
      effectCategory: descriptor.effectCategory,
    };
  }
}

/** Whether an approval card's payload is a capability call rather than a command. */
export function isCapabilityPayload(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as { kind?: unknown };
    return parsed.kind === "capability";
  } catch {
    return false;
  }
}

/**
 * The host's re-check of the widget press an approved job names, made when the approval is used rather than trusted
 * from the card: the instance must still be in this conversation and the person's, and the binding must still be its
 * `invoke` binding for this capability. Its answer is the generation the binding was compiled against.
 */
export type ApprovedJobOriginCheck = (
  origin: JobOrigin,
  ref: string,
) => { ok: true; bindingGeneration: string } | { ok: false; message: string };

/** The effect-ledger hooks a caller wraps around the call, the same ones a widget press uses. */
export type CapabilityLedgerHooks = Pick<CapabilityInvokeRequest, "beforeSend" | "onJobSettled">;

/**
 * Run a capability call a person approved on the host's card.
 *
 * The payload is the card's own, and it is hashed again against the digest the decision covered before anything
 * runs; the registry and the arguments are checked again too, because a service can stop between the question and the
 * answer. A long-running capability's card also names the widget press it came from; that press is checked again by
 * `checkJobOrigin`, and the job it starts belongs to it.
 */
export async function runApprovedCapability(
  deps: CapabilityInvokeDeps,
  input: {
    payload: string;
    expectedDigest: string;
    approvalId: string;
    conversationId: string;
    checkJobOrigin?: ApprovedJobOriginCheck;
    ledger?: (call: { ref: string; args: Record<string, unknown> }) => CapabilityLedgerHooks;
  },
): Promise<
  | {
      ok: true;
      blocks: MessageBlock[];
      description: string;
      succeeded: boolean;
      /** What the call came back with, so the caller can settle the ledger entry its hooks opened. */
      outcome: CapabilityInvokeOutcome;
      job?: { record: JobRecord; origin: JobOrigin };
    }
  | { ok: false; code: string; message: string }
> {
  let parsed: {
    capabilityRef?: unknown;
    args?: unknown;
    source?: unknown;
    generation?: unknown;
    effectCategory?: unknown;
    jobOrigin?: unknown;
  };
  try {
    parsed = JSON.parse(input.payload) as typeof parsed;
  } catch {
    return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload is not readable" };
  }
  const ref = typeof parsed.capabilityRef === "string" ? parsed.capabilityRef : "";
  const args =
    parsed.args !== null && typeof parsed.args === "object" && !Array.isArray(parsed.args)
      ? (parsed.args as Record<string, unknown>)
      : undefined;
  const generation = typeof parsed.generation === "string" ? parsed.generation : "";
  const effect = effectCategorySchema.safeParse(parsed.effectCategory);
  const origin = parsed.jobOrigin === undefined ? undefined : jobOriginSchema.safeParse(parsed.jobOrigin);
  if (ref === "" || args === undefined || generation === "" || !effect.success || origin?.success === false) {
    return { ok: false, code: "APPROVAL_PAYLOAD_UNREADABLE", message: "the approved payload names no capability" };
  }
  const jobOrigin = origin?.data === undefined ? undefined : canonicalOrigin(origin.data);
  const context: CapabilityApprovalContext = {
    generation,
    effectCategory: effect.data,
    ...(jobOrigin === undefined ? {} : { jobOrigin }),
  };
  if (capabilityDigest(ref, args, context) !== input.expectedDigest) {
    return {
      ok: false,
      code: "APPROVAL_FORGED",
      message: "the operation changed after it was displayed; the decision does not cover what would run",
    };
  }
  let bindingGeneration: string | undefined;
  if (jobOrigin !== undefined) {
    const checked = input.checkJobOrigin?.(jobOrigin, ref) ?? {
      ok: false as const,
      message: "this node cannot check the widget this job was approved for",
    };
    if (!checked.ok) {
      return { ok: false, code: "APPROVAL_STALE", message: `${checked.message}; nothing was run — ask again from the widget` };
    }
    bindingGeneration = checked.bindingGeneration;
  }

  const now = deps.now ?? nowInstant;
  const startedAt = now();
  const outcome = await invokeCapability(deps, {
    ref,
    args,
    source: parsed.source === "widget" || parsed.source === "voice" ? parsed.source : "agent",
    conversationId: input.conversationId,
    approvedBy: { approvalId: input.approvalId, generation, effectCategory: effect.data },
    ...(jobOrigin === undefined ? {} : { jobOrigin }),
    ...(bindingGeneration === undefined ? {} : { bindingGeneration }),
    ...(input.ledger?.({ ref, args }) ?? {}),
  });
  const succeeded = outcome.kind === "done" || outcome.kind === "job";
  const result =
    outcome.kind === "done"
      ? outcome.output
      : outcome.kind === "job"
        ? `job ${outcome.job.jobId}`
        : outcome.kind === "refused"
          ? outcome.message
          : "not run";
  const label =
    outcome.kind === "job" ? `Đã bắt đầu job cho ${ref}` : succeeded ? `Đã gọi ${ref}` : `Không gọi được ${ref}`;
  const block: MessageBlock = {
    type: "tool-activity",
    toolCallId: `invoke-${input.approvalId}`,
    name: "invoke_capability",
    label,
    status: succeeded ? "done" : "failed",
    // The approval id travels with the receipt so the card it answered reads as decided, including after a reload.
    args: {
      capabilityRef: ref,
      approvalId: input.approvalId,
      decision: "granted",
      outcome: outcome.kind === "job" ? "job" : succeeded ? "done" : "refused",
      ...(outcome.kind === "job" ? { jobId: outcome.job.jobId } : {}),
    },
    result,
    startedAt,
    endedAt: now(),
  } as MessageBlock;
  return {
    ok: true,
    blocks: [block],
    description: outcome.kind === "job" ? `started job ${outcome.job.jobId} for ${ref}` : succeeded ? `invoked ${ref}` : `could not invoke ${ref}: ${result}`,
    succeeded,
    outcome,
    ...(outcome.kind === "job" && jobOrigin !== undefined ? { job: { record: outcome.job, origin: jobOrigin } } : {}),
  };
}
