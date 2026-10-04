import { z } from "zod";
import { appearanceSnapshotSchema, type AppearanceSnapshot } from "@clarkcant/contracts";

/**
 * Widget author contracts and the host bridge codec.
 *
 * This is what a custom mini-app is written against. Two properties matter more
 * than the convenience of the API:
 *
 * 1. There is no `readAllSecrets`, no `shell`, no `queryCoreDb`, no `approve` and
 *    no `installAnything`. A capability that does not exist cannot be requested by
 *    accident.
 * 2. Every inbound bridge message is validated and matched to a nonce that the host
 *    issued for this exact frame. Checking `origin === null` is not enough for an
 *    opaque-origin iframe, because every opaque origin has a null origin.
 */

export const BRIDGE_PROTOCOL = "agent.widgetbridge";
export const BRIDGE_VERSION = 2;
export const APPEARANCE_EXTENSION = "appearance@1";

export type DeepReadonly<T> = T extends object ? {readonly [K in keyof T]: DeepReadonly<T[K]>} : T;
export type ReadonlyAppearanceSnapshot = DeepReadonly<AppearanceSnapshot>;

/* ------------------------------------------------------------------ *
 * The artifacts extension
 * ------------------------------------------------------------------ */

/**
 * Files a widget holds by reference: `artifacts@1`.
 *
 * An extension rather than a change to the bridge version, advertised in `init.extensions`, so a runtime older than it
 * still handshakes with a host that offers it and a host without it is refused locally instead of answered never.
 *
 * The bounds repeat the host's (`ARTIFACT_LIMITS` in `@clarkcant/contracts`) rather than importing them, for the same
 * reason as `semanticValuesSchema`: a widget bundle does not carry the host's contracts. The host re-checks every one.
 *
 * A ref is a pointer, not a permission: it names an artifact and says what it is, never where its bytes are, and the
 * host re-checks this frame's grant on every use.
 */
export const ARTIFACTS_EXTENSION = "artifacts@1";
export const JOBS_EXTENSION = "jobs@1";
/**
 * Listing a widget's own jobs, added after `jobs@1` shipped and so advertised as an extension of its own.
 *
 * A host that offers only `jobs@1` refuses `{ op: "list" }` as a request outside its schema and never answers it, so a
 * widget asks only when this is in `init.extensions` too: `jobs.canList()`.
 */
export const JOBS_LIST_EXTENSION = "jobs.list@1";
/**
 * Clark asking the frame to perform an action its definition offers (`offeredActions`).
 *
 * The host sends `action.perform` with input it has already checked against the declared schema, and the frame answers
 * with `action.performed`; that answer is what Clark is told. A frame offers a handler with `actions.offer(name, …)`.
 * Advertised in `init.extensions`, so a runtime older than it never receives a perform it cannot answer.
 */
export const ACTIONS_PERFORM_EXTENSION = "actions.perform@1";
/** How long the answer to one perform may be. */
export const PERFORM_OUTPUT_MAX_CHARS = 4_000;

/**
 * Short-lived provider tokens for a frame whose package declared them: `tokens@1`.
 *
 * The one exception to "a widget never holds a provider credential", and offered only to a frame whose package's UI
 * facet declares `browserTokens`. The token is for the frame's own use. The host never places it in props, state, logs
 * or model context; a message carrying the issued value verbatim (into state, a semantic publish, an action's input, a
 * file write or a link to open) is refused, as a guard against accidental leakage. A widget that transforms the value
 * before sending it is not caught by that guard. The bounds repeat the host's (`BROWSER_TOKEN_LIMITS` in
 * `@clarkcant/contracts`), which re-checks every one.
 */
export const TOKENS_EXTENSION = "tokens@1";

export const TOKEN_BRIDGE_LIMITS = Object.freeze({
  /** Token requests one frame may have waiting at once. */
  maxInFlight: 2,
  scopes: 16,
  minTtlSeconds: 30,
  maxTtlSeconds: 3_600,
  /** The longest token value the bridge carries. */
  valueChars: 8_192,
});

