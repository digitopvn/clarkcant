import { readNodeView, type SemanticProposal, type WidgetPerformReport, widgetDevSessionViewSchema } from "@clarkcant/contracts";
import type { FrameActionOutcome, FrameJobBroker, FrameStateOutcome, FrameTokenOutcome } from "@clarkcant/widget-host/session";
import type { BrowserToken, JobSnapshot, TokenRequest } from "@clarkcant/widget-sdk";

import { actionRefusalMessage, pressMayHaveRun } from "./action-messages.ts";
import {
  type ActionInvocationResult,
  type GatewayClient,
  GatewayError,
  type IsolatedFrameLiveResponse,
  readArtifactRange,
  readArtifactRef,
  readAttachedArtifact,
  readBrowserToken,
  readWidgetJob,
  readWidgetJobs,
} from "./api.ts";
import { DesktopFileError } from "./artifact-messages.ts";
import type { DesktopDialogLabels } from "./download.ts";
import type { MessageKey } from "./i18n/messages.ts";
import type { WidgetArtifactFiles } from "./widget-artifacts.tsx";
import type { WidgetDevStatusView } from "./widget-dev-status.tsx";

/**
 * What a widget in its own frame is told about its writes and presses, decided in one place.
 *
 * The frame runs in two hosts: the conversation, which reaches the node with its own credential, and a detached desktop
 * window, which holds none and asks the desktop host to relay each request. The two transports differ; what the widget
 * hears back must not. A stale state write carries the state the node holds in both, a refused press reads the same in
 * both, and a press waiting on an approval, or sent with no answer, is "uncertain" in both. So the outcomes are mapped here, from a
 * `GatewayError`, and each host only turns its own transport's refusal into one (`relayRefusalError`).
 */

type Translate = (key: MessageKey) => string;

/** A refusal as a desktop relay answers it: the node's code and details, kept, beside the sentence. */
export interface RelayRefusal {
  ok: false;
  refused?: string | undefined;
  code?: string | undefined;
  details?: Record<string, unknown> | undefined;
}

/**
 * A relay's refusal as the error the conversation's own client would have thrown for it, so both hosts map one shape.
 *
 * There is no HTTP status on a relay answer, so it is 0; nothing below reads it.
 */
export function relayRefusalError(answer: RelayRefusal): GatewayError {
  return new GatewayError(0, answer.code ?? "RELAY_REFUSED", answer.refused ?? "the desktop host refused the request", answer.details ?? {});
}

/** A state write the node refused, as the frame session tells the widget: with what the node holds, when it said. */
export function stateRefusalOutcome(cause: unknown): FrameStateOutcome {
  if (cause instanceof GatewayError) {
    const committed = cause.details["state"];
    const revision = cause.details["stateRevision"];
    return {
      ok: false,
      code: cause.code,
      message: typeof cause.details["message"] === "string" ? cause.details["message"] : cause.message,
      ...(typeof revision === "number" ? { stateRevision: revision } : {}),
      ...(typeof committed === "object" && committed !== null && !Array.isArray(committed)
        ? { state: committed as Record<string, unknown> }
        : {}),
    };
  }
  return { ok: false, code: "STATE_NOT_SAVED", message: cause instanceof Error ? cause.message : String(cause) };
}

/** A press as the frame asks for one. */
export interface FramePress {
  actionBindingId: string;
  input: Record<string, unknown>;
  expectedRevision: number;
  invocationId: string;
}

/** How one host reaches the node for a frame. Each throws a `GatewayError` for a refusal. */
export interface FrameHostTransport {
  saveState(write: { expectedRevision: number; patch: Record<string, unknown> }): Promise<{ stateRevision: number; state: Record<string, unknown> }>;
  publishSemantic(proposal: SemanticProposal, signal: AbortSignal): Promise<void>;
  /** Perform a press on a binding the instance holds; `binding` is the one the frame named. */
  invokeAction(
    press: FramePress,
    binding: IsolatedFrameLiveResponse["bindings"][number],
  ): Promise<Pick<ActionInvocationResult, "approvalRequired" | "output"> & Partial<Pick<ActionInvocationResult, "timeline">>>;
}

/** A relay's answer: what the verb returns, or the refusal. */
type RelayAnswer<Done> = ({ ok: true } & Done) | RelayRefusal;

