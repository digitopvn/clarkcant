import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  acceptBridgeMessage,
  type HostToWidgetMessage,
  type WidgetToHostMessage,
} from "@clarkcant/widget-sdk";

/**
 * The host end of one widget frame.
 *
 * A frame is not trusted to say who it is: for an opaque-origin iframe every `origin` is `"null"`, so the
 * per-frame nonce plus the exact source window are the two things that establish which widget is speaking. Both
 * checks live in `acceptBridgeMessage`; what this file adds is what happens *after* a message is believed, and the
 * decisions there are the ones that keep an isolated widget isolated:
 *
 * - **The host executes nothing the widget asks for by name.** An action invocation is checked against a binding
 *   the host already knows about, and a capability request is refused unless the host brokered that exact
 *   capability for this frame. There is no path from a message to a generic call.
 * - **Opening a link is a request.** `openExternal` reaches the host's own chrome, which decides. The frame has no
 *   `window.open`, and a session that called one on the widget's behalf would be the host doing what it was only
 *   asked to consider.
 * - **A stale write is refused, not merged.** An optimistic-concurrency check that quietly accepted an old write
 *   would let two frames' edits interleave in whatever order they arrived.
 * - **A double click produces one effect.** An invocation id already seen returns the first outcome rather than
 *   running the action again.
 *
 * Nothing here holds a port or a window: the caller posts, which keeps this testable as a sequence of messages.
 */

export type FrameRefusal =
  | "SOURCE_MISMATCH"
  | "SCHEMA_INVALID"
  | "JSON_INVALID"
  | "NONCE_MISMATCH"
  | "TOO_LARGE"
  | "MESSAGE_BUDGET_EXCEEDED"
  | "NOT_INITIALISED"
  | "STALE_REVISION"
  | "CAPABILITY_NOT_BROKERED"
  | "ACTION_UNKNOWN"
  | "DISPOSED";

export type FrameAcceptance =
  | { ok: true; kind: WidgetToHostMessage["kind"]; detail?: string }
  | { ok: false; code: FrameRefusal; message: string };

export interface FrameActionOutcome {
  status: "accepted" | "refused" | "failed" | "uncertain";
  message: string;
}

export interface FrameSessionInput {
  instanceId: string;
  /** Issued by the host, never exposed outside this frame. */
  nonce: string;
  props: Record<string, unknown>;
  state?: Record<string, unknown>;
  /** Capabilities the host is willing to broker for this frame, and no others. */
  brokeredCapabilities: readonly string[];
  /** Origins this frame may reach, enforced by CSP and stated here for the init message. */
  allowedOrigins: readonly string[];
  /** Bindings the host has already accepted for this instance; an unknown id is refused. */
  knownActionBindings: readonly string[];
  invokeAction: (input: {
    actionBindingId: string;
    input: Record<string, unknown>;
    expectedRevision: number;
    invocationId: string;
  }) => Promise<FrameActionOutcome>;
  /** The host's own chrome. The frame asks; the host decides and shows its own UI. */
  chrome: {
    focus: () => void;
    resize: (height: number) => void;
    requestPin: () => void;
    openExternal: (url: string) => void;
  };
  post: (message: HostToWidgetMessage) => void;
  /** Overridable so a test can drive the budget without sending thousands of messages. */
  maxMessageBytes?: number;
  maxMessages?: number;
}

export interface FrameSession {
  /** The init message, sent once. Returns it rather than posting, so a caller can see what it advertised. */
  init(): Extract<HostToWidgetMessage, { kind: "init" }>;
  accept(event: { data: unknown; sourceMatchesExpectedWindow: boolean }): FrameAcceptance;
  suspend(reason: string): void;
  dispose(): void;
  status(): "awaiting-init" | "ready" | "suspended" | "disposed";
  /** What the frame said, in order. What a session records is what it is willing to be held to. */
  transcript(): readonly { kind: string; detail: string }[];
  refused(): readonly FrameRefusal[];
}