export const tokenRequestSchema = z.strictObject({
  provider: z.string().max(64).regex(/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/),
  scopes: z
    .array(z.string().max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/))
    .min(1)
    .max(TOKEN_BRIDGE_LIMITS.scopes),
  ttlSeconds: z.int().min(TOKEN_BRIDGE_LIMITS.minTtlSeconds).max(TOKEN_BRIDGE_LIMITS.maxTtlSeconds).optional(),
});
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

/** A token the host gave this frame. `value` is the credential; `expiresAt` is when it stops working. */
export const browserTokenWireSchema = z.strictObject({
  provider: z.string().min(1).max(64),
  value: z.string().min(1).max(TOKEN_BRIDGE_LIMITS.valueChars),
  scopes: z.array(z.string().min(1).max(128)).max(TOKEN_BRIDGE_LIMITS.scopes),
  expiresAt: z.string().min(1).max(40),
});
export type BrowserToken = z.infer<typeof browserTokenWireSchema>;

export const jobRefWireSchema = z.string().regex(/^job_[A-Za-z0-9_-]{1,120}$/);

export const ARTIFACT_BRIDGE_LIMITS = Object.freeze({
  /** Bytes in one write, and in one read. */
  chunkBytes: 262_144,
  /** Base64 characters one chunk may take. */
  chunkBase64Chars: Math.ceil(262_144 / 3) * 4,
  /** Entries in a picker's accept list. */
  maxAccept: 16,
  /**
   * Requests one frame may have waiting for an answer. The runtime queues any beyond this and sends each as an earlier
   * one is answered, so a `Promise.all` over many reads is slower, not refused.
   */
  maxInFlight: 4,
  nameMaxChars: 200,
});

const artifactIdWire = z.string().regex(/^art_[A-Za-z0-9_-]{1,120}$/);
const acceptWire = z.string().regex(/^[a-z][a-z0-9.+-]*\/(\*|[a-z0-9][a-z0-9.+-]*)$/).max(120);
const nameWire = z.string().min(1).max(ARTIFACT_BRIDGE_LIMITS.nameMaxChars);

/** An artifact as a widget sees it. No path, no staging name, no place: what it is, not where it is. */
export const artifactRefWireSchema = z.strictObject({
  v: z.literal(1),
  artifactId: artifactIdWire,
  kind: z.enum(["attachment", "working", "finalized", "external"]),
  mimeType: z.string().min(3).max(120),
  sizeBytes: z.int().nonnegative(),
  name: nameWire,
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
});
export type ArtifactRef = z.infer<typeof artifactRefWireSchema>;

export const jobSnapshotWireSchema = z.strictObject({
  jobId: jobRefWireSchema,
  status: z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled"]),
  progress: z.strictObject({
    current: z.number().finite().nonnegative(),
    total: z.number().finite().positive().optional(),
    message: z.string().max(500).optional(),
  }).optional(),
  resultRefs: z.array(artifactRefWireSchema).max(32),
  output: z.string().max(16_000).optional(),
  error: z.string().min(1).max(800).optional(),
  createdAt: z.string().min(1).max(40),
  startedAt: z.string().min(1).max(40).optional(),
  endedAt: z.string().min(1).max(40).optional(),
});
export type JobRef = z.infer<typeof jobRefWireSchema>;
export type JobSnapshot = z.infer<typeof jobSnapshotWireSchema>;
/** The most jobs one `list` answer carries: the frame's newest. */
export const JOB_LIST_LIMIT = 20;
export const jobRequestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("get"), jobId: jobRefWireSchema }),
  z.strictObject({ op: z.literal("cancel"), jobId: jobRefWireSchema }),
  /** The jobs this instance's own bindings started, by any surface, newest first. */
  z.strictObject({ op: z.literal("list") }),
]);
export type JobRequest = z.infer<typeof jobRequestSchema>;

