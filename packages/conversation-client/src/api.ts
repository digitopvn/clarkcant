/**
 * Gateway client.
 *
 * The only place the UI talks to the runtime. Kept tiny and explicit so the authorization
 * story is visible: every call carries the bearer token, and nothing ever sends a
 * principal, because the gateway derives the caller from the channel rather than the body.
 */

import type {
  AppearanceResponse,
  AutonomySettings,
  CompositionGraph,
  ConnectionStatus,
  GraphSemanticState,
  LayoutNode,
  MapTilePolicyView,
  ModelPool,
  ProviderAuthEntryView,
  ProviderSignInView,
  SseEvent,
  TableFilterValue,
  TableSort,
  ThemesResponse,
  WidgetDefinition,
  WidgetFixture,
} from "@clarkcant/contracts";

import {
  COMPOSER_SURFACE_HEADER,
  MAP_TILES_OFFLINE_REASONS,
  appIntentDecisionSchema,
  WIDGET_PERFORM_HEADER,
  WIDGET_PERFORM_VERSION,
  type WidgetPerformReport,
  type WidgetPerformRequest,
  readWidgetPerformRequest,
  conversationDeleteResultSchema,
  artifactRefSchema,
  attachmentRefSchema,
  type ArtifactRef,
  type AttachmentRef,
  composerSuggestionsResponseSchema,
  effectReconcileResponseSchema,
  parseSseChunk,
  inboxResponseSchema,
  noticeSchema,
  waitingItemSchema,
  inboxSummarySchema,
  memoryListSchema,
  noticeOperationResponseSchema,
  suggestionsResponseSchema,
  type AppIntentDecision,
  type AppIntentKind,
  type AppIntentResolution,
  type ComposerReference,
  type ComposerSuggestionsResponse,
  type ComposerTrigger,
  type ConfirmationDecision,
  type EffectReconcileResponse,
  type InboxResponse,
  type InboxSummary,
  type NoticeOperationId,
  type NoticeOperationResponse,
  type NoticeOperationSource,
  type NoticeSuppression,
  type SkippedVersion,
  type MemoryRecord,
  type RegisteredPreference,
  type SemanticProposal,
  type SettingsTab,
  type Suggestion,
  type VoiceCapabilities,
} from "@clarkcant/contracts";
import { JOB_LIST_LIMIT, browserTokenWireSchema, jobSnapshotWireSchema, type BrowserToken, type JobSnapshot, type TokenRequest } from "@clarkcant/widget-sdk";
import { answerWidgetPerform } from "./frame-performs.ts";

import {
  type StartVoiceSessionOptions,
  type VoiceSession,
  type VoiceSessionEvents,
  startVoiceSession,
} from "./voice-session.ts";
import {
  type TerminalCommandView,
  type TerminalConnection,
  type TerminalOverview,
  type TerminalServerFrame,
  connectTerminalSocket,
  terminalSocketUrl,
} from "./terminal-socket.ts";

/** Where the key in effect for one credential comes from: the key saved in the node, its environment, or neither. */
export type CredentialSource = "vault" | "environment" | "none";

/** What `GET /readiness` answers. `sources` is absent from a node older than it. Names and sources, never values. */
export interface NodeReadinessAnswer {
  model: boolean;
  credentials: string[];
  sources?: Partial<Record<string, CredentialSource>>;
}

/** A press on a page the node recorded in its activity log: what was pressed, and the page's host and path. */
export interface RecentEffectAction {
  verb: "click";
  label: string;
  page: string;
}

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
  /**
   * The code to mount, or null when the widget's package was uninstalled: then `textFallback` and the kept `state` are
   * what there is to show, and `stateStatus` says why.
   */
  frame: {
    /** Relative to the node, and served from the package path so the widget's own imports resolve. */
    url: string;
    /**
     * How long, from the node's answer, the grant in `url` lasts. A node that predates it leaves it out, and then there
     * is no expiry to act on.
     */
    urlExpiresInMs?: number;
    /**
     * When the grant in `url` stops working, in this client's own clock (epoch ms). Not sent by the node: `liveWidget`
     * stamps it from the moment the request went out, so it is never later than the node's own expiry however the two
     * clocks disagree.
     */
    urlExpiresAt?: number;
    /** The document the URL loads, without its per-read grant: equal across reads until the widget's code changes. */
    document?: string;
    isolation: string;
    /**
     * What this frame is actually brokered — the *granted* set, already narrowed against what the package's
     * manifest requested. Not the request itself: a manifest's requested capabilities are metadata the package
     * wrote about itself, never an authority.
     */
    grantedCapabilities: readonly string[];
    /** Granted capabilities held back because they cannot run yet, each with the reason the node gave. */
    unavailableCapabilities?: readonly { ref: string; code: string; message: string }[];
    allowedOrigins: readonly string[];
    /**
     * What the frame does out of view under its package's granted profile. `authorized-playback` lets the person keep
     * it running offscreen from host chrome; absent or `suspend`, it unmounts when scrolled away.
     */
    offscreen?: "suspend" | "authorized-playback";
    /** The providers the widget's package declared browser tokens from. Absent: the frame is offered no tokens. */
    browserTokens?: readonly string[];
    /** The actions the widget's package declared it offers to Clark, by name. Absent: Clark can perform none. */
    offeredActions?: readonly string[];
  } | null;
  /** Present when `frame` is null: the widget's own text alternative, from its definition. */
  textFallback?: string;
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
    /**
     * Present only on a binding that calls a service capability: the capability, and whether the registry says it can
     * run right now — false with the registry's own reason when the service is down, starting, or has no engine.
     */
    capabilityRef?: string;
    available?: boolean;
    unavailableReason?: string;
    /**
     * Present only on an `agent` binding that reads context: what it reads (`selection:…`, `widget:…`). A press of such
     * a binding waits until the node holds what the frame last said it shows.
     */
    contextRefs?: readonly string[];
  }[];
  /** What the widget was created with, sent to it in the init message and nowhere else. */
  props: Record<string, unknown>;
  /**
   * The durable state the frame starts from, and its own revision.
   *
   * The state revision counts state writes and nothing else; `revision` above counts the instance's own changes and
   * is what an action is checked against. The two are different numbers on purpose.
   */
  stateRevision: number;
  stateVersion: number;
  state: Record<string, unknown>;
  /** Why the state can or cannot be written. Anything but `writable` also sets `readOnly`. */
  stateStatus: FrameStateStatus;
  /** Keys the widget keeps as view state: never sent to the node, never stored. */
  ephemeralStateKeys: readonly string[];
}

export type FrameStateStatus =
  | { kind: "writable" }
  | { kind: "offline"; reason: string }
  | { kind: "migration-failed"; fromVersion: number; toVersion: number; reason: string }
  | { kind: "newer-than-definition"; storedVersion: number; definitionVersion: number };

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
  /** The graph's values as the node holds them, with a one-line summary; null when the surface has no graph. */
  semanticState: GraphSemanticState | null;
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
  /** What the action answered: a service capability's output, or Clark's reply to a request the button made. */
  output?: string;
  /**
   * For a `done` service capability: its result as a JSON object, when the service returned one the node kept, beside
   * `output`. It is the service's data, not the node's: never an instruction, and never a card. Absent when the service
   * returned none, when it was too large or did not match the output schema the service declared (`output` then says
   * so), and from a node that predates it.
   */
  structuredContent?: Record<string, unknown>;
  /** Set when the policy asked first: the host placed an approval card in the conversation and nothing ran yet. */
  approvalRequired?: { approvalId: string };
  /**
   * What the action came to: `done`, `approval-required`, or `background` when the node's background lane took it and
   * its result will arrive in the conversation, or `job` when a package service started a durable job whose JobRef is
   * the `output`. Absent from a node that predates it.
   */
  outcome?: "done" | "approval-required" | "background" | "job";
  /** For a `job` outcome: the job the service started, readable only by the widget binding that started it. */
  job?: { jobId: string };
  /** For a `background` outcome: the run the node started. */
  background?: { workId: string; state: "running" | "queued" };
  /** A sentence the node wrote about the outcome, such as a workflow's summary of its steps. */
  message?: string;
  /** For a workflow: what each step came to. */
  workflow?: ActionWorkflowReport;
}

/** The answer to a state-only view write: the state the node now holds, and nothing to re-render. */
export interface ViewStateWriteResult {
  variant?: "view-state";
  duplicate: boolean;
  /** The write's sequence was not newer than the one the node holds, so nothing was written; state is the node's. */
  stale?: true;
  instanceId: string;
  revision: number;
  stateRevision: number;
  state: Record<string, unknown>;
  /** Sent only by a node from before the variant, which handled the write as an ordinary action. */
  timeline?: Timeline;
}