/**
 * The relays a detached window's preload exposes for a widget in its own frame (`detached-preload.cjs`).
 *
 * None of them takes an instance, a conversation or a credential: the host performs each against the one instance it
 * opened the window for, with its own token.
 */
export interface DetachedFrameBridge {
  frameRead(): Promise<RelayAnswer<{ live?: IsolatedFrameLiveResponse }>>;
  saveState(write: { expectedRevision: number; patch: Record<string, unknown> }): Promise<
    RelayAnswer<{ saved?: { stateRevision: number; state: Record<string, unknown> } }>
  >;
  publishSemantic(input: { proposal: SemanticProposal }): Promise<RelayAnswer<object>>;
  intent(input: {
    instanceRef: string;
    actionBindingId: string;
    expectedRevision: number;
    input: Record<string, unknown>;
    invocationId?: string;
  }): Promise<RelayAnswer<{ result?: unknown }>>;
  devSession(): Promise<RelayAnswer<{ view?: unknown }>>;
  /** The frame's files, one verb each. A pick and an export open the OS dialog over the window; no path comes back. */
  artifacts: DetachedArtifactBridge;
  jobs: {
    get(input: { jobId: string }): Promise<RelayAnswer<{ job?: unknown }>>;
    list(): Promise<RelayAnswer<{ jobs?: unknown }>>;
    cancel(input: { jobId: string }): Promise<RelayAnswer<object>>;
  };
  tokens: {
    request(input: { session: string; request: TokenRequest }): Promise<RelayAnswer<{ token?: unknown }>>;
    end(input: { session: string }): Promise<RelayAnswer<object>>;
  };
  /** Told when the installed packages changed, so the window re-reads its frame. Returns the unsubscribe. */
  onPackagesChanged?(listener: () => void): () => void;
  /**
   * Told of each action Clark asks the widget to perform, as the host pushes it (`{ performId, action, input }`), so the
   * window asks its frame. Returns the unsubscribe. Absent in a window whose host cannot forward a perform.
   */
  onPerform?(listener: (push: unknown) => void): () => void;
  /** What the frame answered, for the host to report to the node; the host refuses an id it did not push. */
  reportPerform?(answer: { performId: string; report: WidgetPerformReport }): Promise<RelayAnswer<object>>;
}

/** What an answer naming an artifact carries: the node's reference, passed on for the window to parse. */
type RefAnswer = RelayAnswer<{ artifactRef?: unknown }>;

/**
 * A desktop dialog's refusal, as the host relays it: a fixed code, at most the file system's own code, and `desktop`
 * set, so it is worded as the desktop's rather than as the node's.
 */
export interface DesktopRelayRefusal {
  ok: false;
  desktop: true;
  refused?: string | undefined;
  errorCode?: string | undefined;
}

export interface DetachedArtifactBridge {
  pick(input: { accept: readonly string[]; title?: string; filterName?: string }): Promise<
    RelayAnswer<{ canceled?: boolean; artifactRef?: unknown; original?: { name?: unknown } }> | DesktopRelayRefusal
  >;
  describe(input: { artifactId: string }): Promise<RefAnswer>;
  create(input: { mimeType: string; name?: string }): Promise<RefAnswer>;
  read(input: { artifactId: string; offset: number; length: number }): Promise<
    RelayAnswer<{ artifactRef?: unknown; contentBase64?: unknown; eof?: unknown }>
  >;
  write(input: { artifactId: string; offset: number; chunkBase64: string }): Promise<RefAnswer>;
  finalize(input: { artifactId: string }): Promise<RefAnswer>;
  export(input: { artifactId: string; suggestedName: string; replace?: boolean; labels?: DesktopDialogLabels }): Promise<
    RelayAnswer<{ canceled?: boolean; saved?: boolean; name?: string }> | DesktopRelayRefusal
  >;
  attach(input: { artifactId: string; name?: string }): Promise<RelayAnswer<{ artifactRef?: unknown; attachmentRef?: unknown }>>;
  discard(input: { artifactId: string }): Promise<RelayAnswer<object>>;
}

/** A relay's answer, or the error the conversation's client would have thrown for its refusal. */
function relayed<Done extends object>(answer: RelayAnswer<Done> | DesktopRelayRefusal): { ok: true } & Done {
  if (answer.ok) return answer;
  if ("desktop" in answer && answer.desktop) throw new DesktopFileError(answer.refused ?? "DESKTOP_FAILED", answer.errorCode);
  throw relayRefusalError(answer);
}

