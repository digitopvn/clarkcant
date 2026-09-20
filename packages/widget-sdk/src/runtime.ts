import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  hostToWidgetSchema,
  widgetToHostSchema,
  type HostToWidgetMessage,
  type WidgetAuthorApi,
  type WidgetToHostMessage,
} from "./index.ts";

/**
 * The runtime a mini-app imports.
 *
 * This is the piece that was missing: the codec, the nonce check and the API surface were implemented
 * and tested, but nothing implemented `WidgetAuthorApi` over an actual channel, so a mini-app could be
 * written against the contract and not run.
 *
 * Three decisions shape it.
 *
 * **Nothing is *sent* until `init` arrives.** The nonce is issued by the host for this one frame, so the
 * runtime has no identity to speak with until it has been told one, and every send before then throws rather
 * than queueing: a message sent before the handshake would have to carry a nonce the runtime does not have,
 * and inventing one is how a frame comes to act as another.
 *
 * Reading props and registering lifecycle handlers are not sends, and are allowed immediately. That is not a
 * convenience: a widget has to be able to register `onMount` *before* init, because init is what fires it — a
 * runtime that refused the API until init made mount impossible to observe, which is how the conformance suite
 * found this.
 *
 * **The channel is an interface, not `MessagePort`.** `MessageEndpoint` is the three methods this
 * actually uses, which keeps the runtime free of DOM types and lets the handshake be tested as a
 * sequence of messages rather than as a browser.
 *
 * **A refused request is refused locally when it can be.** A capability the host did not broker is not
 * sent at all, because sending it would ask the host to arbitrate something it has already answered, and
 * the answer would come back out of band where the caller cannot see it.
 */

/** The parts of a message channel this runtime uses, so it does not depend on DOM types. */
export interface MessageEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export type RuntimeStatus = "awaiting-init" | "ready" | "suspended" | "disposed";

export interface WidgetRuntime {
  status(): RuntimeStatus;
  instanceId(): string | undefined;
  /** Throws until `init` has arrived: there is no nonce to speak with before then. */
  api(): WidgetAuthorApi;
}

export interface RuntimeDeps {
  endpoint: MessageEndpoint;
  /** Called for a message that could not be used, so the widget can surface it rather than fail silently. */
  onRejected?: (rejection: { code: string; message: string }) => void;
}

