import { appearanceSnapshotSchema, type AppearanceSnapshot, type SemanticProposal } from "@clarkcant/contracts";
import {
  ARTIFACTS_EXTENSION,
  JOBS_EXTENSION,
  APPEARANCE_EXTENSION,
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  acceptBridgeMessage,
  type ArtifactRef as WireArtifactRef,
  type ArtifactRequest,
  type JobRequest,
  type JobSnapshot,
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
  | "EXTENSION_NOT_OFFERED"
  | "ARTIFACT_BUSY"
  | "ARTIFACT_RATE_LIMITED"
  | "JOB_BUSY"
  | "JOB_RATE_LIMITED"
  | "DISPOSED";

/**
 * What the host answered one artifact request with.
 *
 * `cancelled` is the person saying no in host chrome; `refused` carries the node's code and sentence.
 */
export type FrameArtifactOutcome =
  | { status: "ok"; ref?: WireArtifactRef | undefined; chunkBase64?: string | undefined; eof?: boolean | undefined }
  | { status: "refused"; code: string; message: string }
  | { status: "cancelled"; message?: string | undefined };

/** The host's side of `artifacts@1`: one call per request, each re-checked by the node against this frame's grant. */
export type FrameArtifactBroker = (request: ArtifactRequest) => Promise<FrameArtifactOutcome>;

export type FrameJobOutcome =
  | { status: "ok"; job: JobSnapshot }
  | { status: "refused"; code: string; message: string };
export type FrameJobBroker = (request: JobRequest) => Promise<FrameJobOutcome>;

export type FrameAcceptance =
  | { ok: true; kind: WidgetToHostMessage["kind"]; detail?: string }
  | {
      ok: false;
      code: FrameRefusal;
      message: string;
      /**
       * The widget was sent an answer for this refusal — an artifact request turned away with `artifact-result` — so it
       * is the widget's to handle, like a stale write. A host shows only refusals the widget was never told about.
       */
      answered?: true;
    };

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
  /** What a service capability answered, when the binding called one and it ran. */
  output?: string | undefined;
}

/** Whether one service-backed binding can run right now, with the registry's reason when it cannot. */
export interface FrameActionAvailability {
  actionBindingId: string;
  available: boolean;
  reason?: string | undefined;
}

export interface FrameSessionInput {
  instanceId: string;
  appearance?: AppearanceSnapshot;
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
  /**
   * Where what the frame says it shows is sent, for the next model turn and for voice.
   *
   * Absent (the dev host, the conformance harness), a publish is only recorded in the transcript. Called at most as
   * often as the frame publishes; a host that sends it over the network should settle a burst into one request.
   */
  publishSemantic?: (proposal: SemanticProposal) => void;
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
  /**
   * The `artifacts@1` extension. Given, it is advertised in `init` and each request is handed here; absent (a host
   * that has no broker, an older dev host), it is not advertised and a request is refused with an answer, so the
   * widget is never left waiting.
   */
  artifacts?: FrameArtifactBroker;
  /** The versioned `jobs@1` bridge. Every request is checked again by the trusted node route. */
  jobs?: FrameJobBroker;
  /** Overridable so a test can drive the budget without sending thousands of messages. */
  maxMessageBytes?: number;
  maxMessages?: number;
  /**
   * The ceiling for one artifact request, which carries up to one 256 KiB chunk as base64 and is therefore larger
   * than every other message. Applied only to a message that says it is one, and the schema still bounds the chunk.
   */
  maxArtifactMessageBytes?: number;
  /**
   * The rate of artifact requests, counted apart from `maxMessages` because a 25 MiB file is a hundred chunks: a bucket
   * of `artifactBurst` requests that refills at `artifactRefillPerSecond`. A rate rather than a lifetime budget, so a
   * widget that autosaves for hours keeps working while one that floods the host is slowed to the refill.
   */
  artifactBurst?: number;
  artifactRefillPerSecond?: number;
  /** Artifact requests a frame may have unanswered at once. */
  maxArtifactInFlight?: number;
  maxJobInFlight?: number;
  /** Refusals kept for `refused()`, newest last. Older ones are dropped, so a frame that keeps failing cannot grow it. */
  maxRecordedRefusals?: number;
  /**
   * Entries kept for `transcript()`, newest last. Older ones are dropped: a widget that autosaves for hours sends
   * thousands of file requests, and each is an entry.
   */
  maxTranscriptEntries?: number;
  /** The clock the rate is measured on, in milliseconds. */
  now?: () => number;
}