export const artifactRequestSchema = z.discriminatedUnion("op", [
  /** Ask the person to choose a file. The host shows its own chrome; the widget learns only what the person picked. */
  z.strictObject({ op: z.literal("pick"), accept: z.array(acceptWire).max(ARTIFACT_BRIDGE_LIMITS.maxAccept) }),
  z.strictObject({
    op: z.literal("read"),
    artifactId: artifactIdWire,
    offset: z.int().nonnegative(),
    length: z.int().min(1).max(ARTIFACT_BRIDGE_LIMITS.chunkBytes),
  }),
  z.strictObject({ op: z.literal("create"), mimeType: z.string().min(3).max(120), name: nameWire.optional() }),
  z.strictObject({
    op: z.literal("write"),
    artifactId: artifactIdWire,
    offset: z.int().nonnegative(),
    chunkBase64: z.string().max(ARTIFACT_BRIDGE_LIMITS.chunkBase64Chars),
  }),
  z.strictObject({ op: z.literal("finalize"), artifactId: artifactIdWire }),
  /** Save As. The host's own dialog; the widget suggests a name and learns only whether the person saved. */
  z.strictObject({ op: z.literal("export"), artifactId: artifactIdWire, suggestedName: nameWire }),
  /**
   * Offer a finalized file to the conversation. `name` is optional and only a proposal: the host makes it safe — the
   * last part of a path, safe characters, bounded length, the bytes' type's extension — and falls back to its own
   * default name. The first attach of an artifact decides its attachment's name. Absent unless the widget proposes one, so a request without it means what it always meant; the
   * runtime a host serves predates the field only together with that host, and then drops the proposal unsent.
   */
  z.strictObject({ op: z.literal("attach"), artifactId: artifactIdWire, name: nameWire.optional() }),
  /**
   * Give back a file this widget made, freeing its share of the node's space. Only the widget that created it may; a
   * file the person chose is theirs, and one already sent in a message keeps its bytes for that message.
   */
  z.strictObject({ op: z.literal("discard"), artifactId: artifactIdWire }),
]);
export type ArtifactRequest = z.infer<typeof artifactRequestSchema>;

