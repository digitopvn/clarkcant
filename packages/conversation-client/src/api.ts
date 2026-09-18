/**
 * Gateway client.
 *
 * The only place the UI talks to the runtime. Kept tiny and explicit so the authorization
 * story is visible: every call carries the bearer token, and nothing ever sends a
 * principal, because the gateway derives the caller from the channel rather than the body.
 */

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
export interface LiveWidgetResponse {
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

  sendMessage(conversationId: string, text: string): Promise<SendMessageResult> {
    return this.#call("POST", `/conversations/${conversationId}/messages`, { text });
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
  ): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/conversations/${conversationId}/messages/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ text }),
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

  /** Resolve the live surface for an instance: current state, sections and ownership. */
  liveWidget(conversationId: string, instanceId: string): Promise<LiveWidgetResponse> {
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
}
