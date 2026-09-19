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

export const hostToWidgetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("init"),
    protocol: z.literal(BRIDGE_PROTOCOL),
    version: z.literal(BRIDGE_VERSION),
    instanceId: z.string().min(1).max(128),
    nonce: z.string().min(16).max(200),
    props: z.record(z.string(), z.unknown()),
    state: z.record(z.string(), z.unknown()).optional(),
    /** Capabilities the host is willing to broker, and no others. */
    brokeredCapabilities: z.array(z.string().min(1).max(160)).max(64),
    /** Origins this frame may reach. Enforced by CSP, declared here for the SDK. */
    allowedOrigins: z.array(z.string().min(1).max(300)).max(64),
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
    revision: z.int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("action-result"),
    nonce: z.string().min(16).max(200),
    actionBindingId: z.string().min(1).max(128),
    status: z.enum(["accepted", "refused", "failed", "uncertain"]),
    message: z.string().min(1).max(1000),
  }),
  z.strictObject({
    kind: z.literal("suspend"),
    nonce: z.string().min(16).max(200),
    reason: z.string().min(1).max(300),
  }),
  z.strictObject({ kind: z.literal("dispose"), nonce: z.string().min(16).max(200) }),
]);
export type HostToWidgetMessage = z.infer<typeof hostToWidgetSchema>;

export const widgetToHostSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready"), nonce: z.string().min(16).max(200) }),
  z.strictObject({
    kind: z.literal("state.update"),
    nonce: z.string().min(16).max(200),
    /** Optimistic-concurrency guard: the host refuses a stale write. */
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

export interface WidgetAuthorApi {
  props: {
    read(): Record<string, unknown>;
    /** Called whenever the host sends new props, so a widget can re-render without polling. */
    subscribe(handler: (props: Record<string, unknown>) => void): void;
  };
  state: { get(): Record<string, unknown>; update(expectedRevision: number, patch: Record<string, unknown>): Promise<void> };
  events: { emit(name: string, payload: Record<string, unknown>): void };
  actions: { invoke(actionBindingId: string, input: Record<string, unknown>, invocationId: string): Promise<void> };
  capabilities: { request(capabilityRef: string, justification: string): Promise<void> };
  host: {
    focus(): void;
    resize(request: { height: number }): void;
    requestPin(): void;
    openExternal(approvedUrl: string): void;
  };
  semantic: { publish(summary: string, selectedIds: string[]): void };
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
] as const;

/**
 * @implementation-status implemented
 *
 * The codec, nonce validation and API surface above, plus the runtime a mini-app imports
 * (`runtime.ts`) and the host end of one frame (`@clarkcant/widget-host`, `session.ts`). The handshake,
 * the refusals and the lifecycle are tested on both sides.
 *
 * Two things this does *not* claim, because they are not true yet: no mini-app ships against it, and the
 * conversation client does not yet mount one in a frame. Phase 12 is where an author gets a way to run
 * one, and that is when this status stops being a description of the packages and becomes a description
 * of something a user can reach.
 */
export const WIDGET_RUNTIME_STATUS = "runtime-and-host-session-implemented";