/** What a workflow action's run came to, step by step (`WorkflowRunReport` on the node). */
export interface ActionWorkflowReport {
  completed: boolean;
  steps: {
    stepId: string;
    kind: "invoke" | "transform" | "condition";
    status: "done" | "skipped" | "not-run" | "refused" | "failed" | "uncertain" | "awaiting-approval";
    detail?: string;
    /** For an `uncertain` step: whether the node's effect ledger holds it, which is when the inbox asks about it. */
    recorded?: boolean;
    /** For a `failed` step that calls a service: it only reads, so nothing can have changed. */
    readOnly?: boolean;
  }[];
  stoppedAt?: string;
  code?: string;
  message: string;
  output?: string;
}

export interface TimelineMessage {
  messageId: string;
  role: "user" | "assistant" | "system" | "tool";
  blocks: Record<string, unknown>[];
  createdAt: string;
  /**
   * Present when the host wrote this message itself so a turn could run (`MessageRecord.hostWritten`). Its text is
   * for the model; the transcript draws a quiet line from the host instead of the person's bubble.
   */
  hostWritten?: { kind: string; version: number };
}

export interface TimelineInstance {
  instanceId: string;
  definitionId: string;
  definitionVersion: string;
  lifecycle: string;
  revision: number;
  props: Record<string, unknown>;
  /** The actions the instance holds, when it holds any. What pressing one does is the node's to decide. */
  actions?: TimelineAction[];
  /** The view the node holds for the instance, when it holds one: a chart's hidden series and selected point. */
  state?: Record<string, unknown>;
  stateRevision?: number;
}

/** One bound action: what to show, what to send back, and whether it can run now. */
export interface TimelineAction {
  actionBindingId: string;
  label: string;
  effectCategory: string;
  bindingDigest: string;
  /** A host-checked, effect-free view operation, when this binding is one of several on a widget. */
  viewOperation?: string;
  available: boolean;
  unavailableCode?: string;
  unavailableReason?: string;
  /** What a use sends goes under: a form's field names, or the key a list item's id is sent as. */
  inputKeys?: string[];
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
  /** The node could not read this snapshot back; its block is shown as unreadable, and the rest of the conversation opens. */
  unreadable?: true;
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
    actions: { actionBindingId: string; sectionId: string; label: string; kind: string; effectCategory: string; operation?: string }[];
    provenance: { createdAt: string };
    /** Present when the surface was arranged as a tree; its leaves name sections by id. */
    layout?: LayoutNode;
    /** Present when its leaves write and read state; the values themselves live in the instance state under `graph`. */
    graph?: CompositionGraph;
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
  | { type: "tool-end"; toolCallId: string; status: "done" | "failed"; result: string }
  /**
   * An app-control action the main agent asked for through `control_app`, mid-turn.
   *
   * Carried as its own event rather than folded into `tool-end`'s text result, because a decision is
   * something the page runs through `runAppIntent` and a tool result is text the transcript shows — the
   * two must not be read as the same thing by a caller that only looks at one of them.
   */
  | { type: "host-control"; decision: AppIntentDecision }
  /**
   * An action Clark asked a widget shown on this page to perform. The page hands it to the mounted frame and reports
   * what the frame answered (`reportWidgetPerform`); the node is waiting for that report. One this page cannot read but
   * whose id it can is `widget-perform-unreadable`, answered with the refusal it carries (`answerWidgetPerform`).
   */
  | { type: "widget-perform"; request: WidgetPerformRequest }
  | { type: "widget-perform-unreadable"; performId: string; report: WidgetPerformReport };

/*
 * The event-stream parser lives in contracts so the node's WebSocket, the CLI and this client split a stream the
 * same way; re-exported here so the client's own callers keep importing it from where they always have.
 */
export { parseSseChunk, type SseEvent };

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
  /**
   * The frozen build input this generation was activated against, when there was one.
   *
   * Absent means nothing was frozen, which is a different statement from an empty closure. `coverage` says how much
   * of the build input the lock covers, so `artifact-only` is never read as "the dependencies are pinned".
   */
  lock?: { ref: string; digest: string; coverage: string };
  /** The version a rollback would make active again; absent when no other version was ever active here. */
  previousVersion?: string;
  /**
   * The resource profile the package asked for and what this node decided. Absent when the node could not read the
   * package's manifest, which is not the same as the light profile.
   */
  resources?: PackageResourcesView;
  /**
   * The origins, keys and browser-token providers its manifest declares, as install consent covered them. Absent when
   * it reaches none, or when the node could not read its manifest.
   */
  reach?: unknown;
  /**
   * Its account connection's status, when its service declares one: state, scopes and why it is not usable. Never a
   * token; the node keeps those.
   */
  connection?: ConnectionStatus;
}

/** The node's resource decision for one package: the bounds its code runs in, or why it does not run. */
export type PackageResourcesView =
  | {
      requested: ResourceProfileName;
      status: "granted";
      profile: ResourceProfileName;
      bounds: {
        memoryMib: number;
        cpus: number;
        pids: number;
        tmpfsMib: number;
        callDeadlineMs: number;
        jobDeadlineMs: number;
        maxActiveJobs: number;
      };
      summary: string;
      offscreen: "suspend" | "authorized-playback";
      /** Facts the node states beside the grant, such as limits its container engine does not enforce. */
      notes: string[];
    }
  | { requested: ResourceProfileName; status: "degraded"; reason: string };

export type ResourceProfileName = "interactive-light" | "interactive-heavy" | "media-workstation" | "background-compute";

/** A package that was uninstalled here and can be restored without fetching anything. */
export interface RestorablePackageView {
  packageId: string;
  version: string;
  digest: string;
  uninstalledAt: string;
}

/** What uninstalling, restoring or rolling back a package did. */
export interface PackageChangeResponse {
  action: "uninstall" | "restore" | "rollback";
  packageId: string;
  activeVersion?: string;
  previousVersion?: string;
  instancesOffline: number;
  instancesRestored: number;
  statesKept: number;
  /** The package carries trusted native code, which only reaches Pi when Pi restarts. */
  restartNeeded: boolean;
}

/** A capability an install asked the person about, still unanswered. Decided only through host-owned Settings. */
export interface PendingCapabilityApprovalView {
  approvalId: string;
  ref: string;
  packageId: string;
  version: string;
  /** Sent back with the decision, so the answer applies to exactly what was shown. */
  operationDigest: string;
  description: string;
  requestedAt: string;
  expiresAt: string;
}

/**
 * A widget definition an installed package declares, as the node reports it.
 *
 * Data only. A package never contributes a renderer, so what arrives is a definition and the fixtures the package
 * wrote, and whether any of it can be drawn is decided where the renderers are.
 */
export interface InstalledWidgetRead {
  packageId: string;
  version: string;
  facetId: string;
  definition: WidgetDefinition;
  fixtures: WidgetFixture[];
}

/**
 * One installed package's widgets, or the reason this node could not read them.
 *
 * The failure arm is not an empty list, because "this package declares no widgets" and "this node cannot read that
 * package" are different facts: a git or npm entry names bytes nobody here holds, and a package the configured
 * directory does not list cannot be located at all.
 */
export type InstalledPackageRead =
  | {
      packageId: string;
      version: string;
      ok: true;
      widgets: InstalledWidgetRead[];
      /** Facets that did not parse, named rather than silently dropped. */
      problems: string[];
    }
  | { packageId: string; version: string; ok: false; code: string; message: string };

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

/** The view a table export writes. The node re-applies it to the instance's own dataset. */
export interface TableExportRequest {
  sort?: TableSort;
  query?: string;
  filters?: Record<string, TableFilterValue>;
  /** Column keys, in order; a key the table does not show is ignored by the node. */
  columns?: string[];
}

/**
 * The file name a `Content-Disposition` header offers, preferring the RFC 5987 UTF-8 form.
 *
 * Anything that could name a directory is removed: the name only labels a download, and a browser
 * would sanitize it anyway, but this client should not depend on that.
 */
export function attachmentFilename(header: string | null): string | undefined {
  if (header === null) return undefined;
  let name: string | undefined;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (extended !== undefined) {
    try {
      name = decodeURIComponent(extended.trim());
    } catch {
      name = undefined;
    }
  }
  name ??= /filename\s*=\s*"([^"]*)"/i.exec(header)?.[1] ?? /filename\s*=\s*([^;\s]+)/i.exec(header)?.[1];
  const cleaned = name === undefined
    ? undefined
    : [...name].filter((char) => char !== "/" && char !== "\\" && char.charCodeAt(0) >= 0x20).join("").trim();
  return cleaned === undefined || cleaned === "" || /^\.+$/.test(cleaned) ? undefined : cleaned;
}

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * The rest of the refusal body, when the node sent more than a code and a message — a stale state write, for
   * one, carries the state the node holds, which is what lets the caller show it instead of guessing.
   */
  readonly details: Record<string, unknown>;
  /** The node's sentence without the code in front of it, for a line a person reads rather than a log. */
  readonly reason: string;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.reason = message;
  }
}

