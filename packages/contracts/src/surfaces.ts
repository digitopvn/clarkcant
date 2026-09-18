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

/**
 * A tool call, as the transcript recorded it.
 *
 * Built by the node, because the node is what ran the tool: the model asks and this is the record of
 * what happened, carrying the arguments and the result so the widget can show them again after the
 * fact. It is deliberately not a host-owned card — it makes no claim about the node's state, and the
 * host-owned list is the set of things a widget must not be able to mint.
 */
export const toolActivityBlockSchema = z.strictObject({
  type: z.literal("tool-activity"),
  /** The provider's identifier for this call, so a start and an end can be the same widget. */
  toolCallId: z.string().min(1).max(128),
  /** The tool's own name, e.g. `show_view` or `search_files`. */
  name: z.string().min(1).max(120),
  /** One line for a reader: what this call was for. */
  label: z.string().min(1).max(300),
  status: z.enum(["running", "done", "failed"]),
  /** The arguments the model passed, as data rather than as a string to be parsed again. */
  args: z.record(z.string(), z.unknown()),
  /** What the tool returned, once it has. */
  result: z.string().max(20_000).optional(),
  /** A language hint for the arguments and the result, so the widget can colour them. */
  language: z.string().max(40).optional(),
  /** The path the call touched, when it touched one. */
  path: z.string().max(1000).optional(),
  startedAt: instantSchema,
  endedAt: instantSchema.optional(),
});

/**
 * The model's own reasoning, when the provider exposes it.
 *
 * Separate from a `text` block because it is not the reply: it is what the model said to itself on the
 * way there, and an interface that mixes the two shows the user something the model did not address to
 * them. Collapsed by default for the same reason.
 */
export const reasoningBlockSchema = z.strictObject({
  type: z.literal("reasoning"),
  content: z.string().max(100_000),
  startedAt: instantSchema,
  endedAt: instantSchema.optional(),
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
 * `owner` is always the host, and the renderer uses it to apply host chrome and to place the card
 * outside any widget iframe. That placement is real; the field is not a proof of origin. A schema
 * literal only says what value the field must hold, and a forger that holds the right value passes
 * it — so this type is kept out of third-party reach by construction instead: the node builds these
 * cards itself and never accepts one from model, widget or pack output, and `prepareBlocksForRender`
 * rejects any that arrive from a non-host origin (acceptance test T41).
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

/**
 * A task that is still running.
 *
 * Steps are the unit here rather than a percentage. A progress card showing only "60%" invites
 * the question "doing what", and a card listing steps the host has not actually reached is worse
 * than no card at all — so a step is only present once there is something true to say about it.
 */
export const taskProgressCardSchema = z.strictObject({
  type: z.literal("task-progress-card"),
  owner: z.literal("host"),
  cardId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  goal: z.string().min(1).max(2000),
  status: z.enum(["queued", "working", "blocked", "needs-decision"]),
  steps: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(300),
        status: z.enum(["pending", "active", "done", "failed", "skipped"]),
        detail: z.string().max(1000).optional(),
      }),
    )
    .max(64),
  /** Where the work runs, so a task on another node is never shown as if it were local. */
  targetNode: z
    .strictObject({ nodeId: z.string().min(1).max(128), label: z.string().min(1).max(200) })
    .optional(),
  startedAt: instantSchema,
  updatedAt: instantSchema,
  cancellable: z.boolean(),
});

/**
 * A task that has finished.
 *
 * `outcome` and `evidence` are separate fields on purpose. A task that ran to completion without
 * producing evidence did not succeed, and a single field would force the card to choose between
 * reporting that the run ended and reporting whether it achieved anything.
 */
export const taskSummaryCardSchema = z.strictObject({
  type: z.literal("task-summary-card"),
  owner: z.literal("host"),
  cardId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  goal: z.string().min(1).max(2000),
  outcome: z.enum(["succeeded", "failed", "cancelled", "not-verified"]),
  evidence: z.enum(["verified", "not-verified", "contradicted"]),
  durationMs: z.number().int().nonnegative(),
  /** What the task touched, so "done" is not taken on trust. */
  changes: z
    .array(
      z.strictObject({
        target: z.string().min(1).max(1000),
        kind: z.enum(["created", "modified", "deleted", "read"]),
      }),
    )
    .max(200),
  summary: z.string().min(1).max(4000),
  updatedAt: instantSchema,
});