export const hostToWidgetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("init"),
    protocol: z.literal(BRIDGE_PROTOCOL),
    version: z.union([z.literal(1), z.literal(BRIDGE_VERSION)]),
    /** Bridge v2 carries only the normalized public contract, never a theme document. */
    appearance: appearanceSnapshotSchema.optional(),
    instanceId: z.string().min(1).max(128),
    nonce: z.string().min(16).max(200),
    props: z.record(z.string(), z.unknown()),
    state: z.record(z.string(), z.unknown()).optional(),
    /**
     * The instance revision this frame was initialized at, so its first action is not refused as stale.
     *
     * Optional in the schema because a runtime copy older than this field must still handshake; the host always sends
     * it, and a runtime that receives it speaks the revision it was shown instead of inventing one.
     */
    revision: z.number().int().nonnegative().optional(),
    /**
     * The revision of the widget's *state*, which is a different counter from the instance revision above.
     *
     * An instance moves when an action changes what the user sees; state moves when the widget writes it. Using one
     * number for both refused the first state write of any frame whose instance had moved, and sent the next action
     * with a revision that was really the state's. Optional for the same reason as `revision`.
     */
    stateRevision: z.number().int().nonnegative().optional(),
    /** Capabilities the host is willing to broker, and no others. */
    brokeredCapabilities: z.array(z.string().min(1).max(160)).max(64),
    /** Origins this frame may reach. Enforced by CSP, declared here for the SDK. */
    allowedOrigins: z.array(z.string().min(1).max(300)).max(64),
    /**
     * Bridge extensions this host offers this frame, such as `artifacts@1`. Optional so a host older than extensions
     * still handshakes; a runtime refuses an extension's calls locally when its name is absent.
     */
    extensions: z.array(z.string().min(1).max(60)).max(16).optional(),
  }),
  z.strictObject({
    kind: z.literal("appearance.changed"),
    nonce: z.string().min(16).max(200),
    revision: appearanceSnapshotSchema.shape.revision,
    appearance: appearanceSnapshotSchema,
  }).refine((message) => message.revision === message.appearance.revision, {message: "appearance revision must match its snapshot"}),
  z.strictObject({
    kind: z.literal("props"),
    nonce: z.string().min(16).max(200),
    props: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    kind: z.literal("state"),
    nonce: z.string().min(16).max(200),
    state: z.record(z.string(), z.unknown()),
    /** The state revision the host now holds, not the instance revision. */
    revision: z.int().nonnegative(),
    /**
     * Why the host answered a write with this state rather than the widget's own, when it did.
     *
     * Present only on a refusal: the state here is what is committed, and the widget's unsaved change is still its
     * own to keep or retry — the host does not throw it away by answering.
     */
    refused: z
      .strictObject({ code: z.string().min(1).max(60), message: z.string().min(1).max(600) })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("action-result"),
    nonce: z.string().min(16).max(200),
    actionBindingId: z.string().min(1).max(128),
    /**
     * The invocation this answers. Two clicks on one binding are two invocations, and each waits for its own answer;
     * optional so a runtime that keys on the binding alone still parses it.
     */
    invocationId: z.string().min(1).max(128).optional(),
    status: z.enum(["accepted", "refused", "failed", "uncertain"]),
    message: z.string().min(1).max(1000),
    /**
     * What a service capability answered, when the binding called one and it ran.
     *
     * Optional and sent only when there is an answer, so a runtime older than this field — which only ever held
     * bindings that have none — still parses every result it is sent.
     */
    output: z.string().max(16_000).optional(),
  }),
  /**
   * Which of this frame's service-backed bindings can run right now, and why not when one cannot.
   *
   * Sent after the frame is ready and again whenever the answer changes, so a widget can disable a button and say
   * why — the registry's reason, not a guess — while the rest of it keeps working. Sent only for bindings that call a
   * service capability, so a widget without one never receives it.
   */
  z.strictObject({
    kind: z.literal("actions"),
    nonce: z.string().min(16).max(200),
    actions: z
      .array(
        z.strictObject({
          actionBindingId: z.string().min(1).max(128),
          available: z.boolean(),
          reason: z.string().min(1).max(600).optional(),
        }),
      )
      .max(64),
  }),
  z.strictObject({
    kind: z.literal("suspend"),
    nonce: z.string().min(16).max(200),
    reason: z.string().min(1).max(300),
  }),
  z.strictObject({ kind: z.literal("dispose"), nonce: z.string().min(16).max(200) }),
  /**
   * The answer to one `artifact.request`, matched by `requestId`.
   *
   * `cancelled` is the person saying no in host chrome — a picker closed, a Save As dismissed — and is not an error.
   * `refused` carries the host's code and sentence, such as `ARTIFACT_GRANT_EXPIRED`.
   */
  z.strictObject({
    kind: z.literal("artifact-result"),
    nonce: z.string().min(16).max(200),
    requestId: z.string().min(1).max(128),
    status: z.enum(["ok", "refused", "cancelled"]),
    code: z.string().min(1).max(60).optional(),
    message: z.string().min(1).max(600).optional(),
    ref: artifactRefWireSchema.optional(),
    chunkBase64: z.string().max(ARTIFACT_BRIDGE_LIMITS.chunkBase64Chars).optional(),
    eof: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("job-result"),
    nonce: z.string().min(16).max(200),
    requestId: z.string().min(1).max(128),
    status: z.enum(["ok", "refused"]),
    code: z.string().min(1).max(60).optional(),
    message: z.string().min(1).max(600).optional(),
    job: jobSnapshotWireSchema.optional(),
    /** The answer to `list`. */
    jobs: z.array(jobSnapshotWireSchema).max(JOB_LIST_LIMIT).optional(),
  }),
  z.strictObject({
    kind: z.literal("job.changed"),
    nonce: z.string().min(16).max(200),
    job: jobSnapshotWireSchema,
  }),
  /**
   * Perform one action this widget offers (`actions.perform@1`), with input the host checked against the declared
   * schema. Answered by an `action.performed` with the same `performId`.
   */
  z.strictObject({
    kind: z.literal("action.perform"),
    nonce: z.string().min(16).max(200),
    performId: z.string().min(1).max(128),
    action: z.string().min(1).max(64),
    input: z.record(z.string(), z.unknown()),
  }),
  /** The answer to one `token.request`: a token, or the host's code and sentence, such as `TOKEN_PROVIDER_UNSCOPED`. */
  z.strictObject({
    kind: z.literal("token-result"),
    nonce: z.string().min(16).max(200),
    requestId: z.string().min(1).max(128),
    status: z.enum(["ok", "refused"]),
    code: z.string().min(1).max(60).optional(),
    message: z.string().min(1).max(600).optional(),
    token: browserTokenWireSchema.optional(),
  }),
]);
export type HostToWidgetMessage = z.infer<typeof hostToWidgetSchema>;

