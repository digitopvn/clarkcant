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

  sendMessage(conversationId: string, text: string): Promise<{ resolution: string; taskId: string | null; timeline: Timeline }> {
    return this.#call("POST", `/conversations/${conversationId}/messages`, { text });
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
