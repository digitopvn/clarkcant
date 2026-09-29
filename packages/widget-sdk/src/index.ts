import { z } from "zod";

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
export const BRIDGE_VERSION = 1;

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

export const ARTIFACT_BRIDGE_LIMITS = Object.freeze({
  /** Bytes in one write, and in one read. */
  chunkBytes: 262_144,
  /** Base64 characters one chunk may take. */
  chunkBase64Chars: Math.ceil(262_144 / 3) * 4,
  /** Entries in a picker's accept list. */
  maxAccept: 16,
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
  z.strictObject({ op: z.literal("attach"), artifactId: artifactIdWire }),
]);
export type ArtifactRequest = z.infer<typeof artifactRequestSchema>;

export const hostToWidgetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("init"),
    protocol: z.literal(BRIDGE_PROTOCOL),
    version: z.literal(BRIDGE_VERSION),
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
    /** Ask the person to save a copy. The host's own Save As; resolves whether they saved. */
    export(ref: ArtifactRef, options: { suggestedName: string }): Promise<boolean>;
    /** Offer a finalized artifact to the conversation. The person sends it with their next message. */
    attachToConversation(ref: ArtifactRef): Promise<void>;
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