/** `GET /inbox` as read: the response, and how many of its items did not match the contract and were left out. */
export type InboxRead = InboxResponse & { unreadable?: number };

/**
 * `GET /inbox`, parsed item by item.
 *
 * The envelope is parsed whole, so a response that is not an inbox at all still fails. Each waiting item and notice is
 * then parsed on its own: one that does not match the contract (a newer node's field, or a node bug) is left out and
 * counted, rather than hiding every question and approval behind one bad row. Items that do parse are exactly what the
 * contract says, so no button is built from a field that was not there.
 */
export function parseInboxResponse(raw: unknown): InboxRead {
  const body = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const waiting = body?.["waiting"];
  const notices = body?.["notices"];
  const snoozed = body?.["snoozed"] ?? [];
  // Not an inbox: the whole response fails, with the contract's own error.
  if (body === undefined || !Array.isArray(waiting) || !Array.isArray(notices) || !Array.isArray(snoozed)) {
    return inboxResponseSchema.parse(raw);
  }
  const envelope = inboxResponseSchema.parse({ ...body, waiting: [], notices: [], snoozed: [] });
  let unreadable = 0;
  const each = <T,>(items: unknown[], parse: (item: unknown) => { success: true; data: T } | { success: false; error: unknown }): T[] =>
    items.flatMap((item) => {
      const result = parse(item);
      if (result.success) return [result.data];
      unreadable += 1;
      // A schema failure has no sentence fit for a person to read; the panel says how many were left out.
      console.error("inbox: an item does not match the contract and is not shown", result.error);
      return [];
    });
  return {
    ...envelope,
    waiting: each(waiting, (item) => waitingItemSchema.safeParse(item)),
    notices: each(notices, (item) => noticeSchema.safeParse(item)),
    snoozed: each(snoozed, (item) => noticeSchema.safeParse(item)),
    ...(unreadable === 0 ? {} : { unreadable }),
  };
}

/** What a message carries besides its text. */
export interface MessageOptions {
  demo?: boolean;
  attachmentIds?: readonly string[];
  /** What the person picked after `/` or `@`, whose tokens are still in the text. */
  references?: readonly ComposerReference[];
}

/**
 * The body both message routes take.
 *
 * Empty lists are omitted rather than sent: a node that predates a field validates it when it is present, and an empty
 * list is not worth an extra rule on either side.
 */
function messageBody(text: string, options: MessageOptions): Record<string, unknown> {
  return {
    text,
    ...(options.demo === true ? { demo: true } : {}),
    ...(options.attachmentIds === undefined || options.attachmentIds.length === 0
      ? {}
      : { attachmentIds: [...options.attachmentIds] }),
    ...(options.references === undefined || options.references.length === 0
      ? {}
      : { references: { version: 1, items: [...options.references] } }),
  };
}

/**
 * How long a read of node-owned bytes (a picture, a player's source, an attached file) waits for the node to start
 * answering.
 *
 * Only the wait for the response's headers is bounded, never the body: a large file on a slow link may take minutes to
 * arrive and still be arriving, but a node that has not begun to answer in this long has stalled - a sleeping laptop, a
 * relay hop that dropped, a half-open connection after a network switch. Without a bound such a read waits forever,
 * and whatever is waiting on it (a card preparing a download, a player, a picture) waits with it. With one, the stall
 * becomes the failure that surface already explains and recovers from.
 */
export const FIRST_RESPONSE_TIMEOUT_MS = 30_000;

/** The code a read carries when the node did not start answering within `FIRST_RESPONSE_TIMEOUT_MS`. */
export const NODE_NOT_ANSWERING = "NODE_NOT_ANSWERING";

