import { z } from "zod";

/**
 * Shared scalar primitives.
 *
 * Every identifier in this protocol is an opaque, prefixed string. Keeping the
 * prefix in the type makes it impossible to pass a `TaskId` where a `RunId` is
 * expected, which is the single most common cross-node bug: a peer forwarding a
 * task identifier into a run field and silently retargeting work.
 */

const OPAQUE_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

function prefixed<const P extends string>(prefix: P) {
  const expected = `${prefix}_`;
  return z
    .string()
    .max(128)
    .refine(
      (value) => value.startsWith(expected) && OPAQUE_PATTERN.test(value.slice(expected.length)),
      { error: `must be a ${expected}... identifier` },
    )
    .brand<`${P}Id`>();
}

export const nodeIdSchema = prefixed("node");
export const principalIdSchema = prefixed("prin");
export const conversationIdSchema = prefixed("conv");
export const messageIdSchema = prefixed("msg");
export const taskIdSchema = prefixed("task");
/** A suggestion the node offered. Its id is stable while it is offered, so a press can name it back. */
export const suggestionIdSchema = prefixed("sug");
/** One thing the node remembers. Stable, because the Memory tab deletes by it. */
export const memoryIdSchema = prefixed("mem");
export const runIdSchema = prefixed("run");
export const commandIdSchema = prefixed("cmd");
export const eventIdSchema = prefixed("evt");
export const delegationIdSchema = prefixed("dlg");
export const grantIdSchema = prefixed("grant");
export const leaseIdSchema = prefixed("lease");
export const effectIdSchema = prefixed("eff");
export const approvalIdSchema = prefixed("appr");
export const installPlanIdSchema = prefixed("plan");
export const packageIdSchema = prefixed("pkg");
export const connectionIdSchema = prefixed("conn");
export const instanceIdSchema = prefixed("winst");
export const snapshotIdSchema = prefixed("wsnap");
export const pinIdSchema = prefixed("pin");
export const actionIdSchema = prefixed("act");
export const datasetIdSchema = prefixed("ds");
export const artifactIdSchema = prefixed("art");
export const attachmentIdSchema = prefixed("att");
export const capabilityIdSchema = prefixed("cap");
export const targetIdSchema = prefixed("tgt");
/** Descriptive alias for the automation contract, where `target` alone is ambiguous. */
export const automationTargetIdSchema = targetIdSchema;
export const observationIdSchema = prefixed("obs");
export const voiceSessionIdSchema = prefixed("voice");
export const receiptIdSchema = prefixed("rcpt");

export type NodeId = z.infer<typeof nodeIdSchema>;
export type PrincipalId = z.infer<typeof principalIdSchema>;
export type ConversationId = z.infer<typeof conversationIdSchema>;
export type MessageId = z.infer<typeof messageIdSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type RunId = z.infer<typeof runIdSchema>;
export type CommandId = z.infer<typeof commandIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type DelegationId = z.infer<typeof delegationIdSchema>;
export type GrantId = z.infer<typeof grantIdSchema>;
export type LeaseId = z.infer<typeof leaseIdSchema>;
export type EffectId = z.infer<typeof effectIdSchema>;
export type ApprovalId = z.infer<typeof approvalIdSchema>;
export type InstallPlanId = z.infer<typeof installPlanIdSchema>;
export type PackageId = z.infer<typeof packageIdSchema>;
export type ConnectionId = z.infer<typeof connectionIdSchema>;
export type WidgetInstanceId = z.infer<typeof instanceIdSchema>;
export type WidgetSnapshotId = z.infer<typeof snapshotIdSchema>;
export type PinId = z.infer<typeof pinIdSchema>;
export type ActionId = z.infer<typeof actionIdSchema>;
export type DatasetId = z.infer<typeof datasetIdSchema>;
export type ArtifactId = z.infer<typeof artifactIdSchema>;
export type AttachmentId = z.infer<typeof attachmentIdSchema>;
export type CapabilityId = z.infer<typeof capabilityIdSchema>;
export type AutomationTargetId = z.infer<typeof targetIdSchema>;
export type ObservationId = z.infer<typeof observationIdSchema>;
export type VoiceSessionId = z.infer<typeof voiceSessionIdSchema>;
export type ReceiptId = z.infer<typeof receiptIdSchema>;

/**
 * Instants are ISO 8601 in UTC. Wall-clock ordering is never used to resolve
 * cross-node conflicts; durability and ordering come from per-stream sequence
 * numbers instead (see `nodelink.ts`).
 */
export const instantSchema = z.iso.datetime({ offset: false }).brand<"Instant">();
export type Instant = z.infer<typeof instantSchema>;

export function nowInstant(): Instant {
  return instantSchema.parse(new Date().toISOString());
}

/** Monotonic per-stream counter. Gaps are allowed; regressions are not. */
export const sequenceSchema = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type Sequence = z.infer<typeof sequenceSchema>;

export const digestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, { error: "must be a sha256:<64 hex> digest" })
  .brand<"Digest">();
export type Digest = z.infer<typeof digestSchema>;

export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, { error: "must be a semantic version" });
export type Semver = z.infer<typeof semverSchema>;

/**
 * A resource is always addressed as the triple (node, opaque id, version).
 * Absolute paths and `file://` URLs are deliberately not representable here:
 * a model must not be able to name a path on another machine and have it
 * resolve to something real.
 */
export const resourceRefSchema = z.strictObject({
  nodeId: nodeIdSchema,
  resourceId: z.string().min(1).max(200),
  resourceVersion: z.string().min(1).max(120),
  kind: z.enum([
    "workspace",
    "folder",
    "file",
    "git-worktree",
    "browser-profile",
    "native-desktop",
    "virtual-desktop",
    "connection",
    "dataset",
    "artifact",
    "widget-instance",
    "package",
  ]),
});
export type ResourceRef = z.infer<typeof resourceRefSchema>;

export const platformSchema = z.enum([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
  "web",
]);
export type Platform = z.infer<typeof platformSchema>;

/*
 * Windows is in both vocabularies because this repository's own desktop app is Electron on Windows. Without it a
 * package cannot declare the platform it is running on and a node cannot say which system it is, which is a gap in
 * the contract rather than a missing test. `win32-*` follows Node's `process.platform`, which is what the desktop
 * app and the runtime both report.
 */
export const operatingSystemSchema = z.enum(["macos", "windows", "linux", "web"]);
export type OperatingSystem = z.infer<typeof operatingSystemSchema>;

/**
 * Three planes, kept apart on purpose. Control-plane data is durable and small;
 * execution-plane work holds leases; media bytes never enter event replay or the
 * conductor context (system-architecture.md §4).
 */
export const planeSchema = z.enum(["control", "execution", "media"]);
export type Plane = z.infer<typeof planeSchema>;

/**
 * Effects that leave the machine cannot be made exactly-once. The ledger tracks
 * how far an effect actually got so a timeout becomes `unknown` rather than a
 * silent retry (system-architecture.md §9).
 */
export const effectCategorySchema = z.enum([
  "read",
  "local-write",
  "external-write",
  "destructive",
  "financial",
  "communication",
  "media-capture",
]);
export type EffectCategory = z.infer<typeof effectCategorySchema>;