export interface FrameSession {
  /** The init message, sent once. Returns it rather than posting, so a caller can see what it advertised. */
  init(): Extract<HostToWidgetMessage, { kind: "init" }>;
  accept(event: { data: unknown; sourceMatchesExpectedWindow: boolean }): FrameAcceptance;
  suspend(reason: string): void;
  /**
   * Tell the frame which of its service-backed bindings can run right now.
   *
   * Held until the frame is initialized and sent only when the answer changed, so a host can call this on every read
   * of the node without the widget hearing the same thing twice. An empty list is never sent: a widget with no
   * service-backed binding has nothing to be told.
   */
  announceActions(actions: readonly FrameActionAvailability[]): void;
  /** Restyle the existing frame without changing its instance or semantic revisions. */
  announceAppearance(appearance: AppearanceSnapshot): void;
  dispose(): void;
  status(): "awaiting-init" | "ready" | "suspended" | "disposed";
  /** What the frame said, in order — the latest `maxTranscriptEntries` of it. What a session records is what it is willing to be held to. */
  transcript(): readonly { kind: string; detail: string }[];
  refused(): readonly FrameRefusal[];
}

/**
 * The request id to answer a rate-limited artifact request under, read without parsing the rest of it: only under this
 * frame's own nonce, and in the id's own bounds. Anything else is refused without an answer. (A message from another
 * window never gets this far: it is turned away before anything is counted.)
 */
function answerableRequestId(raw: unknown, nonce: string): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { nonce: said, requestId } = raw as { nonce?: unknown; requestId?: unknown };
  if (said !== nonce || typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return undefined;
  return requestId;
}

function pickEphemeral(patch: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([key]) => keys.has(key)));
}