export class GatewayClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #packageListeners = new Set<() => void>();
  readonly #modelListeners = new Set<() => void>();

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

  /**
   * The live terminal channel. Like the voice socket, the token goes in the first frame and is never handed to the
   * card that draws the terminal.
   */
  openTerminalSocket(handlers: {
    onFrame: (frame: TerminalServerFrame) => void;
    onClose: (reason: string) => void;
  }): TerminalConnection {
    return connectTerminalSocket({ url: terminalSocketUrl(this.#baseUrl), token: this.#token, ...handlers });
  }

  /** Everything running on the node: terminals, `run_command` processes, background work and Pi sessions. */
  terminals(): Promise<TerminalOverview> {
    return this.#call("GET", "/terminals");
  }

  killTerminal(terminalId: string): Promise<{ terminalId: string; stopping: true }> {
    return this.#call("POST", `/terminals/${encodeURIComponent(terminalId)}/kill`, {});
  }

  terminalCommands(terminalId: string): Promise<{ terminalId: string; commands: TerminalCommandView[] }> {
    return this.#call("GET", `/terminals/${encodeURIComponent(terminalId)}/commands`);
  }

  /**
   * An authenticated GET for node-owned bytes, resolved once the node has answered with its headers.
   *
   * The wait for those headers is bounded by `FIRST_RESPONSE_TIMEOUT_MS`, and a stall rejects with `NODE_NOT_ANSWERING`
   * and aborts the request. The body, which the caller reads, is not bounded. `signal` aborts the request at any point,
   * the body included.
   */
  async #readBytes(path: string, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    if (signal?.aborted === true) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new GatewayError(
          504,
          NODE_NOT_ANSWERING,
          `the node did not start answering within ${String(FIRST_RESPONSE_TIMEOUT_MS / 1000)} seconds`,
        );
        controller.abort(error);
        reject(error);
      }, FIRST_RESPONSE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.#fetch(`${this.#baseUrl}${path}`, {
          headers: { authorization: `Bearer ${this.#token}` },
          signal: controller.signal,
        }),
        stalled,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `keepalive` lets a request outlive the page that sent it, for the last write a page makes as it goes away. `signal`
   * aborts the request, for a caller that gives up waiting.
   */
  async #call<T>(
    method: string,
    path: string,
    body?: unknown,
    init: { keepalive?: true; signal?: AbortSignal; headers?: Record<string, string>; composer?: true } = {},
  ): Promise<T> {
    const { headers: extraHeaders, composer, ...fetchInit } = init;
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...fetchInit,
      method,
      headers: {
        ...extraHeaders,
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        // This page's own mark, on what the person does here that starts a turn: the node records them as who asked.
        ...(composer === true ? { [COMPOSER_SURFACE_HEADER]: "composer" } : {}),
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
      throw new GatewayError(
        response.status,
        record.code ?? "UNKNOWN",
        record.message ?? "the request failed",
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {},
      );
    }
    return parsed as T;
  }

  /** Whether the node answers. `signal` lets a caller that stops waiting cancel the request. */
  health(init: { signal?: AbortSignal } = {}): Promise<{ status: string; runtime: { node: string; platform: string; arch: string } }> {
    return this.#call("GET", "/health", undefined, init.signal === undefined ? {} : { signal: init.signal });
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
    model: { provider: string; id: string; maxWallClockMs?: number; maxTokens: number; thinkingLevel?: string } | null;
  }> {
    return this.#call("GET", "/node");
  }

  /**
   * Called after this page changes which model the next turn runs, by a Settings pick or the pool hotkey.
   *
   * A surface that names the model, such as the composer's statusline, reads it again then instead of polling the node
   * or naming the model it read at startup. Answers the function that stops listening.
   */
  onModelChange(listener: () => void): () => void {
    this.#modelListeners.add(listener);
    return () => {
      this.#modelListeners.delete(listener);
    };
  }

  /** Tells the statusline to read the model again, after a change this page learned of some other way (`/thinking`). */
  notifyModelChange(): void {
    for (const listener of this.#modelListeners) listener();
  }

  #changingModel<T>(call: Promise<T>): Promise<T> {
    return call.then((result) => {
      for (const listener of this.#modelListeners) listener();
      return result;
    });
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
    options: MessageOptions = {},
  ): Promise<SendMessageResult> {
    return this.#call("POST", `/conversations/${conversationId}/messages`, messageBody(text, options));
  }

  /**
   * What the composer's picker offers after `/` or `@`.
   *
   * Parsed rather than trusted, like the suggestions above: a row is drawn and then sent back as a reference, so a shape
   * this build does not know must fail here rather than become a reference the node refuses later.
   */
  async composerSuggestions(input: {
    trigger: ComposerTrigger;
    query: string;
    conversationId?: string | undefined;
  }): Promise<ComposerSuggestionsResponse> {
    const params = new URLSearchParams({ trigger: input.trigger, q: input.query });
    if (input.conversationId !== undefined) params.set("conversationId", input.conversationId);
    const body = await this.#call<unknown>("GET", `/composer/suggestions?${params.toString()}`);
    return composerSuggestionsResponseSchema.parse(body);
  }

  /**
   * Stop the reply a conversation is writing, and learn whether one was running.
   *
   * Only this conversation's turn: what it had written stays, labelled as stopped, and the stream that is carrying it
   * ends with its `done` as any reply does. `false` is the quiet answer for a reply that had already finished.
   */
  stopTurn(conversationId: string, source: "chat" | "voice" = "chat"): Promise<{ stopped: boolean }> {
    return this.#call("POST", `/conversations/${encodeURIComponent(conversationId)}/stop`, { source });
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
    options: MessageOptions = {},
  ): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/conversations/${conversationId}/messages/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        // Typed into this page's composer: the node stores the message as the person's own words.
        [COMPOSER_SURFACE_HEADER]: "composer",
        // This page hands a `widget-perform` of this version to a mounted frame and reports back; without it the node
        // sends none.
        [WIDGET_PERFORM_HEADER]: String(WIDGET_PERFORM_VERSION),
      },
      body: JSON.stringify(messageBody(text, options)),
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
        } else if (frame.event === "host-control") {
          // Validated rather than cast, the same guard `voice-session.ts` applies to the equivalent
          // voice frame: this arrives from the node, and a decision that does not parse is not
          // permission to run anything.
          const parsedDecision = appIntentDecisionSchema.safeParse(payload.decision);
          if (parsedDecision.success) listeners.onEvent({ type: "host-control", decision: parsedDecision.data });
        } else if (frame.event === "widget-perform") {
          // Validated like a decision: a request that does not parse is not one to hand to a widget. It is still answered
          // when its id can be read, because the node is waiting on that id.
          const read = readWidgetPerformRequest(payload.request);
          if (read.kind === "request") listeners.onEvent({ type: "widget-perform", request: read.request });
          else if (read.kind === "unreadable") {
            listeners.onEvent({ type: "widget-perform-unreadable", performId: read.performId, report: read.report });
          }
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
      /** Fixed words, for an effect the client has no wording of its own for. */
      description: string;
      /** A press on a page, as data, which the client words in the person's language. */
      action?: RecentEffectAction;
      operationDigest: string;
      because: string;
      /** Who asked for the effect, when the host recorded it: the person, an AI client over MCP, a relay, and so on. */
      origin?: string;
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
    const written = this.#call<{ preference: RegisteredPreference }>("PUT", `/preferences/${encodeURIComponent(key)}`, { value });
    // The thinking level is part of what the statusline names for the next turn.
    return key === "ai.thinkingLevel" ? this.#changingModel(written) : written;
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
    return this.#changingModel(this.#call("POST", "/model-pool/cycle", {}));
  }

  /**
   * Select a configured pool profile by its alias, without cycling through the others.
   *
   * The node re-validates the alias against the stored pool rather than trusting the caller, for the
   * same reason `cycleModel` never accepts a bare provider/model string: this is a choice among what
   * was configured, not a way to name an arbitrary model from the browser.
   */
  async selectModel(alias: string): Promise<{
    ok: boolean;
    previous?: string;
    alias: string;
    provider: string;
    modelId: string;
    applies: string;
  }> {
    return this.#changingModel(this.#call("POST", "/model-pool/select", { alias }));
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
    return this.#changingModel(this.#call("POST", "/model", input));
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

  /** The providers pi can sign in to, and which are signed in. Never a credential. */
  async providerAuth(): Promise<{ providers: ProviderAuthEntryView[] }> {
    return this.#call("GET", "/providers/auth");
  }

  /** Starts a provider's own sign-in; the answer is the sign-in to follow with `providerSignIn`. */
  async startProviderSignIn(providerId: string, method: "oauth" | "api_key"): Promise<ProviderSignInView> {
    return this.#call("POST", `/providers/${encodeURIComponent(providerId)}/sign-in`, { method });
  }

  async providerSignIn(signInId: string): Promise<ProviderSignInView> {
    return this.#call("GET", `/providers/sign-ins/${encodeURIComponent(signInId)}`);
  }

  /** The person's answer to what the sign-in asked, handed to the provider. The node does not keep it. */
  async answerProviderSignIn(signInId: string, value: string): Promise<ProviderSignInView> {
    return this.#call("POST", `/providers/sign-ins/${encodeURIComponent(signInId)}/answer`, { value });
  }

  async cancelProviderSignIn(signInId: string): Promise<ProviderSignInView> {
    return this.#call("POST", `/providers/sign-ins/${encodeURIComponent(signInId)}/cancel`, {});
  }

  async signOutProvider(providerId: string): Promise<{ providerId: string; signedOut: boolean }> {
    return this.#call("POST", `/providers/${encodeURIComponent(providerId)}/sign-out`, {});
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
   * that asked for a value here would be asking for exactly the thing the asking exists to avoid. `sources` says where
   * each key in effect comes from, so a card can say which one the node uses when both places hold one.
   */
  readiness(): Promise<NodeReadinessAnswer> {
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
      /** `toolCalls` is present only where the catalogue states it; absent means unknown, not no. */
      models: { provider: string; id: string; contextWindow?: number; current: boolean; toolCalls?: boolean }[];
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
  async decideApproval(
    conversationId: string,
    approvalId: string,
    decision: { decision: "granted" | "denied"; digest: string },
  ): Promise<{ decision: string; timeline: Timeline; outcome?: string }> {
    const answered = await this.#call<{ decision: string; timeline: Timeline; outcome?: string; perform?: unknown }>(
      "POST",
      `/conversations/${conversationId}/approvals/${approvalId}/decide`,
      decision,
      // An approved widget action is performed by the frame on this page, so the page says it can run one.
      { headers: { [WIDGET_PERFORM_HEADER]: String(WIDGET_PERFORM_VERSION) } },
    );
    const { perform, ...rest } = answered;
    if (perform === undefined) return rest;
    /*
     * The person approved an action Clark asked a widget to perform: the node handed it back here because only this page
     * reaches the frame. It is answered either way, and the receipt the node writes once it has the answer is read back.
     */
    const read = readWidgetPerformRequest(perform);
    if (read.kind === "none") return rest;
    await answerWidgetPerform(
      read.kind === "request"
        ? { type: "widget-perform", request: read.request }
        : { type: "widget-perform-unreadable", performId: read.performId, report: read.report },
      (performId, report) => this.reportWidgetPerform(performId, report),
    );
    return { ...rest, timeline: await this.timeline(conversationId) };
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
      // The answer opens a turn, and it is the person's, clicked or said on this page.
      { composer: true },
    );
  }

  cancelQuestion(conversationId: string, questionId: string): Promise<{ ok: boolean; timeline: Timeline }> {
    return this.#call("POST", `/conversations/${conversationId}/questions/${encodeURIComponent(questionId)}/cancel`, {});
  }

  /** Puts a question that expired unanswered back in its conversation as a new question; refused once it was. */
  askQuestionAgain(conversationId: string, questionId: string): Promise<{ ok: boolean; questionId: string; timeline: Timeline }> {
    return this.#call("POST", `/conversations/${conversationId}/questions/${encodeURIComponent(questionId)}/ask-again`, {});
  }

  /** Resolve the live surface for an instance: current state, sections and ownership. */
  async liveWidget(
    conversationId: string,
    instanceId: string,
  ): Promise<LiveWidgetResponse | IsolatedFrameLiveResponse> {
    // Read before the request goes out: the node starts the grant's lifetime later than this, so a deadline counted
    // from here can only be early, never late.
    const sentAt = Date.now();
    const live = await this.#call<LiveWidgetResponse | IsolatedFrameLiveResponse>(
      "GET",
      `/conversations/${conversationId}/widgets/${instanceId}/live`,
    );
    if (live.kind !== "isolated-frame" || live.frame === null || typeof live.frame.urlExpiresInMs !== "number") return live;
    return { ...live, frame: { ...live.frame, urlExpiresAt: sentAt + live.frame.urlExpiresInMs } };
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
    options: { keepalive?: boolean } = {},
  ): Promise<ActionInvocationResult> {
    return this.#call(
      "POST",
      `/conversations/${conversationId}/widgets/${instanceId}/actions`,
      { instanceId, ...invocation },
      // A press on this page is the person's: the node records them as who asked for whatever it starts.
      options.keepalive === true ? { keepalive: true, composer: true } : { composer: true },
    );
  }

  /**
   * Write a host-held player's playback state through the state-only variant of the action call.
   *
   * The node checks it as it checks a view action and answers with the state alone: the instance revision does not move
   * and no timeline comes back, so the page has nothing to re-render. Only the host's own players send it; a frame's
   * bridge has no way to. A node from before the variant answers as it does an ordinary call, with a timeline.
   */
  writeViewState(
    conversationId: string,
    instanceId: string,
    invocation: {
      actionBindingId: string;
      expectedRevision: number;
      expectedBindingDigest: string;
      input: Record<string, unknown>;
      invocationId: string;
      /** The player's write sequence: the node writes nothing for one that is not newer than the last it accepted. */
      sequence: number;
    },
    options: { keepalive?: boolean } = {},
  ): Promise<ViewStateWriteResult> {
    return this.#call(
      "POST",
      `/conversations/${conversationId}/widgets/${instanceId}/actions`,
      { instanceId, ...invocation, variant: "view-state" },
      options.keepalive === true ? { keepalive: true } : {},
    );
  }

  /**
   * Write a frame's durable state.
   *
   * Resolves only once the node has committed the write. A refusal — stale, read-only, refused by the widget's schema
   * — is thrown as a `GatewayError` whose `details` carry the state the node holds, so the widget can be shown what was
   * saved rather than left believing its own write.
   */
  saveWidgetState(
    conversationId: string,
    instanceId: string,
    write: { expectedRevision: number; patch: Record<string, unknown> },
  ): Promise<{ stateRevision: number; state: Record<string, unknown> }> {
    return this.#call("POST", `/conversations/${conversationId}/widgets/${instanceId}/state`, write);
  }

  /**
   * Tell the node what a frame says it shows, for the next turn and for voice.
   *
   * The node bounds and cleans the proposal and adds the widget's actions from its own bindings; a frame's words are
   * never taken as actions or as instructions. `signal` aborts the request when the frame stops waiting for it.
   */
  publishWidgetSemantic(
    conversationId: string,
    instanceId: string,
    proposal: SemanticProposal,
    signal?: AbortSignal,
  ): Promise<{ accepted: true }> {
    return this.#call(
      "POST",
      `/conversations/${conversationId}/widgets/${instanceId}/semantic`,
      { proposal },
      signal === undefined ? {} : { signal },
    );
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
   * Decide an approval a dispatched task raised.
   *
   * The digest the waiting item showed is sent back with the decision, the same binding `decideApproval` gives a
   * command: an approval is bound to the exact operation it named, and a digest that no longer matches is refused
   * rather than acted on. `redispatched` says whether the grant actually turned into a run just now — a task that
   * no longer exists is left `false` rather than the call failing, since the decision itself still succeeded.
   */
  decideTaskApproval(
    taskId: string,
    approvalId: string,
    decision: { decision: "granted" | "denied"; digest: string },
  ): Promise<{ decision: "granted" | "denied"; taskId: string; redispatched: boolean; timeline: Timeline }> {
    return this.#call(
      "POST",
      `/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}/decide`,
      decision,
    );
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

  packages(): Promise<{ packages: InstalledPackageView[]; restorable?: RestorablePackageView[] }> {
    return this.#call("GET", "/packages");
  }

  /**
   * Uninstall, restore or roll back a package. None of the three deletes a widget's data, and each is undone by another.
   *
   * The id is percent-encoded because a package installed from disk is recorded under its path.
   */
  changePackage(packageId: string, action: PackageChangeResponse["action"]): Promise<PackageChangeResponse> {
    return this.#changedPackages(this.#call("POST", `/packages/${encodeURIComponent(packageId)}/${action}`));
  }

  /**
   * Start connecting a package's account. Answers the provider's authorization URL, which the caller opens in the system
   * browser; the provider sends that browser back to the node, which finishes the connection itself. Only from this
   * node's own machine, because the browser has to come back over loopback.
   */
  connectPackage(packageId: string): Promise<{ authorizationUrl: string }> {
    return this.#call("POST", `/packages/${encodeURIComponent(packageId)}/connection`, {});
  }

  /** A package's account connection, as the node holds it now. */
  packageConnection(packageId: string): Promise<{ connection: ConnectionStatus }> {
    return this.#call("GET", `/packages/${encodeURIComponent(packageId)}/connection`);
  }

  /** End a package's account connection, at the provider and on the node. What needs it stops being ready at once. */
  revokePackageConnection(packageId: string): Promise<{ connection: ConnectionStatus }> {
    return this.#call("POST", `/packages/${encodeURIComponent(packageId)}/connection/revoke`, {});
  }

  /**
   * Called after this client installs, updates, uninstalls, restores or rolls back a package.
   *
   * The node does not push package changes, so a surface that draws something a package provides — the theme above
   * all, which colours every other surface — would otherwise keep drawing the previous generation until reloaded.
   * Returns the function that stops listening.
   */
  onPackagesChanged(listener: () => void): () => void {
    this.#packageListeners.add(listener);
    return () => {
      this.#packageListeners.delete(listener);
    };
  }

  #changedPackages<T>(call: Promise<T>): Promise<T> {
    return call.then((result) => {
      for (const listener of this.#packageListeners) listener();
      return result;
    });
  }

  /** Every theme this node can draw, with who provides each, and the ones that could not be loaded. */
  themes(): Promise<ThemesResponse> {
    return this.#call("GET", "/themes");
  }

  /** The theme to draw now. A fallback names why it is not the one chosen. */
  appearance(previewRef?: string): Promise<AppearanceResponse> {
    return this.#call("GET", `/appearance${previewRef === undefined ? "" : `?themeRef=${encodeURIComponent(previewRef)}`}`);
  }

  capabilityApprovals(): Promise<{ approvals: PendingCapabilityApprovalView[] }> {
    return this.#call("GET", "/packages/approvals");
  }

  /** Answer one capability question with the digest it was shown under; a changed operation is refused, not granted. */
  decideCapabilityApproval(
    approval: Pick<PendingCapabilityApprovalView, "approvalId" | "operationDigest">,
    decision: "granted" | "denied",
  ): Promise<{ decision: "granted" | "denied"; ref: string; alreadyDecided: boolean }> {
    return this.#call("POST", `/packages/approvals/${encodeURIComponent(approval.approvalId)}/decision`, {
      decision,
      digest: approval.operationDigest,
    });
  }

  /**
   * Decide an install the execution policy asked about. Approving installs exactly the version the approval named,
   * through the node's own install; a refusal (the listing changed, the policy now forbids it, the install failed) is
   * thrown like any other. Either way what is installed may have changed, so the package listeners hear about it.
   */
  decideInstallApproval(
    approval: { approvalId: string; operationDigest: string },
    decision: "granted" | "denied",
  ): Promise<{ decision: "granted" | "denied"; installed?: { packageId: string; version: string }; generationId?: string }> {
    return this.#changedPackages(
      this.#call("POST", `/packages/approvals/${encodeURIComponent(approval.approvalId)}/decision`, {
        decision,
        digest: approval.operationDigest,
      }),
    );
  }

  /**
   * The widget definitions of the packages installed on this node.
   *
   * Each package answers for itself: its widgets, or why this node could not read them. A caller that turned the
   * failure arm into an empty list would be reporting a package as having no widgets when the truth is that nobody
   * here can tell.
   */
  packageWidgets(): Promise<{ packages: InstalledPackageRead[] }> {
    return this.#call("GET", "/packages/widgets");
  }

  /**
   * Install a package a directory listed.
   *
   * Refusals are thrown, like every other call here: a caller that has to tell "refused" from "installed" by reading
   * a field inside a resolved promise is a caller that will one day not. An approval is not a refusal and arrives as
   * an ordinary answer with `code: "APPROVAL_REQUIRED"`, because nothing failed — the next step is a decision.
   *
   * `contentDigest` is what a listing by a path on this machine showed of its files, sent back so the node installs
   * those files or refuses (`DIGEST_MISMATCH`) when they changed since. The node digests the files itself either way.
   */
  installPackage(
    packageId: string,
    version: string,
    contentDigest?: string,
  ): Promise<{
    installed?: { packageId: string; version: string };
    code?: string;
    message?: string;
    approvalId?: string;
    generationId?: string;
    /** What the node actually checked. `digest-only` means the plan was bound to a published digest. */
    verified?: string;
  }> {
    return this.#changedPackages(
      this.#call("POST", "/packages/install", { packageId, version, ...(contentDigest === undefined ? {} : { contentDigest }) }),
    );
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
  async imageObjectUrl(imageId: string, signal?: AbortSignal): Promise<string> {
    const response = await this.#readBytes(`/images/${imageId}`, signal);
    if (!response.ok) {
      throw new GatewayError(response.status, "IMAGE_UNAVAILABLE", "that image could not be read");
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  /**
   * Ask the node for a CSV of a table instance's current view.
   *
   * Only the view travels: the node reads the instance's own dataset and writes the rows itself, so a
   * page cannot hand it rows to put in a file. The bytes come back through the authenticated client
   * because a download link cannot carry the bearer token; the caller turns the blob into a download.
   */
  async exportTable(
    conversationId: string,
    instanceId: string,
    view: TableExportRequest,
  ): Promise<{ blob: Blob; filename: string }> {
    const response = await this.#fetch(
      `${this.#baseUrl}/conversations/${encodeURIComponent(conversationId)}/widgets/${encodeURIComponent(instanceId)}/export`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
        body: JSON.stringify(view),
      },
    );
    if (!response.ok) {
      let code = "EXPORT_FAILED";
      let message = "the table could not be exported";
      try {
        const parsed = (await response.json()) as { code?: unknown; message?: unknown };
        if (typeof parsed.code === "string") code = parsed.code;
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
        // A refusal without a JSON body keeps the generic code and message above.
      }
      throw new GatewayError(response.status, code, message);
    }
    return {
      blob: await response.blob(),
      filename: attachmentFilename(response.headers.get("content-disposition")) ?? "table.csv",
    };
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
   *
   * `signal` aborts the read, for a caller that no longer wants the bytes. A node that does not start answering within
   * `FIRST_RESPONSE_TIMEOUT_MS` fails the read (see `#readBytes`).
   */
  async attachmentObjectUrl(attachmentId: string, signal?: AbortSignal): Promise<string> {
    const response = await this.#readBytes(`/attachments/${encodeURIComponent(attachmentId)}/content`, signal);
    if (!response.ok) {
      throw new GatewayError(response.status, "ATTACHMENT_UNAVAILABLE", "that attachment could not be read");
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  /*
   * Artifacts: files a widget works with, through the node's broker.
   *
   * Every answer is parsed rather than trusted, and every call names the instance the grant belongs to: the node checks
   * the grant again on each one, so none of these is a permission this client holds. No path is ever sent or received.
   */

  #artifactPath(conversationId: string, instanceId: string, rest = ""): string {
    return `/conversations/${encodeURIComponent(conversationId)}/widgets/${encodeURIComponent(instanceId)}/artifacts${rest}`;
  }

  #jobPath(conversationId: string, instanceId: string, jobId: string): string {
    return `/conversations/${encodeURIComponent(conversationId)}/widgets/${encodeURIComponent(instanceId)}/jobs/${encodeURIComponent(jobId)}`;
  }

  async getWidgetJob(conversationId: string, instanceId: string, jobId: string): Promise<JobSnapshot> {
    const body = await this.#call<{ job?: unknown }>("GET", this.#jobPath(conversationId, instanceId, jobId));
    const parsed = jobSnapshotWireSchema.safeParse(body.job);
    if (!parsed.success) throw new GatewayError(502, "MALFORMED_RESPONSE", "the node answered without a usable job snapshot");
    return parsed.data;
  }

  async cancelWidgetJob(conversationId: string, instanceId: string, jobId: string): Promise<void> {
    await this.#call("POST", this.#jobPath(conversationId, instanceId, jobId), {});
  }

  /** The jobs this widget's own bindings started, newest first, as the node owns them. */
  async listWidgetJobs(conversationId: string, instanceId: string): Promise<JobSnapshot[]> {
    const body = await this.#call<{ jobs?: unknown }>(
      "GET",
      `/conversations/${encodeURIComponent(conversationId)}/widgets/${encodeURIComponent(instanceId)}/jobs`,
    );
    const parsed = jobSnapshotWireSchema.array().max(JOB_LIST_LIMIT).safeParse(body.jobs);
    if (!parsed.success) throw new GatewayError(502, "MALFORMED_RESPONSE", "the node answered without a usable job list");
    return parsed.data;
  }

  #browserTokenPath(conversationId: string, instanceId: string, rest = ""): string {
    return `/conversations/${encodeURIComponent(conversationId)}/widgets/${encodeURIComponent(instanceId)}/browser-tokens${rest}`;
  }

  /**
   * Ask the node for a token for the frame mounted under `session`. Person-only on the node: only the chrome that
   * mounted the frame asks, and the value goes to that frame and nowhere else.
   */
  async requestBrowserToken(conversationId: string, instanceId: string, session: string, request: TokenRequest): Promise<BrowserToken> {
    const body = await this.#call<{ token?: { provider?: unknown; token?: unknown; scopes?: unknown; expiresAt?: unknown } }>(
      "POST",
      this.#browserTokenPath(conversationId, instanceId),
      { session, request },
    );
    const parsed = browserTokenWireSchema.safeParse({
      provider: body.token?.provider,
      value: body.token?.token,
      scopes: body.token?.scopes,
      expiresAt: body.token?.expiresAt,
    });
    if (!parsed.success) throw new GatewayError(502, "MALFORMED_RESPONSE", "the node answered without a usable token");
    return parsed.data;
  }

  /** The frame mounted under `session` has gone: the node revokes what it was given. */
  async endBrowserTokens(conversationId: string, instanceId: string, session: string): Promise<void> {
    await this.#call("DELETE", this.#browserTokenPath(conversationId, instanceId, `/${encodeURIComponent(session)}`));
  }

  #artifactRef(body: { artifactRef?: unknown }): ArtifactRef {
    const parsed = artifactRefSchema.safeParse(body.artifactRef);
    if (!parsed.success) throw new GatewayError(502, "MALFORMED_RESPONSE", "the node answered without a usable artifact reference");
    return parsed.data;
  }

  /** Store a file the person chose in host chrome, granted to this instance to read. Person-only on the node. */
  async pickArtifact(input: {
    conversationId: string;
    instanceId: string;
    accept: readonly string[];
    name: string;
    mimeType: string;
    contentBase64: string;
  }): Promise<ArtifactRef> {
    const { conversationId, instanceId, ...body } = input;
    return this.#artifactRef(await this.#call("POST", this.#artifactPath(conversationId, instanceId, "/pick"), body));
  }

  /** An artifact as this instance may see it: refused when its grant is missing, expired or revoked. */
  async describeWidgetArtifact(conversationId: string, instanceId: string, artifactId: string): Promise<ArtifactRef> {
    return this.#artifactRef(await this.#call("GET", this.#artifactPath(conversationId, instanceId, `/${encodeURIComponent(artifactId)}`)));
  }

  async createArtifact(conversationId: string, instanceId: string, input: { mimeType: string; name?: string }): Promise<ArtifactRef> {
    return this.#artifactRef(await this.#call("POST", this.#artifactPath(conversationId, instanceId), input));
  }

  async readArtifactRange(
    conversationId: string,
    instanceId: string,
    artifactId: string,
    range: { offset: number; length: number },
  ): Promise<{ artifactRef: ArtifactRef; contentBase64: string; eof: boolean }> {
    const query = `?offset=${String(range.offset)}&length=${String(range.length)}`;
    const body = await this.#call<{ artifactRef?: unknown; contentBase64?: unknown; eof?: unknown }>(
      "GET",
      this.#artifactPath(conversationId, instanceId, `/${encodeURIComponent(artifactId)}/content${query}`),
    );
    if (typeof body.contentBase64 !== "string" || typeof body.eof !== "boolean") {
      throw new GatewayError(502, "MALFORMED_RESPONSE", "the node answered a read without its bytes");
    }
    return { artifactRef: this.#artifactRef(body), contentBase64: body.contentBase64, eof: body.eof };
  }

  async writeArtifactChunk(
    conversationId: string,
    instanceId: string,
    artifactId: string,
    chunk: { offset: number; contentBase64: string },
  ): Promise<ArtifactRef> {
    return this.#artifactRef(
      await this.#call("POST", this.#artifactPath(conversationId, instanceId, `/${encodeURIComponent(artifactId)}/chunks`), chunk),
    );
  }

  async finalizeArtifact(conversationId: string, instanceId: string, artifactId: string): Promise<ArtifactRef> {
    return this.#artifactRef(
      await this.#call("POST", this.#artifactPath(conversationId, instanceId, `/${encodeURIComponent(artifactId)}/finalize`), {}),
    );
  }

  /** Make a finalized artifact an attachment of the conversation. The person still decides whether to send it. */
  async attachArtifact(
    conversationId: string,
    instanceId: string,
    artifactId: string,
    options: { name?: string | undefined } = {},
  ): Promise<{ artifactRef: ArtifactRef; attachmentRef: AttachmentRef }> {
    const body = await this.#call<{ artifactRef?: unknown; attachmentRef?: unknown }>(
      "POST",
      this.#artifactPath(conversationId, instanceId, `/${encodeURIComponent(artifactId)}/attach`),
      // The widget's proposed name, passed on as it is: the node sanitizes it.
      options.name === undefined ? {} : { name: options.name },
    );
    const attachment = attachmentRefSchema.safeParse(body.attachmentRef);
    if (!attachment.success) throw new GatewayError(502, "MALFORMED_RESPONSE", "the node attached the file but returned no attachment");
    return { artifactRef: this.#artifactRef(body), attachmentRef: attachment.data };
  }

  /** Give back an artifact this instance made. The node refuses one the person chose, or another widget's. */
  async discardArtifact(conversationId: string, instanceId: string, artifactId: string): Promise<void> {
    await this.#call<unknown>("DELETE", this.#artifactPath(conversationId, instanceId, `/${encodeURIComponent(artifactId)}`));
  }

  /** What the node holds for an artifact this principal owns: its reference, never where its bytes are. */
  async describeArtifact(artifactId: string): Promise<ArtifactRef> {
    return this.#artifactRef(await this.#call("GET", `/artifacts/${encodeURIComponent(artifactId)}`));
  }

  /**
   * A finalized artifact's bytes, for the person to look at in host chrome.
   *
   * A blob rather than a URL for the same reason as `attachmentObjectUrl`: the route needs the bearer token.
   */
  async artifactContent(artifactId: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.#readBytes(`/artifacts/${encodeURIComponent(artifactId)}/content`, signal);
    if (!response.ok) throw await this.#binaryRefusal(response, "ARTIFACT_UNAVAILABLE", "that file could not be read");
    return response.blob();
  }

  /**
   * Export a finalized artifact for the person to save. Person-only on the node, and refused on every relay.
   *
   * The name the file is saved under is the one the node settled on, read from the response.
   */
  async exportArtifact(artifactId: string, suggestedName?: string): Promise<{ blob: Blob; filename: string; mimeType: string }> {
    const response = await this.#fetch(`${this.#baseUrl}/artifacts/${encodeURIComponent(artifactId)}/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify(suggestedName === undefined ? {} : { suggestedName }),
    });
    if (!response.ok) throw await this.#binaryRefusal(response, "ARTIFACT_EXPORT_FAILED", "that file could not be exported");
    return {
      blob: await response.blob(),
      filename: attachmentFilename(response.headers.get("content-disposition")) ?? suggestedName ?? "file",
      // The type the node sent the bytes as, which a save names the file by; empty when it sent none.
      mimeType: (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "",
    };
  }

  /**
   * Whether this node shows map tiles, and whose: the provider's origin, attribution and maximum zoom, or `null` with
   * the reason the maps are offline-only when the node gives one.
   *
   * Only what the node's tile policy says to show. Never a path template or a key.
   */
  async mapTilePolicy(): Promise<MapTilePolicyView> {
    const body = (await this.#call("GET", "/map-tiles")) as { provider?: unknown; offline?: unknown };
    const offline = MAP_TILES_OFFLINE_REASONS.find((reason) => reason === body.offline);
    const none: MapTilePolicyView = offline === undefined ? { provider: null } : { provider: null, offline };
    const provider = body.provider;
    if (typeof provider !== "object" || provider === null) return none;
    const { origin, attribution, maxZoom } = provider as Record<string, unknown>;
    if (typeof origin !== "string" || typeof attribution !== "string" || typeof maxZoom !== "number") return none;
    return { provider: { origin, attribution, maxZoom } };
  }

  /** Whether a map tile provider key is saved, and the one origin the node sends it to. Never the value. */
  async mapTileKey(): Promise<{ origin?: string } | null> {
    const body = (await this.#call("GET", "/map-tiles/key")) as { key?: unknown };
    if (typeof body.key !== "object" || body.key === null) return null;
    const origin = (body.key as { origin?: unknown }).origin;
    return typeof origin === "string" ? { origin } : {};
  }

  /**
   * Enter the map tile provider key, bound to the origin the person typed it for. The value travels once, in this
   * request; the answer names the origin only.
   */
  async putMapTileKey(input: { origin: string; value: string }): Promise<{ origin: string }> {
    const body = (await this.#call("PUT", "/map-tiles/key", input)) as { key?: { origin?: unknown } };
    return { origin: typeof body.key?.origin === "string" ? body.key.origin : input.origin };
  }

  /** Remove the map tile provider key. */
  async deleteMapTileKey(): Promise<{ removed: boolean }> {
    const body = (await this.#call("DELETE", "/map-tiles/key")) as { removed?: unknown };
    return { removed: body.removed === true };
  }

  /**
   * One map tile, read through the node's own tile route with the bearer token. The page names a tile by `z/x/y` only;
   * where it comes from is the node's tile policy.
   */
  async mapTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Blob> {
    const response = await this.#fetch(`${this.#baseUrl}/map-tiles/${String(z)}/${String(x)}/${String(y)}`, {
      headers: { authorization: `Bearer ${this.#token}` },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw await this.#binaryRefusal(response, "MAP_TILE_FAILED", "that map tile could not be read");
    return response.blob();
  }

  async #binaryRefusal(response: Response, fallbackCode: string, fallbackMessage: string): Promise<GatewayError> {
    let code = fallbackCode;
    let message = fallbackMessage;
    try {
      const parsed = (await response.json()) as { code?: unknown; message?: unknown };
      if (typeof parsed.code === "string") code = parsed.code;
      if (typeof parsed.message === "string") message = parsed.message;
    } catch {
      // A refusal without a JSON body keeps the fallback code and sentence.
    }
    return new GatewayError(response.status, code, message);
  }
  /**
   * Object URL for the frame a session card was captured at.
   *
   * The same shape as an attachment read, and for the same reason: the route re-checks that the frame belongs to
   * the principal on every read, so this URL is not a capability that outlives the conversation it was issued for.
   * A card shows what the screen looked like when it was captured, never what it looks like now.
   */
  async previewObjectUrl(digest: string): Promise<string> {
    const response = await this.#fetch(`${this.#baseUrl}/previews/${encodeURIComponent(digest)}`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (!response.ok) {
      throw new GatewayError(response.status, "PREVIEW_UNAVAILABLE", "that frame could not be read");
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
    /** Only with `notice.act`: which notice, and which of its actions. */
    noticeId?: string;
    noticeAction?: NoticeOperationId;
    /** Only with `inbox.open`: the notice or waiting item a notification pointed at. */
    inboxTarget?: string;
  }): Promise<AppIntentResolution> {
    const body = {
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.tab === undefined ? {} : { tab: input.tab }),
      ...(input.noticeId === undefined ? {} : { noticeId: input.noticeId }),
      ...(input.noticeAction === undefined ? {} : { noticeAction: input.noticeAction }),
      ...(input.inboxTarget === undefined ? {} : { inboxTarget: input.inboxTarget }),
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
  async deleteConversation(conversationId: string, deletionPermit?: string): Promise<import("@clarkcant/contracts").ConversationDeletionResult> {
    const response = await this.#fetch(`${this.#baseUrl}/conversations/${encodeURIComponent(conversationId)}/delete`, {
      method: "POST",
      headers: {authorization: `Bearer ${this.#token}`, "content-type": "application/json"},
      body: JSON.stringify(deletionPermit === undefined ? {} : {deletionPermit}),
    });
    const body = await response.json();
    const parsed = conversationDeleteResultSchema.safeParse(body);
    if (!parsed.success) throw new GatewayError(response.status, "DELETE_UNCONFIRMED", "The deletion result could not be confirmed. Reload the conversation before trying again.");
    return parsed.data;
  }

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
    return (body.decision ?? { kind: "refused", say: "Nothing was carried out." }) as AppIntentDecision;
  }

  /**
   * Tell the node what this page did with an action the agent asked for.
   *
   * The agent's `control_app` is waiting on this answer to tell the model whether the screen changed, so it is sent
   * for every agent-issued decision, run or not. A node that stopped waiting answers 404, which is not this page's
   * problem to surface: the model was already told the action was unconfirmed.
   */
  async reportHostControl(controlId: string, report: { ran: boolean; say: string }): Promise<void> {
    await this.#fetch(`${this.#baseUrl}/app-intents/host-control/${encodeURIComponent(controlId)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify({ ran: report.ran, say: report.say.slice(0, 2000) }),
    });
  }

  /**
   * Tell the node what a widget's frame on this page answered to an action Clark asked it to perform.
   *
   * Sent for every perform this page was handed, done or not: the node is waiting on it to tell Clark whether the widget
   * changed. A node that stopped waiting answers 404, and Clark was already told the outcome is unknown. A request that
   * never reached the node is sent once more: a report lost to a network blip would otherwise become "unknown" for an
   * action whose answer this page holds. Reporting the same id twice is harmless, the node takes the first.
   */
  async reportWidgetPerform(performId: string, report: WidgetPerformReport): Promise<void> {
    const send = (): Promise<Response> =>
      this.#fetch(`${this.#baseUrl}/app-intents/widget-perform/${encodeURIComponent(performId)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
        body: JSON.stringify(report),
      });
    try {
      await send();
    } catch {
      await send().catch(() => undefined);
    }
  }
  /**
   * Starts one request in a worker of its own, so it happens while the conversation carries on.
   *
   * The node answers 409 when it has no model to run a worker with, and that is a refusal to report rather than an
   * error to hide: the alternative is a caller showing work that will never happen.
   */
  async startBackground(input: {
    conversationId: string;
    text: string;
  }): Promise<{ sessionId: string; state: "queued" | "running"; position?: number }> {
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
        typeof detail.message === "string" ? detail.message : "the background task did not start",
      );
    }
    const body = (await response.json()) as { sessionId?: unknown; state?: unknown; position?: unknown };
    return {
      sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
      state: body.state === "queued" ? "queued" : "running",
      ...(typeof body.position === "number" ? { position: body.position } : {}),
    };
  }

  /**
   * The work running behind the conversation, newest first.
   *
   * Polled rather than streamed, which is the honest description of what this is: a count that a person glances at,
   * not a value anything depends on. A stream for it would be a connection held open to watch a number change.
   */
  async backgroundSessions(): Promise<{
    running: number;
    /** Waiting for a place under the node's limit. */
    queued: number;
    sessions: { sessionId: string; title: string; status: string }[];
  }> {
    const body = (await this.#call("GET", "/background-sessions")) as {
      running?: unknown;
      queued?: unknown;
      sessions?: { sessionId?: unknown; title?: unknown; status?: unknown }[];
    };
    return {
      running: typeof body.running === "number" ? body.running : 0,
      queued: typeof body.queued === "number" ? body.queued : 0,
      sessions: (Array.isArray(body.sessions) ? body.sessions : []).flatMap((entry) =>
        typeof entry?.sessionId === "string" && typeof entry.title === "string"
          ? [{ sessionId: entry.sessionId, title: entry.title, status: typeof entry.status === "string" ? entry.status : "running" }]
          : [],
      ),
    };
  }

  /**
   * What is waiting for the person, and the notices from work that finished while nobody was looking.
   *
   * Parsed against the contract rather than cast: the inbox puts approve buttons on screen, and a button built from a
   * field that was not there is a button that sends the wrong digest. Parsed item by item (`parseInboxResponse`), so
   * one item that does not match leaves the rest readable.
   */
  async inbox(): Promise<InboxRead> {
    return parseInboxResponse(await this.#call("GET", "/inbox"));
  }

  /** The two counts the header mark polls, without the lists behind them. */
  async inboxSummary(): Promise<InboxSummary> {
    return inboxSummarySchema.parse(await this.#call("GET", "/inbox/summary"));
  }

  /** Marks the notices that were on screen as read; with no ids, every notice. */
  markInboxRead(noticeIds?: readonly string[]): Promise<{ marked: number }> {
    return this.#call("POST", "/inbox/read", noticeIds === undefined ? {} : { noticeIds });
  }

  /** Takes one notice out of the inbox. Waiting items cannot be dismissed: hiding a question is not answering it. */
  dismissNotice(noticeId: string): Promise<{ dismissed: true }> {
    return this.#call("POST", `/inbox/notices/${encodeURIComponent(noticeId)}/dismiss`);
  }

  /** Marks notices unread again. Attention state only: it never brings back a dismissed one. */
  markInboxUnread(noticeIds: readonly string[]): Promise<{ marked: number }> {
    return this.#call("POST", "/inbox/unread", { noticeIds });
  }

  /** Undoes a dismissal the node still considers recent (`UNDO_EXPIRED` once it is not). */
  restoreNotice(noticeId: string): Promise<{ restored: true }> {
    return this.#call("POST", `/inbox/notices/${encodeURIComponent(noticeId)}/restore`);
  }

  /** Puts a notice aside until `until` (at most 30 days ahead); it comes back unread then. */
  snoozeNotice(noticeId: string, until: string): Promise<{ snoozedUntil: string }> {
    return this.#call("POST", `/inbox/notices/${encodeURIComponent(noticeId)}/snooze`, { until });
  }

  /** Brings a snoozed notice back now, unread. */
  unsnoozeNotice(noticeId: string): Promise<{ unsnoozed: true }> {
    return this.#call("POST", `/inbox/notices/${encodeURIComponent(noticeId)}/unsnooze`);
  }

  /** Stops reporting the version an update notice names, and anything older; the notice leaves the list. */
  skipNoticeVersion(noticeId: string): Promise<{ skipped: true; name: string; version: string }> {
    return this.#call("POST", `/inbox/notices/${encodeURIComponent(noticeId)}/skip-version`);
  }

  /** Takes a skip back: the version is reported again, and the notice returns while its dismissal can be undone. */
  unskipNoticeVersion(noticeId: string): Promise<{ skipped: false; restored: boolean }> {
    return this.#call("POST", `/inbox/notices/${encodeURIComponent(noticeId)}/unskip-version`);
  }

  /** Takes a skip back from the list of skipped versions, whether or not its notice is still around. */
  removeSkippedVersion(skip: Pick<SkippedVersion, "subjectKind" | "name" | "version">): Promise<{ removed: true }> {
    const path = [skip.subjectKind, skip.name, skip.version].map(encodeURIComponent).join("/");
    return this.#call("DELETE", `/inbox/skipped-versions/${path}`);
  }

  /** Stops notifying about notices of this one's kind; they still arrive in the list, already read. */
  suppressNoticeKind(noticeId: string): Promise<{ suppression: NoticeSuppression }> {
    return this.#call("POST", `/inbox/notices/${encodeURIComponent(noticeId)}/suppress`);
  }

  /** Notifies about this notice's kind again. */
  unsuppressNoticeKind(noticeId: string): Promise<{ unsuppressed: true }> {
    return this.#call("POST", `/inbox/notices/${encodeURIComponent(noticeId)}/unsuppress`);
  }

  /**
   * Record what the person saw of an effect whose outcome was unknown: it took effect, or it did not. `EFFECT_NOT_UNKNOWN`
   * (409) once it was already recorded; a person-only route, so this is only ever called from the person's own screen.
   */
  async reconcileEffect(
    effectId: string,
    outcome: "confirmed" | "failed",
    source: "click" | "chat" | "voice",
  ): Promise<EffectReconcileResponse> {
    const body = await this.#call<unknown>("POST", `/effects/${encodeURIComponent(effectId)}/reconcile`, { outcome, source });
    return effectReconcileResponseSchema.parse(body);
  }

  /** The same, from the inbox's list of quieted kinds, for a kind with no notice left to act from. */
  removeNoticeSuppression(suppressionId: string): Promise<{ removed: true }> {
    return this.#call("DELETE", `/inbox/suppressions/${encodeURIComponent(suppressionId)}`);
  }

  /**
   * Stop one piece of work by the id a listing showed: a background request, a command the model ran, or a task
   * worker. The same stop the agent's `stop_work` reaches, so a button and a sentence end the same way.
   */
  cancelWork(workId: string): Promise<{ workId: string; outcome: "stopped" | "dequeued" | "already-ended" }> {
    return this.#call("POST", `/work/${encodeURIComponent(workId)}/cancel`, {});
  }

  /**
   * Carry out one of a notice's own actions on the node (`POST /inbox/notices/:id/actions/:action`): the same function
   * MCP, `clarkcant api` and both agents reach, which checks the action against what the notice offers now. `outcome`
   * is `approval-required` when an update's install waits for the person's approval; nothing is installed then.
   * `source` says where on this page it was asked for — a press, a typed or a spoken command — for the node's audit.
   */
  async actOnNotice(
    noticeId: string,
    action: NoticeOperationId,
    options: { until?: string; source?: NoticeOperationSource } = {},
  ): Promise<NoticeOperationResponse> {
    const body = await this.#call<unknown>(
      "POST",
      // The action is sent as it is: the node reads that segment raw and refuses an encoded one.
      `/inbox/notices/${encodeURIComponent(noticeId)}/actions/${action}`,
      {
        ...(options.until === undefined ? {} : { until: options.until }),
        ...(options.source === undefined ? {} : { source: options.source }),
      },
    );
    return noticeOperationResponseSchema.parse(body);
  }

  /** Runs background work that failed or was stopped again, once, as new work with the same words. */
  retryWork(workId: string): Promise<{ accepted: true; workId: string; retriedFrom: string; state: "running" | "queued"; position?: number }> {
    return this.#call("POST", `/work/${encodeURIComponent(workId)}/retry`, {});
  }
}