/**
 * The files a widget in a detached window works with, through the desktop host's relays.
 *
 * Every answer is read by the same functions the conversation's client reads the node's with, so a malformed one is
 * refused the same way in both windows. A pick and a save happen in the host: the window learns the node's reference
 * and the file's bare name, or whether the file was saved, never where.
 */
export function detachedArtifactFiles(bridge: DetachedArtifactBridge): WidgetArtifactFiles {
  return {
    desktop: true,
    describe: async (artifactId) => readArtifactRef(relayed(await bridge.describe({ artifactId }))),
    create: async (input) => readArtifactRef(relayed(await bridge.create(input))),
    read: async (artifactId, range) => readArtifactRange(relayed(await bridge.read({ artifactId, ...range }))),
    write: async (artifactId, chunk) =>
      readArtifactRef(relayed(await bridge.write({ artifactId, offset: chunk.offset, chunkBase64: chunk.contentBase64 }))),
    finalize: async (artifactId) => readArtifactRef(relayed(await bridge.finalize({ artifactId }))),
    attach: async (artifactId, options) =>
      readAttachedArtifact(relayed(await bridge.attach({ artifactId, ...(options.name === undefined ? {} : { name: options.name }) }))),
    discard: async (artifactId) => {
      relayed(await bridge.discard({ artifactId }));
    },
    pickOnDesktop: async (input) => {
      const answer = relayed(await bridge.pick(input));
      if (answer.canceled === true) return { canceled: true };
      const ref = readArtifactRef(answer);
      const name = typeof answer.original?.name === "string" ? answer.original.name : ref.name;
      // No handle: the host keeps the path, and writes back over it when a save asks to replace.
      return { canceled: false, ref, original: { name, mimeType: ref.mimeType } };
    },
    save: async ({ ref, suggestedName, original, labels }) => {
      const answer = relayed(
        await bridge.export({ artifactId: ref.artifactId, suggestedName, ...(original === undefined ? {} : { replace: true }), labels }),
      );
      if (answer.canceled === true) return { outcome: "cancelled", name: suggestedName };
      if (answer.saved !== true) throw new DesktopFileError("WRITE_FAILED");
      return { outcome: "saved", name: typeof answer.name === "string" ? answer.name : suggestedName };
    },
  };
}

/** How one host reaches the node for a frame's jobs. Each throws a `GatewayError` for a refusal. */
export interface FrameJobTransport {
  get(jobId: string): Promise<JobSnapshot>;
  list(): Promise<JobSnapshot[]>;
  cancel(jobId: string): Promise<void>;
}

/** The detached window's job transport: the host's relays, read as the conversation's client reads the node. */
export function detachedJobTransport(bridge: DetachedFrameBridge["jobs"]): FrameJobTransport {
  return {
    get: async (jobId) => readWidgetJob(relayed(await bridge.get({ jobId }))),
    list: async () => readWidgetJobs(relayed(await bridge.list())),
    cancel: async (jobId) => {
      relayed(await bridge.cancel({ jobId }));
    },
  };
}

/** The conversation window's job transport: its own client, against the instance it shows. */
export function shellJobTransport(client: GatewayClient, conversationId: string, instanceId: string): FrameJobTransport {
  return {
    get: (jobId) => client.getWidgetJob(conversationId, instanceId, jobId),
    list: () => client.listWidgetJobs(conversationId, instanceId),
    cancel: (jobId) => client.cancelWidgetJob(conversationId, instanceId, jobId),
  };
}

/** The `jobs@1` broker a `WidgetFrame` is given, over one host's transport: the same answers in both windows. */
export function frameJobBroker(transport: FrameJobTransport): FrameJobBroker {
  return async (request) => {
    try {
      if (request.op === "list") return { status: "ok", jobs: await transport.list() };
      if (request.op === "cancel") await transport.cancel(request.jobId);
      return { status: "ok", job: await transport.get(request.jobId) };
    } catch (cause) {
      return {
        status: "refused",
        code: cause instanceof GatewayError ? cause.code : "JOB_UNAVAILABLE",
        message: cause instanceof Error ? cause.message : "the job is unavailable to this widget",
      };
    }
  };
}