/**
 * The named values a widget may publish about what it shows. The same bounds as the host's proposal schema in
 * `@clarkcant/contracts`, repeated rather than imported so a widget bundle does not carry the host's contracts.
 */
export const semanticValuesSchema = z.record(
  z.string().max(80),
  z.union([z.string().max(600), z.number(), z.boolean(), z.array(z.string().max(600)).max(64)]),
);
export type SemanticValues = z.infer<typeof semanticValuesSchema>;

export const widgetToHostSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready"), nonce: z.string().min(16).max(200) }),
  z.strictObject({
    kind: z.literal("state.update"),
    nonce: z.string().min(16).max(200),
    /** Optimistic-concurrency guard on the *state* revision: the host refuses a stale write. */
    expectedRevision: z.int().nonnegative(),
    patch: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    kind: z.literal("event"),
    nonce: z.string().min(16).max(200),
    name: z.string().min(1).max(120),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    kind: z.literal("action.invoke"),
    nonce: z.string().min(16).max(200),
    actionBindingId: z.string().min(1).max(128),
    expectedRevision: z.int().nonnegative(),
    input: z.record(z.string(), z.unknown()),
    /** Client-generated so a double click produces one accepted effect. */
    invocationId: z.string().min(1).max(128),
  }),
  z.strictObject({
    kind: z.literal("capability.request"),
    nonce: z.string().min(16).max(200),
    capabilityRef: z.string().min(1).max(160),
    justification: z.string().min(1).max(600),
  }),
  /** Opens nothing by itself; the host decides and shows its own chrome. */
  z.strictObject({
    kind: z.literal("host.request"),
    nonce: z.string().min(16).max(200),
    request: z.enum(["focus", "resize", "request-pin", "open-external"]),
    argument: z.string().max(600).optional(),
  }),
  z.strictObject({
    kind: z.literal("semantic.publish"),
    nonce: z.string().min(16).max(200),
    summary: z.string().min(1).max(600),
    selectedIds: z.array(z.string().min(1).max(200)).max(64),
    /**
     * A few named values the widget shows now: a chosen filter, a query, a page. Bounded here and cleaned again by the
     * host before a model reads them; never actions, which are the host's bindings.
     */
    values: semanticValuesSchema.optional(),
  }),
  /** One call of the `artifacts@1` extension. Answered by an `artifact-result` with the same `requestId`. */
  z.strictObject({
    kind: z.literal("artifact.request"),
    nonce: z.string().min(16).max(200),
    requestId: z.string().min(1).max(128),
    request: artifactRequestSchema,
  }),
  z.strictObject({
    kind: z.literal("job.request"),
    nonce: z.string().min(16).max(200),
    requestId: z.string().min(1).max(128),
    request: jobRequestSchema,
  }),
  /** One call of the `tokens@1` extension. Answered by a `token-result` with the same `requestId`. */
  z.strictObject({
    kind: z.literal("token.request"),
    nonce: z.string().min(16).max(200),
    requestId: z.string().min(1).max(128),
    request: tokenRequestSchema,
  }),
  /**
   * The frame's answer to one `action.perform`: `done` with what it did, in a sentence or a short value; `refused` with
   * its code and why, a deliberate refusal before anything changed; or `failed`, the handler broke while it ran, so what
   * it changed is unknown. Only a perform the host is waiting for is accepted.
   */
  z.strictObject({
    kind: z.literal("action.performed"),
    nonce: z.string().min(16).max(200),
    performId: z.string().min(1).max(128),
    status: z.enum(["done", "refused", "failed"]),
    output: z.string().max(PERFORM_OUTPUT_MAX_CHARS).optional(),
    code: z.string().min(1).max(60).optional(),
    message: z.string().min(1).max(600).optional(),
  }),
]);
export type WidgetToHostMessage = z.infer<typeof widgetToHostSchema>;