export function createFrameSession(input: FrameSessionInput): FrameSession {
  const maxMessageBytes = input.maxMessageBytes ?? 64 * 1024;
  const maxMessages = input.maxMessages ?? 200;
  const transcript: { kind: string; detail: string }[] = [];
  const refusals: FrameRefusal[] = [];
  const answeredInvocations = new Map<string, FrameActionOutcome>();
  let state = input.state ?? {};
  let revision = 0;
  let messages = 0;
  let status: "awaiting-init" | "ready" | "suspended" | "disposed" = "awaiting-init";

  const refuse = (code: FrameRefusal, message: string): FrameAcceptance => {
    refusals.push(code);
    return { ok: false, code, message };
  };

  const init = (): Extract<HostToWidgetMessage, { kind: "init" }> => {
    const message: Extract<HostToWidgetMessage, { kind: "init" }> = {
      kind: "init",
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      instanceId: input.instanceId,
      nonce: input.nonce,
      props: input.props,
      state,
      brokeredCapabilities: [...input.brokeredCapabilities],
      allowedOrigins: [...input.allowedOrigins],
    };
    input.post(message);
    status = "ready";
    return message;
  };

  const dispatch = (message: WidgetToHostMessage): FrameAcceptance => {
    switch (message.kind) {
      case "ready":
        transcript.push({ kind: "ready", detail: message.nonce });
        return { ok: true, kind: "ready" };

      case "state.update": {
        if (message.expectedRevision !== revision) {
          // Refused rather than merged: an accepted stale write is two frames editing in arrival order.
          return refuse(
            "STALE_REVISION",
            `write planned at revision ${String(message.expectedRevision)}; frame is at ${String(revision)}`,
          );
        }
        state = { ...state, ...message.patch };
        revision += 1;
        input.post({ kind: "state", nonce: input.nonce, state, revision });
        transcript.push({ kind: "state.update", detail: String(revision) });
        return { ok: true, kind: "state.update", detail: String(revision) };
      }

      case "event":
        transcript.push({ kind: "event", detail: message.name });
        return { ok: true, kind: "event", detail: message.name };

      case "action.invoke": {
        const seen = answeredInvocations.get(message.invocationId);
        if (seen !== undefined) {
          /*
           * The same click twice. Returning the first outcome rather than running it again is what makes a double
           * click one effect; re-running would be the host doing an effect twice because a pointer bounced.
           */
          input.post({
            kind: "action-result",
            nonce: input.nonce,
            actionBindingId: message.actionBindingId,
            status: seen.status,
            message: seen.message,
          });
          return { ok: true, kind: "action.invoke", detail: "duplicate" };
        }
        if (!input.knownActionBindings.includes(message.actionBindingId)) {
          // An id the host never accepted is refused before anything runs: there is no generic invoke to fall into.
          return refuse("ACTION_UNKNOWN", `no accepted binding ${message.actionBindingId} for this instance`);
        }
        void input
          .invokeAction({
            actionBindingId: message.actionBindingId,
            input: message.input,
            expectedRevision: message.expectedRevision,
            invocationId: message.invocationId,
          })
          .then((outcome) => {
            answeredInvocations.set(message.invocationId, outcome);
            input.post({
              kind: "action-result",
              nonce: input.nonce,
              actionBindingId: message.actionBindingId,
              status: outcome.status,
              message: outcome.message,
            });
          })
          .catch((error: unknown) => {
            const outcome: FrameActionOutcome = {
              status: "failed",
              message: error instanceof Error ? error.message : "the action failed",
            };
            answeredInvocations.set(message.invocationId, outcome);
            input.post({
              kind: "action-result",
              nonce: input.nonce,
              actionBindingId: message.actionBindingId,
              status: outcome.status,
              message: outcome.message,
            });
          });
        transcript.push({ kind: "action.invoke", detail: message.actionBindingId });
        return { ok: true, kind: "action.invoke", detail: message.actionBindingId };
      }

      case "capability.request":
        if (!input.brokeredCapabilities.includes(message.capabilityRef)) {
          /*
           * The host answered this question when it decided what to broker. Considering it again because the frame
           * asked louder is how a bounded capability list becomes advisory.
           */
          return refuse("CAPABILITY_NOT_BROKERED", `capability ${message.capabilityRef} was not brokered to this frame`);
        }
        transcript.push({ kind: "capability.request", detail: message.capabilityRef });
        return { ok: true, kind: "capability.request", detail: message.capabilityRef };

      case "host.request": {
        // Routed to the host's chrome. The frame never performs the effect itself, and a link is opened by the host
        // deciding to open it rather than by the ask arriving.
        if (message.request === "focus") input.chrome.focus();
        else if (message.request === "resize") input.chrome.resize(Number(message.argument ?? "0"));
        else if (message.request === "request-pin") input.chrome.requestPin();
        else input.chrome.openExternal(message.argument ?? "");
        transcript.push({ kind: "host.request", detail: message.request });
        return { ok: true, kind: "host.request", detail: message.request };
      }

      case "semantic.publish":
        // Published for a reader who cannot see the widget, and for a voice path to address its actions.
        transcript.push({ kind: "semantic.publish", detail: message.summary });
        return { ok: true, kind: "semantic.publish", detail: message.summary };
    }
  };

  return {
    init,

    accept(event) {
      if (status === "disposed") return refuse("DISPOSED", "the frame has been disposed");

      /*
       * Bounded before parsed. A frame that can send an arbitrarily large object can spend the host's memory on
       * validation, so the size check comes first and does not trust the payload to be small.
       */
      let bytes: number;
      try {
        bytes = JSON.stringify(event.data)?.length ?? 0;
      } catch {
        return refuse("SCHEMA_INVALID", "the message could not be serialised");
      }
      if (bytes > maxMessageBytes) {
        return refuse("TOO_LARGE", `message of ${String(bytes)} bytes exceeds ${String(maxMessageBytes)}`);
      }
      messages += 1;
      if (messages > maxMessages) {
        return refuse("MESSAGE_BUDGET_EXCEEDED", `frame sent more than ${String(maxMessages)} messages`);
      }

      const accepted = acceptBridgeMessage({
        raw: event.data,
        expectedNonce: input.nonce,
        sourceMatchesExpectedWindow: event.sourceMatchesExpectedWindow,
      });
      if (!accepted.ok) {
        return refuse(accepted.code, accepted.message);
      }
      return dispatch(accepted.message);
    },

    suspend(reason) {
      if (status === "disposed") return;
      status = "suspended";
      input.post({ kind: "suspend", nonce: input.nonce, reason });
      transcript.push({ kind: "suspend", detail: reason });
    },

    dispose() {
      if (status === "disposed") return;
      status = "disposed";
      input.post({ kind: "dispose", nonce: input.nonce });
      transcript.push({ kind: "dispose", detail: "" });
    },

    status: () => status,
    transcript: () => transcript,
    refused: () => refusals,
  };
}
