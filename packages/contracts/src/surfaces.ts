import { z } from "zod";

import { instantSchema } from "./primitives.ts";
import { widgetSnapshotSchema } from "./widgets.ts";

/**
 * Conversation surfaces.
 *
 * The timeline is a list of message blocks. Rich responses are a block type, not
 * a separate screen, which is what lets one conversation hold text, a pinned
 * widget, an install card and an approval card without a navigation model.
 *
 * Two categories are kept apart on purpose:
 *
 * - Ordinary blocks come from a widget or a pack and are rendered inside the
 *   conversation.
 * - Host-owned cards (`system-card`, `approval-card`, `credential-card`,
 *   `connection-card`) carry trust state. A third-party widget may draw
 *   something that looks like an approval, but it cannot mint one, because these
 *   block types are constructed by the host with host chrome.
 */

export const messageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const textBlockSchema = z.strictObject({
  type: z.literal("text"),
  format: z.enum(["plain", "markdown"]),
  content: z.string().max(200_000),
  /** Streaming keeps a stable block identity so the UI never remounts mid-stream. */
  streaming: z.boolean(),
});

export const surfaceBlockSchema = z.strictObject({
  type: z.literal("surface"),
  /** Which widget definition rendered this, for history fidelity. */
  definitionRef: z
    .strictObject({ id: z.string().min(1).max(160), version: z.string().min(1).max(80) })
    .optional(),
  snapshot: widgetSnapshotSchema,
});

export const widgetRefBlockSchema = z.strictObject({
  type: z.literal("widget-ref"),
  instanceId: z.string().min(1).max(128),
  displayMode: z.enum(["inline", "compact"]),
  /**
   * When the instance cannot be mounted, this is what the user sees instead. A
   * missing renderer must never make a message disappear.
   */
  textAlternative: z.string().min(1).max(4000),
});

export const artifactBlockSchema = z.strictObject({
  type: z.literal("artifact"),
  artifactId: z.string().min(1).max(128),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.int().nonnegative(),
  digest: z.string().min(1).max(120),
  label: z.string().min(1).max(300),
  /** Set when the artifact came from another node, so provenance stays visible. */
  originNodeId: z.string().min(1).max(128).optional(),
});

export const evidenceBlockSchema = z.strictObject({
  type: z.literal("evidence"),
  kind: z.enum([
    "exit-status",
    "file-diff",
    "file-version",
    "api-receipt",
    "read-after-write",
    "browser-observation",
    "test-output",
    "screenshot",
    "log-excerpt",
    "absent",
  ]),
  summary: z.string().min(1).max(4000),
  verdict: z.enum(["verified", "not-verified", "contradicted"]),
  ref: z.string().min(1).max(300).optional(),
});

/**
 * Host-owned trust card.
 *
 * `owner` is always the host. This is not decorative metadata: the renderer uses
 * it to apply host chrome and to place the card outside any widget iframe, so a
 * third-party surface cannot impersonate it.
 */
export const systemCardBlockSchema = z.strictObject({
  type: z.literal("system-card"),
  owner: z.literal("host"),
  cardId: z.string().min(1).max(128),
  subject: z.enum([
    "task",
    "install",
    "capability",
    "connection",
    "peer",
    "budget",
    "voice",
    "automation",
    "onboarding",
  ]),
  title: z.string().min(1).max(300),
  /** One live card per subject; updates replace in place instead of appending. */
  status: z.enum([
    "needs-decision",
    "downloading",
    "verifying",
    "needs-sign-in",
    "ready",
    "blocked",
    "working",
    "done",
    "failed",
  ]),
  detail: z.string().min(1).max(4000),
  /** Target node, always shown when an action will run somewhere specific. */
  targetNode: z
    .strictObject({ nodeId: z.string().min(1).max(128), label: z.string().min(1).max(200) })
    .optional(),
  /** Real underlying state, kept as typed fields rather than prose only. */
  fields: z.array(
    z.strictObject({
      label: z.string().min(1).max(200),
      value: z.string().min(1).max(1000),
      /** Set when a value is a guess or a cached read, so it can be styled as such. */
      freshness: z.enum(["live", "cached", "sample", "unknown"]).optional(),
    }),
  ).max(64),
  /** Whether the user can back out, and what that does. */
  cancellable: z.boolean(),
  updatedAt: instantSchema,
});

export const approvalCardBlockSchema = z.strictObject({
  type: z.literal("approval-card"),
  owner: z.literal("host"),
  approvalId: z.string().min(1).max(128),
  /** The operation in the user's words, not the model's. */
  operationDescription: z.string().min(1).max(2000),
  /**
   * Digest of exactly what will run. Shown so that an approved plan cannot be
   * swapped for a different one between display and execution.
   */
  operationDigest: z.string().min(1).max(120),
  effectCategory: z.enum([
    "read",
    "local-write",
    "external-write",
    "destructive",
    "financial",
    "communication",
    "media-capture",
  ]),
  /** Bound target so approval is never abstract. */
  targetNode: z
    .strictObject({ nodeId: z.string().min(1).max(128), label: z.string().min(1).max(200) })
    .optional(),
  account: z.string().min(1).max(300).optional(),
  expiresAt: instantSchema,
  /** The model cannot approve; this records who is allowed to. */
  decider: z.literal("user"),
  decision: z.enum(["pending", "granted", "denied", "expired"]),
  decidedAt: instantSchema.optional(),
});