export type BridgeRejection =
  | { ok: true; message: WidgetToHostMessage }
  | { ok: false; code: "JSON_INVALID" | "SCHEMA_INVALID" | "NONCE_MISMATCH" | "SOURCE_MISMATCH"; message: string };

/**
 * Validate an inbound bridge message.
 *
 * The nonce comparison is the load-bearing part. For an opaque-origin iframe every
 * `event.origin` is `"null"`, so origin alone identifies nothing; a per-frame nonce
 * the host generated and never exposed outside that frame is what actually
 * establishes which widget is speaking (acceptance test T45's sibling concern:
 * a frame must not be able to act as another frame).
 */
export function acceptBridgeMessage(input: {
  raw: unknown;
  expectedNonce: string;
  sourceMatchesExpectedWindow: boolean;
}): BridgeRejection {
  if (!input.sourceMatchesExpectedWindow) {
    return {
      ok: false,
      code: "SOURCE_MISMATCH",
      message: "the message did not come from the window the host registered for this instance",
    };
  }
  const parsed = widgetToHostSchema.safeParse(input.raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "SCHEMA_INVALID",
      message: parsed.error.issues[0]?.message ?? "message does not match the bridge schema",
    };
  }
  if (parsed.data.nonce !== input.expectedNonce) {
    return {
      ok: false,
      code: "NONCE_MISMATCH",
      message: "the message nonce does not match the nonce issued for this frame",
    };
  }
  return { ok: true, message: parsed.data };
}

/* ------------------------------------------------------------------ *
 * Author-facing descriptors
 * ------------------------------------------------------------------ */

/** Whether one service-backed binding can run right now, as the host last reported it. */
export interface ActionAvailability {
  actionBindingId: string;
  available: boolean;
  reason?: string | undefined;
}