/** How one host reaches the node for a frame's browser tokens. `request` throws a `GatewayError` for a refusal. */
export interface FrameTokenTransport {
  request(session: string, request: TokenRequest): Promise<BrowserToken>;
  end(session: string): Promise<void>;
}

/** The detached window's token transport: the host's relays, which record the session so the host can end it too. */
export function detachedTokenTransport(bridge: DetachedFrameBridge["tokens"]): FrameTokenTransport {
  return {
    request: async (session, request) => readBrowserToken(relayed(await bridge.request({ session, request }))),
    end: async (session) => {
      relayed(await bridge.end({ session }));
    },
  };
}

/** The conversation window's token transport: its own client, against the instance it shows. */
export function shellTokenTransport(client: GatewayClient, conversationId: string, instanceId: string): FrameTokenTransport {
  return {
    request: (session, request) => client.requestBrowserToken(conversationId, instanceId, session, request),
    end: (session) => client.endBrowserTokens(conversationId, instanceId, session),
  };
}

/** Whether a frame is offered `tokens@1`: only when its package declared the browser tokens it may ask for. */
export function offersBrowserTokens(frame: { browserTokens?: readonly unknown[] | undefined }): boolean {
  return Array.isArray(frame.browserTokens) && frame.browserTokens.length > 0;
}

/** The `tokens` a `WidgetFrame` is given, over one host's transport: the same answers in both windows. */
export function frameTokenBroker(transport: FrameTokenTransport): {
  request: (request: TokenRequest, session: string) => Promise<FrameTokenOutcome>;
  release: (session: string) => void;
} {
  return {
    request: async (request, session) => {
      try {
        return { status: "ok", token: await transport.request(session, request) };
      } catch (cause) {
        return {
          status: "refused",
          code: cause instanceof GatewayError ? cause.code : "TOKEN_UNAVAILABLE",
          message: cause instanceof Error ? cause.message : "no token is available to this widget",
        };
      }
    },
    // The frame is gone either way; a failed revoke still lapses at the token's own expiry.
    release: (session) => {
      void transport.end(session).catch(() => undefined);
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The detached window's transport: each request is a relay, and each refusal the host relays becomes the error the
 * conversation's client would have thrown, so `frameHostCallbacks` tells the widget the same thing in both windows.
 *
 * There is no timeline here: an approval card, or anything else a press puts in the conversation, appears in the
 * conversation window, which the frame cannot reach from either.
 */
export function detachedFrameTransport(bridge: DetachedFrameBridge, instanceRef: string): FrameHostTransport {
  return {
    saveState: async (write) => {
      const answer = await bridge.saveState(write);
      if (!answer.ok) throw relayRefusalError(answer);
      if (answer.saved === undefined) throw relayRefusalError({ ok: false, code: "MALFORMED_RESPONSE", refused: "the host answered without the saved state" });
      return answer.saved;
    },
    /*
     * A relay cannot be called back once sent, so giving up is said to the frame when `signal` aborts and the host's own
     * bound ends the request; a refusal that arrives later has nobody waiting for it.
     */
    publishSemantic: (proposal, signal) =>
      new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("the publish was given up"));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        bridge.publishSemantic({ proposal }).then(
          (answer) => {
            signal.removeEventListener("abort", abort);
            if (answer.ok) resolve();
            else reject(relayRefusalError(answer));
          },
          (cause: unknown) => {
            signal.removeEventListener("abort", abort);
            reject(cause instanceof Error ? cause : new Error(String(cause)));
          },
        );
      }),
    // The host resolves the binding's digest from its own newest read, so only the frame's words travel.
    invokeAction: async (press) => {
      const answer = await bridge.intent({
        instanceRef,
        actionBindingId: press.actionBindingId,
        expectedRevision: press.expectedRevision,
        input: press.input,
        invocationId: press.invocationId,
      });
      if (!answer.ok) {
        /*
         * The host stopped waiting, not the node: the press was sent and the node may still take its effect. That is
         * the node's own "uncertain" for a call whose answer never came, so it is said the same way, never "refused".
         */
        if (answer.code === "NODE_TIMEOUT") throw relayRefusalError({ ...answer, details: { ...answer.details, outcome: "uncertain" } });
        throw relayRefusalError(answer);
      }
      const result = isRecord(answer.result) ? answer.result : {};
      const approval = result["approvalRequired"];
      const output = result["output"];
      return {
        ...(isRecord(approval) && typeof approval["approvalId"] === "string" ? { approvalRequired: { approvalId: approval["approvalId"] } } : {}),
        ...(typeof output === "string" ? { output } : {}),
      };
    },
  };
}