export const credentialCardBlockSchema = z.strictObject({
  type: z.literal("credential-card"),
  owner: z.literal("host"),
  requestId: z.string().min(1).max(128),
  /** What the credential is for, in plain language. */
  purpose: z.string().min(1).max(1000),
  /** Where the input goes. Never the transcript, never the model. */
  destination: z.enum(["vault-node", "system-browser", "provider-page"]),
  fields: z.array(
    z.strictObject({
      name: z.string().min(1).max(120),
      label: z.string().min(1).max(200),
      /** Masked entry; the value never enters history. */
      masked: z.boolean(),
      /** Host-only fields are rendered by the host, not by any widget. */
      hostOwned: z.literal(true),
    }),
  ).max(16),
  expiresAt: instantSchema,
});

export const connectionCardBlockSchema = z.strictObject({
  type: z.literal("connection-card"),
  owner: z.literal("host"),
  connectionRef: z.string().min(1).max(160),
  provider: z.string().min(1).max(200),
  /** Actual account, once verified. Absent while unverified. */
  account: z.string().min(1).max(300).optional(),
  status: z.enum([
    "unconfigured",
    "proposal",
    "awaiting_user_consent",
    "authorizing",
    "verifying_account_and_scopes",
    "probing_capability",
    "connected",
    "needs_reauth",
    "degraded",
    "revoked",
    "denied",
    "partial",
    "expired",
    "failed",
  ]),
  grantedScopes: z.array(z.string().min(1).max(300)).max(64),
  /** Scopes the user did not grant, so "partial" is visible rather than implied. */
  missingScopes: z.array(z.string().min(1).max(300)).max(64),
  /** Which node holds the credential. Connections do not silently migrate. */
  credentialNodeId: z.string().min(1).max(128),
  lastProbeAt: instantSchema.optional(),
  lastProbeResult: z.enum(["pass", "fail", "not-run"]).optional(),
});

export const messageBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  surfaceBlockSchema,
  widgetRefBlockSchema,
  artifactBlockSchema,
  evidenceBlockSchema,
  systemCardBlockSchema,
  approvalCardBlockSchema,
  credentialCardBlockSchema,
  connectionCardBlockSchema,
]);
export type MessageBlock = z.infer<typeof messageBlockSchema>;

/** Blocks whose trust state is owned by the host, never by a pack or a model. */
export const HOST_OWNED_BLOCK_TYPES = [
  "system-card",
  "approval-card",
  "credential-card",
  "connection-card",
] as const satisfies readonly MessageBlock["type"][];

export function isHostOwnedBlock(block: MessageBlock): boolean {
  return (HOST_OWNED_BLOCK_TYPES as readonly string[]).includes(block.type);
}

/**
 * Reject a block that claims host ownership without actually being host-built.
 *
 * The renderer calls this before trusting any card. A widget that fabricates a
 * grant-shaped payload fails here rather than drawing a convincing approval
 * (acceptance test T41).
 */
export function assertBlockProvenance(
  block: MessageBlock,
  provenance: { builtByHost: boolean },
): { ok: true } | { ok: false; message: string } {
  if (isHostOwnedBlock(block) && !provenance.builtByHost) {
    return {
      ok: false,
      message: `${block.type} blocks may only be created by the host, not by a pack, widget, or model output`,
    };
  }
  return { ok: true };
}

export const messageRecordSchema = z.strictObject({
  messageId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(128),
  role: messageRoleSchema,
  blocks: z.array(messageBlockSchema).max(64),
  /** Node that authored the message, for provenance display. */
  authorNodeId: z.string().min(1).max(128),
  /** Task this message reports on, when it is a progress or result message. */
  taskId: z.string().min(1).max(128).optional(),
  createdAt: instantSchema,
  /** Delivery state, so "sent" is never shown before the node accepted it. */
  delivery: z.enum(["draft", "sending", "accepted", "failed"]),
});
export type MessageRecord = z.infer<typeof messageRecordSchema>;

/**
 * Whether a block list is displayable when some widgets fail to mount.
 *
 * The rule the blueprint states as "chat remains usable": unknown definitions,
 * invalid props and oversized specs must degrade to their text alternative
 * rather than break the timeline (acceptance test T44).
 */
export function degradeUnrenderableBlocks(
  blocks: readonly MessageBlock[],
  available: { definitionIds: ReadonlySet<string>; maxSurfaceBytes: number },
): MessageBlock[] {
  return blocks.map((block) => {
    if (block.type === "surface") {
      const definitionId = block.definitionRef?.id;
      const tooLarge = new TextEncoder().encode(JSON.stringify(block.snapshot)).length > available.maxSurfaceBytes;
      if (tooLarge || (definitionId !== undefined && !available.definitionIds.has(definitionId))) {
        return {
          type: "text",
          format: "plain",
          content: block.snapshot.textAlternative,
          streaming: false,
        } satisfies MessageBlock;
      }
    }
    if (block.type === "widget-ref" && !available.definitionIds.has(`instance:${block.instanceId}`)) {
      return {
        type: "text",
        format: "plain",
        content: block.textAlternative,
        streaming: false,
      } satisfies MessageBlock;
    }
    return block;
  });
}
