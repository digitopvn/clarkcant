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

/** What the node answered a state write with. */
export type FrameStateOutcome =
  | { ok: true; stateRevision: number; state: Record<string, unknown> }
  | {
      ok: false;
      code: string;
      message: string;
      /** The committed state and its revision, when the node could say — what the widget should plan against next. */
      stateRevision?: number;
      state?: Record<string, unknown>;
    };

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
  /**
   * The instance revision this frame is being shown.
   *
   * Sent in the init message so the widget's first action carries the revision it was actually initialized at. A
   * frame that was never told one speaks revision 0 and has its first action refused as stale, which is a handshake
   * that looks fine and a widget that cannot act.
   */
  revision: number;
  /** The state revision the node holds for `state`. A different counter from `revision`; 0 when never written. */
  stateRevision?: number;
  /**
   * Keys the definition declares as view state. They stay in the frame's own copy and are never handed to
   * `persistState`'s answer to overwrite, because the node never stored them.
   */
  ephemeralStateKeys?: readonly string[];
  /**
   * Where a state write is made durable.
   *
   * Given, a write is answered only after the node has committed it: the frame is told the new state and revision
   * then, and on a refusal it is told the committed state instead, with the reason — its own change is not thrown
   * away by the host, it is simply not what was saved. Absent (the dev host, the conformance harness), a write is
   * applied to this session's copy, which is all those hosts have.
   */
  persistState?: (input: { expectedRevision: number; patch: Record<string, unknown> }) => Promise<FrameStateOutcome>;
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

function pickEphemeral(patch: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => keys.has(key)));
}

export function createFrameSession(input: FrameSessionInput): FrameSession {
  const maxMessageBytes = input.maxMessageBytes ?? 64 * 1024;
  const maxMessages = input.maxMessages ?? 200;
  const transcript: { kind: string; detail: string }[] = [];
  const refusals: FrameRefusal[] = [];
  /**
   * Invocations seen, whether or not they have answered yet.
   *
   * `pending` is the important half: a double click is two messages in quick succession, so keying dedup on the
   * *answer* let both run — the exact case this exists to prevent. The entry is written when the message is
   * accepted, not when the action finishes.
   */
  const invocations = new Map<string, "pending" | FrameActionOutcome>();
  let state = input.state ?? {};
  let stateRevision = input.stateRevision ?? 0;
  let writeInFlight = false;
  const ephemeral = new Set(input.ephemeralStateKeys ?? []);
  /** The frame's view-state keys, which the node's answer has no copy of. */
  const viewState = (): Record<string, unknown> =>
    Object.fromEntries(Object.entries(state).filter(([key]) => ephemeral.has(key)));
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
      revision: input.revision,
      stateRevision,
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
        if (writeInFlight || message.expectedRevision !== stateRevision) {
          /*
           * Refused rather than merged: an accepted stale write is two frames editing in arrival order. The frame is
           * answered with the committed state as well as refused here, because a widget waiting on its write would
           * otherwise wait for an answer that is never coming.
           */
          const reason = writeInFlight
            ? "an earlier write has not been committed yet"
            : `write planned at revision ${String(message.expectedRevision)}; state is at ${String(stateRevision)}`;
          input.post({
            kind: "state",
            nonce: input.nonce,
            state,
            revision: stateRevision,
            refused: { code: "STATE_REVISION_STALE", message: reason },
          });
          return refuse("STALE_REVISION", reason);
        }

        if (input.persistState === undefined) {
          state = { ...state, ...message.patch };
          stateRevision += 1;
          input.post({ kind: "state", nonce: input.nonce, state, revision: stateRevision });
          transcript.push({ kind: "state.update", detail: String(stateRevision) });
          return { ok: true, kind: "state.update", detail: String(stateRevision) };
        }

        const patchKeys = Object.keys(message.patch);
        if (patchKeys.length > 0 && patchKeys.every((key) => ephemeral.has(key))) {
          /*
           * Only view state: nothing the node keeps changes, so nothing is sent and the revision stays. Sending it would
           * advance the stored revision for a no-op and refuse another surface's write as stale for nothing.
           */
          state = { ...state, ...message.patch };
          input.post({ kind: "state", nonce: input.nonce, state, revision: stateRevision });
          transcript.push({ kind: "state.update", detail: "view-only" });
          return { ok: true, kind: "state.update", detail: "view-only" };
        }

        writeInFlight = true;
        const answer = (outcome: FrameStateOutcome): void => {
          writeInFlight = false;
          if (status === "disposed") return;
          if (outcome.ok) {
            // The node's copy is the truth for durable keys; view-state keys are the frame's own and stay.
            state = { ...outcome.state, ...viewState(), ...pickEphemeral(message.patch, ephemeral) };
            stateRevision = outcome.stateRevision;
            input.post({ kind: "state", nonce: input.nonce, state, revision: stateRevision });
            transcript.push({ kind: "state.update", detail: String(stateRevision) });
            return;
          }
          if (outcome.state !== undefined) state = { ...outcome.state, ...viewState() };
          if (outcome.stateRevision !== undefined) stateRevision = outcome.stateRevision;
          input.post({
            kind: "state",
            nonce: input.nonce,
            state,
            revision: stateRevision,
            refused: { code: outcome.code.slice(0, 60), message: outcome.message.slice(0, 600) },
          });
          transcript.push({ kind: "state.refused", detail: outcome.code });
        };
        void input
          .persistState({ expectedRevision: message.expectedRevision, patch: message.patch })
          .then(answer)
          .catch((error: unknown) => {
            answer({
              ok: false,
              code: "STATE_NOT_SAVED",
              message: error instanceof Error ? error.message : "the state could not be saved",
            });
          });
        return { ok: true, kind: "state.update", detail: "pending" };
      }

      case "event":
        transcript.push({ kind: "event", detail: message.name });
        return { ok: true, kind: "event", detail: message.name };

      case "action.invoke": {
        const seen = invocations.get(message.invocationId);
        if (seen === "pending") {
          // Already running. Answered once it finishes, and not started again meanwhile.
          return { ok: true, kind: "action.invoke", detail: "pending" };
        }
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
        invocations.set(message.invocationId, "pending");
        void input
          .invokeAction({
            actionBindingId: message.actionBindingId,
            input: message.input,
            expectedRevision: message.expectedRevision,
            invocationId: message.invocationId,
          })
          .then((outcome) => {
            invocations.set(message.invocationId, outcome);
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
            invocations.set(message.invocationId, outcome);
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