/** A session as the detached window reads it: the conversation's view without the folder path or the placement. */
const detachedDevViewSchema = widgetDevSessionViewSchema.omit({ root: true, placed: true });

/**
 * The widget dev status's client in a detached window: the host's relay, read as strictly as the conversation reads
 * the node. The session id is not sent: the host reads the session its own newest frame read named.
 */
export function detachedDevStatusClient(bridge: Pick<DetachedFrameBridge, "devSession">): {
  widgetDevSession: (sessionId: string) => Promise<WidgetDevStatusView>;
} {
  return {
    widgetDevSession: async () => {
      const answer = await bridge.devSession();
      if (!answer.ok) throw relayRefusalError(answer);
      const read = readNodeView(detachedDevViewSchema, answer.view);
      if (!read.success) {
        throw relayRefusalError({ ok: false, code: "MALFORMED_RESPONSE", refused: "the widget dev session's status could not be read" });
      }
      return read.unreadFields === undefined ? read.data : { ...read.data, unreadFields: read.unreadFields };
    },
  };
}

export interface FrameHostCallbacks {
  persistState: (write: { expectedRevision: number; patch: Record<string, unknown> }) => Promise<FrameStateOutcome>;
  publishSemantic: (proposal: SemanticProposal, signal: AbortSignal) => Promise<void>;
  invokeAction: (press: FramePress) => Promise<FrameActionOutcome>;
}

/**
 * The callbacks a `WidgetFrame` is given, over one host's transport.
 *
 * - Every durable write goes to the node and is answered from there: the widget is told its state was saved only when
 *   the node committed it, and a refusal comes back with what the node holds.
 * - A press names a binding the instance holds, or is refused before anything is sent. Nothing that waits on an
 *   approval is called a success: the outcome is on a card in the conversation, which the frame cannot reach.
 */
export function frameHostCallbacks(input: {
  transport: FrameHostTransport;
  bindings: IsolatedFrameLiveResponse["bindings"];
  t: Translate;
  /** Told what a press put in the conversation (an approval card, a reply), where the host shows it. */
  onTimeline?: (timeline: ActionInvocationResult["timeline"]) => void;
  /** Told when a press was refused: the refusal may be a service that stopped, which a re-read shows. */
  onPressRefused?: () => void;
}): FrameHostCallbacks {
  const { transport, bindings, t } = input;
  return {
    persistState: async (write) => {
      try {
        const saved = await transport.saveState(write);
        return { ok: true, stateRevision: saved.stateRevision, state: saved.state };
      } catch (cause) {
        return stateRefusalOutcome(cause);
      }
    },
    publishSemantic: (proposal, signal) => transport.publishSemantic(proposal, signal),
    invokeAction: async (press) => {
      // The digest the node re-authorizes against is the named binding's, never a composition's.
      const binding = bindings.find((entry) => entry.actionBindingId === press.actionBindingId);
      if (binding === undefined) return { status: "refused", message: t("shell.live.actionUnbound") };
      try {
        const result = await transport.invokeAction(press, binding);
        if (result.timeline !== undefined) input.onTimeline?.(result.timeline);
        if (result.approvalRequired !== undefined) {
          return { status: "uncertain", message: t("shell.live.actionAwaitingApproval") };
        }
        return { status: "accepted", message: t("shell.live.actionSent"), ...(result.output === undefined ? {} : { output: result.output }) };
      } catch (cause) {
        /*
         * Sent, and it may have taken effect: uncertain, so nobody is invited to press twice. The widget shows the
         * node's own sentence, as it shows every other answer. Only a desktop host that stopped waiting has none, and
         * the host says it.
         */
        if (cause instanceof GatewayError && pressMayHaveRun(cause.details)) {
          const message =
            cause.code === "NODE_TIMEOUT"
              ? actionRefusalMessage(t, { code: cause.code, reason: cause.reason, details: cause.details })
              : cause.message;
          return { status: "uncertain", message };
        }
        input.onPressRefused?.();
        return { status: "refused", message: cause instanceof Error ? cause.message : t("shell.live.actionRefusedGeneric") };
      }
    },
  };
}