/**
 * Every task in a conversation, in one place.
 *
 * A conversation accumulates tasks, and without a single view of them the only way to find out
 * whether something is still running is to scroll until you recognise it.
 */
export const taskOverviewCardSchema = z.strictObject({
  type: z.literal("task-overview-card"),
  owner: z.literal("host"),
  cardId: z.string().min(1).max(128),
  conversationId: z.string().min(1).max(128),
  tasks: z
    .array(
      z.strictObject({
        taskId: z.string().min(1).max(128),
        goal: z.string().min(1).max(2000),
        status: z.enum([
          "queued",
          "working",
          "blocked",
          "needs-decision",
          "done",
          "failed",
          "cancelled",
        ]),
        updatedAt: instantSchema,
      }),
    )
    .max(200),
  updatedAt: instantSchema,
});

/**
 * A diff the host is proposing or has applied.
 *
 * The hunks are carried as structured lines rather than one pre-coloured string, because the
 * client has to be able to render them at its own theme and size. `truncated` is explicit: a diff
 * that was cut for size and not marked as cut reads as the whole change.
 */
export const codeDiffCardSchema = z.strictObject({
  type: z.literal("code-diff-card"),
  owner: z.literal("host"),
  cardId: z.string().min(1).max(128),
  summary: z.string().min(1).max(2000),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1000),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        hunks: z
          .array(
            z.strictObject({
              header: z.string().max(300),
              lines: z
                .array(
                  z.strictObject({
                    kind: z.enum(["add", "remove", "context"]),
                    text: z.string().max(4000),
                  }),
                )
                .max(2000),
            }),
          )
          .max(200),
      }),
    )
    .max(200),
  /** True when hunks were omitted for size, so the card can say the view is partial. */
  truncated: z.boolean(),
  updatedAt: instantSchema,
});

/**
 * Choosing which project a task may touch.
 *
 * The roots are the ones the node has already approved. A picker that accepted an arbitrary path
 * would be a way to widen the workspace without an approval, so entry of a new root is a separate
 * affordance the host has to offer explicitly — `allowManualEntry` says whether it does here.
 */
export const projectPickerCardSchema = z.strictObject({
  type: z.literal("project-picker-card"),
  owner: z.literal("host"),
  cardId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(2000),
  roots: z
    .array(
      z.strictObject({
        rootId: z.string().min(1).max(128),
        label: z.string().min(1).max(300),
        path: z.string().min(1).max(1000),
        readOnly: z.boolean(),
      }),
    )
    .max(100),
  allowManualEntry: z.boolean(),
  updatedAt: instantSchema,
});

/**
 * A lost connection to a node the conversation depends on.
 *
 * `lastSeenAt` and `attempt` are required rather than optional because the two questions a user
 * has when something stops working are "since when" and "is it still trying", and a card that
 * cannot answer either is only a decoration.
 */
export const reconnectCardSchema = z.strictObject({
  type: z.literal("reconnect-card"),
  owner: z.literal("host"),
  cardId: z.string().min(1).max(128),
  nodeId: z.string().min(1).max(128),
  nodeLabel: z.string().min(1).max(300),
  status: z.enum(["disconnected", "reconnecting", "failed"]),
  attempt: z.number().int().nonnegative(),
  lastSeenAt: instantSchema,
  reason: z.string().min(1).max(2000).optional(),
});

export const messageBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  toolActivityBlockSchema,
  reasoningBlockSchema,
  surfaceBlockSchema,
  widgetRefBlockSchema,
  artifactBlockSchema,
  evidenceBlockSchema,
  systemCardBlockSchema,
  approvalCardBlockSchema,
  credentialCardBlockSchema,
  connectionCardBlockSchema,
  taskProgressCardSchema,
  taskSummaryCardSchema,
  taskOverviewCardSchema,
  codeDiffCardSchema,
  projectPickerCardSchema,
  reconnectCardSchema,
]);
export type MessageBlock = z.infer<typeof messageBlockSchema>;

/** Blocks whose trust state is owned by the host, never by a pack or a model. */
export const HOST_OWNED_BLOCK_TYPES = [
  "system-card",
  "approval-card",
  "credential-card",
  "connection-card",
  "task-progress-card",
  "task-summary-card",
  "task-overview-card",
  "code-diff-card",
  "project-picker-card",
  "reconnect-card",
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