export function createFrameSession(input: FrameSessionInput): FrameSession {
  const maxMessageBytes = input.maxMessageBytes ?? 64 * 1024;
  const maxMessages = input.maxMessages ?? 200;
  const maxArtifactMessageBytes = input.maxArtifactMessageBytes ?? 512 * 1024;
  const artifactBurst = input.artifactBurst ?? 300;
  const artifactRefillPerSecond = input.artifactRefillPerSecond ?? 10;
  const maxArtifactInFlight = input.maxArtifactInFlight ?? 4;
  const maxRecordedRefusals = input.maxRecordedRefusals ?? 64;
  const maxTranscriptEntries = input.maxTranscriptEntries ?? 500;
  const clock = input.now ?? ((): number => Date.now());
  let artifactTokens = artifactBurst;
  let artifactRefilledAt = clock();
  /** Take one artifact request from the bucket, refilled for the time since the last one. */
  const takeArtifactToken = (): boolean => {
    const at = clock();
    artifactTokens = Math.min(artifactBurst, artifactTokens + (Math.max(0, at - artifactRefilledAt) / 1000) * artifactRefillPerSecond);
    artifactRefilledAt = at;
    if (artifactTokens < 1) return false;
    artifactTokens -= 1;
    return true;
  };
  const artifactsInFlight = new Set<string>();
  const jobsInFlight = new Set<string>();
  const transcript: { kind: string; detail: string }[] = [];
  /** Record what the frame said, dropping the oldest entries past the bound. */
  const record = (entry: { kind: string; detail: string }): void => {
    transcript.push(entry);
    if (transcript.length > maxTranscriptEntries) transcript.splice(0, transcript.length - maxTranscriptEntries);
  };
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
  let availability: readonly FrameActionAvailability[] = [];
  let announced = "";
  let appearance = input.appearance === undefined ? undefined : appearanceSnapshotSchema.parse(input.appearance);
  let appearanceRevision = "";
  const initExtensions = [
    ...(input.artifacts === undefined ? [] : [ARTIFACTS_EXTENSION]),
    ...(input.jobs === undefined ? [] : [JOBS_EXTENSION]),
    ...(appearance === undefined ? [] : [APPEARANCE_EXTENSION]),
  ];
  const postActions = (): void => {
    if (availability.length === 0) return;
    const key = JSON.stringify(availability);
    if (key === announced) return;
    announced = key;
    input.post({
      kind: "actions",
      nonce: input.nonce,
      actions: availability.slice(0, 64).map((entry) => ({
        actionBindingId: entry.actionBindingId,
        available: entry.available,
        ...(entry.reason === undefined || entry.reason === "" ? {} : { reason: entry.reason.slice(0, 600) }),
      })),
    });
  };
  /** An action result, carrying the service's answer only when there is one, so an older runtime still parses it. */
  const postResult = (actionBindingId: string, invocationId: string, outcome: FrameActionOutcome): void => {
    input.post({
      kind: "action-result",
      nonce: input.nonce,
      actionBindingId,
      invocationId,
      status: outcome.status,
      // Bounded as the bridge bounds it: a longer or empty message would fail the frame's schema, and the widget would
      // wait for an answer it had already been sent.
      message: (outcome.message === "" ? outcome.status : outcome.message).slice(0, 1000),
      ...(outcome.output === undefined ? {} : { output: outcome.output.slice(0, 16_000) }),
    });
  };

  const refuse = (code: FrameRefusal, message: string): FrameAcceptance => {
    refusals.push(code);
    if (refusals.length > maxRecordedRefusals) refusals.splice(0, refusals.length - maxRecordedRefusals);
    return { ok: false, code, message };
  };
  /** A refusal the widget has already been answered for, so the host leaves it to the widget. */
  const refuseAnswered = (code: FrameRefusal, message: string): FrameAcceptance => {
    refuse(code, message);
    return { ok: false, code, message, answered: true };
  };

  /** Answer one artifact request, bounded as the bridge bounds it so the frame's schema accepts the answer. */
  const postArtifactResult = (requestId: string, outcome: FrameArtifactOutcome): void => {
    if (status === "disposed") return;
    const base = { kind: "artifact-result" as const, nonce: input.nonce, requestId, status: outcome.status };
    if (outcome.status === "ok") {
      input.post({
        ...base,
        ...(outcome.ref === undefined ? {} : { ref: outcome.ref }),
        ...(outcome.chunkBase64 === undefined ? {} : { chunkBase64: outcome.chunkBase64 }),
        ...(outcome.eof === undefined ? {} : { eof: outcome.eof }),
      });
    } else if (outcome.status === "refused") {
      input.post({
        ...base,
        code: (outcome.code === "" ? "ARTIFACT_REFUSED" : outcome.code).slice(0, 60),
        message: (outcome.message === "" ? "refused" : outcome.message).slice(0, 600),
      });
    } else {
      input.post({ ...base, ...(outcome.message === undefined || outcome.message === "" ? {} : { message: outcome.message.slice(0, 600) }) });
    }
  };

  const postJobResult = (requestId: string, outcome: FrameJobOutcome): void => {
    if (status === "disposed") return;
    if (outcome.status === "ok") {
      input.post({ kind: "job-result", nonce: input.nonce, requestId, status: "ok", job: outcome.job });
      return;
    }
    input.post({
      kind: "job-result",
      nonce: input.nonce,
      requestId,
      status: "refused",
      code: (outcome.code || "JOB_REFUSED").slice(0, 60),
      message: (outcome.message || "job request refused").slice(0, 600),
    });
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
      ...(initExtensions.length === 0 ? {} : { extensions: initExtensions }),
      ...(appearance === undefined ? {} : { appearance }),
    };
    appearanceRevision = appearance?.revision ?? "";
    input.post(message);
    status = "ready";
    postActions();
    return message;
  };

  const dispatch = (message: WidgetToHostMessage): FrameAcceptance => {
    switch (message.kind) {
      case "ready":
        record({ kind: "ready", detail: message.nonce });
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
          record({ kind: "state.update", detail: String(stateRevision) });
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
          record({ kind: "state.update", detail: "view-only" });
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
            record({ kind: "state.update", detail: String(stateRevision) });
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
          record({ kind: "state.refused", detail: outcome.code });
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
        record({ kind: "event", detail: message.name });
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
          postResult(message.actionBindingId, message.invocationId, seen);
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
            postResult(message.actionBindingId, message.invocationId, outcome);
          })
          .catch((error: unknown) => {
            const outcome: FrameActionOutcome = {
              status: "failed",
              message: error instanceof Error ? error.message : "the action failed",
            };
            invocations.set(message.invocationId, outcome);
            postResult(message.actionBindingId, message.invocationId, outcome);
          });
        record({ kind: "action.invoke", detail: message.actionBindingId });
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
        record({ kind: "capability.request", detail: message.capabilityRef });
        return { ok: true, kind: "capability.request", detail: message.capabilityRef };

      case "host.request": {
        // Routed to the host's chrome. The frame never performs the effect itself, and a link is opened by the host
        // deciding to open it rather than by the ask arriving.
        if (message.request === "focus") input.chrome.focus();
        else if (message.request === "resize") input.chrome.resize(Number(message.argument ?? "0"));
        else if (message.request === "request-pin") input.chrome.requestPin();
        else input.chrome.openExternal(message.argument ?? "");
        record({ kind: "host.request", detail: message.request });
        return { ok: true, kind: "host.request", detail: message.request };
      }

      case "artifact.request": {
        const { requestId, request } = message;
        /*
         * Every refusal here is also answered, because the widget's promise is waiting on this request id; a refusal
         * recorded only on the host side would leave it waiting for good.
         */
        const turnAway = (code: FrameRefusal, reason: string): FrameAcceptance => {
          postArtifactResult(requestId, { status: "refused", code, message: reason });
          return refuseAnswered(code, reason);
        };
        if (input.artifacts === undefined) {
          return turnAway("EXTENSION_NOT_OFFERED", `${ARTIFACTS_EXTENSION} is not offered to this frame`);
        }
        if (artifactsInFlight.has(requestId)) {
          return turnAway("ARTIFACT_BUSY", "a request with that id is still being answered");
        }
        if (artifactsInFlight.size >= maxArtifactInFlight) {
          return turnAway("ARTIFACT_BUSY", `at most ${String(maxArtifactInFlight)} file requests may wait at once`);
        }
        artifactsInFlight.add(requestId);
        // What is recorded is the operation and the artifact id: never a name, a type the person chose, or bytes.
        const detail = "artifactId" in request ? `${request.op} ${request.artifactId}` : request.op;
        record({ kind: "artifact.request", detail });
        void input
          .artifacts(request)
          .then((outcome) => postArtifactResult(requestId, outcome))
          .catch(() => {
            // A fixed sentence: what the broker threw is the host's, and may name things the widget must not learn.
            postArtifactResult(requestId, {
              status: "refused",
              code: "ARTIFACT_UNAVAILABLE",
              message: "the file request could not be completed",
            });
          })
          .finally(() => artifactsInFlight.delete(requestId));
        return { ok: true, kind: "artifact.request", detail };
      }

      case "job.request": {
        if (input.jobs === undefined) {
          postJobResult(message.requestId, { status: "refused", code: "EXTENSION_NOT_OFFERED", message: `the host did not offer ${JOBS_EXTENSION}` });
          return refuseAnswered("EXTENSION_NOT_OFFERED", `the host did not offer ${JOBS_EXTENSION}`);
        }
        const maxJobInFlight = input.maxJobInFlight ?? 4;
        if (jobsInFlight.size >= maxJobInFlight) {
          postJobResult(message.requestId, { status: "refused", code: "JOB_BUSY", message: "too many job requests are waiting for this frame" });
          return refuseAnswered("JOB_BUSY", "too many job requests are waiting for this frame");
        }
        if (jobsInFlight.has(message.requestId)) return refuse("JOB_RATE_LIMITED", "this job request id is already in flight");
        jobsInFlight.add(message.requestId);
        void input.jobs(message.request).then((outcome) => postJobResult(message.requestId, outcome)).catch(() => {
          postJobResult(message.requestId, {
            status: "refused",
            code: "JOB_UNAVAILABLE",
            message: "the job request could not be completed; its saved state is still available",
          });
        }).finally(() => jobsInFlight.delete(message.requestId));
        record({ kind: "job.request", detail: message.request.op });
        return { ok: true, kind: "job.request", detail: message.request.op };
      }

      case "semantic.publish":
        // Published for a reader who cannot see the widget, and for the next model turn and voice to know what it shows.
        // Handed on as a proposal: the node bounds and cleans it, and adds the actions from its own bindings.
        record({ kind: "semantic.publish", detail: message.summary });
        input.publishSemantic?.({
          summary: message.summary,
          selectedIds: message.selectedIds,
          ...(message.values === undefined ? {} : { values: message.values }),
        });
        return { ok: true, kind: "semantic.publish", detail: message.summary };
    }
  };

  return {
    init,

    accept(event) {
      if (status === "disposed") return refuse("DISPOSED", "the frame has been disposed");
      /*
       * A message from another window is not this frame's, whatever it says: turned away before it is measured, counted
       * or read, so another widget on the page cannot spend this frame's file rate or message budget — which would leave
       * this widget refused for what someone else sent.
       */
      if (!event.sourceMatchesExpectedWindow) {
        return refuse("SOURCE_MISMATCH", "the message did not come from the window the host registered for this instance");
      }

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
      /*
       * An artifact request may carry one chunk, so it has its own, larger ceiling and its own count. Which ceiling
       * applies is read from the message's own `kind` before it is parsed — a claim, but a harmless one: a message that
       * says it is an artifact request and is not fails the schema below, and the larger ceiling is still a bound.
       */
      const claimsArtifact =
        typeof event.data === "object" && event.data !== null && (event.data as { kind?: unknown }).kind === "artifact.request";
      const ceiling = claimsArtifact ? maxArtifactMessageBytes : maxMessageBytes;
      /*
       * Counted before anything else is looked at, so every message from this frame's window that says it is an artifact
       * request spends from the rate — including one that is too large or malformed. Checking first and counting after
       * would let a frame spend the host's validation for free by sending requests that always fail.
       */
      if (claimsArtifact && !takeArtifactToken()) {
        const reason = `at most ${String(artifactRefillPerSecond)} file requests a second, after a burst of ${String(artifactBurst)}`;
        const requestId = answerableRequestId(event.data, input.nonce);
        if (requestId === undefined || artifactsInFlight.has(requestId)) return refuse("ARTIFACT_RATE_LIMITED", reason);
        postArtifactResult(requestId, { status: "refused", code: "ARTIFACT_RATE_LIMITED", message: reason });
        return refuseAnswered("ARTIFACT_RATE_LIMITED", reason);
      }
      if (bytes > ceiling) {
        return refuse("TOO_LARGE", `message of ${String(bytes)} bytes exceeds ${String(ceiling)}`);
      }
      if (!claimsArtifact) {
        messages += 1;
        if (messages > maxMessages) {
          return refuse("MESSAGE_BUDGET_EXCEEDED", `frame sent more than ${String(maxMessages)} messages`);
        }
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
      record({ kind: "suspend", detail: reason });
    },

    announceActions(actions) {
      if (status === "disposed") return;
      availability = actions;
      // Before init there is no frame listening; `init` sends what was held.
      if (status !== "awaiting-init") postActions();
    },

    announceAppearance(next) {
      if (status === "disposed" || appearance === undefined) return;
      const checked = appearanceSnapshotSchema.parse(next);
      appearance = checked;
      if (status === "awaiting-init" || checked.revision === appearanceRevision) return;
      appearanceRevision = checked.revision;
      input.post({ kind: "appearance.changed", nonce: input.nonce, revision: checked.revision, appearance: checked });
    },

    dispose() {
      if (status === "disposed") return;
      status = "disposed";
      input.post({ kind: "dispose", nonce: input.nonce });
      record({ kind: "dispose", detail: "" });
    },

    status: () => status,
    transcript: () => transcript,
    refused: () => refusals,
  };
}