export interface WidgetAuthorApi {
  appearance: {
    /** Undefined before init, or when an older host does not offer appearance. */
    current(): ReadonlyAppearanceSnapshot | undefined;
    /** Read-only notifications; registering before init observes its initial snapshot. */
    subscribe(handler: (snapshot: ReadonlyAppearanceSnapshot) => void): () => void;
  };
  props: {
    read(): Record<string, unknown>;
    /** Called whenever the host sends new props, so a widget can re-render without polling. */
    subscribe(handler: (props: Record<string, unknown>) => void): void;
  };
  state: {
    get(): Record<string, unknown>;
    /** The state revision to pass as `expectedRevision` on the next write. */
    revision(): number;
    /**
     * Resolves once the host has committed the write, and rejects with the host's reason when it refused — a stale
     * revision, a value outside the declared schema, a state too large, or a widget that is read-only right now.
     */
    update(expectedRevision: number, patch: Record<string, unknown>): Promise<void>;
    /** Called whenever the host sends committed state, including the answer to a refused write. */
    subscribe(handler: (state: Record<string, unknown>, revision: number) => void): void;
  };
  events: { emit(name: string, payload: Record<string, unknown>): void };
  actions: {
    /**
     * Resolves when the host accepted the action — with what the service answered, when the binding called a service
     * capability — and rejects with the host's reason otherwise, including "waiting for your approval".
     */
    invoke(actionBindingId: string, input: Record<string, unknown>, invocationId: string): Promise<string | undefined>;
    /** The service-backed bindings the host has said cannot run right now, with the reason. Empty until it says. */
    availability(): readonly ActionAvailability[];
    /** Called whenever the host reports a change in which service-backed bindings can run. */
    subscribe(handler: (availability: readonly ActionAvailability[]) => void): void;
    /**
     * Handle an action this widget's definition offers (`offeredActions`), when Clark asks for it (`actions.perform@1`).
     *
     * The input has been checked by the host against the declared schema. Return (or resolve with) a short sentence
     * saying what was done — it is what Clark is told. To refuse, `throw api.actions.refuse(code, why)` before changing
     * anything: only that is a refusal, meaning nothing changed. Any other throw — including a rejection from the SDK
     * itself, such as a refused state or artifact write, whatever its message — is reported as failed while performing,
     * so Clark is told the outcome is unknown and does not retry it. May be called before init. Returns a function that
     * stops handling it.
     */
    offer(name: string, handler: (input: Record<string, unknown>) => string | undefined | Promise<string | undefined>): () => void;
    /**
     * The error an offered action's handler throws to refuse, before it has changed anything: `code` is an upper-case
     * identifier such as `NOTHING_SELECTED` (2–60 of A–Z, 0–9 and `_`, starting with a letter), `message` says why.
     * Throws a `TypeError` for a code of any other shape.
     */
    refuse(code: string, message: string): Error;
  };
  capabilities: { request(capabilityRef: string, justification: string): Promise<void> };
  host: {
    focus(): void;
    resize(request: { height: number }): void;
    requestPin(): void;
    openExternal(approvedUrl: string): void;
  };
  semantic: { publish(summary: string, selectedIds: string[], values?: SemanticValues): void };
  /**
   * Files, by reference (`artifacts@1`). Every call rejects locally when the host did not offer the extension, and
   * every refusal from the host rejects with its code first, such as `ARTIFACT_GRANT_REVOKED: …`.
   */
  artifacts: {
    /** Whether the host offered the extension to this frame. */
    available(): boolean;
    /** Ask the person to choose a file. Resolves `undefined` when they close the picker without choosing. */
    pick(options?: { accept?: readonly string[] }): Promise<ArtifactRef | undefined>;
    /** One bounded range: at most 256 KiB. `eof` is true once the range reaches the end. */
    read(ref: ArtifactRef, range: { offset: number; length: number }): Promise<{ bytes: Uint8Array; eof: boolean }>;
    /** A new working artifact this frame may write. It expires unless it is written to or finalized. */
    create(options: { mimeType: string; name?: string }): Promise<ArtifactRef>;
    /** Append one chunk of at most 256 KiB. Writes to one artifact are sent in order, one at a time. */
    write(ref: ArtifactRef, chunk: Uint8Array): Promise<ArtifactRef>;
    /** Fix the bytes. The host checks they are what the artifact was created as. */
    finalize(ref: ArtifactRef): Promise<ArtifactRef>;
    /**
     * Ask the person to save a copy: the host's own Save As on the desktop, the browser's download on the web. Resolves
     * `true` once the file was saved or its download started, `false` when the person declined.
     */
    export(ref: ArtifactRef, options: { suggestedName: string }): Promise<boolean>;
    /**
     * Offer a finalized artifact to the conversation. The person sends it with their next message. `name` proposes the
     * attachment's file name. It is reduced, never refused: an empty one is left out and a long one is cut to 200
     * characters before it is sent, and the host then sanitizes it and forces the extension of the bytes' type. Without
     * it the attachment takes the artifact's name, sanitized the same way. The first attach of an artifact decides the
     * name: attaching it again returns the same attachment, under that name, whatever `name` the later call proposes.
     */
    attachToConversation(ref: ArtifactRef, options?: { name?: string }): Promise<void>;
    /**
     * Give back a file this frame's widget made, freeing its share of the node's space (128 MiB per widget). Only the
     * widget that created it may; a file the person chose is theirs. Bytes already sent in a message stay with it.
     */
    discard(ref: ArtifactRef): Promise<void>;
  };
  /** Durable package work (`jobs@1`). A JobRef is an opaque handle and each use is re-authorized by the host. */
  jobs: {
    available(): boolean;
    get(ref: JobRef): Promise<JobSnapshot>;
    cancel(ref: JobRef): Promise<void>;
    /** Whether the host offered `jobs.list@1` beside `jobs@1`, so `list()` can be asked. */
    canList(): boolean;
    /**
     * The jobs this instance's own bindings started — from a click, a spoken command or Clark — newest first, at most
     * `JOB_LIST_LIMIT`. How a frame finds work it did not start itself, or after a remount without saved state. Rejects
     * locally when `canList()` is false.
     */
    list(): Promise<JobSnapshot[]>;
    /** Resumes from the durable snapshot; polls are serialized and stop on terminal state or unsubscribe. */
    subscribe(ref: JobRef, handler: (job: JobSnapshot) => void): () => void;
  };
  /**
   * Short-lived provider tokens (`tokens@1`), only for a provider and scopes the package declared. Rejects locally when
   * the host did not offer the extension, and with the host's code first otherwise, such as `TOKEN_SCOPE_NOT_DECLARED`.
   * A token is for this frame's own use: sending the value verbatim into state, a semantic publish, an action's input,
   * a file write or a link to open is refused.
   */
  tokens: {
    available(): boolean;
    request(request: TokenRequest): Promise<BrowserToken>;
  };
  lifecycle: {
    onMount(handler: () => void): void;
    onSuspend(handler: (reason: string) => void): void;
    onResume(handler: () => void): void;
    onDispose(handler: () => void): void;
  };
}