export function createWidgetRuntime(deps: RuntimeDeps): WidgetRuntime {
  let status: RuntimeStatus = "awaiting-init";
  let instanceId: string | undefined;
  let nonce: string | undefined;
  let props: Record<string, unknown> = {};
  let state: Record<string, unknown> = {};
  let revision = 0;
  let brokered = new Set<string>();

  const mountHandlers = new Set<() => void>();
  const suspendHandlers = new Set<(reason: string) => void>();
  const resumeHandlers = new Set<() => void>();
  const disposeHandlers = new Set<() => void>();
  const propsHandlers = new Set<(props: Record<string, unknown>) => void>();
  const actionWaiters = new Map<string, { resolve: (value: void) => void; reject: (error: Error) => void }>();

  const send = (message: unknown): void => {
    deps.endpoint.postMessage(message);
  };

  const speakingNonce = (): string => {
    if (nonce === undefined) {
      throw new Error(
        "widget runtime: chưa nhận được init nên chưa có nonce; không gửi gì trước handshake",
      );
    }
    return nonce;
  };

  const handleInit = (message: Extract<HostToWidgetMessage, { kind: "init" }>): void => {
    if (status !== "awaiting-init") return;
    nonce = message.nonce;
    instanceId = message.instanceId;
    props = message.props;
    state = message.state ?? {};
    /*
     * The revision the host initialized this frame at.
     *
     * Without it a freshly mounted frame speaks revision 0, and the node refuses its first action as stale — so every
     * widget's first click would fail on an instance that has moved at all since it was created. The host knows the
     * revision; this is the frame being told rather than guessing.
     */
    if (message.revision !== undefined) revision = message.revision;
    brokered = new Set(message.brokeredCapabilities);
    status = "ready";
    send({ kind: "ready", nonce });
    for (const handler of mountHandlers) handler();
  };

  const handleMessage = (event: { data: unknown }): void => {
    const parsed = hostToWidgetSchema.safeParse(event.data);
    if (!parsed.success) {
      /*
       * The protocol and version are zod literals, so a host that speaks a different bridge fails the schema before
       * any hand-written check could run. Reporting that as a generic schema error would send an author looking at
       * their own message shape, so the mismatch is recognised here and named for what it is.
       */
      const raw = event.data as { protocol?: unknown; version?: unknown } | null;
      if (raw !== null && typeof raw === "object" && "protocol" in raw && raw.protocol !== BRIDGE_PROTOCOL) {
        deps.onRejected?.({
          code: "PROTOCOL_MISMATCH",
          message: `host speaks ${String(raw.protocol)}; this runtime speaks ${BRIDGE_PROTOCOL}`,
        });
        return;
      }
      if (raw !== null && typeof raw === "object" && "version" in raw && raw.version !== BRIDGE_VERSION) {
        deps.onRejected?.({
          code: "PROTOCOL_MISMATCH",
          message: `host speaks bridge version ${String(raw.version)}; this runtime speaks ${String(BRIDGE_VERSION)}`,
        });
        return;
      }
      deps.onRejected?.({ code: "SCHEMA_INVALID", message: "message from host does not match the bridge schema" });
      return;
    }
    const message = parsed.data;

    if (message.kind === "init") {
      // A second init is a second identity, which is how one frame comes to speak as two.
      if (status !== "awaiting-init") {
        deps.onRejected?.({ code: "DUPLICATE_INIT", message: "init already received for this frame" });
        return;
      }
      // Every later message carries the nonce, so a message before init is a host that skipped the step.
      handleInit(message);
      return;
    }

    if (message.nonce !== nonce) {
      deps.onRejected?.({ code: "NONCE_MISMATCH", message: "message nonce does not match this frame's nonce" });
      return;
    }

    if (message.kind === "props") {
      props = message.props;
      // A props message after a suspension is the host bringing the widget back rather than a new lifecycle.
      if (status === "suspended") {
        status = "ready";
        for (const handler of resumeHandlers) handler();
      }
      for (const handler of propsHandlers) handler(props);
      return;
    }
    if (message.kind === "state") {
      state = message.state;
      revision = message.revision;
      if (status === "suspended") {
        status = "ready";
        for (const handler of resumeHandlers) handler();
      }
      return;
    }
    if (message.kind === "suspend") {
      if (status === "disposed") return;
      status = "suspended";
      for (const handler of suspendHandlers) handler(message.reason);
      return;
    }
    if (message.kind === "dispose") {
      if (status === "disposed") return;
      status = "disposed";
      for (const handler of disposeHandlers) handler();
      for (const waiter of actionWaiters.values()) {
        waiter.reject(new Error("widget runtime: the host disposed the frame before the action answered"));
      }
      actionWaiters.clear();
      deps.endpoint.removeEventListener("message", handleMessage);
      return;
    }

    // action-result
    const waiter = actionWaiters.get(message.actionBindingId);
    if (waiter === undefined) return;
    actionWaiters.delete(message.actionBindingId);
    if (message.status === "accepted") waiter.resolve();
    else waiter.reject(new Error(message.message));
  };

  deps.endpoint.addEventListener("message", handleMessage);

  const requireReady = (what: string): void => {
    if (status === "disposed") throw new Error(`widget runtime: frame đã dispose, không ${what} được nữa`);
    if (status === "awaiting-init") throw new Error(`widget runtime: chưa init nên không ${what} được`);
  };

  const api: WidgetAuthorApi = {
    props: {
      read: () => props,
      subscribe: (handler) => {
        propsHandlers.add(handler);
      },
    },
    state: {
      get: () => state,
      update: (expectedRevision, patch) => {
        requireReady("cập nhật state");
        if (expectedRevision !== revision) {
          return Promise.reject(
            new Error(
              `widget runtime: revision ${String(expectedRevision)} đã cũ, frame đang ở ${String(revision)}`,
            ),
          );
        }
        revision += 1;
        state = { ...state, ...patch };
        send({ kind: "state.update", nonce: speakingNonce(), expectedRevision, patch });
        return Promise.resolve();
      },
    },
    events: {
      emit: (name, payload) => {
        requireReady("phát event");
        send({ kind: "event", nonce: speakingNonce(), name, payload });
      },
    },
    actions: {
      invoke: (actionBindingId, input, invocationId) =>
        new Promise<void>((resolve, reject) => {
          try {
            requireReady("gọi action");
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          actionWaiters.set(actionBindingId, { resolve, reject });
          send({
            kind: "action.invoke",
            nonce: speakingNonce(),
            actionBindingId,
            expectedRevision: revision,
            input,
            invocationId,
          });
        }),
    },
    capabilities: {
      request: (capabilityRef, justification) => {
        requireReady("xin capability");
        /*
         * Refused here rather than sent. The host has already answered this question by not brokering the
         * capability, and posting it anyway would ask the host to arbitrate something it has decided — with the
         * refusal arriving somewhere the caller is not looking.
         */
        if (!brokered.has(capabilityRef)) {
          return Promise.reject(
            new Error(`widget runtime: host không broker capability ${capabilityRef} cho frame này`),
          );
        }
        send({ kind: "capability.request", nonce: speakingNonce(), capabilityRef, justification });
        return Promise.resolve();
      },
    },
    host: {
      focus: () => {
        requireReady("xin focus");
        send({ kind: "host.request", nonce: speakingNonce(), request: "focus" });
      },
      resize: ({ height }) => {
        requireReady("xin resize");
        send({ kind: "host.request", nonce: speakingNonce(), request: "resize", argument: String(height) });
      },
      requestPin: () => {
        requireReady("xin pin");
        send({ kind: "host.request", nonce: speakingNonce(), request: "request-pin" });
      },
      openExternal: (approvedUrl) => {
        requireReady("mở link");
        // A request, never an open: the host decides, and shows its own chrome when it does.
        send({ kind: "host.request", nonce: speakingNonce(), request: "open-external", argument: approvedUrl });
      },
    },
    semantic: {
      publish: (summary, selectedIds) => {
        requireReady("publish semantic");
        send({ kind: "semantic.publish", nonce: speakingNonce(), summary, selectedIds });
      },
    },
    lifecycle: {
      onMount: (handler) => mountHandlers.add(handler),
      onSuspend: (handler) => suspendHandlers.add(handler),
      onResume: (handler) => resumeHandlers.add(handler),
      onDispose: (handler) => disposeHandlers.add(handler),
    },
  };

  return {
    status: () => status,
    instanceId: () => instanceId,
    api: () => api,
  };
}

/**
 * The message a widget sends first.
 *
 * Typed by the parsed variant rather than `unknown`: the value crosses the bridge as a checked message, and a
 * helper that handed back `unknown` would push the parse back onto every caller.
 */
export function readyMessage(nonce: string): Extract<WidgetToHostMessage, { kind: "ready" }> {
  // `parse` returns the whole union; the variant is narrowed rather than asserted, so a schema change that
  // stopped producing a `ready` message would fail here instead of being cast away.
  const parsed = widgetToHostSchema.parse({ kind: "ready", nonce });
  if (parsed.kind !== "ready") throw new Error("expected a ready message from the bridge schema");
  return parsed;
}
