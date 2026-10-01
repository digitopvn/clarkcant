import {
  APPEARANCE_EXTENSION,
  ARTIFACT_BRIDGE_LIMITS,
  ARTIFACTS_EXTENSION,
  JOBS_EXTENSION,
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  artifactRequestSchema,
  jobRequestSchema,
  jobSnapshotWireSchema,
  hostToWidgetSchema,
  widgetToHostSchema,
  type ActionAvailability,
  type ArtifactRef,
  type ArtifactRequest,
  type JobRef,
  type JobRequest,
  type JobSnapshot,
  type HostToWidgetMessage,
  type WidgetAuthorApi,
  type ReadonlyAppearanceSnapshot,
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
  let appearance: ReadonlyAppearanceSnapshot | undefined;
  const appearanceHandlers = new Set<(snapshot: ReadonlyAppearanceSnapshot) => void>();
  const setAppearance = (next: ReadonlyAppearanceSnapshot): void => {
    if (appearance?.revision === next.revision) return;
    appearance = freezeSnapshot(next);
    for (const handler of appearanceHandlers) handler(appearance);
  };
  let instanceId: string | undefined;
  let nonce: string | undefined;
  let props: Record<string, unknown> = {};
  let state: Record<string, unknown> = {};
  /** The instance revision: what an action is checked against. */
  let revision = 0;
  /** The state revision: what a state write is checked against. A different counter, moved by a different thing. */
  let stateRevision = 0;
  /**
   * The one state write the host has not answered yet.
   *
   * One at a time, because the answer decides the revision the next write must name: a second write sent before the
   * first was committed would be planned against a revision that was about to move, and refused for it.
   */
  let pendingWrite: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let brokered = new Set<string>();

  const mountHandlers = new Set<() => void>();
  const suspendHandlers = new Set<(reason: string) => void>();
  const resumeHandlers = new Set<() => void>();
  const disposeHandlers = new Set<() => void>();
  const propsHandlers = new Set<(props: Record<string, unknown>) => void>();
  const stateHandlers = new Set<(state: Record<string, unknown>, revision: number) => void>();
  /** Keyed by invocation id: two invocations of one binding each wait for their own answer. */
  const actionWaiters = new Map<
    string,
    { actionBindingId: string; resolve: (value: string | undefined) => void; reject: (error: Error) => void }
  >();
  let availability: readonly ActionAvailability[] = [];
  const availabilityHandlers = new Set<(availability: readonly ActionAvailability[]) => void>();
  /** Extensions the host offered in `init`. A call into one it did not offer is refused here, never sent. */
  let extensions = new Set<string>();
  /** Artifact requests waiting for their answer, keyed by the request id this runtime minted. */
  const artifactWaiters = new Map<string, { resolve: (result: ArtifactResult) => void; reject: (error: Error) => void }>();
  let artifactRequests = 0;
  /**
   * Requests past the host's in-flight limit, waiting their turn in the order they were made. The host answers a fifth
   * request with `ARTIFACT_BUSY`; queuing here means a widget that reads many ranges at once is paced, not refused.
   */
  const artifactQueue: { request: ArtifactRequest; resolve: (result: ArtifactResult) => void; reject: (error: Error) => void }[] = [];
  const sendArtifactRequest = (entry: (typeof artifactQueue)[number]): void => {
    artifactRequests += 1;
    const requestId = `artreq-${String(artifactRequests)}`;
    artifactWaiters.set(requestId, { resolve: entry.resolve, reject: entry.reject });
    send({ kind: "artifact.request", nonce: speakingNonce(), requestId, request: entry.request });
  };
  const drainArtifactQueue = (): void => {
    while (status !== "disposed" && artifactWaiters.size < ARTIFACT_BRIDGE_LIMITS.maxInFlight) {
      const next = artifactQueue.shift();
      if (next === undefined) return;
      sendArtifactRequest(next);
    }
  };
  /**
   * Writes to one artifact, chained so they reach the host in order and each names the offset the last one left.
   * Two chunks in flight at once would both name the same offset, and the host would refuse the second.
   */
  const writeChains = new Map<string, Promise<unknown>>();
  const knownSizes = new Map<string, number>();
  const jobWaiters = new Map<string, { resolve: (result: JobResult) => void; reject: (error: Error) => void }>();
  const jobSubscriptions = new Set<JobSubscription>();
  let jobRequests = 0;

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
    if (message.stateRevision !== undefined) stateRevision = message.stateRevision;
    brokered = new Set(message.brokeredCapabilities);
    extensions = new Set(message.extensions ?? []);
    if (extensions.has(APPEARANCE_EXTENSION) && message.appearance !== undefined) setAppearance(message.appearance);
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

    if (message.kind === "appearance.changed") {
      if (status !== "disposed" && extensions.has(APPEARANCE_EXTENSION)) setAppearance(message.appearance);
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
      // Committed state replaces the local copy, including after a refusal: what the host holds is what is true.
      state = message.state;
      stateRevision = message.revision;
      const waiter = pendingWrite;
      pendingWrite = undefined;
      if (waiter !== undefined) {
        if (message.refused === undefined) waiter.resolve();
        else waiter.reject(new Error(`${message.refused.code}: ${message.refused.message}`));
      }
      if (status === "suspended") {
        status = "ready";
        for (const handler of resumeHandlers) handler();
      }
      for (const handler of stateHandlers) handler(state, stateRevision);
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
      pendingWrite?.reject(new Error("widget runtime: the host disposed the frame before the write was committed"));
      pendingWrite = undefined;
      for (const waiter of [...artifactWaiters.values(), ...artifactQueue]) {
        waiter.reject(new Error("widget runtime: the host disposed the frame before the file request answered"));
      }
      artifactWaiters.clear();
      artifactQueue.length = 0;
      for (const waiter of jobWaiters.values()) {
        waiter.reject(new Error("widget runtime: the host disposed the frame before the job request answered"));
      }
      jobWaiters.clear();
      for (const subscription of jobSubscriptions) {
        subscription.closed = true;
        if (subscription.timer !== undefined) clearTimeout(subscription.timer);
      }
      jobSubscriptions.clear();
      appearanceHandlers.clear();
      deps.endpoint.removeEventListener("message", handleMessage);
      return;
    }

    if (message.kind === "actions") {
      availability = message.actions;
      for (const handler of availabilityHandlers) handler(availability);
      return;
    }

    if (message.kind === "artifact-result") {
      const waiter = artifactWaiters.get(message.requestId);
      if (waiter === undefined) return;
      artifactWaiters.delete(message.requestId);
      waiter.resolve(message);
      drainArtifactQueue();
      return;
    }

    if (message.kind === "job-result") {
      const waiter = jobWaiters.get(message.requestId);
      if (waiter === undefined) return;
      jobWaiters.delete(message.requestId);
      waiter.resolve(message);
      return;
    }

    if (message.kind === "job.changed") {
      for (const subscription of jobSubscriptions) {
        if (!subscription.closed && subscription.jobId === message.job.jobId) {
          subscription.handler(freezeSnapshot(message.job));
          if (isTerminalJob(message.job.status)) closeJobSubscription(subscription);
        }
      }
      return;
    }

    // action-result
    // A host that does not name the invocation answers the oldest one waiting on that binding.
    const key =
      message.invocationId ??
      [...actionWaiters.entries()].find(([, candidate]) => candidate.actionBindingId === message.actionBindingId)?.[0];
    const waiter = key === undefined ? undefined : actionWaiters.get(key);
    if (key === undefined || waiter === undefined || waiter.actionBindingId !== message.actionBindingId) return;
    actionWaiters.delete(key);
    if (message.status === "accepted") waiter.resolve(message.output);
    else waiter.reject(new Error(message.message));
  };

  deps.endpoint.addEventListener("message", handleMessage);

  const requireReady = (what: string): void => {
    if (status === "disposed") throw new Error(`widget runtime: frame đã dispose, không ${what} được nữa`);
    if (status === "awaiting-init") throw new Error(`widget runtime: chưa init nên không ${what} được`);
  };

  /** Send one artifact request and wait for its answer. Refused locally when the host did not offer the extension. */
  const artifactRequest = (request: ArtifactRequest): Promise<ArtifactResult> =>
    new Promise<ArtifactResult>((resolve, reject) => {
      try {
        requireReady("dùng artifacts");
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!extensions.has(ARTIFACTS_EXTENSION)) {
        reject(new Error(`widget runtime: host không mở ${ARTIFACTS_EXTENSION} cho frame này`));
        return;
      }
      // Checked before it is sent, so a bug in the widget is reported to the widget rather than refused out of sight.
      const parsed = artifactRequestSchema.safeParse(request);
      if (!parsed.success) {
        reject(new Error(`widget runtime: yêu cầu artifact không hợp lệ: ${parsed.error.issues[0]?.message ?? "sai dạng"}`));
        return;
      }
      artifactQueue.push({ request: parsed.data, resolve, reject });
      drainArtifactQueue();
    });

  const jobRequest = async (request: JobRequest): Promise<JobResult> => {
    requireReady("dùng jobs");
    if (!extensions.has(JOBS_EXTENSION)) throw new Error(`widget runtime: host không mở ${JOBS_EXTENSION} cho frame này`);
    const parsed = jobRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new Error(`widget runtime: yêu cầu job không hợp lệ: ${parsed.error.issues[0]?.message ?? "sai dạng"}`);
    }
    if (jobWaiters.size >= 4) throw new Error("JOB_BUSY: too many job requests are waiting for this frame");
    jobRequests += 1;
    const requestId = `jobreq-${String(jobRequests)}`;
    return new Promise<JobResult>((resolve, reject) => {
      jobWaiters.set(requestId, { resolve, reject });
      send({ kind: "job.request", nonce: speakingNonce(), requestId, request: parsed.data });
    });
  };

  const closeJobSubscription = (subscription: JobSubscription): void => {
    subscription.closed = true;
    if (subscription.timer !== undefined) clearTimeout(subscription.timer);
    jobSubscriptions.delete(subscription);
  };

  const emitJobResult = (result: JobResult): JobSnapshot => {
    if (result.status !== "ok") throw new Error(`${result.code ?? "JOB_REFUSED"}: ${result.message ?? "host refused the job request"}`);
    const parsed = jobSnapshotWireSchema.safeParse(result.job);
    if (!parsed.success) throw new Error("widget runtime: host returned an invalid job snapshot");
    return freezeSnapshot(parsed.data);
  };

  const readJob = async (jobId: JobRef): Promise<JobSnapshot> => emitJobResult(await jobRequest({ op: "get", jobId }));

  const pollJobSubscription = async (subscription: JobSubscription): Promise<void> => {
    if (subscription.closed || subscription.polling) return;
    subscription.polling = true;
    try {
      const job = await readJob(subscription.jobId);
      if (subscription.closed) return;
      subscription.handler(job);
      if (isTerminalJob(job.status)) {
        closeJobSubscription(subscription);
        return;
      }
    } catch {
      // Keep the subscription alive through transient refusals; the next bounded read can recover from persisted state.
    } finally {
      subscription.polling = false;
      if (!subscription.closed) {
        subscription.timer = setTimeout(() => void pollJobSubscription(subscription), 1000);
      }
    }
  };

  /** An answer that must be `ok`, with a ref. A refusal becomes an error that names the host's code first. */
  const expectRef = (result: ArtifactResult): ArtifactRef => {
    if (result.status !== "ok") throw artifactError(result);
    if (result.ref === undefined) throw new Error("widget runtime: host trả lời mà không kèm artifact");
    knownSizes.set(result.ref.artifactId, result.ref.sizeBytes);
    return result.ref;
  };

  const api: WidgetAuthorApi = {
    appearance: {
      current: () => appearance,
      subscribe: (handler) => {
        if (status === "disposed") return () => undefined;
        appearanceHandlers.add(handler);
        return () => { appearanceHandlers.delete(handler); };
      },
    },
    props: {
      read: () => props,
      subscribe: (handler) => {
        propsHandlers.add(handler);
      },
    },
    state: {
      get: () => state,
      revision: () => stateRevision,
      update: (expectedRevision, patch) => {
        requireReady("cập nhật state");
        if (expectedRevision !== stateRevision) {
          return Promise.reject(
            new Error(
              `widget runtime: revision ${String(expectedRevision)} đã cũ, state đang ở ${String(stateRevision)}`,
            ),
          );
        }
        if (pendingWrite !== undefined) {
          return Promise.reject(
            new Error("widget runtime: lần ghi state trước chưa được host xác nhận; chờ nó xong rồi ghi tiếp"),
          );
        }
        /*
         * Shown locally at once, confirmed by the host later. The promise resolves only when the host has committed
         * the write, so a widget that says "đã lưu" on resolve is saying something true; a refusal replaces this
         * optimistic copy with the committed one and rejects with the host's reason.
         */
        state = { ...state, ...patch };
        return new Promise<void>((resolve, reject) => {
          pendingWrite = { resolve, reject };
          send({ kind: "state.update", nonce: speakingNonce(), expectedRevision, patch });
        });
      },
      subscribe: (handler) => {
        stateHandlers.add(handler);
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
        new Promise<string | undefined>((resolve, reject) => {
          try {
            requireReady("gọi action");
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          actionWaiters.set(invocationId, { actionBindingId, resolve, reject });
          send({
            kind: "action.invoke",
            nonce: speakingNonce(),
            actionBindingId,
            expectedRevision: revision,
            input,
            invocationId,
          });
        }),
      availability: () => availability,
      subscribe: (handler) => {
        availabilityHandlers.add(handler);
      },
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
      publish: (summary, selectedIds, values) => {
        requireReady("publish semantic");
        send({
          kind: "semantic.publish",
          nonce: speakingNonce(),
          summary,
          selectedIds,
          ...(values === undefined ? {} : { values }),
        });
      },
    },
    artifacts: {
      available: () => extensions.has(ARTIFACTS_EXTENSION),
      pick: async (options) => {
        const result = await artifactRequest({ op: "pick", accept: [...(options?.accept ?? [])] });
        // The person closing the picker is an answer, not a failure.
        if (result.status === "cancelled") return undefined;
        return expectRef(result);
      },
      read: async (ref, range) => {
        const result = await artifactRequest({ op: "read", artifactId: ref.artifactId, offset: range.offset, length: range.length });
        if (result.status !== "ok") throw artifactError(result);
        return { bytes: fromBase64(result.chunkBase64 ?? ""), eof: result.eof ?? true };
      },
      create: async (options) =>
        expectRef(
          await artifactRequest({
            op: "create",
            mimeType: options.mimeType,
            ...(options.name === undefined ? {} : { name: options.name }),
          }),
        ),
      write: (ref, chunk) => {
        if (chunk.byteLength > ARTIFACT_BRIDGE_LIMITS.chunkBytes) {
          return Promise.reject(
            new Error(`widget runtime: một lần ghi tối đa ${String(ARTIFACT_BRIDGE_LIMITS.chunkBytes)} byte; hãy chia nhỏ`),
          );
        }
        const previous = writeChains.get(ref.artifactId) ?? Promise.resolve();
        // A failed write does not block the next one: it names the offset the host last confirmed.
        const next = previous
          .catch(() => undefined)
          .then(async () =>
            expectRef(
              await artifactRequest({
                op: "write",
                artifactId: ref.artifactId,
                offset: knownSizes.get(ref.artifactId) ?? ref.sizeBytes,
                chunkBase64: toBase64(chunk),
              }),
            ),
          );
        writeChains.set(ref.artifactId, next);
        return next;
      },
      finalize: async (ref) => {
        // After every write this frame sent to it, so the bytes fixed are the bytes written.
        await (writeChains.get(ref.artifactId) ?? Promise.resolve()).catch(() => undefined);
        return expectRef(await artifactRequest({ op: "finalize", artifactId: ref.artifactId }));
      },
      export: async (ref, options) => {
        const result = await artifactRequest({ op: "export", artifactId: ref.artifactId, suggestedName: options.suggestedName });
        if (result.status === "cancelled") return false;
        if (result.status !== "ok") throw artifactError(result);
        return true;
      },
      attachToConversation: async (ref) => {
        const result = await artifactRequest({ op: "attach", artifactId: ref.artifactId });
        if (result.status !== "ok") throw artifactError(result);
      },
      discard: async (ref) => {
        // After any write still on its way, so the host is not asked to write to a file it has just let go.
        await (writeChains.get(ref.artifactId) ?? Promise.resolve()).catch(() => undefined);
        const result = await artifactRequest({ op: "discard", artifactId: ref.artifactId });
        if (result.status !== "ok") throw artifactError(result);
        writeChains.delete(ref.artifactId);
        knownSizes.delete(ref.artifactId);
      },
    },
    jobs: {
      available: () => extensions.has(JOBS_EXTENSION),
      get: (ref) => readJob(ref),
      cancel: async (ref) => {
        const result = await jobRequest({ op: "cancel", jobId: ref });
        if (result.status !== "ok") {
          throw new Error(`${result.code ?? "JOB_REFUSED"}: ${result.message ?? "host refused the job request"}`);
        }
      },
      subscribe: (ref, handler) => {
        requireReady("đăng ký theo dõi job");
        if (!extensions.has(JOBS_EXTENSION)) throw new Error(`widget runtime: host không mở ${JOBS_EXTENSION} cho frame này`);
        if (jobSubscriptions.size >= 4) throw new Error("JOB_BUSY: at most four job subscriptions are allowed per frame");
        const subscription = { jobId: ref, handler, polling: false, closed: false };
        jobSubscriptions.add(subscription);
        void pollJobSubscription(subscription);
        return () => closeJobSubscription(subscription);
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

type ArtifactResult = Extract<HostToWidgetMessage, { kind: "artifact-result" }>;
type JobResult = Extract<HostToWidgetMessage, { kind: "job-result" }>;
interface JobSubscription {
  jobId: JobRef;
  handler: (job: JobSnapshot) => void;
  timer?: ReturnType<typeof setTimeout>;
  polling: boolean;
  closed: boolean;
}

function isTerminalJob(status: JobSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function artifactError(result: ArtifactResult): Error {
  const code = result.code ?? (result.status === "cancelled" ? "CANCELLED" : "ARTIFACT_REFUSED");
  return new Error(`${code}: ${result.message ?? "host từ chối yêu cầu artifact"}`);
}

/** Base64 without `Buffer`, which a widget running in a browser frame does not have. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
/** The validated message is a detached copy; freeze every nested value before handing it to widget code. */
function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
