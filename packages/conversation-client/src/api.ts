/**
 * Gateway client.
 *
 * The only place the UI talks to the runtime. Kept tiny and explicit so the authorization
 * story is visible: every call carries the bearer token, and nothing ever sends a
 * principal, because the gateway derives the caller from the channel rather than the body.
 */

import type { AutonomySettings, ModelPool } from "@clarkcant/contracts";

import {
  memoryListSchema,
  suggestionsResponseSchema,
  type AppIntentDecision,
  type AppIntentKind,
  type AppIntentResolution,
  type ConfirmationDecision,
  type MemoryRecord,
  type RegisteredPreference,
  type SettingsTab,
  type Suggestion,
  type VoiceCapabilities,
} from "@clarkcant/contracts";

import {
  type StartVoiceSessionOptions,
  type VoiceSession,
  type VoiceSessionEvents,
  startVoiceSession,
} from "./voice-session.ts";

export interface GatewayClientOptions {
  baseUrl: string;
  token: string;
  /** Injected so tests and the E2E harness can substitute a transport. */
  fetchImpl?: typeof fetch;
}
/** What a live composed surface resolves to right now. */
/**
 * A widget that runs in its own frame.
 *
 * A different shape rather than more fields on the one below, because the two are not the same thing: a composition
 * is data the client draws, and this is a URL it mounts plus the bindings that mount may invoke. A single interface
 * with half its fields empty would make every reader check which half it is holding.
 */
export interface IsolatedFrameLiveResponse {
  kind: "isolated-frame";
  instanceId: string;
  revision: number;
  readOnly: boolean;
  frame: {
    /** Relative to the node, and served from the package path so the widget's own imports resolve. */
    url: string;
    isolation: string;
    requestedCapabilities: readonly string[];
    allowedOrigins: readonly string[];
  };
  /**
   * The bindings the frame may invoke, with the digest to send back.
   *
   * A frame names one of these ids and nothing else: the session refuses an unknown id before the node ever sees it.
   */
  bindings: {
    actionBindingId: string;
    label: string;
    effectCategory: string;
    bindingDigest: string;
  }[];
  /** What the widget was created with, sent to it in the init message and nowhere else. */
  props: Record<string, unknown>;
}

export interface LiveWidgetResponse {
  kind: "composition";
  compositionId: string;
  readOnly: boolean;
  spec: CompositionResponse["spec"];
  /** The compiled bindings for this instance, with the digest the client must send back. */
  bindings: {
    actionBindingId: string;
    sectionId: string;
    label: string;
    kind: string;
    effectCategory: string;
    bindingDigest: string;
  }[];
  sections: CompositionResponse["sections"];
  availability: Record<string, "live" | "missing" | "denied">;
  revision: number;
  stateRevision: number;
  state: Record<string, unknown>;
  ownerSurface: "inline" | "pin" | null;
  capturedAt: null;
  tombstone: null;
  period: "week" | "month";
  timezone: string;
  conversationId: string;
}

/** What a historical surface renders from: the bundle captured with the message. */
export interface SnapshotPresentationResponse {
  snapshot: { instanceId?: string; capturedAt?: string; stale?: boolean } & Record<string, unknown>;
  readOnly: true;
  text: string;
  bundleRef: string | null;
  /** Present when the message was captured with a bundle; absent for a legacy snapshot. */
  spec?: CompositionResponse["spec"];
  sections: CompositionResponse["sections"];
  tombstone: { reason: string; at: string } | null;
  catalogDigest?: string;
}

/**
 * What a start-session request produced.
 *
 * `needs-path` is the case the plan asks about by name: nothing matched, so the user is asked for a
 * directory and the answer is a path. `clarify` is the other question — several directories could be
 * meant — and its options are what the user chooses between.
 */
export type StartSessionResponse =
  | {
      status: "started";
      projectName: string;
      relPath: string;
      mode: string;
      sessionId: string;
      sessionFile: string | null;
      messageId: string;
      timeline: Timeline;
    }
  | {
      status: "clarify" | "needs-path";
      question: string;
      options: string[];
      messageId: string;
      timeline: Timeline;
    };

export interface ActionInvocationResult {
  duplicate: boolean;
  instanceId: string;
  revision: number;
  stateRevision: number;
  state: Record<string, unknown>;
  pinId: string | null;
  timeline: Timeline;
}

export interface TimelineMessage {
  messageId: string;
  role: "user" | "assistant" | "system" | "tool";
  blocks: Record<string, unknown>[];
  createdAt: string;
}

export interface TimelineInstance {
  instanceId: string;
  definitionId: string;
  definitionVersion: string;
  lifecycle: string;
  revision: number;
  props: Record<string, unknown>;
}

/** A historical capture, separate from the live instance it came from. */
export interface TimelineSnapshotView {
  snapshotId: string;
  messageId: string;
  instanceId?: string;
  capturedRevision: number;
  capturedAt: string;
  /** True once the live instance has moved past this revision. */
  stale: boolean;
  presentationRef: string;
  bundleRef?: string;
  catalogDigest?: string;
  textAlternative: string;
}

export interface Timeline {
  conversationId: string;
  cursor: number;
  messages: TimelineMessage[];
  pins: { pinId: string; instanceId: string; displayMode: string; position: number; refreshPolicy: string }[];
  instances: TimelineInstance[];
  /** The authoritative staleness and capture identity, which the message document cannot carry. */
  snapshots: TimelineSnapshotView[];
  metadata: { messageCount: number; taskCount: number; updatedAt: string };
  activeTaskIds: string[];
}

