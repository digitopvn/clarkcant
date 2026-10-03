import { appearanceSnapshotSchema, type AppearanceSnapshot, type SemanticProposal } from "@clarkcant/contracts";
import {
  ACTIONS_PERFORM_EXTENSION,
  ARTIFACTS_EXTENSION,
  JOBS_EXTENSION,
  JOBS_LIST_EXTENSION,
  JOB_LIST_LIMIT,
  TOKENS_EXTENSION,
  APPEARANCE_EXTENSION,
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  acceptBridgeMessage,
  type ArtifactRef as WireArtifactRef,
  type ArtifactRequest,
  type BrowserToken,
  type JobRequest,
  type TokenRequest,
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
  | "TOKEN_BUSY"
  | "TOKEN_RATE_LIMITED"
  | "TOKEN_NOT_ALLOWED"
  | "PERFORM_UNKNOWN"
  | "DISPOSED";

/**
 * What the frame answered one perform with (`actions.perform@1`).
 *
 * `done` and `refused` are the frame's own answers. `no-answer` is the host giving up waiting, or the frame going away
 * mid-perform: the frame was asked and may have done it, so it is never reported as refused. A perform that was never
 * sent — the frame not mounted, not ready, without the extension, or asked for an action it does not offer — is
 * `refused` with the host's code, and nothing is queued for later.
 */
export type FramePerformOutcome =
  | { status: "done"; output?: string | undefined }
  | { status: "refused"; code: string; message: string }
  | { status: "no-answer"; message: string };

export interface FramePerformRequest {
  performId: string;
  action: string;
  input: Record<string, unknown>;
}

/** How long a frame has to answer one perform before the host stops waiting. Below the node's own wait. */
export const FRAME_PERFORM_TIMEOUT_MS = 6_000;
/** Performs one frame may be asked at once. */
const MAX_PERFORMS_IN_FLIGHT = 4;

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
  /** The answer to `list`: this frame's jobs, newest first. */
  | { status: "ok"; jobs: JobSnapshot[] }
  | { status: "refused"; code: string; message: string };
export type FrameJobBroker = (request: JobRequest) => Promise<FrameJobOutcome>;

export type FrameTokenOutcome =
  | { status: "ok"; token: BrowserToken }
  | { status: "refused"; code: string; message: string };
/**
 * The host's side of `tokens@1`. `request` asks the node for one token under this frame's session; `release` is called
 * once, when the session is disposed, so the node revokes what this frame was given.
 */
export interface FrameTokenBroker {
  request(request: TokenRequest): Promise<FrameTokenOutcome>;
  release(): void;
}

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
  /**
   * The `tokens@1` extension, given only for a frame whose package declared browser tokens. Every request is checked
   * again by the node against that declaration and the provider's support.
   */
  tokens?: FrameTokenBroker;
  /**
   * The names of the actions this widget's definition offers (`offeredActions`). Non-empty, `actions.perform@1` is
   * advertised in `init` and `perform` may ask for one of these, and no other.
   */
  offeredActions?: readonly string[];
  /** How long `perform` waits for the frame's answer. */
  performTimeoutMs?: number;
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
  /**
   * The rate of job requests, counted apart from `maxMessages` for the same reason as artifacts: a widget that watches a
   * job for half an hour reads it many times. A bucket of `jobBurst` requests refilled at `jobRefillPerSecond`.
   */
  jobBurst?: number;
  jobRefillPerSecond?: number;
  /**
   * The rate of token requests: a bucket of `tokenBurst` refilled at `tokenRefillPerSecond`. A frame needs a token when
   * it starts and again as one nears its expiry, so the default is a handful, not a stream.
   */
  tokenBurst?: number;
  tokenRefillPerSecond?: number;
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
  /**
   * Ask the frame to perform an action its definition offers, with input the node has already checked, and wait —
   * bounded — for its answer. Refused at once, with nothing sent or queued, when the frame cannot be asked now.
   */
  perform(request: FramePerformRequest): Promise<FramePerformOutcome>;
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
  const jobBurst = input.jobBurst ?? 60;
  // Above what the SDK spends following the most jobs it waits on at once (4 polls a second), so a cancel still fits.
  const jobRefillPerSecond = input.jobRefillPerSecond ?? 5;
  /** A request bucket that refills for the time since its last request; `take` spends one, or says it is empty. */
  const bucket = (burst: number, refillPerSecond: number): (() => boolean) => {
    let tokens = burst;
    let refilledAt = clock();
    return () => {
      const at = clock();
      tokens = Math.min(burst, tokens + (Math.max(0, at - refilledAt) / 1000) * refillPerSecond);
      refilledAt = at;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
  };
  const takeArtifactToken = bucket(artifactBurst, artifactRefillPerSecond);
  const takeJobToken = bucket(jobBurst, jobRefillPerSecond);
  const tokenBurst = input.tokenBurst ?? 10;
  const tokenRefillPerSecond = input.tokenRefillPerSecond ?? 0.2;
  const takeTokenRequest = bucket(tokenBurst, tokenRefillPerSecond);
  const artifactsInFlight = new Set<string>();
  const jobsInFlight = new Set<string>();
  const tokensInFlight = new Set<string>();
  /**
   * Token values this frame was given. A message that carries one back out verbatim — into state the node stores, a
   * publish the model reads, an action's input a service receives, a file it writes, a link it asks the host to open —
   * is refused. This guards against a widget leaking a token by accident; a widget that transforms the value first
   * (encodes, splits or reverses it) is not caught, so the guarantee is the host's own: it never places a token in
   * props, state, logs or model context. Bounded: a frame given more than this many tokens has its oldest forgotten,
   * and those have long expired.
   */
  const issuedTokens: string[] = [];
  const carriesToken = (value: unknown): boolean => {
    if (issuedTokens.length === 0) return false;
    let text: string;
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      return false;
    }
    return issuedTokens.some((token) => text.includes(token));
  };
  const TOKEN_LEAK =
    "a browser token stays in its frame; it may not be saved in state, published, sent with an action, written to a file or opened as a link";
  /** A file chunk as text, so a token written into a file is found as it would be read back. */
  const chunkText = (chunkBase64: string): string => {
    try {
      return atob(chunkBase64);
    } catch {
      return "";
    }
  };
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
  const offeredActions = new Set(input.offeredActions ?? []);
  const performTimeoutMs = input.performTimeoutMs ?? FRAME_PERFORM_TIMEOUT_MS;
  /** Performs asked and not yet answered, by id. Only one of these may be answered. */
  const performs = new Map<string, { resolve: (outcome: FramePerformOutcome) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Whether the widget has said `ready`: before that, nothing in the frame is listening for a perform. */
  let frameReady = false;
  const settlePerform = (performId: string, outcome: FramePerformOutcome): void => {
    const waiting = performs.get(performId);
    if (waiting === undefined) return;
    performs.delete(performId);
    clearTimeout(waiting.timer);
    waiting.resolve(outcome);
  };
  const initExtensions = [
    ...(offeredActions.size === 0 ? [] : [ACTIONS_PERFORM_EXTENSION]),
    ...(input.artifacts === undefined ? [] : [ARTIFACTS_EXTENSION]),
    // `jobs.list@1` is answered by the same broker, so it is offered with `jobs@1`; a widget asks `list` only when it sees it.
    ...(input.jobs === undefined ? [] : [JOBS_EXTENSION, JOBS_LIST_EXTENSION]),
    ...(input.tokens === undefined ? [] : [TOKENS_EXTENSION]),
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
      input.post(
        "jobs" in outcome
          ? { kind: "job-result", nonce: input.nonce, requestId, status: "ok", jobs: outcome.jobs.slice(0, JOB_LIST_LIMIT) }
          : { kind: "job-result", nonce: input.nonce, requestId, status: "ok", job: outcome.job },
      );
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

  const postTokenResult = (requestId: string, outcome: FrameTokenOutcome): void => {
    if (status === "disposed") return;
    if (outcome.status === "ok") {
      issuedTokens.push(outcome.token.value);
      if (issuedTokens.length > 64) issuedTokens.splice(0, issuedTokens.length - 64);
      input.post({ kind: "token-result", nonce: input.nonce, requestId, status: "ok", token: outcome.token });
      return;
    }
    input.post({
      kind: "token-result",
      nonce: input.nonce,
      requestId,
      status: "refused",
      code: (outcome.code || "TOKEN_REFUSED").slice(0, 60),
      message: (outcome.message || "token request refused").slice(0, 600),
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
        frameReady = true;
        record({ kind: "ready", detail: message.nonce });
        return { ok: true, kind: "ready" };

      case "action.performed": {
        if (!performs.has(message.performId)) {
          // Only an answer the host is waiting for: a frame cannot report a perform nobody asked for.
          return refuse("PERFORM_UNKNOWN", `no perform ${message.performId} is waiting for this frame's answer`);
        }
        if (carriesToken({ output: message.output, message: message.message })) {
          settlePerform(message.performId, { status: "refused", code: "TOKEN_NOT_ALLOWED", message: TOKEN_LEAK });
          return refuse("TOKEN_NOT_ALLOWED", TOKEN_LEAK);
        }
        settlePerform(
          message.performId,
          message.status === "done"
            ? { status: "done", ...(message.output === undefined ? {} : { output: message.output }) }
            : {
                status: "refused",
                code: message.code ?? "ACTION_REFUSED",
                message: message.message ?? "the widget refused the action",
              },
        );
        record({ kind: "action.performed", detail: `${message.performId} ${message.status}` });
        return { ok: true, kind: "action.performed", detail: message.status };
      }

      case "state.update": {
        if (carriesToken(message.patch)) {
          // Answered with the committed state, so the widget is not left waiting, and nothing of the patch is kept.
          input.post({
            kind: "state",
            nonce: input.nonce,
            state,
            revision: stateRevision,
            refused: { code: "STATE_HOLDS_TOKEN", message: TOKEN_LEAK },
          });
          return refuse("TOKEN_NOT_ALLOWED", TOKEN_LEAK);
        }
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
        if (carriesToken(message.input)) {
          postResult(message.actionBindingId, message.invocationId, { status: "refused", message: TOKEN_LEAK });
          return refuse("TOKEN_NOT_ALLOWED", TOKEN_LEAK);
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
        if (message.request === "open-external" && carriesToken(message.argument ?? "")) {
          // A link the host would open in the person's browser, carrying the token to whatever site it names.
          return refuse("TOKEN_NOT_ALLOWED", TOKEN_LEAK);
        }
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
        // A file outlives the frame and can be attached to the conversation: the token is looked for in its bytes too.
        if (carriesToken(request.op === "write" ? { ...request, chunk: chunkText(request.chunkBase64) } : request)) {
          return turnAway("TOKEN_NOT_ALLOWED", TOKEN_LEAK);
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

      case "token.request": {
        if (input.tokens === undefined) {
          postTokenResult(message.requestId, { status: "refused", code: "EXTENSION_NOT_OFFERED", message: `the host did not offer ${TOKENS_EXTENSION}` });
          return refuseAnswered("EXTENSION_NOT_OFFERED", `the host did not offer ${TOKENS_EXTENSION}`);
        }
        if (tokensInFlight.has(message.requestId)) return refuse("TOKEN_BUSY", "this token request id is already being answered");
        if (tokensInFlight.size >= 2) {
          postTokenResult(message.requestId, { status: "refused", code: "TOKEN_BUSY", message: "at most 2 token requests may wait at once" });
          return refuseAnswered("TOKEN_BUSY", "at most 2 token requests may wait at once");
        }
        tokensInFlight.add(message.requestId);
        void input.tokens
          .request(message.request)
          .then((outcome) => postTokenResult(message.requestId, outcome))
          .catch(() => {
            // A fixed sentence: what the broker threw is the host's, and may name things the widget must not learn.
            postTokenResult(message.requestId, { status: "refused", code: "TOKEN_UNAVAILABLE", message: "the token request could not be completed" });
          })
          .finally(() => tokensInFlight.delete(message.requestId));
        // The provider only: the scopes are the package's own declaration, and the value is never recorded.
        record({ kind: "token.request", detail: message.request.provider });
        return { ok: true, kind: "token.request", detail: message.request.provider };
      }

      case "semantic.publish":
        if (carriesToken({ summary: message.summary, selectedIds: message.selectedIds, values: message.values })) {
          // Not recorded either: the transcript would otherwise hold the summary that carried it.
          return refuse("TOKEN_NOT_ALLOWED", TOKEN_LEAK);
        }
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
      const claimsJob =
        typeof event.data === "object" && event.data !== null && (event.data as { kind?: unknown }).kind === "job.request";
      if (claimsJob && !takeJobToken()) {
        const reason = `at most ${String(jobRefillPerSecond)} job requests a second, after a burst of ${String(jobBurst)}`;
        const requestId = answerableRequestId(event.data, input.nonce);
        if (requestId === undefined || jobsInFlight.has(requestId) || input.jobs === undefined) return refuse("JOB_RATE_LIMITED", reason);
        postJobResult(requestId, { status: "refused", code: "JOB_RATE_LIMITED", message: reason });
        return refuseAnswered("JOB_RATE_LIMITED", reason);
      }
      const claimsToken =
        typeof event.data === "object" && event.data !== null && (event.data as { kind?: unknown }).kind === "token.request";
      if (claimsToken && !takeTokenRequest()) {
        const reason = `at most ${String(tokenBurst)} token requests, then one every ${String(Math.round(1 / tokenRefillPerSecond))} seconds`;
        const requestId = answerableRequestId(event.data, input.nonce);
        if (requestId === undefined || tokensInFlight.has(requestId) || input.tokens === undefined) return refuse("TOKEN_RATE_LIMITED", reason);
        postTokenResult(requestId, { status: "refused", code: "TOKEN_RATE_LIMITED", message: reason });
        return refuseAnswered("TOKEN_RATE_LIMITED", reason);
      }
      if (bytes > ceiling) {
        return refuse("TOO_LARGE", `message of ${String(bytes)} bytes exceeds ${String(ceiling)}`);
      }
      // An answer to a perform the host asked for is the host's request coming back, not the frame talking; it is bounded
      // by how often the host asks, so it does not spend the frame's own message budget.
      const answersPerform =
        performs.size > 0 &&
        typeof event.data === "object" &&
        event.data !== null &&
        (event.data as { kind?: unknown }).kind === "action.performed";
      if (!claimsArtifact && !claimsJob && !claimsToken && !answersPerform) {
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

    perform(request) {
      const refused = (code: string, message: string): Promise<FramePerformOutcome> =>
        Promise.resolve({ status: "refused", code, message });
      if (status === "disposed") return refused("FRAME_NOT_MOUNTED", "the widget's frame has been closed");
      if (status === "suspended") return refused("FRAME_NOT_READY", "the widget's frame is suspended");
      if (status === "awaiting-init" || !frameReady) return refused("FRAME_NOT_READY", "the widget's frame has not finished opening");
      if (offeredActions.size === 0) {
        return refused("EXTENSION_NOT_OFFERED", `this widget offers no actions, so ${ACTIONS_PERFORM_EXTENSION} is not open to it`);
      }
      if (!offeredActions.has(request.action)) {
        return refused("ACTION_NOT_OFFERED", `this widget does not offer an action named "${request.action}"`);
      }
      if (performs.has(request.performId)) return refused("PERFORM_IN_PROGRESS", "this perform is already waiting for the widget's answer");
      if (performs.size >= MAX_PERFORMS_IN_FLIGHT) {
        return refused("PERFORM_BUSY", `the widget is already performing ${String(MAX_PERFORMS_IN_FLIGHT)} actions`);
      }
      return new Promise<FramePerformOutcome>((resolve) => {
        const timer = setTimeout(() => {
          settlePerform(request.performId, {
            status: "no-answer",
            message: `the widget did not answer within ${String(Math.ceil(performTimeoutMs / 1000))} s`,
          });
        }, performTimeoutMs);
        performs.set(request.performId, { resolve, timer });
        record({ kind: "action.perform", detail: `${request.performId} ${request.action}` });
        input.post({
          kind: "action.perform",
          nonce: input.nonce,
          performId: request.performId,
          action: request.action,
          input: request.input,
        });
      });
    },

    dispose() {
      if (status === "disposed") return;
      status = "disposed";
      // A perform the frame was sent may have run before it went: said as unknown, never as refused.
      for (const performId of [...performs.keys()]) {
        settlePerform(performId, { status: "no-answer", message: "the widget's frame closed before it answered" });
      }
      // The node revokes what this frame was given; the values are forgotten here at once.
      issuedTokens.length = 0;
      input.tokens?.release();
      input.post({ kind: "dispose", nonce: input.nonce });
      record({ kind: "dispose", detail: "" });
    },

    status: () => status,
    transcript: () => transcript,
    refused: () => refusals,
  };
}
