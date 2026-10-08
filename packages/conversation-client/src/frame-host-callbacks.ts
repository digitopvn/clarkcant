import { readNodeView, type SemanticProposal, widgetDevSessionViewSchema } from "@clarkcant/contracts";
import type { FrameActionOutcome, FrameStateOutcome } from "@clarkcant/widget-host/session";

import { actionRefusalMessage, pressMayHaveRun } from "./action-messages.ts";
import { type ActionInvocationResult, GatewayError, type IsolatedFrameLiveResponse } from "./api.ts";
import type { MessageKey } from "./i18n/messages.ts";
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
        // Sent, and it may have taken effect: said as the conversation says it, so nobody is invited to press twice.
        if (cause instanceof GatewayError && pressMayHaveRun(cause.details)) {
          return { status: "uncertain", message: actionRefusalMessage(t, { code: cause.code, reason: cause.reason, details: cause.details }) };
        }
        input.onPressRefused?.();
        return { status: "refused", message: cause instanceof Error ? cause.message : t("shell.live.actionRefusedGeneric") };
      }
    },
  };
}