export interface ResolvedDataset {
  datasetId: string;
  rowCount: number;
  freshness: "live" | "cached" | "sample" | "unknown";
  updatedAt: string;
  document: { rows: Record<string, unknown>[] };
}

/** The stored composition a composed surface renders from, plus the bundle captured with it. */
export interface CompositionResponse {
  compositionId: string;
  spec: {
    schemaVersion: number;
    compositionId: string;
    instanceId: string;
    templateId: string;
    templateVersion: string;
    catalogDigest: string;
    sections: {
      sectionId: string;
      slot: string;
      definitionRef: { id: string; version: string; digest: string };
      props: Record<string, unknown>;
      dataRefs: string[];
      textAlternative: string;
    }[];
    initialState: { period: "week" | "month"; selectedDate?: string; timezone: string };
    actions: { actionBindingId: string; sectionId: string; label: string; kind: string; effectCategory: string }[];
    provenance: { createdAt: string };
  };
  bundleRef: string | null;
  tombstone: { reason: string; at: string } | null;
  sections: {
    sectionId: string;
    slot: string;
    definitionRef: { id: string; version: string; digest: string };
    props: Record<string, unknown>;
    dataRefs: string[];
    rows?: Record<string, unknown>[];
    textAlternative: string;
  }[];
  capturedAt: string | null;
  byteSize: number;
}

export interface CalendarEventView {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  date: string;
  source: "local";
}

export interface ImageView {
  imageId: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  digest: string;
  alt: string;
  createdAt: string;
  url: string;
}

/** What a message that was accepted produced, streamed or not. */
export interface SendMessageResult {
  resolution: string;
  taskId: string | null;
  /** The messages this request wrote, in order. */
  messageIds: string[];
  /**
   * A command the node recognised in what was typed.
   *
   * Present when the text was an application command rather than a request for the agent. The node answers those
   * itself and records them, and the page runs the decision - which is what makes typing "mở settings" open the
   * panel exactly as saying it does.
   */
  appIntent?: AppIntentResolution;
  /** Every message in the conversation, so the client never has to guess whether its cursor is valid. */
  timeline: Timeline;
}

/** One event from a turn that is still running, as the client receives it. */
export type ReplyStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-start"; toolCallId: string; name: string; label: string; args: Record<string, unknown> }
  | { type: "tool-end"; toolCallId: string; status: "done" | "failed"; result: string };

/** One frame of a server-sent event stream. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Split one chunk of an event stream into complete frames, keeping the incomplete tail.
 *
 * Incremental by design: a chunk boundary can fall anywhere, including in the middle of the event
 * name or of a multi-byte character, so a parser that only understands whole frames would drop text
 * at exactly the sizes nobody tests with.
 *
 * Comment frames — the ones a server sends to keep a connection alive — carry no data and are
 * dropped. Returning them would mean every keep-alive arrived at the caller as an empty event.
 */
export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;
  for (;;) {
    // The frame separator is the transport's to choose, so both spellings are accepted.
    const separator = /\r?\n\r?\n/.exec(rest);
    if (separator === null) break;
    const frame = rest.slice(0, separator.index);
    rest = rest.slice(separator.index + separator[0].length);
    const parsed = parseSseFrame(frame);
    if (parsed !== undefined) events.push(parsed);
  }
  return { events, rest };
}

function parseSseFrame(frame: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    // A line starting with a colon is a comment, and an empty line inside a frame is padding.
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional space after the colon belongs to the format, not to the value.
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length === 0 ? undefined : { event, data: data.join("\n") };
}

/** What the node reports about an artifact. No path, deliberately: see `artifact()`. */
/**
 * A controlled surface as the node holds it.
 *
 * The epoch is the fencing token and `preview` is whether the surface can currently be observed, so both are on
 * the wire: a client that cannot see them cannot say whether the agent may still act.
 */
export interface ControlSessionView {
  sessionId: string;
  surface: "browser" | "computer";
  label: string;
  owner: "agent" | "user";
  status: "running" | "stopped";
  leaseEpoch: number;
  preview: "available" | "needs-permission" | "unavailable";
  previewReason?: string;
  takenOverAt?: string;
  stoppedAt?: string;
}

/** An installed package, as the node reports it. */
export interface InstalledPackageView {
  packageId: string;
  version: string;
  digest: string;
  codeGeneration: string;
  activatedAt: string;
  source: { sourceTier: string; rationale: string; artifactUrl: string };
  /** The strongest lane among the package's facets: a package is as trusted as its least isolated part. */
  lane: "isolated-ui" | "service" | "declarative" | "trusted-native";
  consentedDigest?: string;
}

export interface ArtifactView {
  artifactId: string;
  digest: string;
  sizeBytes: number;
  mimeType: string;
  originNodeId: string;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
}

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
  }
}