/** Methods the SDK deliberately does not expose, asserted by the conformance test. */
export const FORBIDDEN_API_SURFACE = [
  "readAllSecrets",
  "shell",
  "queryCoreDb",
  "disableCSP",
  "approve",
  "installAnything",
  "registerSidebar",
  "grant",
  // No filesystem inside a widget: a file reaches it as an artifact ref the host brokers, never as a path.
  "fs",
  "readFile",
  "writeFile",
] as const;

/**
 * @status-ref widget-sdk.runtime-and-host-session
 *
 * The codec, nonce validation and API surface above, plus the runtime a mini-app imports
 * (`runtime.ts`) and the host end of one frame (`@clarkcant/widget-host`, `session.ts`). The handshake,
 * the refusals and the lifecycle are tested on both sides.
 *
 * What this package does not claim: no mini-app ships against it, and the frame the conversation
 * client mounts is exercised by `apps/web/e2e/widget-frame.spec.ts` rather than by a shipped
 * package. The `V12` registry entry names the rest of that gap.
 */
export const WIDGET_RUNTIME_STATUS = "runtime-and-host-session-implemented";

/*
 * The runtime a mini-app imports.
 *
 * Re-exported from the package root so an author has one import rather than two: the contract and the thing that
 * implements it are the same package from the outside.
 */
export * from "./runtime.ts";