export class GatewayClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Open a live voice session against this node.
   *
   * The token stays here rather than being handed to the surface. That is the point: the voice
   * socket authenticates in its first frame, and the only component that already holds the
   * credential is this one. A surface that had to ask for it would put the token into a prop,
   * and props end up in devtools, snapshots and logs.
   *
   * The injection points exist so this can be exercised without a microphone or an audio device.
   */
  openVoiceSession(
    options: {
      conversationId?: string;
      events: VoiceSessionEvents;
    } & Pick<
      StartVoiceSessionOptions,
      "mediaDevices" | "createAudioContext" | "createSocket" | "onSampleRateFallback"
    >,
  ): Promise<VoiceSession> {
    return startVoiceSession({ ...options, nodeBaseUrl: this.#baseUrl, token: this.#token });
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    let parsed: unknown = {};
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GatewayError(
          response.status,
          "MALFORMED_RESPONSE",
          `the gateway returned a body that is not JSON (status ${response.status})`,
        );
      }
    }

    if (!response.ok) {
      const record = parsed as { code?: string; message?: string };
      throw new GatewayError(response.status, record.code ?? "UNKNOWN", record.message ?? "the request failed");
    }
    return parsed as T;
  }

  health(): Promise<{ status: string; runtime: { node: string; platform: string; arch: string } }> {
    return this.#call("GET", "/health");
  }

  /**
   * This node's identity and what it is configured to run on.
   *
   * `model` is null when the node has none, which the settings surface shows as a state rather
   * than as an absence — a node without a model is a perfectly good node, it just answers from
   * scripts and capabilities instead of calling a provider.
   */
  node(): Promise<{
    nodeId: string;
    label: string;
    createdAt: string;
    model: { provider: string; id: string; maxWallClockMs: number; maxTokens: number } | null;
  }> {
    return this.#call("GET", "/node");
  }

  createConversation(title?: string): Promise<{ conversationId: string }> {
    return this.#call("POST", "/conversations", title === undefined ? {} : { title });
  }

  listConversations(): Promise<{ conversations: { conversationId: string }[] }> {
    return this.#call("GET", "/conversations");
  }

  /**
   * What the node suggests doing next.
   *
   * The body is parsed rather than trusted: it crosses a socket and a version boundary, and a client that trusted
   * it would render whatever an older or newer node happened to send. A node that answers with a shape this build
   * does not know is an error here, which the caller turns into the fallback chips - not a broken first screen.
   */
  async suggestions(): Promise<Suggestion[]> {
    const body = await this.#call<unknown>("GET", "/suggestions");
    return suggestionsResponseSchema.parse(body).items;
  }

  /**
   * What this node remembers, or why it could not be read.
   *
   * Failure is an answer rather than a throw, because the Memory tab has a state for it: a screen that cannot
   * list what is remembered still has to render, with the reason and a way to try again. A thrown error here
   * would be a blank panel with nothing to act on.
   */
  async listMemories(): Promise<
    | { ok: true; items: MemoryRecord[]; counts: Record<string, number> }
    | { ok: false; reason: string }
  > {
    try {
      const body = await this.#call<unknown>("GET", "/memory");
      const parsed = memoryListSchema.safeParse(body);
      if (!parsed.success) return { ok: false, reason: "the node's answer was not a list of remembered things" };
      return { ok: true, items: parsed.data.items, counts: parsed.data.counts };
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : "the node did not answer" };
    }
  }

  /** Remove one, and say whether it went. */
  async deleteMemory(memoryId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.#call<unknown>("DELETE", `/memory/${encodeURIComponent(memoryId)}`);
      return { ok: true };
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : "the node did not answer" };
    }
  }

  sendMessage(
    conversationId: string,
    text: string,
    options: { demo?: boolean; attachmentIds?: readonly string[] } = {},
  ): Promise<SendMessageResult> {
    return this.#call("POST", `/conversations/${conversationId}/messages`, {
      text,
      ...(options.demo === true ? { demo: true } : {}),
      ...(options.attachmentIds === undefined || options.attachmentIds.length === 0
        ? {}
        : { attachmentIds: [...options.attachmentIds] }),
    });
  }

  /**
   * Send a message and read the reply while it is being written.
   *
   * The same request as `sendMessage`, against the route that reports it as it happens. `done`
   * carries the identical timeline the plain route returns, so a caller ends up with the node's own
   * record either way and the stream is only a view of something that would have arrived whole.
   *
   * Resolves when the stream ends. Throws on a refusal that has a status code, on an `error` event
   * (which is the only way the node can report a failure once the status line has been sent), and on
   * a stream that ends without a `done` — that last one because a truncated reply shown as a
   * finished answer is worse than an error the user can see.
   */
  async streamMessage(
    conversationId: string,
    text: string,
    listeners: { onEvent: (event: ReplyStreamEvent) => void; onDone: (result: SendMessageResult) => void; signal?: AbortSignal },
    options: { demo?: boolean; attachmentIds?: readonly string[] } = {},
  ): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/conversations/${conversationId}/messages/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        text,
        ...(options.demo === true ? { demo: true } : {}),
        // Omitted rather than sent as an empty array: a node that predates attachments validates this field
        // when it is present, and an empty list is not worth an extra rule on either side.
        ...(options.attachmentIds === undefined || options.attachmentIds.length === 0
          ? {}
          : { attachmentIds: [...options.attachmentIds] }),
      }),
      ...(listeners.signal === undefined ? {} : { signal: listeners.signal }),
    });

    if (!response.ok) {
      const body = await response.text();
      let parsed: { code?: string; message?: string } = {};
      try {
        parsed = JSON.parse(body) as { code?: string; message?: string };
      } catch {
        // The refusal is still a refusal; only its wording is missing.
      }
      throw new GatewayError(response.status, parsed.code ?? "UNKNOWN", parsed.message ?? "the request failed");
    }

    const body = response.body;
    if (body === null) {
      throw new GatewayError(response.status, "STREAM_UNAVAILABLE", "the node answered without a body to stream");
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.events) {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(frame.data) as Record<string, unknown>;
        } catch {
          throw new GatewayError(response.status, "MALFORMED_FRAME", `the node sent an ${frame.event} event that is not JSON`);
        }
        if (frame.event === "delta") {
          listeners.onEvent({ type: "text-delta", text: typeof payload.text === "string" ? payload.text : "" });
        } else if (frame.event === "reasoning") {
          listeners.onEvent({ type: "reasoning-delta", text: typeof payload.text === "string" ? payload.text : "" });
        } else if (frame.event === "tool-start") {
          listeners.onEvent({
            type: "tool-start",
            toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : "",
            name: typeof payload.name === "string" ? payload.name : "tool",
            label: typeof payload.label === "string" ? payload.label : "",
            args: typeof payload.args === "object" && payload.args !== null ? (payload.args as Record<string, unknown>) : {},
          });
        } else if (frame.event === "tool-end") {
          listeners.onEvent({
            type: "tool-end",
            toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : "",
            status: payload.status === "failed" ? "failed" : "done",
            result: typeof payload.result === "string" ? payload.result : "",
          });
        } else if (frame.event === "done") {
          finished = true;
          listeners.onDone({
            resolution: typeof payload.resolution === "string" ? payload.resolution : "unknown",
            taskId: typeof payload.taskId === "string" ? payload.taskId : null,
            messageIds: Array.isArray(payload.messageIds)
              ? payload.messageIds.filter((id): id is string => typeof id === "string")
              : [],
            ...(payload.appIntent === undefined
              ? {}
              : { appIntent: payload.appIntent as AppIntentResolution }),
            // SAFETY: the timeline is the node's own record and this client has no schema for it — the
            // same position every other route here takes, since the channel is authenticated and the
            // node is the authority on its own timeline. Its fields are read defensively at each use.
            timeline: payload.timeline as Timeline,
          });
        } else if (frame.event === "error") {
          throw new GatewayError(
            response.status,
            typeof payload.code === "string" ? payload.code : "TURN_FAILED",
            typeof payload.message === "string" ? payload.message : "the turn failed",
          );
        }
        // Any other event is one this client does not know about yet, which is not a reason to fail
        // a reply that is otherwise arriving: the `done` frame is what makes it complete.
      }
    }

    if (!finished) {
      throw new GatewayError(
        response.status,
        "STREAM_INCOMPLETE",
        "the node ended the stream before the answer was finished",
      );
    }
  }

  timeline(conversationId: string, after = 0): Promise<Timeline> {
    return this.#call("GET", `/conversations/${conversationId}/timeline?after=${after}`);
  }

  dataset(datasetId: string): Promise<ResolvedDataset> {
    return this.#call("GET", `/datasets/${datasetId}`);
  }

  pin(conversationId: string, instanceId: string, displayMode: "compact" | "expanded" = "compact"): Promise<{ pinId: string; timeline: Timeline }> {
    return this.#call("POST", `/conversations/${conversationId}/pins`, { instanceId, displayMode });
  }

  unpin(conversationId: string, pinId: string): Promise<{ removed: boolean; timeline: Timeline }> {
    return this.#call("DELETE", `/conversations/${conversationId}/pins/${pinId}`);
  }

  capabilities(): Promise<{ capabilities: { ref: string; summary: string; usable: boolean; blockedReason?: string }[] }> {    return this.#call("GET", "/capabilities");
  }

  /**
   * The effects this node performed without an approval card, newest first.
   *
   * The record that makes autonomy checkable: an approval card is its own evidence, and an effect that skipped
   * the card leaves one here instead. Empty is a real answer — nothing has run without asking yet.
   */
  activity(): Promise<{
    effects: {
      at: string;
      kind: string;
      mode: string;
      category: string;
      description: string;
      operationDigest: string;
      because: string;
    }[];
  }> {
    return this.#call("GET", "/activity");
  }

  /**
   * What the configured voice provider can do, as it reports it.
   *
   * The surface draws its voice control from this rather than from a list of provider names, so a provider
   * that cannot select a voice shows no selector instead of one that changes nothing.
   */
  voiceCapabilities(): Promise<{ capabilities: VoiceCapabilities }> {
    return this.#call("GET", "/voice/capabilities");
  }

  /**
   * The registered preferences and their current values.
   *
   * Every registered key is answered, including the ones nobody has set: those come back with the
   * default the product would use and `isDefault: true`, so a settings surface renders an actual
   * current state instead of inventing one — and cannot show a default as a choice the user made.
   * `applies` says when a change is in effect, so the copy can say "next voice session" rather than
   * implying that something already speaking changed underneath the reader.
   */
  preferences(): Promise<{ preferences: RegisteredPreference[] }> {
    return this.#call("GET", "/preferences");
  }

  /**
   * Writes one registered preference.
   *
   * The node validates the value against the key's own schema before storing anything, so a refused
   * write leaves the previous value exactly where it was, and the error names the field rather than
   * echoing what was sent.
   */
  writePreference(key: string, value: unknown): Promise<{ preference: RegisteredPreference }> {
    return this.#call("PUT", `/preferences/${encodeURIComponent(key)}`, { value });
  }

  /**
   * Undoes the last write to one preference.
   *
   * `undone: false` travels as a success, because a key nobody has written has nothing to undo.
   */
  undoPreference(
    key: string,
  ): Promise<{ undone: boolean; preference: RegisteredPreference; reason?: string }> {
    return this.#call("POST", `/preferences/${encodeURIComponent(key)}/undo`);
  }

  /**
   * Chooses the model to run for sessions created from now on.
   *
   * The node stores the choice and answers with the scope it reaches: a conversation already open keeps the model it
   * began with, so this is not a switch that changes what is running underneath somebody mid-sentence.
   */
  /**
   * The pool of models this node keeps, with what the catalogue says about each one.
   *
   * `checked` is the node's own answer about whether it can run a profile, not something the client derives: the
   * catalogue lives on the node, and a client that guessed would disagree with the node at the first upgrade.
   */
  async modelPool(): Promise<{
    pool: ModelPool;
    currentAlias?: string;
    checked: { alias: string; ok: boolean; message?: string }[];
  }> {
    return this.#call("GET", "/model-pool");
  }

  async putModelPool(pool: ModelPool): Promise<{ ok: boolean; pool: ModelPool }> {
    return this.#call("POST", "/model-pool", { pool });
  }

  /**
   * Move to the next enabled profile.
   *
   * The node answers with the alias it moved to and says what that applies to, because the honest answer is "a new
   * generation" rather than "now": a running turn keeps the model it started with.
   */
  async cycleModel(): Promise<{
    ok: boolean;
    previous?: string;
    alias: string;
    provider: string;
    modelId: string;
    applies: string;
  }> {
    return this.#call("POST", "/model-pool/cycle", {});
  }

  async chooseModel(input: {
    provider: string;
    id: string;
  }): Promise<{
    ok: boolean;
    stored: { provider: string; id: string };
    /**
     * When the choice takes effect.
     *
     * `next-session` when the node already has a model turn to read it — the choice lands on the next conversation.
     * `next-start` when it has none, which is the node that has never run a model: the choice is stored, and the node
     * starts with it next time. The copy beside the field says which, rather than promising the sooner of the two.
     */
    applies: "next-session" | "next-start";
  }> {
    return this.#call("POST", "/model", input);
  }

  /**
   * How much this node does on its own, and what may stop it.
   *
   * The narrowing list comes back with the settings because the panel shows what the guardrail is allowed to
   * ask for: a host-owned list a guardrail may pick from, never compose.
   */
  async autonomy(): Promise<{ settings: AutonomySettings; narrowing: { id: string; description: string }[] }> {
    return this.#call("GET", "/autonomy");
  }

  async putAutonomy(settings: AutonomySettings): Promise<{ ok: boolean; settings: AutonomySettings }> {
    return this.#call("POST", "/autonomy", { settings });
  }

  /**
   * Forgets a credential this node holds.
   *
   * This is what logging out of a provider is: the key is the only thing the node holds for it, so a node that has
   * forgotten it stops using that provider. The node answers with the names that remain, never a value and never a
   * length, and says not-found rather than success when there was nothing to forget.
   */
  async deleteCredential(name: string): Promise<{ ok: boolean; names: string[] }> {
    return this.#call("DELETE", `/credentials/${encodeURIComponent(name)}`);
  }

  /**
   * What this node offers, and what the agent it drives offers.
   *
   * Two lists rather than one, because a reader deciding whether something is possible needs to know which half would
   * do it: a tool the node holds works here, and one the agent holds works wherever the agent was pointed.
   */
  tools(): Promise<{
    self: { name: string; label: string; description: string }[];
    agent: { name: string; label: string; description: string }[];
    agentNote?: string;
  }> {
    return this.#call("GET", "/tools");
  }

  /**
   * What this node has already been told: whether it can run a model, and which credentials it already holds.
   *
   * Names only, never values. The first run reads this to skip questions the machine has already answered, and a client
   * that asked for a value here would be asking for exactly the thing the asking exists to avoid.
   */
  readiness(): Promise<{ model: boolean; credentials: string[] }> {
    return this.#call("GET", "/readiness");
  }

  /**
   * What pi loads on this machine.
   *
   * Names and kinds only: an extension can hold a credential, and a surface that reported more would be the place it
   * leaked from. Read from the node, because which extensions exist belongs to the machine pi runs on.
   */
  extensions(): Promise<{ extensions: { name: string; kind: "directory" | "file" }[] }> {
    return this.#call("GET", "/extensions");
  }

  /**
   * pi's own configuration, as far as the node is willing to report it.
   *
   * Scalars only, and anything whose name sounds like a secret arrives already redacted: the node is the only thing that
   * can see the file, so the decision about what may be shown is made there rather than here.
   */
  piSettings(): Promise<{ settings: { key: string; value: string }[] }> {
    return this.#call("GET", "/pi-settings");
  }

  /**
   * The providers and models this node can run, and the one it is configured for.
   *
   * Read from the node's own catalogue rather than from a list kept here, so upgrading pi on the node makes a new
   * provider appear in the interface without the interface changing. `current` is reported beside the catalogue rather
   * than inferred from it, because a node configured for a model its installation no longer offers is a state worth
   * showing plainly.
   */
  model(): Promise<{
    current: { provider: string; id: string } | null;
    catalogue: {
      id: string;
      models: { provider: string; id: string; contextWindow?: number; current: boolean }[];
    }[];
  }> {
    return this.#call("GET", "/model");
  }

  /**
   * The stored composition and the bundle captured with it.
   *
   * The snapshot's rows travel here rather than through the message, so the transcript keeps its
   * size while history stays exactly what the user saw.
   */
  composition(conversationId: string, instanceId: string): Promise<CompositionResponse> {
    return this.#call("GET", `/conversations/${conversationId}/widgets/${instanceId}/composition`);
  }

  /* Local calendar. Local records only: these routes never reach a provider. */

  calendarEvents(options: { from?: string; to?: string } = {}): Promise<{ events: CalendarEventView[]; source: "local" }> {
    const query = new URLSearchParams();
    if (options.from !== undefined) query.set("from", options.from);
    if (options.to !== undefined) query.set("to", options.to);
    const suffix = query.toString() === "" ? "" : `?${query.toString()}`;
    return this.#call("GET", `/calendar/events${suffix}`);
  }

  createEvent(input: { title: string; startsAt: string; endsAt: string; timezone: string }): Promise<{ event: CalendarEventView }> {
    return this.#call("POST", "/calendar/events", input);
  }

  updateEvent(
    eventId: string,
    input: { title?: string; startsAt?: string; endsAt?: string; timezone?: string },
  ): Promise<{ event: CalendarEventView }> {
    return this.#call("PATCH", `/calendar/events/${eventId}`, input);
  }

  deleteEvent(eventId: string): Promise<{ removed: boolean }> {
    return this.#call("DELETE", `/calendar/events/${eventId}`);
  }

  /* Imported images. */

  images(): Promise<{ images: ImageView[] }> {
    return this.#call("GET", "/images");
  }

  importImage(input: { dataBase64: string; mimeType: string; altText: string }): Promise<{ image: ImageView }> {
    return this.#call("POST", "/images", input);
  }

  deleteImage(imageId: string): Promise<{ removed: boolean }> {
    return this.#call("DELETE", `/images/${imageId}`);
  }

  /**
   * Approve or refuse an operation the agent asked for.
   *
   * The digest the card showed is sent back with the decision, because the node compares it against a
   * digest recomputed from the operation it is about to run: an approval is bound to the exact thing
   * that was displayed, so a payload that changed between display and decision is refused rather than
   * executed. This is the only route that can start a command, and it takes a decision from a user.
   */
  decideApproval(
    conversationId: string,
    approvalId: string,
    decision: { decision: "granted" | "denied"; digest: string },
  ): Promise<{ decision: string; timeline: Timeline; outcome?: string }> {
    return this.#call("POST", `/conversations/${conversationId}/approvals/${approvalId}/decide`, decision);
  }

  /**
   * Answer a question the agent asked, or drop it.
   *
   * The node records the answer and opens a new turn with it, which is why this route exists separately from the
   * turn that asked: nothing was waiting on the node for this answer, so nothing needs resuming. A click and a
   * spoken utterance post to this same route, so the two can never disagree about what an answer means.
   */
  answerQuestion(
    conversationId: string,
    questionId: string,
    answer: { text?: string; optionIds?: string[]; confirmed?: boolean; viaVoice?: boolean },
  ): Promise<{ ok: boolean; note: string; timeline: Timeline }> {
    return this.#call(
      "POST",
      `/conversations/${conversationId}/questions/${encodeURIComponent(questionId)}/answer`,
      answer,
    );
  }

  cancelQuestion(conversationId: string, questionId: string): Promise<{ ok: boolean; timeline: Timeline }> {
    return this.#call("POST", `/conversations/${conversationId}/questions/${encodeURIComponent(questionId)}/cancel`, {});
  }

  /** Resolve the live surface for an instance: current state, sections and ownership. */
  liveWidget(
    conversationId: string,
    instanceId: string,
  ): Promise<LiveWidgetResponse | IsolatedFrameLiveResponse> {
    return this.#call("GET", `/conversations/${conversationId}/widgets/${instanceId}/live`);
  }

  /** The immutable presentation a message captured. Never carries an action binding. */
  /**
   * Ask the node to start a worker session in a directory it found.
   *
   * The text is the user's own words. A node that cannot tell which directory is meant answers with a
   * question instead of starting one, and a node that was given a path it cannot use says which of the
   * two reasons applies — which is why the outcome is reported rather than assumed to be success.
   */
  startSession(conversationId: string, text: string): Promise<StartSessionResponse> {
    return this.#call("POST", `/conversations/${conversationId}/start-session`, { text });
  }

  snapshotPresentation(conversationId: string, snapshotId: string): Promise<SnapshotPresentationResponse> {
    return this.#call("GET", `/conversations/${conversationId}/snapshots/${snapshotId}/presentation`);
  }

  /**
   * Invoke a bound view action.
   *
   * `expectedRevision` and `expectedBindingDigest` are what the client saw. A mismatch is refused
   * rather than applied, which is why the caller has to re-read on a conflict instead of retrying
   * with a fresh revision.
   */
  invokeAction(
    conversationId: string,
    instanceId: string,
    invocation: {
      actionBindingId: string;
      expectedRevision: number;
      expectedBindingDigest: string;
      input: Record<string, unknown>;
      invocationId: string;
    },
  ): Promise<ActionInvocationResult> {
    return this.#call("POST", `/conversations/${conversationId}/widgets/${instanceId}/actions`, {
      instanceId,
      ...invocation,
    });
  }

  /**
   * Ask a task to stop.
   *
   * Resolves with what the node actually did, not with what was asked for. Cancellation is two steps so the
   * executor can confirm what happened, so `state: "cancel_requested"` with `confirmed: false` means the request
   * is recorded and the work may still be finishing — it does not mean the task stopped.
   */
  cancelTask(taskId: string): Promise<{ taskId: string; state: string; confirmed: boolean }> {
    return this.#call("POST", `/tasks/${encodeURIComponent(taskId)}/cancel`, {});
  }

  /**
   * Open an artifact.
   *
   * Resolves with facts about it and never with where its bytes live: the node's own data directory is not
   * something a client needs in order to show a file. `expired` is reported separately from a missing artifact,
   * because "the node had it and a retention window passed" and "there is no such file" are different answers
   * to the user.
   */
  artifact(artifactId: string): Promise<{ artifact: ArtifactView }> {
    return this.#call("GET", `/artifacts/${encodeURIComponent(artifactId)}`);
  }

  /**
   * Take the wheel of a controlled surface.
   *
   * Resolves with the session as the node now holds it, including the new lease epoch — which is the part that
   * makes the takeover real: the agent's already-planned action is refused because its lease is stale, not
   * because something was interrupted.
   */
  controlTakeover(sessionId: string): Promise<{ session: ControlSessionView }> {
    return this.#call("POST", `/control-sessions/${encodeURIComponent(sessionId)}/takeover`, {});
  }

  /** End a browser session. Refused rather than reported as done when there is nothing left to stop. */
  controlStop(sessionId: string): Promise<{ session: ControlSessionView }> {
    return this.#call("POST", `/control-sessions/${encodeURIComponent(sessionId)}/stop`, {});
  }

  /**
   * What is installed, with where each package came from and the lane it runs in.
   *
   * The digest is part of the answer on purpose: it is the only thing tying what is running to what was approved,
   * and a list that showed a version without one would be inviting trust it has not earned.
   */
  /**
   * A node-relative path as an absolute URL.
   *
   * The node hands out paths relative to itself, and the client is not always served by the node — in the browser
   * suite it is served by a different origin entirely — so a path put straight into a frame's `src` would resolve
   * against the wrong host. One place does the join, so a caller cannot forget it.
   */
  nodeUrl(path: string): string {
    return `${this.#baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  packages(): Promise<{ packages: InstalledPackageView[] }> {
    return this.#call("GET", "/packages");
  }

  /**
   * Install a package a directory listed.
   *
   * Refusals are thrown, like every other call here: a caller that has to tell "refused" from "installed" by reading
   * a field inside a resolved promise is a caller that will one day not. An approval is not a refusal and arrives as
   * an ordinary answer with `code: "APPROVAL_REQUIRED"`, because nothing failed — the next step is a decision.
   */
  installPackage(
    packageId: string,
    version: string,
  ): Promise<{
    installed?: { packageId: string; version: string };
    code?: string;
    message?: string;
    approvalId?: string;
    generationId?: string;
    /** What the node actually checked. `digest-only` means the plan was bound to a published digest. */
    verified?: string;
  }> {
    return this.#call("POST", "/packages/install", { packageId, version });
  }

  claimLiveOwner(
    conversationId: string,
    instanceId: string,
    input: { ownerToken: string; surface: "inline" | "pin"; leaseMs?: number },
  ): Promise<{ claimed: boolean; surface: "inline" | "pin"; expiresAt: string; recovered?: boolean }> {
    return this.#call("POST", `/conversations/${conversationId}/widgets/${instanceId}/live-owner`, input);
  }

  releaseLiveOwner(conversationId: string, instanceId: string, ownerToken: string): Promise<{ released: boolean }> {
    return this.#call("DELETE", `/conversations/${conversationId}/widgets/${instanceId}/live-owner`, { ownerToken });
  }

  /**
   * Fetch an imported image's bytes and return an object URL for it.
   *
   * An `<img src="/images/x">` cannot carry the bearer token, so the bytes are fetched through the
   * authenticated client and handed to the DOM as a blob URL. The caller owns the URL and must
   * revoke it; the runtime is the only thing that ever sees the token.
   */
  async imageObjectUrl(imageId: string): Promise<string> {
    const response = await this.#fetch(`${this.#baseUrl}/images/${imageId}`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (!response.ok) {
      throw new GatewayError(response.status, "IMAGE_UNAVAILABLE", "that image could not be read");
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  /**
   * Send one file to the node and get back the id a message may refer to it by.
   *
   * The body is base64 inside JSON rather than a multipart upload, because this node's transport already
   * speaks one content type and a second parser is a second thing to get right. The cost is a third more
   * bytes on the wire, which the route's body ceiling is sized for.
   *
   * A refusal throws `GatewayError` carrying the node's own code, so the composer can show the node's
   * sentence rather than inventing its own version of the same rule.
   */
  async uploadAttachment(input: {
    conversationId: string;
    filename: string;
    mime: string;
    contentBase64: string;
  }): Promise<{ attachmentId: string }> {
    const response = await this.#call<{ attachmentRef?: { attachmentId?: unknown } }>(
      "POST",
      "/attachments",
      input,
    );
    const attachmentId = response.attachmentRef?.attachmentId;
    if (typeof attachmentId !== "string") {
      throw new GatewayError(502, "MALFORMED_RESPONSE", "the node accepted the file but returned no attachment id");
    }
    return { attachmentId };
  }

  /**
   * Fetch an attachment's bytes and return an object URL for it.
   *
   * The same reason `imageObjectUrl` exists: an `<img src="/attachments/x/content">` cannot carry the
   * bearer token, so the bytes come through the authenticated client and the DOM gets a blob URL. The
   * caller owns the URL and must revoke it.
   */
  async attachmentObjectUrl(attachmentId: string): Promise<string> {
    const response = await this.#fetch(`${this.#baseUrl}/attachments/${encodeURIComponent(attachmentId)}/content`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (!response.ok) {
      throw new GatewayError(response.status, "ATTACHMENT_UNAVAILABLE", "that attachment could not be read");
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  /**
   * Store a secret the person typed.
   *
   * The answer is a status, not the value: the node never hands a secret back, so there is nothing here to
   * cache, redisplay or log. The value travels once, in the request body, and that is the only place it exists
   * on this side of the wire.
   */
  async putCredential(input: {
    fields: { name: string; value: string; kind?: string; description?: string; consumer?: string }[];
  }): Promise<{ names: string[] }> {
    const response = await this.#fetch(`${this.#baseUrl}/credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: input.fields }),
    });
    if (!response.ok) {
      throw new GatewayError(response.status, "CREDENTIAL_REFUSED", "that credential was not stored");
    }
    const body = (await response.json()) as { names?: unknown };
    return {
      names: Array.isArray(body.names) ? body.names.filter((name): name is string => typeof name === "string") : [],
    };
  }

  /**
   * Ask the node what a command means.
   *
   * A click goes through the node for the same reason a spoken command does: the registry, the audit record and
   * the matching rules live there, so clicking Settings and saying "open Settings" produce the same event with the
   * same kind and only the source differing. It also means a click cannot run something the node would refuse.
   */
  async sendAppIntent(input: {
    kind?: AppIntentKind;
    tab?: SettingsTab;
    text?: string;
    source: "chat" | "click" | "voice";
    conversationId?: string;
  }): Promise<AppIntentResolution> {
    const body = {
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.tab === undefined ? {} : { tab: input.tab }),
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      source: input.source,
    };
    const response = await this.#fetch(`${this.#baseUrl}/app-intents`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new GatewayError(response.status, "APP_INTENT_REFUSED", "the node refused that command");
    }
    const answer = (await response.json()) as { decision?: unknown };
    // `none` is a real answer - the sentence was not a command - so it is returned rather than treated as a
    // missing field. A caller that gets it must fall back to the ordinary path.
    return (answer.decision ?? { kind: "none" }) as AppIntentResolution;
  }

  /**
   * Answer a confirmation the node asked for.
   *
   * The token travels back to the node, which spends it and decides; this client never assembles an executable
   * decision of its own. A denial is a complete answer and comes back as a refusal, so the caller has something to
   * say rather than a silence to explain.
   */
  async confirmAppIntent(input: {
    confirmationToken: string;
    decision: ConfirmationDecision;
    conversationId?: string;
  }): Promise<AppIntentDecision> {
    const response = await this.#fetch(`${this.#baseUrl}/app-intents/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify({
        confirmationToken: input.confirmationToken,
        decision: input.decision,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      }),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { code?: unknown };
      throw new GatewayError(
        response.status,
        typeof detail.code === "string" ? detail.code : "CONFIRMATION_REFUSED",
        "that confirmation was not accepted",
      );
    }
    const body = (await response.json()) as { decision?: unknown };
    return (body.decision ?? { kind: "refused", say: "Không có gì được thực hiện." }) as AppIntentDecision;
  }

  /**
   * Starts one request in a worker of its own, so it happens while the conversation carries on.
   *
   * The node answers 409 when it has no model to run a worker with, and that is a refusal to report rather than an
   * error to hide: the alternative is a caller showing work that will never happen.
   */
  async startBackground(input: { conversationId: string; text: string }): Promise<{ sessionId: string }> {
    const response = await this.#fetch(`${this.#baseUrl}/background-sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify({ conversationId: input.conversationId, text: input.text }),
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { message?: unknown };
      throw new GatewayError(
        response.status,
        "BACKGROUND_REFUSED",
        typeof detail.message === "string" ? detail.message : "việc nền không bắt đầu được",
      );
    }
    const body = (await response.json()) as { sessionId?: unknown };
    return { sessionId: typeof body.sessionId === "string" ? body.sessionId : "" };
  }

  /**
   * The work running behind the conversation, newest first.
   *
   * Polled rather than streamed, which is the honest description of what this is: a count that a person glances at,
   * not a value anything depends on. A stream for it would be a connection held open to watch a number change.
   */
  async backgroundSessions(): Promise<{
    running: number;
    sessions: { sessionId: string; title: string; status: string }[];
  }> {
    const body = (await this.#call("GET", "/background-sessions")) as {
      running?: unknown;
      sessions?: { sessionId?: unknown; title?: unknown; status?: unknown }[];
    };
    return {
      running: typeof body.running === "number" ? body.running : 0,
      sessions: (Array.isArray(body.sessions) ? body.sessions : []).flatMap((entry) =>
        typeof entry?.sessionId === "string" && typeof entry.title === "string"
          ? [{ sessionId: entry.sessionId, title: entry.title, status: typeof entry.status === "string" ? entry.status : "running" }]
          : [],
      ),
    };
  }
}
