import { randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  type AppIntent,
  type AppIntentDecision,
  type AppIntentResolution,
  type AttachmentRef,
  type DirectoryEntry,
  type Instant,
  type MessageBlock,
  type MessageRecord,
  type MessageSurface,
  type Principal,
  type ReferenceBlock,
  type ResourceProfile,
  type ResourceRequest,
  COMPOSER_SURFACE_HEADER,
  HOST_WRITTEN_MESSAGE_VERSION,
  type TurnOrigin,
  VIEW_STATE_WRITE_VARIANT,
  WIDGET_PERFORM_HEADER,
  WIDGET_PERFORM_VERSION,
  type WidgetPerformRequest,
  turnOriginOfSurfaceMark,
  turnOriginSchema,
  actionInvocationSchema,
  capabilityRefSchema,
  conversationDeleteRequestSchema,
  commandEnvelopeSchema,
  graphSemanticState,
  nowInstant,
  parseSlashCommand,
  parseTimelinePageQuery,
  semanticProposalSchema,
  surfaceCompositionSpecSchema,
} from "@clarkcant/contracts";
import { readDirectory,
  activeGenerations,
  activePackageVersions,
  installedDirectoryEntries,
  notInstalledAsListedMessage,
  brokeredCapabilities,
  claimLiveOwner,
  decideApproval,
  findIsolatedFrame,
  getActionBinding,
  getInstance,
  handleUserMessage,
  settleApprovedInvokeJob,
  invocationPreflight,
  liveOwnerOf,
  liveStateOf,
  applyWidgetStatePatch,
  FRAME_GRANT_LIFETIME_MS,
  mintFrameGrant,
  pinInstance,
  prepareFrameState,
  readSnapshotForDisplay,
  readyCapabilities,
  releaseLiveOwner,
  sweepExpiredLiveOwners,
  unpinInstance,
  type UnavailableCapability,
} from "@clarkcant/core";
import {
  type Database,
  appendAuditEvent,
  appendMessage,
  claimWorkRunRetry,
  createConversation,
  dismissNotificationByKey,
  findBundleForSnapshot,
  findCompositionByInstance,
  getChannelBinding,
  getConversation,
  getWorkRun,
  instanceIsInConversation,
  latestMessages,
  listConversations,
  nextMessageSequence,
  oneRow,
  recordWidgetProposal,
  releaseWorkRunRetry,
  touchWidgetSemantic,
} from "@clarkcant/storage";

import { type AppIntentDeps, decideAppIntent, mintConfirmation, preferredAppIntentLocale } from "../app-intents.ts";
import { deleteConversation } from "../application/conversation-delete.ts";
import { readThemeRegistry, themeRegistryDeps } from "../application/themes.ts";
import { activeGenerationWithResolvedGrants } from "../application/package-install.ts";
import { NOTHING_TO_STOP_SAY, type StopTurnSource, stopTurnOnNode } from "../application/stop-turn.ts";
import { bindingAvailability } from "../application/action-bindings.ts";
import { settleActionEffect } from "../application/action-effects.ts";
import {
  type WidgetPerformer,
  actionLedgerHooks,
  invokeWidgetAction,
  isWidgetPerformPayload,
  performReceipt,
  runApprovedPerform,
  settleCallOutcome,
  writeWidgetViewState,
} from "../application/widget-actions.ts";
import { resolveAttachmentRefs } from "../attachments.ts";
import {
  type ChannelToolPayload,
  canonicalJson,
  channelToolDigest,
  channelToolWords,
  parseChannelToolPayload,
} from "../channels/channel-tool-gate.ts";
import { resolveComposerReferences } from "../composer-references.ts";
import { type InteractionDeps, answerQuestion, askQuestionAgain, cancelQuestion } from "../interactions.ts";
import { resolveLiveSections } from "../mini-app-data.ts";
import { packageResourceGrant } from "../package-resources.ts";
import { resourceProfilePolicy } from "../service-host.ts";
import { WorkAbort, nodeWork } from "../work-supervisor.ts";
import { type HostText, hostText, ownerHostText } from "../host-text.ts";
import { decideTurnAction, decisionTimeoutMsFromEnv, searchDecisionBudget } from "../jev-decider.ts";
import { type OwnedResources, ownedResources } from "../preflight.ts";
import { markProjectUsed, projectContext, resolveProject } from "../project-finder.ts";
import { initialPrompt } from "../project-session.ts";
import { retryableBackgroundRun } from "../notice-actions.ts";
import { tryRecordNodeNotice } from "../notices.ts";
import { receiptForModel, runApprovedCommand } from "../run-command.ts";
import {
  capabilityInvokeDeps,
  isCapabilityPayload,
  runApprovedCapability,
} from "../application/capability-invoke.ts";
import { isMapTilePolicyPayload, runApprovedMapTilePolicy } from "../application/map-tile-policy.ts";
import {
  deniedWidgetArtifactWriteLabel,
  isWidgetArtifactWritePayload,
  recordDeniedWidgetArtifactWrite,
  runApprovedWidgetArtifactWrite,
} from "../application/machine-artifact-writes.ts";
import { type NodeServices, buildTimeline } from "../services.ts";
import { answerSlashCommand, slashCommandBlocks, type SlashCommandAnswer } from "../application/slash-commands.ts";
import { indexMessages, textOfMessage } from "../session-search.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";
import { exportTableCsv } from "./table-export.ts";

/**
 * The conversation family: the thread, its messages, its turns, its questions and its approvals, plus
 * the raw command envelope the durable path sends.
 *
 * The route owns the HTTP: which method and shape is accepted, which status a refusal deserves, and
 * the streaming envelope a turn is reported with. Everything it needs is a parameter, and `services` is
 * narrowed to the fields in `ConversationServices` rather than taken as the whole bundle: those fields were
 * injected at composition, so this is not a lookup, and a module handed every seam can reach one its
 * interface never named.
 *
 * The order the routes were dispatched in is unchanged; the gateway calls the two entry points below at
 * the positions the branches used to occupy.
 */

/**
 * The node services the conversation family reads, named one field at a time.
 *
 * The seven are every service these routes touch: the node itself, the conductor that owns widget instances, the
 * search service a written message is indexed into, the selector wiring that decides what to do with a message that
 * arrives mid-turn, the two project seams a session start needs, and the turn control a background request runs
 * through. Nothing else of the bundle is here, so a route cannot start reaching for a service this file never asked
 * for.
 */
export type ConversationServices = Pick<
  NodeServices,
  "runtime" | "conductor" | "search" | "jev" | "projects" | "projectSessions" | "turnControl" | "hostControl" | "widgetPerforms" | "providerAuth"
>;

/** What the conversation routes need. */
export interface ConversationRouteDeps {
  services: ConversationServices;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
  /** Injected so conversation identifiers are deterministic in tests. */
  newConversationId?: () => string;
}

/** What the durable command envelope needs: the node's own identity, and nothing else. */
export interface RawCommandRouteDeps {
  services: Pick<NodeServices, "runtime">;
  request: GatewayRequest;
  at: () => string;
}

/** The HTTP status each refused state write answers with. */
const STATE_REFUSAL_STATUS = {
  INSTANCE_UNKNOWN: 404,
  NOT_AUTHORIZED: 403,
  INSTANCE_OFFLINE: 410,
  STATE_READ_ONLY: 409,
  STATE_REVISION_STALE: 409,
  STATE_SCHEMA_INVALID: 422,
  STATE_TOO_LARGE: 413,
} as const;

/**
 * Find the package code a frame-rendered widget runs, by its definition id.
 *
 * Shared by the live route and the state route so both hold the widget to the same definition: the one the frame
 * the user is looking at was mounted from.
 */
/** The granted profile's offscreen behaviour for a frame; anything not granted keeps the default, which suspends. */
function frameOffscreen(
  services: Pick<NodeServices, "runtime" | "serviceHost">,
  packageId: string,
  request: ResourceRequest | undefined,
): ResourceProfile["offscreen"] {
  const grant = packageResourceGrant({
    packageId,
    request,
    serviceHost: services.serviceHost,
    policy: resourceProfilePolicy({
      db: services.runtime.db,
      principalId: services.runtime.identity.ownerPrincipalId,
      now: nowInstant,
    }),
  });
  return grant.status === "granted" ? grant.profile.offscreen : "suspend";
}

export function locateIsolatedFrame(runtime: { dataDir: string; db: Database; identity: { nodeId: string } }, widgetId: string) {
  const index = readDirectory({ env: process.env, dataDir: runtime.dataDir });
  /*
   * The version this node is running comes first. A directory lists every version it knows, and after a rollback the
   * newest listing is not what is installed: the frame must load the code of the active generation, or rolling back
   * would change the label and not the widget.
   */
  const node = { db: runtime.db, nodeId: runtime.identity.nodeId };
  const active = activePackageVersions(node);
  const generations = activeGenerations(node);
  const activePackages = new Set([...active].map((key) => key.slice(0, key.lastIndexOf("@"))));
  // A local install is recorded under its path, not the manifest id the directory lists it by.
  const idsOf = (entry: DirectoryEntry): string[] =>
    entry.source.kind === "local" ? [entry.packageId, entry.source.path] : [entry.packageId];
  const isActive = (entry: DirectoryEntry) => idsOf(entry).some((id) => active.has(`${id}@${entry.version}`));
  const otherVersionActive = (entry: DirectoryEntry) =>
    !isActive(entry) && idsOf(entry).some((id) => activePackages.has(id));
  const cacheRoot = join(runtime.dataDir, "package-cache");
  /*
   * A local package an active generation installed is read from that generation's snapshot, never from its path. A
   * listing that no longer names what that generation installed is withheld, not read from the path.
   */
  const installed = installedDirectoryEntries(index.kind === "configured" ? index.entries : [], generations, cacheRoot);
  const { entries } = installed;
  const found = findIsolatedFrame({
    /*
     * While a version of a package is active, only that version's code runs: after a rollback a definition that exists
     * only in the newer version has no code here, rather than the retired version's. With no version active (never
     * installed, or uninstalled) the listing is still what describes the widget, and an offline instance is shown from
     * it as text.
     */
    directory: [...entries.filter(isActive), ...entries.filter((entry) => !isActive(entry) && !otherVersionActive(entry))],
    widgetId,
    // A git/npm entry this node has fetched is served from its cache path exactly like a local package (H1); the
    // cache root here must match the one the install route fetched into.
    cacheRoot,
  });
  if (!found.ok) {
    // A widget whose running package is withheld is refused as not installed, rather than reported as unknown.
    const held = installed.withheld.find(({ generation }) => generation.widgetIds?.includes(widgetId) === true);
    if (found.code === "NO_SUCH_WIDGET" && held !== undefined) {
      return {
        ok: false as const,
        code: "NOT_INSTALLED" as const,
        message: notInstalledAsListedMessage(held.entry.packageId, held.generation.version),
      };
    }
    return found;
  }
  /*
   * Whether the code found is the version this node is running, rather than a listing kept to describe an instance
   * whose package is gone. A frame is still described either way; only a running package is given anything new.
   */
  const { entry: owner, ...located } = found;
  const running = isActive(owner);
  /*
   * The active generation of the package the definition was read from: that same directory entry, by package identity
   * and version. Widget ids are not namespaced, so this, not which generation lists the id, is what says whose widget it is.
   */
  const generationId = running
    ? generations.find((generation) => idsOf(owner).includes(generation.packageId) && generation.version === owner.version)?.generationId
    : undefined;
  return { ...located, active: running, generationId };
}

/**
 * Resolve what a live composed surface shows right now.
 *
 * The rows are read here rather than left to the client to fetch per dataset reference, so the live
 * view and the snapshot bundle are the same shape and the client has one render path. The state is
 * read under the same call, which is what lets a control start at the value the server holds
 * instead of at the default in the spec.
 */
/** One binding as a frame's live view lists it, plus the registry refusal it is merged into the notice from. */
interface FrameBindingRow {
  actionBindingId: string;
  label: string;
  effectCategory: string;
  bindingDigest: string;
  capabilityRef?: string;
  available?: boolean;
  unavailableReason?: string;
  contextRefs?: string[];
  unavailable: UnavailableCapability | undefined;
}

/**
 * Mark a widget as changed from this conversation, after the change was stored.
 *
 * Nothing is built and no model is called: the next turn works out what the change meant. A failure to record the touch
 * does not undo or fail the change the person made; the widget is only left out of the next turn's note.
 */
function touchWidget(db: Database, conversationId: string, instanceId: string): void {
  try {
    touchWidgetSemantic(db, { instanceId, conversationId, at: nowInstant() });
  } catch {
    // Deliberately quiet: see above.
  }
}

function resolveLiveWidget(
  services: Pick<NodeServices, "runtime" | "conductor" | "serviceHost" | "frameGrantFixture">,
  conversationId: string,
  instanceId: string,
  principalId: string,
): GatewayResponse {
  const { runtime } = services;
  const instance = getInstance(services.conductor, instanceId);
  if (instance === undefined) {
    return fail(404, "RESOURCE_NOT_FOUND", "that instance is not on this node");
  }
  if (instance.ownerPrincipalId !== principalId) {
    return fail(403, "NOT_AUTHORIZED", "that instance belongs to another principal");
  }

  /*
   * A widget that runs in its own frame has no composition to resolve.
   *
   * Its code is the package's, so what a client needs is the URL to mount it from and the bindings it may invoke —
   * and that is what this returns instead. The check comes first because it is what decides which of the two shapes
   * this route answers with, and a client that had to guess would be a client that guessed wrong once.
   */
  const isolated = locateIsolatedFrame(runtime, instance.definitionRef.id);
  // The running package's listing changed under it: neither its installed copy nor the path is served (409, as the
  // frame and files routes answer), and the instance and its state are kept for the reinstall.
  if (!isolated.ok && isolated.code === "NOT_INSTALLED") return fail(409, isolated.code, isolated.message);
  if (isolated.ok) {
    /*
     * What the frame is actually brokered is the *granted* set, not the requested one.
     *
     * `isolated.requestedCapabilities` is the manifest's own request — metadata a package wrote about itself,
     * never an authority (`packages/core/src/widget-package.ts`). The generation this node actually activated
     * carries the capabilities a real consent decision granted (`install-consent.ts`, wired in
     * `application/package-install.ts`), narrower than the request whenever the policy asked or refused one. A
     * frame with no active generation on record (should not happen for a package this node just resolved a frame
     * for, but is not proven impossible) is brokered nothing rather than the unchecked request.
     */
    // `activeGenerationWithResolvedGrants` rather than `activeGeneration` directly: a generation activated
    // before `grantedCapabilities` existed on the schema carries a `null` marker (migration 22, N4), and this is
    // exactly the read this generation's frame grant depends on — resolving it here is what "a frame picks up
    // its grant on next mount" means for a legacy generation, not only for one grant/deny just resolved.
    const generation = activeGenerationWithResolvedGrants(
      { runtime: { db: runtime.db, identity: runtime.identity, dataDir: runtime.dataDir }, conductor: services.conductor },
      isolated.packageId,
    );
    const grantedForFrame = brokeredCapabilities(isolated.requestedCapabilities, generation?.grantedCapabilities);
    // Granted is permission; the registry says whether each one can run now. A granted capability still missing its
    // connection is held back and named, rather than handed to a frame that would find out on first use.
    const preflight = (ref: string): ReturnType<typeof invocationPreflight> => {
      const parsed = capabilityRefSchema.safeParse(ref);
      if (!parsed.success) return { ready: false, code: "CAPABILITY_MISSING", message: `${ref} is not a capability reference` };
      return invocationPreflight({ db: runtime.db, nodeId: runtime.identity.nodeId }, parsed.data);
    };
    const capabilities = readyCapabilities(grantedForFrame, preflight);
    /*
     * The bindings the instance holds, each with the digest the client must send back — and, for a binding that calls
     * a service capability, whether that capability can run right now.
     *
     * Read from the registry at the same moment as the grants above, so a service that crashed, or a node with no
     * container engine, shows the binding disabled with the registry's own reason instead of a button that fails when
     * pressed. The widget keeps rendering either way: a service being down is not the widget being broken.
     */
    const bindings = instance.actionBindingIds.flatMap((bindingId): FrameBindingRow[] => {
      const binding = getActionBinding(services.conductor, bindingId);
      // An action the widget offers to Clark is not a binding its frame presses: the frame runs it when asked
      // (`actions.perform@1`), and a press naming it is refused. So it is not announced to the frame as one.
      if (binding === undefined || binding.proposal.kind === "perform") return [];
      const base = {
        actionBindingId: binding.actionBindingId,
        label: binding.label,
        effectCategory: binding.effectCategory,
        bindingDigest: binding.bindingDigest,
      };
      const ref = binding.proposal.kind === "invoke" ? binding.proposal.capabilityRef : undefined;
      const checked = bindingAvailability(
        { db: runtime.db, nodeId: runtime.identity.nodeId, serviceHost: services.serviceHost },
        binding,
      );
      const named = {
        ...(ref === undefined ? {} : { capabilityRef: ref }),
        // What an agent press reads, so the frame's host waits for the widget's description before such a press.
        ...(binding.proposal.kind === "agent" && binding.proposal.contextRefs.length > 0
          ? { contextRefs: [...binding.proposal.contextRefs] }
          : {}),
      };
      return [
        checked.available
          ? { ...base, ...named, available: true, unavailable: undefined }
          : {
              ...base,
              ...named,
              available: false,
              unavailableReason: checked.reason,
              // Only a capability is named in the frame's "not connected" notice; a workflow the node cannot run is
              // the binding's own reason, shown on the binding.
              unavailable: ref === undefined ? undefined : { ref, code: checked.code, message: checked.reason },
            },
      ];
    });
    const unavailableCapabilities = [...capabilities.unavailable];
    for (const binding of bindings) {
      if (binding.unavailable !== undefined && !unavailableCapabilities.some((entry) => entry.ref === binding.unavailable?.ref)) {
        unavailableCapabilities.push(binding.unavailable);
      }
    }
    /*
     * The durable state the frame starts from, migrated here — on the node, once, before any code of this version
     * reads it. State that could not be migrated, or that a newer version wrote, is still returned so the widget can
     * show it; `readOnly` and `stateStatus` are what stop anyone writing over it.
     */
    const frameState = prepareFrameState(services.conductor, { instanceId, definition: isolated.definition });

    /*
     * An instance whose package was uninstalled has no code to run. It still has a text alternative and the state it
     * kept, and those are what come back: no frame to mount, no binding to invoke, and a status that says why, so the
     * conversation shows what the widget last said instead of an empty box or a frame that fails to load.
     */
    if (frameState.status.kind === "offline") {
      return json(200, {
        kind: "isolated-frame",
        instanceId,
        revision: instance.revision,
        readOnly: true,
        stateRevision: frameState.stateRevision,
        stateVersion: frameState.stateVersion,
        state: frameState.state,
        stateStatus: frameState.status,
        ephemeralStateKeys: [],
        frame: null,
        textFallback: isolated.definition.textFallback,
        bindings: [],
        props: instance.props,
      });
    }

    /*
     * How long the URL below works. The production lifetime, or the frame-grant fixture's shorter one on a node started
     * with it; never longer than the production lifetime, whatever the fixture holds.
     */
    const grantLifetimeMs = Math.min(services.frameGrantFixture?.lifetimeMs() ?? FRAME_GRANT_LIFETIME_MS, FRAME_GRANT_LIFETIME_MS);

    return json(200, {
      kind: "isolated-frame",
      instanceId,
      revision: instance.revision,
      readOnly: frameState.status.kind !== "writable",
      stateRevision: frameState.stateRevision,
      stateVersion: frameState.stateVersion,
      state: frameState.state,
      stateStatus: frameState.status,
      ephemeralStateKeys: isolated.definition.ephemeralStateKeys ?? [],
      frame: {
        /*
         * Relative to this node, served from the package path so the widget's own relative imports resolve, and
         * carrying a grant: the frame is loaded by navigation, which cannot carry a bearer token, so this is what
         * lets it fetch its own document — and only its own. Short-lived (`FRAME_GRANT_LIFETIME_MS`) so a URL somebody
         * copied stops working.
         */
        url: `/frame/${mintFrameGrant({
          instanceId,
          packageId: isolated.packageId,
          version: isolated.version,
          secret: runtime.identity.localToken,
          expiresAtMs: Date.parse(nowInstant()) + grantLifetimeMs,
        })}/${isolated.entryPath}`,
        /*
         * How long, from this answer, the URL's grant lasts. A frame kept on screen outlives it, and a client that loads
         * the document again after that — a remount, a reload — has to re-read for a fresh URL first rather than be
         * refused. Carried beside the URL rather than read out of it, so the client never parses a credential, and as a
         * duration rather than an instant, so a client whose clock disagrees with the node's still gets it right.
         */
        urlExpiresInMs: grantLifetimeMs,
        /*
         * Which document the URL loads, without the grant. The grant changes on every read, so a client that compared
         * URLs would remount a running widget each time it re-read availability; this changes only when the code does.
         */
        document: `${isolated.packageId}@${isolated.version}/${isolated.entryPath}`,
        isolation: isolated.isolation,
        grantedCapabilities: capabilities.ready,
        unavailableCapabilities,
        allowedOrigins: isolated.allowedOrigins,
        /*
         * What the frame does out of view under its package's granted profile. Only `authorized-playback` lets the
         * person keep it running offscreen, from host chrome; every other answer unmounts it as before.
         */
        offscreen: frameOffscreen(services, isolated.packageId, isolated.resources),
        /*
         * The providers this widget's package declared browser tokens from, so host chrome offers `tokens@1` only to a
         * frame that may use it. Every request is still decided by the node against the declaration.
         */
        ...(isolated.browserTokens.length === 0 ? {} : { browserTokens: isolated.browserTokens.map((entry) => entry.provider) }),
        /*
         * The actions the package declared it offers to Clark, by name, so host chrome offers `actions.perform@1` only to
         * a frame that has some. Which one runs, with what input, is still decided on the node before the frame is asked.
         */
        ...((isolated.definition.offeredActions ?? []).length === 0
          ? {}
          : { offeredActions: (isolated.definition.offeredActions ?? []).map((offered) => offered.name) }),
      },
      /*
       * The same shape the composition path returns, and for the same reason: an invocation is re-authorized
       * against the instance, the digest and the revision, so a client that could not send the digest it displayed
       * could not be authorized at all. A frame names one of these ids and nothing else.
       */
      bindings: bindings.map(({ unavailable: _unavailable, ...binding }) => binding),
      /*
       * The props the widget was created with. The frame cannot read them from anywhere else: it has no session, no
       * storage and no route of its own, so what it is showing has to arrive with the thing that mounts it.
       */
      props: instance.props,
    });
  }

  const composition = findCompositionByInstance(runtime.db, instanceId, principalId);
  if (composition === undefined) {
    // A bundled composition is a state, not an error: the instance exists and the client falls back
    // to a single-widget render or to the message's text alternative.
    return fail(404, "RESOURCE_NOT_FOUND", "that instance has no composition on this node");
  }

  const state = liveStateOf(services.conductor, instanceId);
  const owner = liveOwnerOf(services.conductor, instanceId);
  const resolved = resolveLiveSections(
    {
      db: runtime.db,
      nodeId: runtime.identity.nodeId,
      dataDir: runtime.dataDir,
      now: () => nowInstant() as never,
      newId: services.conductor.newId,
    },
    {
      principalId: principalId as never,
      composition,
      state: state?.body ?? {},
      locale: services.conductor.locale?.(principalId) ?? "vi",
    },
  );

  // Bindings are re-read here rather than taken from the stored spec, because a stored document
  // must not be able to introduce an action after the fact. The digest travels with each one so a
  // client can send back exactly what it displayed.
  const bindings = instance.actionBindingIds.flatMap((bindingId) => {
    const binding = getActionBinding(services.conductor, bindingId);
    if (binding === undefined) return [];
    const spec = composition.actions.find((action) => action.actionBindingId === bindingId);
    if (spec === undefined) return [];
    return [
      {
        actionBindingId: binding.actionBindingId,
        sectionId: spec.sectionId,
        label: binding.label,
        kind: binding.proposal.kind,
        effectCategory: binding.effectCategory,
        bindingDigest: binding.bindingDigest,
      },
    ];
  });

  return json(200, {
    kind: "composition",
    compositionId: composition.compositionId,
    // A live surface never mints its own authority: the bindings below are references, and every
    // invocation is re-authorized against the instance, the digest and the current revision.
    readOnly: false,
    spec: composition,
    bindings,
    sections: resolved.sections,
    availability: resolved.availability,
    revision: instance.revision,
    stateRevision: state?.revision ?? 0,
    state: state?.body ?? {},
    /*
     * The graph's values as the node holds them, bounded and typed, so a client or an agent turn reads what the surface
     * is showing without re-deriving it from a page. Data about the view, never instructions.
     */
    semanticState: graphSemanticState(composition.graph, state?.body.graph) ?? null,
    ownerSurface: owner?.surface ?? null,
    capturedAt: null,
    tombstone: null,
    period: resolved.period,
    timezone: resolved.timezone,
    conversationId,
  });
}

/**
 * Where a command may run, computed at the moment it is decided.
 *
 * Both halves are read fresh rather than captured when the request was made: an approval can sit for a
 * quarter of an hour, and a project that was indexed then may not be known now.
 */
export function blocksOfConversation(
  services: Pick<NodeServices, "runtime">,
  conversationId: string,
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  // The newest messages, read straight from storage. A timeline is the page a reader sees - the first 200 messages
  // with snapshots and metadata attached - and a card still waiting for a decision sits at the other end of a long
  // conversation, where that page never reached: its approval was then consumed and its payload not found.
  // SAFETY: a stored message's blocks are the node's own writes, and every route that renders a block validates
  // the ones claiming host ownership before drawing it.
  const messages = latestMessages(services.runtime.db, conversationId, OPEN_ITEM_MESSAGES) as unknown as {
    blocks?: Record<string, unknown>[];
  }[];
  for (const message of messages) blocks.push(...(message.blocks ?? []));
  return blocks;
}

/**
 * How far back in one conversation a card still waiting for an answer is looked for.
 *
 * The same window the inbox scans across the whole node, so any card the inbox offers is one this conversation's
 * decide and answer routes can find: node-wide newest messages are a superset of one conversation's newest.
 */
const OPEN_ITEM_MESSAGES = 2000;

/**
 * The interaction manager for one conversation.
 *
 * Built per conversation rather than once per node, because every question belongs to a conversation: the
 * durable state is that conversation's transcript, and an answer only means something against the card that
 * asked. The two halves are the ones the approval route already uses — read the blocks, append a message — so
 * a question and an approval cannot end up disagreeing about what the timeline is.
 */
export function interactionDepsFor(
  services: Pick<NodeServices, "runtime" | "conductor" | "search">,
  conversationId: string,
): InteractionDeps {
  return {
    conversationId,
    now: () => nowInstant(),
    newId: services.conductor.newId,
    // SAFETY: the timeline hands back a message's blocks as unparsed JSON, exactly as it does for the approval
    // route above. The node wrote these rows, and the manager reads only `question-card` and `tool-activity`
    // fields after checking `type`, so a block of any other shape is skipped rather than trusted.
    blocks: () => blocksOfConversation(services, conversationId) as unknown as MessageBlock[],
    append: ({ at, blocks }) => {
      appendHostReply(services, { conversationId, blocks, at });
    },
    language: () => preferredAppIntentLocale({ db: services.runtime.db, now: nowInstant }, services.runtime.identity.ownerPrincipalId),
  };
}

/**
 * Record an answer and open the turn it starts.
 *
 * One function, called by the HTTP route and by the voice session, because "voice and a click mean the same thing"
 * has to be structurally true rather than a claim two code paths keep in step. What a caller can differ on is the
 * answer's shape: an utterance has already been matched against the question's own options before it arrives here.
 */
export async function answerQuestionForNode(
  services: Pick<NodeServices, "runtime" | "conductor" | "search">,
  input: {
    conversationId: string;
    principal: { principalId: string; kind: "user"; nodeId: string };
    questionId: string;
    text?: unknown;
    optionIds?: unknown;
    confirmed?: unknown;
    viaVoice?: boolean;
    at: Instant;
    /** Who answered (`TurnOrigin`), decided by the caller from the path the answer came on. Absent is the person. */
    origin?: TurnOrigin;
  },
): Promise<{ ok: true; note: string } | { ok: false; code: string; message: string }> {
  const answered = answerQuestion(interactionDepsFor(services, input.conversationId), input.questionId, {
    text: input.text,
    optionIds: input.optionIds,
    confirmed: input.confirmed,
    ...(input.viaVoice === true ? { viaVoice: true } : {}),
  });
  if (!answered.ok) return { ok: false, code: answered.code, message: answered.message };

  /*
   * What the person sees, and what the model gets.
   *
   * The visible message states the answer; the note carries the same sentence plus the instruction to carry on.
   * The note travels to the model rather than into the transcript, for the same reason the command receipt does:
   * the transcript already says what happened, and saying it twice is what made a reader complain about a receipt
   * printed twice.
   */
  await handleUserMessage(services.conductor, {
    conversationId: input.conversationId as never,
    principal: input.principal as never,
    text: answered.note,
    note: `${answered.note}\n\nĐây là câu trả lời của người dùng cho câu hỏi bạn đã hỏi. Hãy tiếp tục công việc đang làm dở.`,
    at: input.at,
    origin: input.origin ?? "person",
  });
  return { ok: true, note: answered.note };
}

/**
 * The folders this node owns, for the path that runs an approved command.
 *
 * The same set the guarded path uses — configured workspace roots, the node's own data directory, and the directory
 * the operator launched it from — because asking a person is not a reason to widen what this node may touch.
 */
export function ownedResourcesFor(services: Pick<NodeServices, "runtime" | "projects">): OwnedResources {
  return ownedResources([...services.projects.roots(), services.runtime.dataDir, process.cwd()]);
}

/**
 * Append a message the host wrote — a question, a notice, or the receipt of an operation.
 * * *
 * `blocks` is what a receipt needs: a command's outcome is a tool record and an evidence line, not a
 * paragraph. `text` stays because most host replies are one sentence, and a caller that has to build a
 * text block by hand is a caller that will eventually build it wrong.
 */
/**
 * Starts one request in a worker of its own, and reports it when the worker settles.
 *
 * One implementation for the two ways this happens: the decider choosing background for a message sent mid-turn, and a
 * person asking for one from a selection. At module scope rather than inside the request handler, because the handler
 * has blocks that do not contain each other and a declaration in one of them is invisible from another - which is what
 * a first attempt at this did.
 *
 * Admission is the node's supervisor's (`work-supervisor.ts`): it runs the request now, queues it behind the node's
 * limit, or refuses it in words when the queue is full. However the run ends it comes back into the conversation as a
 * message, because background work that ends in silence is worse than work that never started — except a run the
 * node's own shutdown interrupted, which the next boot reports instead (`work-recovery.ts`), so the conversation is
 * not told twice.
 */
export function startBackgroundWork(
  services: Pick<NodeServices, "runtime" | "conductor" | "search" | "turnControl">,
  principal: Principal,
  at: () => Instant,
  conversationId: string,
  text: string,
  options: {
    workId?: string;
    attempt?: number;
    /** What the run is called where a person sees it, when the request text is not that — a button's label. */
    title?: string;
    /** The token budget the request set, handed to the worker. */
    maxTokens?: number;
    /**
     * Material the host read for this request, sent to the worker after the request as data, never as part of it.
     *
     * Not part of the stored request text, so a retry of this run asks again without it: the screen it was read from
     * may have changed, and a retry is a new request rather than a replay of old context.
     */
    data?: string;
  } = {},
):
  | { sessionId: string; state: "running" | "queued"; position?: number }
  | { refusal: string; busy?: true } {
  // Read when each line is written, so a report that lands after the person switched language reads in the new one.
  const say = (): HostText["background"] => ownerHostText(services.runtime).background;
  const control = services.turnControl;
  if (control === undefined) return { refusal: say().noModel };

  const title = (options.title ?? text).replace(/\s+/g, " ").trim().slice(0, 120);
  const maxTokens = options.maxTokens;
  const data = options.data;
  const submitted = nodeWork().submitBackground({
    ...(options.workId === undefined ? {} : { workId: options.workId }),
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
    conversationId,
    title,
    requestText: text,
    onDequeued: () => {
      appendHostReply(services, {
        conversationId,
        text: say().dequeued(title),
        at: at(),
      });
    },
    run: async (signal, workId) => {
      try {
        const said = await control.runInBackground({
          workId,
          conversationId,
          principal,
          text,
          signal,
          ...(maxTokens === undefined ? {} : { maxTokens }),
          ...(data === undefined ? {} : { data }),
        });
        signal.throwIfAborted();
        if (said !== "") appendHostReply(services, { conversationId, text: said, at: at() });
        // The result is the message above; the notice is the pointer to it, for a person who is not looking at this
        // conversation. Keyed by the work, so this run has one notice whichever branch writes it.
        tryRecordNodeNotice(services, {
          sourceKind: "background",
          category: "result",
          severity: "success",
          title: say().doneNotice(title),
          ...(said === "" ? {} : { body: said }),
          conversationId,
          subject: { kind: "background-work", workId, conversationId },
          dedupKey: `background:${workId}`,
          at: at(),
        });
      } catch (cause) {
        const reply = backgroundEndingReply(signal, cause, title, ownerHostText(services.runtime));
        if (reply !== undefined) {
          appendHostReply(services, { conversationId, text: reply, at: at() });
          // A stop the person asked for is information, not a failure; a shutdown is reported by the next boot.
          const stopped = signal.aborted && signal.reason instanceof WorkAbort && signal.reason.cause_ === "stopped";
          tryRecordNodeNotice(services, {
            sourceKind: "background",
            category: "result",
            severity: stopped ? "info" : "error",
            title: stopped ? say().stoppedNotice(title) : say().failedNotice(title),
            body: reply,
            conversationId,
            subject: { kind: "background-work", workId, conversationId },
            dedupKey: `background:${workId}`,
            at: at(),
          });
        }
        throw cause;
      }
    },
  });
  if (!submitted.accepted) {
    const busy = submitted.running.map((view) => `“${view.title}”`).join("; ");
    const refusal = submitted.reason === "closing" ? say().closing : say().queueFull(submitted.running.length, submitted.queued);
    return { refusal: busy === "" ? refusal : say().alsoRunning(refusal, busy), busy: true };
  }
  return {
    sessionId: submitted.workId,
    state: submitted.state,
    ...(submitted.position === undefined ? {} : { position: submitted.position }),
  };
}

export type RetryBackgroundOutcome =
  | { ok: true; workId: string; retriedFrom: string; state: "running" | "queued"; position?: number }
  | {
      ok: false;
      status: 404 | 409 | 429;
      code: "WORK_NOT_FOUND" | "WORK_NOT_RETRYABLE" | "ALREADY_RETRIED" | "CONVERSATION_GONE" | "BACKGROUND_BUSY" | "BACKGROUND_UNAVAILABLE";
      message: string;
    };

/**
 * Run a background request again, from its notice's "Try again": the same words, in the same conversation, as a new
 * piece of work with an id of its own.
 *
 * Only a background run that ended without a result — failed, stopped or cut off by a restart — and whose words were
 * kept. A background worker has read-only tools and no project root (`work-supervisor.ts`), so running it again changes
 * nothing outside this node, which is why no approval is asked: this is the person asking for the same thing again.
 * Once per run: the run is claimed before the new one starts (`claimWorkRunRetry`), so a second press or a second
 * surface is told it was already done, and a claim whose run the node refused (busy) is given back. The old run's
 * notice is dismissed, because the new run reports for itself.
 */
export function retryBackgroundWork(
  services: Pick<NodeServices, "runtime" | "conductor" | "search" | "turnControl">,
  principal: Principal,
  at: () => Instant,
  workId: string,
): RetryBackgroundOutcome {
  const { db } = services.runtime;
  const say = ownerHostText(services.runtime).background;
  const run = getWorkRun(db, workId);
  if (run === undefined) {
    return { ok: false, status: 404, code: "WORK_NOT_FOUND", message: say.retryMissing };
  }
  if (!retryableBackgroundRun(run) || run.requestText === undefined || run.conversationId === undefined) {
    return { ok: false, status: 409, code: "WORK_NOT_RETRYABLE", message: say.retryNotRetryable };
  }
  if (run.retriedAs !== undefined) {
    return { ok: false, status: 409, code: "ALREADY_RETRIED", message: say.retryAlreadyDone };
  }
  const conversationId = run.conversationId;
  if (getConversation(db, conversationId) === undefined) {
    return { ok: false, status: 409, code: "CONVERSATION_GONE", message: say.retryConversationGone };
  }
  // The same shape the supervisor gives a new run.
  const retryWorkId = `bg-${randomBytes(6).toString("hex")}`;
  if (!claimWorkRunRetry(db, workId, retryWorkId)) {
    return { ok: false, status: 409, code: "ALREADY_RETRIED", message: say.retryAlreadyDone };
  }
  const started = startBackgroundWork(services, principal, at, conversationId, run.requestText, { workId: retryWorkId });
  if ("refusal" in started) {
    releaseWorkRunRetry(db, workId, retryWorkId);
    return started.busy === true
      ? { ok: false, status: 429, code: "BACKGROUND_BUSY", message: started.refusal }
      : { ok: false, status: 409, code: "BACKGROUND_UNAVAILABLE", message: started.refusal };
  }
  appendHostReply(services, {
    conversationId,
    text: say.retrying(run.title),
    at: at(),
  });
  dismissNotificationByKey(db, { principalId: services.runtime.identity.ownerPrincipalId, dedupKey: `background:${workId}`, at: at() });
  return {
    ok: true,
    workId: started.sessionId,
    retriedFrom: workId,
    state: started.state,
    ...(started.position === undefined ? {} : { position: started.position }),
  };
}

export type AskAgainOutcome =
  | { ok: true; questionId: string }
  | { ok: false; status: 404 | 409 | 422; code: string; message: string };

/**
 * "Ask again" for a question that expired unanswered, from wherever it is asked: its conversation's route, the inbox,
 * a sentence or the agent (`notice-operations.ts`). What may be asked again is `askQuestionAgain`'s to decide; this adds
 * the one thing every caller needs after it, which is taking the notice that said it expired out of the inbox, since the
 * new card is now the thing waiting.
 */
export function askExpiredQuestionAgain(
  services: Pick<NodeServices, "runtime" | "conductor" | "search">,
  conversationId: string,
  questionId: string,
  at: () => Instant,
): AskAgainOutcome {
  const asked = askQuestionAgain(interactionDepsFor(services, conversationId), questionId);
  if (!asked.ok) {
    const status = asked.code === "QUESTION_NOT_FOUND" ? 404 : asked.code === "INVALID_QUESTION" || asked.code === "SECRET_REQUEST" ? 422 : 409;
    return { ok: false, status, code: asked.code, message: asked.message };
  }
  dismissNotificationByKey(services.runtime.db, {
    principalId: services.runtime.identity.ownerPrincipalId,
    dedupKey: `expired:${questionId}`,
    at: at(),
  });
  return { ok: true, questionId: asked.questionId };
}

/** What the conversation is told when a background run ends without an answer, or nothing when the next boot says it. */
function backgroundEndingReply(
  signal: AbortSignal,
  cause: unknown,
  title: string,
  text: HostText,
): string | undefined {
  const say = text.background;
  const reason: unknown = signal.aborted ? signal.reason : undefined;
  if (reason instanceof WorkAbort) {
    if (reason.cause_ === "shutdown") return undefined;
    if (reason.cause_ === "stopped") return say.stoppedReply(title);
    // A deadline is worded here, from the limit it carries; anything else keeps the reason it was given.
    const why = reason.cause_ === "deadline" && reason.limitMs !== undefined ? say.deadline(text.duration(reason.limitMs)) : reason.message;
    return say.failedReply(why);
  }
  return say.failed(cause instanceof Error ? cause.message : String(cause));
}

/**
 * Whether a message was typed into the page's composer: the header the page sends, which no relay forwards
 * (`COMPOSER_SURFACE_HEADER`). Anything else — no header, another value, a list of them — is not the composer.
 */
function composerSurface(request: GatewayRequest): { surface?: MessageSurface; origin: TurnOrigin } {
  const value = request.headers[COMPOSER_SURFACE_HEADER];
  // Who asked, from the same mark: the composer is the person, MCP and the relay overwrite the header with their own
  // name, and anything else is a program on the HTTP API. Never from the body (`turnOriginOfSurfaceMark`).
  const origin = turnOriginOfSurfaceMark(value);
  return value === "composer" ? { surface: "composer", origin } : { origin };
}

/**
 * Whether the caller said it can hand a `widget-perform` of this version to a mounted frame and report back
 * (`WIDGET_PERFORM_HEADER`). The node's own page says so; a relay, the CLI or an older page does not, and is never sent
 * one: the dispatch then learns at once that nobody can ask a frame, instead of waiting for a report that cannot come.
 */
function performsWidgets(request: GatewayRequest): boolean {
  return request.headers[WIDGET_PERFORM_HEADER] === String(WIDGET_PERFORM_VERSION);
}

export function appendHostReply(
  services: Pick<NodeServices, "runtime" | "conductor" | "search">,
  input: { conversationId: string; text?: string; blocks?: MessageBlock[]; at: Instant },
): { messageId: string } {
  const message = writeHostReply(services, input);
  indexHostReply(services, message);
  return { messageId: message.messageId };
}

/**
 * Writes the host's reply without indexing it, so a caller can make it part of its own transaction; the search index
 * opens a transaction of its own and is updated after the commit (`indexHostReply`).
 */
export function writeHostReply(
  services: Pick<NodeServices, "runtime" | "conductor">,
  input: { conversationId: string; text?: string; blocks?: MessageBlock[]; at: Instant },
): MessageRecord {
  const blocks: MessageBlock[] =
    input.blocks ?? [{ type: "text", format: "plain", content: input.text ?? "", streaming: false }];
  const message: MessageRecord = {
    messageId: services.conductor.newId("msg") as MessageRecord["messageId"],
    conversationId: input.conversationId as MessageRecord["conversationId"],
    role: "assistant",
    blocks,
    authorNodeId: services.runtime.identity.nodeId as MessageRecord["authorNodeId"],
    createdAt: input.at,
    delivery: "accepted",
  };
  appendMessage(services.runtime.db, message, nextMessageSequence(services.runtime.db, input.conversationId));
  return message;
}

export function indexHostReply(services: Pick<NodeServices, "search">, message: MessageRecord): void {
  indexMessages(services.search, { conversationId: message.conversationId, messages: [message], at: message.createdAt });
}


/**
 * Decide what a typed message means to the application.
 *
 * Shared by both message routes. The composer uses the streaming one, and the plain route was wired first - which
 * meant a typed "mở settings" reached the model instead of the registry until this was found. One function is what
 * keeps the next route from being the one that forgot to record the audit event.
 */
function typedAppIntent(
  services: Pick<NodeServices, "runtime" | "conductor" | "turnControl">,
  conversationId: string,
  text: string,
  at: () => string,
): AppIntentResolution {
  const intentDeps: AppIntentDeps = {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => at() as never,
    newId: services.conductor.newId,
    // Read only for a sentence about the look, so an ordinary message does not read the package directory.
    runningConversations: () => services.turnControl?.running() ?? [],
    themes: () => readThemeRegistry(themeRegistryDeps(services)),
  };
  const principalId = services.runtime.identity.ownerPrincipalId;
  return decideAppIntent(
    intentDeps,
    { principalId, request: { text, source: "chat" }, conversationId: conversationId as never },
    (intent: AppIntent) => mintConfirmation(intentDeps, { principalId, intent, source: "chat" }),
  );
}
/**
 * The sentence a typed command is answered with.
 *
 * A stop is carried out here, where the node knows whether anything was running, so the answer is what happened
 * rather than what was asked: "dừng lại" typed when the reply has already finished says there was nothing to stop.
 */
function answerTypedIntent(
  services: Pick<NodeServices, "runtime" | "conductor" | "turnControl">,
  conversationId: string,
  asked: Exclude<AppIntentResolution, { kind: "none" }>,
): string {
  if (asked.kind === "refused") return asked.say;
  if (asked.kind === "intent" && asked.intent.kind === "turn.stop") {
    const { stopped } = stopTurnOnNode(services, { conversationId, source: "chat" });
    if (!stopped) return NOTHING_TO_STOP_SAY;
  }
  return asked.readBack;
}

/**
 * What a sent message is, before any turn machinery sees it: refused for a file it cannot carry, a command the host
 * answers, or a message for a turn with the files it carries.
 *
 * Shared by both message routes, which differ only in how they say the answer. The files are read first, so a file
 * that is not available refuses the message on every path. A message that carries files is never a host command: a
 * host answer, and the background run `/background` starts, carry only words, so the files would be dropped without a
 * word. It is stored with its files and answered as a turn instead.
 */
async function readSentMessage(
  services: ConversationServices,
  principal: Principal,
  input: { conversationId: string; text: string; attachmentIds: unknown; at: () => string },
): Promise<
  | { kind: "refused"; message: string }
  | { kind: "slash"; answer: SlashCommandAnswer; messageId: string }
  | { kind: "intent"; asked: Exclude<AppIntentResolution, { kind: "none" }>; said: string; messageId: string }
  | { kind: "message"; attachmentRefs: AttachmentRef[] }
> {
  const { conversationId, text, at } = input;
  const attachments = resolveAttachmentRefs({
    db: services.runtime.db,
    principalId: services.runtime.identity.ownerPrincipalId,
    conversationId,
    ids: input.attachmentIds,
  });
  if (!attachments.ok) return { kind: "refused", message: attachments.message };
  if (attachments.refs.length > 0) return { kind: "message", attachmentRefs: attachments.refs };

  // A slash command is the host's to answer, before any sentence matching: `/new` is a command, never a sentence.
  const slash = parseSlashCommand(text);
  if (slash !== undefined) {
    const answer = await answerSlashCommand(services, principal, { conversationId, typed: slash, at: () => at() as never });
    const appended = appendHostReply(services, { conversationId, blocks: slashCommandBlocks(answer), at: at() as never });
    return { kind: "slash", answer, messageId: appended.messageId };
  }

  const asked = typedAppIntent(services, conversationId, text, at);
  if (asked.kind !== "none") {
    const said = answerTypedIntent(services, conversationId, asked);
    const appended = appendHostReply(services, { conversationId, text: said, at: at() as never });
    return { kind: "intent", asked, said, messageId: appended.messageId };
  }
  return { kind: "message", attachmentRefs: [] };
}

export async function handleConversationRoutes(deps: ConversationRouteDeps): Promise<GatewayResponse> {
  const { request, segments, at } = deps;
  const { services } = deps;
  const { runtime } = services;
  const principal = {
    principalId: runtime.identity.ownerPrincipalId as never,
    kind: "user" as const,
    nodeId: runtime.identity.nodeId as never,
  };

  // /conversations
  if (segments.length === 1) {
    if (request.method === "GET") {
      return json(200, {
        conversations: listConversations(runtime.db).map((conversationId) => ({
          conversationId,
          ...(getConversation(runtime.db, conversationId) ?? {}),
        })),
      });
    }
    if (request.method === "POST") {
      const parsed = readJson(request);
      if (!parsed.ok) return parsed.response;
      const conversationId =
        deps.newConversationId?.() ?? `conv_${runtime.identity.nodeId.slice(5, 13)}_${Date.now().toString(36)}`;
      const title = typeof parsed.value.title === "string" ? parsed.value.title.slice(0, 200) : undefined;
      createConversation(runtime.db, {
        conversationId,
        homeNodeId: runtime.identity.nodeId,
        ...(title === undefined ? {} : { title }),
        at: at() as never,
      });
      return json(201, { conversationId, homeNodeId: runtime.identity.nodeId });
    }
    return fail(405, "METHOD_NOT_ALLOWED", `${request.method} is not supported on /conversations`);
  }

  const conversationId = segments[1];
  if (conversationId === undefined) {
    return fail(400, "INVALID_SCHEMA", "a conversation route must name a conversation");
  }
  if (segments.length === 3 && segments[2] === "delete" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const body = conversationDeleteRequestSchema.safeParse(parsed.value);
    if (!body.success) return fail(400, "INVALID_SCHEMA", "conversation deletion accepts only a scoped deletion permit");
    const intentDeps = {
      db: runtime.db,
      nodeId: runtime.identity.nodeId,
      now: () => at() as Instant,
      newId: services.conductor.newId,
      runningConversations: () => services.turnControl?.running() ?? [],
    };
    const principalId = runtime.identity.ownerPrincipalId;
    const result = deleteConversation({...intentDeps, principalId, dataDir: runtime.dataDir}, {
      conversationId,
      ...(body.data.deletionPermit === undefined ? {} : {deletionPermit: body.data.deletionPermit}),
      locale: preferredAppIntentLocale(intentDeps, principalId),
      mint: (intent) => mintConfirmation(intentDeps, {principalId, intent, source: "click"}),
    });
    const status = result.deleted ? 200 : result.decision.kind === "needs-confirmation" ? 202 : 409;
    return json(status, result);
  }

  const conversation = getConversation(runtime.db, conversationId);
  if (!conversation) {
    return fail(404, "RESOURCE_NOT_FOUND", `conversation ${conversationId} does not exist`);
  }

  // A conversation accepts commands only on its home node. Two nodes writing one timeline
  // is the multi-master case the protocol refuses rather than reconciles.
  if (conversation.homeNodeId !== runtime.identity.nodeId) {
    return fail(
      403,
      "WRONG_NODE_FOR_RESOURCE",
      `this conversation is homed on ${conversation.homeNodeId}; send commands there rather than forking the timeline`,
    );
  }

  /*
   * /conversations/:id/stop
   *
   * Stops the reply this conversation is writing and answers whether there was one. Only this conversation's turn:
   * the node-wide emergency stop is `POST /stop`. What the turn had written stays in the conversation, labelled as
   * stopped. `source` says how the person asked, for the audit row; anything else is recorded as the API.
   */
  if (segments.length === 3 && segments[2] === "stop" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const source: StopTurnSource =
      parsed.value.source === "chat" || parsed.value.source === "voice" ? parsed.value.source : "api";
    return json(200, stopTurnOnNode(services, { conversationId, source }));
  }

  // /conversations/:id/messages
  if (segments.length === 3 && segments[2] === "messages" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const text = parsed.value.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return fail(400, "INVALID_SCHEMA", "a message must carry a non-empty text field");
    }

    /*
     * A typed command to the application, and the files the message carries (`readSentMessage`).
     *
     * Checked before the turn machinery, because "mở settings" is not something to steer into a running answer. An
     * intent is answered by the host and recorded with source "chat"; a command-shaped sentence that maps to nothing
     * gets an honest "I did not understand" and no model turn at all, which is the issue's rule about not guessing;
     * anything else falls through untouched and reaches the agent exactly as before. The files are read first, so one
     * that is not available refuses the message before anything is joined, stopped or started for it.
     */
    const sent = await readSentMessage(services, principal, {
      conversationId,
      text,
      attachmentIds: parsed.value.attachmentIds,
      at,
    });
    if (sent.kind === "refused") return fail(400, "ATTACHMENT_NOT_AVAILABLE", sent.message);
    if (sent.kind === "slash") {
      const { answer } = sent;
      return json(200, { accepted: true, messageId: sent.messageId, ...(answer.appIntent === undefined ? {} : { appIntent: answer.appIntent }) });
    }
    if (sent.kind === "intent") return json(200, { accepted: true, messageId: sent.messageId, appIntent: sent.asked });
    const attachmentRefs = sent.attachmentRefs;
    const attachedFiles = attachmentRefs.length > 0;

    // Checked before anything acts on the message, so a reference that no longer holds refuses the whole message by
    // name instead of a turn starting without the thing it was asked about.
    const references = await resolveComposerReferences(services, { value: parsed.value.references });
    if (!references.ok) return fail(400, "REFERENCE_NOT_AVAILABLE", references.message);

    /*
     * A message sent while the assistant is still working.
     *
     * The three answers are not interchangeable, so the decider chooses rather than a rule. Two of them need nothing
     * new and are handled here: joining the turn already running, and stopping it so this message takes its place. The
     * third - doing this in the background while the current work carries on - still needs a worker, so a background
     * answer is treated as an interrupt, because running the message is what sending it asked for.
     *
     * The decider is told how long the running turn has gone on: a long turn is worth keeping, so a new message is more
     * likely to belong beside it than in place of it. A control that cannot tell says zero, which biases toward
     * interrupt — the recoverable direction rather than the silent one.
     */
    const control = services.turnControl;
    /*
     * Decided only against a turn that is answering. A conversation whose turn is still being set up — its session
     * being created, or a model switch pending — has said nothing yet: this message is answered after it, as a turn of
     * its own, rather than stopping a first message the person has not seen answered.
     */
    const answering = control !== undefined && (control.answering?.() ?? control.running()).includes(conversationId);
    // A message that points at something is its own turn: its references are briefed into the turn it starts, and
    // joining a running answer or a background worker would carry its words without them.
    if (control !== undefined && answering && references.blocks.length > 0) {
      control.interrupt(conversationId);
    } else if (control !== undefined && answering) {
      const decided = await decideTurnAction(
        {
          jev: services.jev.deps,
          budget: () => searchDecisionBudget(services.jev.config, { timeoutMs: decisionTimeoutMsFromEnv(process.env) }),
        },
        { text, runningMs: control.runningMs?.(conversationId) ?? 0 },
      );
      const action = decided.status === "decided" ? decided.action : "interrupt";
      /*
       * A steer joins only a turn of the same origin and channel. One the turn will not take — a program's message
       * beside the person's turn, or a typed one during a spoken turn — waits and is answered as a turn of its own, and
       * Stop still cancels it while it waits. It does not cut the running turn off: joining was what the decider chose,
       * and taking the running turn's place was not.
       *
       * A message with attachments is neither joined nor sent to the background: a steer and a background request both
       * carry only its words, so it waits the same way, and is stored with its files and answered in a turn of its own
       * that reads them.
       */
      if (action === "steer" || (action === "background" && attachedFiles)) {
        if (!attachedFiles && (await control.steer(conversationId, text, composerSurface(request).origin))) {
          return json(202, {
            accepted: true,
            resolution: "steered",
            ...(decided.status === "decided" ? {} : { reason: decided.reason }),
          });
        }
      } else if (action === "background") {
        const started = startBackgroundWork(services, principal, () => at() as never, conversationId, text);
        if ("refusal" in started && started.busy === true) {
          // Every place and the whole queue are taken. Ending the turn that is answering would not free one, so the
          // turn is left alone and the refusal is said where the request was made, naming what is running.
          const said = appendHostReply(services, { conversationId, text: started.refusal, at: at() as never });
          return json(202, { accepted: true, resolution: "background-refused", messageIds: [said.messageId] });
        }
        // No worker to run it in: the message is what the person asked for, so it becomes the turn instead.
        if ("refusal" in started) {
          control.interrupt(conversationId);
        } else {
          // A background request is never stored as a message, so who asked for it is written here: the run's id, not
          // its words, which stay in the conversation's own record.
          appendAuditEvent(services.runtime.db, {
            auditId: services.conductor.newId("audit"),
            principalId: runtime.identity.ownerPrincipalId,
            nodeId: runtime.identity.nodeId,
            kind: "interaction",
            summary: "started a background request beside the running turn",
            outcome: "done",
            ref: started.sessionId,
            origin: composerSurface(request).origin,
            at: at() as never,
          });
          return json(202, {
            accepted: true,
            resolution: "background",
            sessionId: started.sessionId,
            state: started.state,
            ...(started.position === undefined ? {} : { position: started.position }),
          });
        }
      } else {
        // An interrupt: this message takes the running turn's place.
        control.interrupt(conversationId);
      }
    }

    const at_ = at() as never;

    // A `control_app` call this turn makes is otherwise silent on this route: there is no stream to carry
    // it, so it is collected here and reported in the response instead, for a caller of the plain HTTP
    // route to run through the same `runAppIntent` executor the streaming and voice routes already reach.
    // Never `expect`ed: nothing can run it before this turn ends, so the tool says it is unconfirmed at
    // once rather than waiting on a report this very request is holding back.
    const hostControlDecisions: AppIntentDecision[] = [];
    const outcome = await handleUserMessage(services.conductor, {
      conversationId: conversationId as never,
      principal,
      text: text.slice(0, 20_000),
      at: at_,
      attachmentRefs,
      referenceBlocks: references.blocks,
      // Only the demo path asks for a scripted sample; a real message never gets one.
      ...(parsed.value.demo === true ? { demo: true } : {}),
      ...composerSurface(request),
      emit: (event) => {
        if (event.type === "host-control") hostControlDecisions.push(event.decision);
      },
    });

    // Indexed here, where the messages were just written, so a message that exists is searchable.
    // Doing it in the same request is what keeps "the conversation shows it" and "search finds it"
    // from disagreeing after a crash between the two.
    indexMessages(services.search, { conversationId, messages: outcome.messages, at: at_ });

    // A turn the model answered is already finished, so reporting it as accepted would be a
    // lie about what the caller is holding. 202 is reserved for the paths that genuinely have
    // work still to do: a dispatched or parked task.
    const finished = outcome.resolution === "model" || outcome.resolution === "model-failed";

    return json(finished ? 200 : 202, {
      resolution: outcome.resolution,
      taskId: outcome.taskId ?? null,
      messageIds: outcome.messages.map((message) => message.messageId),
      // The whole timeline page is returned so the client does not have to guess whether
      // its cursor is still valid after its own write.
      timeline: buildTimeline(services, { conversationId }),
      // Present only while non-zero: a caller that never sees `control_app` used should not learn the
      // field exists.
      ...(hostControlDecisions.length === 0 ? {} : { hostControl: hostControlDecisions }),
    });
  }

  // /conversations/:id/messages/stream
  //
  // The same message, reported while it is being answered. It shares everything with the route above
  // except the reporting: the same validation, the same conductor, the same indexing and the same
  // final timeline in the last event, so a client that ignores the deltas sees exactly what the
  // non-streaming route would have returned.
  if (segments.length === 4 && segments[2] === "messages" && segments[3] === "stream" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const text = parsed.value.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return fail(400, "INVALID_SCHEMA", "a message must carry a non-empty text field");
    }

    /*
     * A typed command to the application, on the route the composer actually uses, and the files the message carries.
     *
     * The same reading as the non-streaming route (`readSentMessage`): the files first, then a slash command or a typed
     * intent the host answers, for a message without files. The difference is only where the decision travels, because
     * this answer is a stream. A command is not a turn, so nothing is sent to the model: its sentence is a delta so a
     * client that renders replies renders this one too, and the `done` frame carries the record and the timeline the
     * other routes would have returned, plus the decision when the page has something to do.
     */
    const sent = await readSentMessage(services, principal, {
      conversationId,
      text,
      attachmentIds: parsed.value.attachmentIds,
      at,
    });
    if (sent.kind === "refused") return fail(400, "ATTACHMENT_NOT_AVAILABLE", sent.message);
    if (sent.kind === "slash" || sent.kind === "intent") {
      const said = sent.kind === "slash" ? sent.answer.text : sent.said;
      const appIntent = sent.kind === "slash" ? sent.answer.appIntent : sent.asked;
      return {
        status: 200,
        body: null,
        stream: {
          contentType: "text/event-stream",
          run: async (send) => {
            send(sse("delta", { text: said }));
            send(
              sse("done", {
                resolution: "app-intent",
                taskId: null,
                messageIds: [sent.messageId],
                timeline: buildTimeline(services, { conversationId }),
                ...(appIntent === undefined ? {} : { appIntent }),
              }),
            );
          },
        },
      };
    }

    const at_ = at() as never;
    const references = await resolveComposerReferences(services, { value: parsed.value.references });
    if (!references.ok) return fail(400, "REFERENCE_NOT_AVAILABLE", references.message);
    return {
      status: 200,
      body: null,
      stream: {
        contentType: "text/event-stream",
        run: (send) =>
          streamUserMessage(
            services,
            {
              conversationId,
              principal,
              text: text.slice(0, 20_000),
              at: at_,
              attachmentRefs: sent.attachmentRefs,
              referenceBlocks: references.blocks,
              ...(parsed.value.demo === true ? { demo: true } : {}),
              ...composerSurface(request),
              performsWidgets: performsWidgets(request),
            },
            send,
          ),
      },
    };
  }

  // /conversations/:id/approvals/:approvalId/decide
  //
  // The one route that can start a command, and it starts nothing without a decision from a user: the
  // principal comes from the transport, `decideApproval` refuses a non-user decider, the digest the
  // approver saw must match the stored one, and the payload it covers is re-hashed here again before
  // anything runs. A refusal is never a block — a message describing something that did not happen is how
  // a transcript starts lying.
  if (segments.length === 5 && segments[2] === "approvals" && segments[4] === "decide" && request.method === "POST") {
    const approvalId = segments[3];
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const decisionValue = parsed.value.decision;
    const decision = decisionValue === "granted" || decisionValue === "denied" ? decisionValue : undefined;
    const digest = typeof parsed.value.digest === "string" ? parsed.value.digest : "";
    if (approvalId === undefined || decision === undefined || digest === "") {
      return fail(400, "INVALID_SCHEMA", "a decision must carry decision: granted|denied and the digest it was shown");
    }

    /*
     * An approved widget action is performed by the frame on the deciding page, which is waiting for this answer and
     * cannot hear an event meanwhile. So when the page says it can run one, the request is handed back in this answer
     * (`perform`), the page asks its frame and reports at the usual route, and the decision finishes — receipt, ledger,
     * audit — when that report arrives. Every other decision answers when it is done, as it always has.
     */
    let deliver: ((performRequest: WidgetPerformRequest) => void) | undefined;
    const delivered = new Promise<WidgetPerformRequest>((resolve) => {
      deliver = resolve;
    });
    const perform: WidgetPerformer | undefined = performsWidgets(request)
      ? async (performRequest) => {
          services.widgetPerforms.expect(performRequest.performId);
          deliver?.(performRequest);
          return services.widgetPerforms.wait(performRequest.performId);
        }
      : undefined;
    const deciding = decideApprovalForNode(services, {
      conversationId,
      approvalId,
      decision,
      digest,
      principal,
      at: at() as never,
      ...(perform === undefined ? {} : { perform }),
    });
    const first = await Promise.race([
      deciding.then((value) => ({ kind: "decided" as const, value })),
      delivered.then((value) => ({ kind: "perform" as const, value })),
    ]);
    if (first.kind === "perform") {
      deciding.catch((cause: unknown) => {
        process.stderr.write(`approval ${approvalId}: an approved widget action did not finish (${cause instanceof Error ? cause.message : String(cause)})\n`);
      });
      return json(200, { decision, perform: first.value, timeline: buildTimeline(services, { conversationId }) });
    }
    const decided = first.value;
    if (!decided.ok) return fail(409, decided.code, decided.message);

    return json(200, {
      decision,
      ...(decided.outcome === undefined ? {} : { outcome: decided.outcome }),
      timeline: buildTimeline(services, { conversationId }),
    });
  }

  /*
   * /conversations/:id/questions/:questionId/answer
   *
   * The other half of `ask_user_question`, and the reason that tool can return immediately: the answer is its
   * own request, arriving whenever the person gets to it. Nothing was waiting on the node for it — the turn
   * that asked ended — so this route starts a new turn rather than resuming anything.
   *
   * Text and voice both land here. The client posts a click and the voice session posts an utterance it has
   * already matched against the question's own options; there is no second path that could disagree about what
   * an answer means.
   */
  if (segments.length === 5 && segments[2] === "questions" && segments[4] === "answer" && request.method === "POST") {
    const questionId = segments[3];
    if (questionId === undefined) return fail(400, "INVALID_SCHEMA", "an answer needs the question it answers");
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;

    const answered = await answerQuestionForNode(services, {
      conversationId,
      principal,
      questionId,
      text: parsed.value.text,
      optionIds: parsed.value.optionIds,
      confirmed: parsed.value.confirmed,
      viaVoice: parsed.value.viaVoice === true,
      at: at() as never,
      // Who answered, from the surface mark like a message: the page's card, or a program on a machine surface.
      origin: composerSurface(request).origin,
    });
    if (!answered.ok) {
      const status = answered.code === "QUESTION_NOT_FOUND" ? 404 : 409;
      return fail(status, answered.code, answered.message);
    }

    return json(200, {
      ok: true,
      note: answered.note,
      timeline: buildTimeline(services, { conversationId }),
    });
  }

  // /conversations/:id/questions/:questionId/cancel
  if (segments.length === 5 && segments[2] === "questions" && segments[4] === "cancel" && request.method === "POST") {
    const questionId = segments[3];
    if (questionId === undefined) return fail(400, "INVALID_SCHEMA", "a cancellation needs the question it drops");
    const cancelled = cancelQuestion(interactionDepsFor(services, conversationId), questionId);
    if (!cancelled) return fail(404, "RESOURCE_NOT_FOUND", "that question is not waiting in this conversation");
    return json(200, { ok: true, timeline: buildTimeline(services, { conversationId }) });
  }

  /*
   * /conversations/:id/questions/:questionId/ask-again
   *
   * A question that expired with nobody answering, put back as a new question with the same words and choices. Refused
   * while it is still open, once it was answered or dropped, and once it was already asked again (`askQuestionAgain`).
   * The notice that said it expired is dismissed: the new card is now the thing waiting.
   */
  if (segments.length === 5 && segments[2] === "questions" && segments[4] === "ask-again") {
    if (request.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "a question is asked again with POST");
    const questionId = segments[3];
    if (questionId === undefined) return fail(400, "INVALID_SCHEMA", "asking again needs the question it repeats");
    const asked = askExpiredQuestionAgain(services, conversationId, questionId, () => at() as Instant);
    if (!asked.ok) return fail(asked.status, asked.code, asked.message);
    return json(200, {
      ok: true,
      questionId: asked.questionId,
      timeline: buildTimeline(services, { conversationId }),
    });
  }


  // /conversations/:id/start-session
  if (segments.length === 3 && segments[2] === "start-session" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const text = typeof parsed.value.text === "string" ? parsed.value.text.trim() : "";
    if (text === "") {
      return fail(400, "INVALID_SCHEMA", "a start-session request must carry the user's text");
    }

    const resolution = await resolveProject(services.projects, { intent: text });
    const startedAt = at() as never;

    if (resolution.status === "rejected") {
      return fail(409, resolution.code, resolution.message);
    }

    if (resolution.status === "clarify" || resolution.status === "ask-for-directory") {
      // One question, and it is written into the conversation so the answer has somewhere to land.
      const message = appendHostReply(services, {
        conversationId,
        text:
          resolution.status === "clarify"
            ? `${resolution.question}\n${resolution.options.map((option: string) => `- ${option}`).join("\n")}`
            : resolution.question,
        at: startedAt,
      });
      return json(200, {
        status: resolution.status === "clarify" ? "clarify" : "needs-path",
        question: resolution.question,
        options: resolution.status === "clarify" ? resolution.options : [],
        messageId: message.messageId,
        timeline: buildTimeline(services, { conversationId }),
      });
    }

    // Resolved. The directory was verified by the finder; the session is started in it, and the brief
    // carries the same path, which is what makes "work in this project" true.
    const availability = services.projectSessions.available();
    if (!availability.available) {
      return fail(503, "SESSION_UNAVAILABLE", availability.reason ?? "this node cannot start a session");
    }

    const context = projectContext(resolution.project);
    /*
     * The approved roots for this session, passed whole rather than as their first element.
     *
     * `projectRoots` is the boundary the session's file tools are confined to, so the array is the contract:
     * the starter canonicalises every entry and the tools admit paths under all of them. A resolution carries
     * exactly one root today — the directory the finder verified, and the only root granted (see
     * `api.spec.ts`) — and a resolution that carried more would need no change here.
     */
    const approvedRoots = [resolution.project.path];
    const session = await services.projectSessions.start({
      goal: initialPrompt(text, resolution.project.name, context),
      projectRoots: approvedRoots,
    });
    markProjectUsed(services.projects, resolution.project.projectId);

    const message = appendHostReply(services, {
      conversationId,
      // The same facts `projectContext` gives the session, worded for the person in their language.
      text: ownerHostText(services.runtime).tasks.projectSessionOpened(
        resolution.project.name,
        resolution.relPath,
        resolution.project.kind,
        resolution.project.markers.slice(0, 6).join(", "),
      ),
      at: startedAt,
    });

    return json(201, {
      status: "started",
      projectName: resolution.project.name,
      relPath: resolution.relPath,
      mode: resolution.mode,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? null,
      messageId: message.messageId,
      timeline: buildTimeline(services, { conversationId }),
    });
  }

  // /conversations/:id/timeline
  if (segments.length === 3 && segments[2] === "timeline" && request.method === "GET") {
    // A bare read is still `after=0`, the page existing readers ask for; the page reopening a conversation shows is
    // `window=latest`, and scrolling back asks with `before`.
    const asked = parseTimelinePageQuery(request.query);
    if (!asked.ok) return fail(400, "INVALID_SCHEMA", asked.message);
    return json(200, buildTimeline(services, { conversationId, page: asked.page, limit: asked.limit }));
  }

  // /conversations/:id/widgets/:instanceId/actions
  if (
    segments.length === 5 &&
    segments[2] === "widgets" &&
    segments[4] === "actions" &&
    request.method === "POST"
  ) {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const instanceId = segments[3] ?? "";

    // The URL and the body must agree. A body that names a different instance is a request that
    // intends something other than what its own path says, and resolving which one is authoritative
    // is a decision this route should not have to make.
    if (typeof parsed.value.instanceId === "string" && parsed.value.instanceId !== instanceId) {
      return fail(400, "INSTANCE_MISMATCH", "the body names a different instance than the path");
    }

    // The body is the contract's `actionInvocationSchema`, the path's instance filling in an absent `instanceId`. Its
    // typed `variant` makes this one call, not a second route: absent is the ordinary invocation, `view-state` the
    // state-only write of a player's playback state with its write `sequence`. Anything else is refused rather than read
    // as the ordinary call, and so is an invocation id in the node's own record space.
    const body = actionInvocationSchema.safeParse({ ...parsed.value, instanceId });
    if (!body.success) {
      return fail(400, "INVALID_SCHEMA", "the action call does not match the contract", {
        issues: body.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }
    const { variant, sequence, ...fields } = body.data;
    const invocation = {
      ...fields,
      conversationId,
      principalId: runtime.identity.ownerPrincipalId,
      ...(sequence === undefined ? {} : { sequence }),
    };
    const result = variant === VIEW_STATE_WRITE_VARIANT ? writeWidgetViewState(services, invocation) : await invokeWidgetAction(services, invocation, "click", composerSurface(request).origin);

    if (result.ok) {
      touchWidget(runtime.db, conversationId, instanceId);
      return json(result.status, result.body);
    }
    return fail(result.status, result.code, result.message, {
      ...(result.currentRevision === undefined ? {} : { currentRevision: result.currentRevision }),
      ...(result.detail ?? {}),
    });
  }

  // /conversations/:id/widgets/:instanceId/state
  if (
    segments.length === 5 &&
    segments[2] === "widgets" &&
    segments[4] === "state" &&
    request.method === "POST"
  ) {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const instanceId = segments[3] ?? "";
    const expectedRevision = parsed.value.expectedRevision;
    const patch = parsed.value.patch;
    if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return fail(400, "INVALID_SCHEMA", "a state write must carry the state revision it was planned at");
    }
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return fail(400, "INVALID_SCHEMA", "a state write must carry a patch object");
    }

    const instance = getInstance(services.conductor, instanceId);
    if (instance === undefined) return fail(404, "RESOURCE_NOT_FOUND", "that instance is not on this node");
    /*
     * Only a frame writes its own state this way. A built-in or composed surface changes state through a bound view
     * action, validated operation by operation; letting it write a raw patch here would be a second, weaker path
     * around those operations.
     */
    const isolated = locateIsolatedFrame(runtime, instance.definitionRef.id);
    if (!isolated.ok) {
      return fail(
        isolated.code === "NOT_AN_ISOLATED_APP" || isolated.code === "NOT_INSTALLED" ? 409 : 404,
        isolated.code,
        isolated.code === "NOT_AN_ISOLATED_APP"
          ? "this widget changes its state through its bound actions, not by writing it directly"
          : isolated.message,
      );
    }

    const outcome = applyWidgetStatePatch(services.conductor, {
      instanceId,
      principalId: runtime.identity.ownerPrincipalId,
      definition: isolated.definition,
      expectedRevision,
      patch: patch as Record<string, unknown>,
    });
    if (outcome.ok) {
      touchWidget(runtime.db, conversationId, instanceId);
      return json(200, { stateRevision: outcome.stateRevision, state: outcome.state });
    }
    return fail(STATE_REFUSAL_STATUS[outcome.code], outcome.code, outcome.message, {
      ...(outcome.stateRevision === undefined ? {} : { stateRevision: outcome.stateRevision }),
      ...(outcome.state === undefined ? {} : { state: outcome.state }),
    });
  }

  // /conversations/:id/widgets/:instanceId/semantic — what a frame says it shows, for the next turn (#195).
  if (
    segments.length === 5 &&
    segments[2] === "widgets" &&
    segments[4] === "semantic" &&
    request.method === "POST"
  ) {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const instanceId = segments[3] ?? "";
    const instance = getInstance(services.conductor, instanceId);
    if (instance === undefined) return fail(404, "RESOURCE_NOT_FOUND", "that instance is not on this node");
    if (instance.ownerPrincipalId !== runtime.identity.ownerPrincipalId) {
      return fail(403, "NOT_AUTHORIZED", "that instance belongs to another principal");
    }
    // A built-in or composed surface is described by the host from the state it stores; only a frame, whose state the
    // host cannot read the meaning of, says what it shows.
    const isolated = locateIsolatedFrame(runtime, instance.definitionRef.id);
    if (!isolated.ok && isolated.code === "NOT_INSTALLED") return fail(409, isolated.code, isolated.message);
    if (!isolated.ok) {
      return fail(409, "NOT_AN_ISOLATED_APP", "this widget is described by the host from its own state");
    }
    // Strict: a proposal that names actions, or anything else a frame does not own, is refused whole.
    const proposal = semanticProposalSchema.safeParse(parsed.value.proposal);
    if (!proposal.success) {
      return fail(400, "INVALID_SCHEMA", "a semantic proposal carries a summary, and optionally selectedIds and values, and nothing else");
    }
    recordWidgetProposal(runtime.db, { instanceId, conversationId, proposal: proposal.data, at: nowInstant() });
    return json(200, { accepted: true });
  }

  // /conversations/:id/widgets/:instanceId/export — a table's CSV, person-only (see `isPersonOnlyRoute`).
  if (
    segments.length === 5 &&
    segments[2] === "widgets" &&
    segments[4] === "export" &&
    request.method === "POST"
  ) {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    return exportTableCsv(services, {
      instanceId: segments[3] ?? "",
      principalId: runtime.identity.ownerPrincipalId,
      body: parsed.value,
    });
  }

  // /conversations/:id/widgets/:instanceId/live
  if (
    segments.length === 5 &&
    segments[2] === "widgets" &&
    segments[4] === "live" &&
    request.method === "GET"
  ) {
    const instanceId = segments[3] ?? "";
    return resolveLiveWidget(services, conversationId, instanceId, runtime.identity.ownerPrincipalId);
  }

  // /conversations/:id/widgets/:instanceId/live-owner
  if (
    segments.length === 5 &&
    segments[2] === "widgets" &&
    segments[4] === "live-owner" &&
    (request.method === "POST" || request.method === "DELETE")
  ) {
    const instanceId = segments[3] ?? "";
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const ownerToken = typeof parsed.value.ownerToken === "string" ? parsed.value.ownerToken : "";
    if (ownerToken === "") {
      return fail(400, "INVALID_SCHEMA", "a live-owner request must carry the client's ownerToken");
    }

    if (request.method === "DELETE") {
      // A release that names a token this client does not hold is a release of somebody else's
      // claim, and is refused by the token comparison rather than by a principal check.
      const released = releaseLiveOwner(services.conductor, instanceId, ownerToken);
      if (!released) {
        return fail(409, "NOT_OWNER", "that client does not hold the live claim on this instance");
      }
      return json(200, { released: true, ownerSurface: null });
    }

    const surface = parsed.value.surface === "pin" ? "pin" : "inline";
    const leaseMs = typeof parsed.value.leaseMs === "number" && parsed.value.leaseMs > 0 ? parsed.value.leaseMs : undefined;
    // Expired claims are cleared first so the reply distinguishes "somebody else is holding it"
    // from "somebody else held it until a moment ago".
    sweepExpiredLiveOwners(services.conductor);
    const claimed = claimLiveOwner(services.conductor, {
      instanceId,
      surface,
      ownerToken,
      ...(leaseMs === undefined ? {} : { leaseMs }),
    });
    if (!claimed.ok) {
      return fail(409, claimed.code, "another surface holds the live view of this instance", {
        heldBySurface: claimed.heldBy.surface,
        ...(claimed.expiresAt === undefined ? {} : { expiresAt: claimed.expiresAt }),
      });
    }
    return json(200, {
      claimed: true,
      surface,
      expiresAt: claimed.expiresAt,
      ...(claimed.recoveredFrom === undefined ? {} : { recovered: true }),
    });
  }

  // /conversations/:id/snapshots/:snapshotId/presentation
  if (
    segments.length === 5 &&
    segments[2] === "snapshots" &&
    segments[4] === "presentation" &&
    request.method === "GET"
  ) {
    const snapshotId = segments[3] ?? "";
    const display = readSnapshotForDisplay(services.conductor, snapshotId);
    if (display === undefined) {
      return fail(404, "RESOURCE_NOT_FOUND", "that snapshot is not on this node");
    }
    const bundle = findBundleForSnapshot(runtime.db, snapshotId, runtime.identity.ownerPrincipalId);
    if (bundle !== undefined && bundle.instanceId !== display.snapshot.instanceId) {
      return fail(409, "OWNERSHIP_MISMATCH", "the stored bundle does not belong to this snapshot's instance");
    }
    return json(200, {
      snapshot: display.snapshot,
      // `read-only` is the point of this route: history never carries an action binding, so a
      // snapshot cannot be used to mutate anything even if a client tried.
      readOnly: true,
      text: display.text,
      ...(bundle === undefined
        ? { bundleRef: null, sections: [], tombstone: null }
        : {
            bundleRef: bundle.bundleId,
            sections: bundle.sections,
            // The spec travels with the bundle so a historical render shows the period and template
            // it was captured with, not the defaults of whatever the live instance is doing now.
            spec: bundle.composition,
            tombstone: bundle.tombstone ?? null,
            catalogDigest: bundle.catalogDigest,
          }),
    });
  }

  // /conversations/:id/widgets/:instanceId/composition
  if (
    segments.length === 5 &&
    segments[2] === "widgets" &&
    segments[4] === "composition" &&
    request.method === "GET"
  ) {
    const instanceId = segments[3] ?? "";
    const principalId = runtime.identity.ownerPrincipalId;
    const composition = findCompositionByInstance(runtime.db, instanceId, principalId);
    if (composition === undefined) {
      return fail(404, "RESOURCE_NOT_FOUND", "that instance has no composition on this node");
    }
    const spec = surfaceCompositionSpecSchema.parse(composition);
    // The bundle is read through the snapshot the message referenced, so a composition without a
    // captured snapshot answers with the spec alone and the client falls back to text.
    const snapshot = oneRow<{ snapshot_id: string }>(
      runtime.db,
      "SELECT snapshot_id FROM widget_snapshots WHERE instance_id = ? ORDER BY captured_at DESC LIMIT 1",
      instanceId,
    );
    const bundle =
      snapshot === undefined ? undefined : findBundleForSnapshot(runtime.db, snapshot.snapshot_id, principalId);
    if (bundle !== undefined && bundle.instanceId !== instanceId) {
      // A bundle that names a different instance is a malformed ownership relation, not a bundle.
      return fail(409, "OWNERSHIP_MISMATCH", "the stored bundle does not belong to this instance");
    }
    return json(200, {
      compositionId: spec.compositionId,
      spec,
      bundleRef: bundle?.bundleId ?? null,
      tombstone: bundle?.tombstone ?? null,
      sections: bundle?.sections ?? [],
      capturedAt: bundle?.capturedAt ?? null,
      byteSize: bundle?.byteSize ?? 0,
    });
  }

  // /conversations/:id/pins
  if (segments.length === 3 && segments[2] === "pins" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const instanceId = parsed.value.instanceId;
    if (typeof instanceId !== "string") {
      return fail(400, "INVALID_SCHEMA", "a pin request must name an instanceId");
    }
    const displayMode = parsed.value.displayMode === "expanded" ? "expanded" : "compact";
    const result = pinInstance(services.conductor, { conversationId, instanceId, displayMode });
    if (!result.ok) {
      const status = result.code === "WIDGET_INSTANCE_UNKNOWN" ? 404 : 409;
      return fail(status, result.code, result.message);
    }
    return json(201, { pinId: result.pinId, timeline: buildTimeline(services, { conversationId }) });
  }

  // /conversations/:id/pins/:pinId
  if (segments.length === 4 && segments[2] === "pins" && request.method === "DELETE") {
    const pinId = segments[3];
    if (pinId === undefined) {
      return fail(400, "INVALID_SCHEMA", "a pin route must name a pin");
    }
    const removed = unpinInstance(services.conductor, { conversationId, pinId });
    if (!removed) return fail(404, "RESOURCE_NOT_FOUND", "that pin is not on this conversation");
    // Unpinning is a presentation change. Note data and running jobs are untouched, which
    // is why nothing here cancels a task.
    return json(200, { removed: true, timeline: buildTimeline(services, { conversationId }) });
  }

  return fail(404, "NOT_FOUND", `no handler for ${request.method} ${request.path}`);
}

/**
 * The widget press an approved job names, checked again when the approval is used: the instance must still be in this
 * conversation and the person's, and the binding must still be that instance's `invoke` binding for this capability.
 */
function checkApprovedJobOrigin(
  services: Pick<NodeServices, "runtime" | "conductor">,
  conversationId: string,
  origin: { instanceId: string; actionBindingId: string },
  ref: string,
): { ok: true; bindingGeneration: string } | { ok: false; message: string } {
  const gone = { ok: false as const, message: "the widget this job was approved for is no longer here" };
  if (!instanceIsInConversation(services.runtime.db, { conversationId, instanceId: origin.instanceId })) return gone;
  const instance = getInstance(services.conductor, origin.instanceId);
  if (instance === undefined || instance.ownerPrincipalId !== services.runtime.identity.ownerPrincipalId) return gone;
  if (!instance.actionBindingIds.includes(origin.actionBindingId)) return gone;
  const binding = getActionBinding(services.conductor, origin.actionBindingId);
  if (
    binding?.instanceId !== origin.instanceId ||
    binding.proposal.kind !== "invoke" ||
    binding.proposal.capabilityRef !== ref ||
    binding.packageGeneration === undefined
  ) {
    return { ok: false, message: "the widget action this job was approved for changed" };
  }
  return { ok: true, bindingGeneration: binding.packageGeneration };
}

/**
 * Carry out a decision on an operation the agent asked for.
 *
 * Shared by the HTTP route and the voice session, because "the user approved this" has to mean exactly the
 * same thing in both places: the decider must be a user, the digest the approver saw must match the one
 * stored with the request, the payload comes from the card that displayed it rather than from the caller,
 * and that payload is hashed again before anything runs. A refusal is never a block - a message describing
 * something that did not happen is how a transcript starts lying.
 */
export async function decideApprovalForNode(
  services: Pick<NodeServices, "runtime" | "conductor" | "search" | "projects" | "serviceHost" | "packageJobs" | "turnControl">,
  input: {
    conversationId: string;
    approvalId: string;
    decision: "granted" | "denied";
    digest: string;
    principal: { principalId: string; kind: "user"; nodeId: string };
    at: Instant;
    /**
     * The page that decided, when it can hand an approved widget action to the frame it shows (`WidgetPerformer`).
     * Without it an approved perform is answered "approved, nothing sent": only a live screen reaches a frame.
     */
    perform?: WidgetPerformer;
  },
): Promise<{ ok: true; outcome?: string; continuation?: string; widgetOutput?: string } | { ok: false; code: string; message: string }> {
  const coordination = {
    db: services.runtime.db,
    nodeId: services.runtime.identity.nodeId,
    now: () => input.at as never,
    newId: services.conductor.newId,
  };
  // A task approval has no card - the worker that needed the capability never wrote one - and is decided through
  // its own route (`POST /tasks/:taskId/approvals/:approvalId/decide`), which re-checks the digest against the
  // task itself. `decideApproval`'s row lookup is not scoped by conversation or kind, so without this check a
  // request aimed at this route could still decide a task's approval by id alone.
  const owningTask = oneRow<{ task_id: string | null }>(
    services.runtime.db,
    `SELECT task_id FROM approvals WHERE approval_id = ?`,
    input.approvalId,
  );
  if (owningTask?.task_id !== null && owningTask?.task_id !== undefined) {
    return {
      ok: false,
      code: "APPROVAL_FORGED",
      message: `approval ${input.approvalId} belongs to a task; decide it through POST /tasks/${owningTask.task_id}/approvals/${input.approvalId}/decide`,
    };
  }

  // The payload lives with the card that displayed it, so the operation approved and the operation run are
  // the same record rather than two copies that can drift. It is found before the decision is written: a grant
  // recorded for an operation that then cannot be found would consume the approval and run nothing. The same
  // requirement holds for a denial - without it, any approvalId could be denied through this route regardless of
  // whether its card was ever shown in this conversation, or in any conversation at all.
  const card = blocksOfConversation(services, input.conversationId).find(
    (block) => block.type === "approval-card" && block.approvalId === input.approvalId,
  );
  const payload = card !== undefined && typeof card.payload === "string" ? card.payload : undefined;
  if (payload === undefined) {
    return { ok: false, code: "APPROVAL_PAYLOAD_MISSING", message: "the approved operation is not in this conversation" };
  }
  /*
   * Who asked for the operation, from the host-written card. The person decides it, but the person approved this one
   * effect, not the rest of a program's plan: the records keep who asked, and the turn that carries on after the
   * approval keeps that origin too, so a program's next risky step is still asked about under "Ask me first".
   */
  const askedBy = card?.type === "approval-card" ? turnOriginSchema.safeParse(card.origin).data : undefined;
  const askedByRecord = askedBy === undefined ? {} : { origin: askedBy };

  const decided = decideApproval(coordination, {
    approvalId: input.approvalId as never,
    decision: input.decision,
    decidingPrincipal: input.principal as never,
    seenOperationDigest: input.digest,
  });
  if (!decided.ok) return { ok: false, code: decided.code, message: decided.message };

  const capabilityCall = isCapabilityPayload(payload);
  const tilePolicyChange = isMapTilePolicyPayload(payload);
  const artifactWrite = isWidgetArtifactWritePayload(payload);
  const widgetPerform = isWidgetPerformPayload(payload);
  const channelTool = parseChannelToolPayload(payload);
  const locale = preferredAppIntentLocale({ db: services.runtime.db, now: () => input.at }, services.runtime.identity.ownerPrincipalId);
  if (input.decision === "denied") {
    if (artifactWrite) recordDeniedWidgetArtifactWrite(services, { payload, approvalId: input.approvalId, at: input.at });
    // A record rather than a sentence, because the card reads its decision from the transcript: a refusal written
    // only as text left the card offering Approve and Deny again after it had been denied.
    const say = hostText(locale).tasks;
    const refused = channelTool !== undefined
      ? hostText(locale).channels.toolRefused
      : tilePolicyChange
      ? say.refusedTilePolicy
      : artifactWrite
        ? deniedWidgetArtifactWriteLabel(services, input.at)
        : widgetPerform
          ? locale === "en"
            ? "Refused: the widget was not asked to do it. Nothing was sent."
            : "Đã từ chối: widget không được yêu cầu làm việc đó. Không có gì được gửi."
          : capabilityCall
            ? say.refusedCapability
            : say.refusedCommand;
    appendHostReply(services, {
      conversationId: input.conversationId,
      blocks: [
        {
          type: "tool-activity",
          toolCallId: `deny-${input.approvalId}`,
          name: "decide_approval",
          label: refused,
          status: "done",
          args: { approvalId: input.approvalId, decision: "denied" },
          startedAt: input.at,
          endedAt: input.at,
        },
      ],
      at: input.at,
    });
    return { ok: true };
  }

  if (channelTool !== undefined) {
    return await runApprovedChannelTool(services, {
      payload,
      call: channelTool,
      approvalId: input.approvalId,
      operationDigest: decided.approval.operationDigest,
      conversationId: input.conversationId,
      principal: input.principal,
      at: input.at,
      locale,
    });
  }

  if (tilePolicyChange) {
    // The map tile policy, which Clark may only propose: the person's grant here is what writes it, through the same
    // writer Settings uses, after the card's payload is hashed again against the digest the decision covered.
    const written = runApprovedMapTilePolicy(
      { db: services.runtime.db, now: () => input.at },
      {
        payload,
        expectedDigest: decided.approval.operationDigest,
        approvalId: input.approvalId,
        principalId: services.runtime.identity.ownerPrincipalId,
      },
    );
    if (!written.ok) return { ok: false, code: written.code, message: written.message };
    appendHostReply(services, { conversationId: input.conversationId, blocks: written.blocks, at: input.at });
    appendAuditEvent(services.runtime.db, {
      auditId: services.conductor.newId("audit"),
      principalId: services.runtime.identity.ownerPrincipalId,
      nodeId: services.runtime.identity.nodeId,
      kind: "approval",
      summary: written.description,
      outcome: "done",
      ref: input.approvalId,
      ...askedByRecord,
      at: input.at,
    });
    return { ok: true, outcome: written.description };
  }

  if (artifactWrite) {
    // A widget file write a machine surface carried: the card's payload is hashed again against the digest the decision
    // covered, the widget is checked again, and the write is audited with the surface that asked for it.
    const written = runApprovedWidgetArtifactWrite(services, {
      payload,
      expectedDigest: decided.approval.operationDigest,
      approvalId: input.approvalId,
      conversationId: input.conversationId,
      at: input.at,
    });
    // A failure after the approval was spent still answers the card, so it shows how it ended.
    appendHostReply(services, { conversationId: input.conversationId, blocks: written.blocks, at: input.at });
    if (!written.ok) return { ok: false, code: written.code, message: written.message };
    return { ok: true, outcome: written.description };
  }

  if (widgetPerform) {
    // An action Clark asked a widget to perform, approved on the host's card: the payload is hashed again, the binding,
    // the input and the policy are checked again, and the frame is asked only if a screen still shows it.
    const performed = await runApprovedPerform(services, {
      payload,
      expectedDigest: decided.approval.operationDigest,
      conversationId: input.conversationId,
      principalId: input.principal.principalId,
      perform: input.perform,
      ...askedByRecord,
    });
    if (!performed.ok) {
      // The approval is already spent, so the card is answered here too: without a receipt it would keep offering
      // Approve for a decision the node no longer accepts.
      appendHostReply(services, {
        conversationId: input.conversationId,
        blocks: [
          {
            type: "tool-activity",
            toolCallId: `perform-${input.approvalId}`,
            name: "perform_widget_action",
            label:
              locale === "en"
                ? `Approved, but nothing was performed: the operation changed after it was shown, or could not be read (${performed.code}). Nothing was sent.`
                : `Đã duyệt, nhưng không có gì được thực hiện: thao tác đã đổi sau khi hiện, hoặc không đọc được (${performed.code}). Không có gì được gửi.`,
            status: "failed",
            args: { approvalId: input.approvalId, decision: "granted" },
            startedAt: input.at,
            endedAt: input.at,
          },
        ],
        at: input.at,
      });
      return { ok: false, code: performed.code, message: performed.message };
    }
    const receipt = performReceipt(locale, performed.label, performed.result);
    appendHostReply(services, {
      conversationId: input.conversationId,
      blocks: [
        {
          type: "tool-activity",
          toolCallId: `perform-${input.approvalId}`,
          name: "perform_widget_action",
          label: receipt.text,
          status: receipt.succeeded ? "done" : "failed",
          // The approval id travels with the receipt so the card it answered reads as decided, including after a reload.
          args: { approvalId: input.approvalId, decision: "granted" },
          startedAt: input.at,
          endedAt: new Date().toISOString() as Instant,
        },
      ],
      at: input.at,
    });
    appendAuditEvent(services.runtime.db, {
      auditId: services.conductor.newId("audit"),
      principalId: services.runtime.identity.ownerPrincipalId,
      nodeId: services.runtime.identity.nodeId,
      kind: "approval",
      summary: receipt.text.slice(0, 500),
      outcome: receipt.succeeded ? "done" : "failed",
      ref: input.approvalId,
      ...askedByRecord,
      at: input.at,
    });
    // What the widget answered - its output, or its reason for refusing - kept apart from the host's receipt so a surface
    // that reads it out attributes it to the widget rather than to Clark (`spokenWidgetWords`).
    const output = performed.result.ok
      ? typeof performed.result.body.output === "string"
        ? performed.result.body.output
        : ""
      : performed.result.code === "WIDGET_REFUSED" && typeof performed.result.detail?.widgetMessage === "string"
        ? performed.result.detail.widgetMessage
        : "";
    return { ok: true, outcome: receipt.text, ...(output === "" ? {} : { widgetOutput: output }) };
  }

  if (capabilityCall) {
    // A package's service capability, approved on the same card a command is: the payload is hashed again against
    // the digest the decision covered, and the registry and the input are checked again before the service is called.
    let ledger: ReturnType<typeof actionLedgerHooks> | undefined;
    let invoked: Awaited<ReturnType<typeof runApprovedCapability>>;
    try {
      invoked = await runApprovedCapability(capabilityInvokeDeps(services), {
      payload,
      expectedDigest: decided.approval.operationDigest,
      approvalId: input.approvalId,
      conversationId: input.conversationId,
      checkJobOrigin: (origin, ref) => checkApprovedJobOrigin(services, input.conversationId, origin, ref),
      ...askedByRecord,
      ledger: (call) => {
        ledger = actionLedgerHooks(services, {
          conversationId: input.conversationId,
          principalId: input.principal.principalId,
          intent: `approved ${call.ref}`,
          ref: call.ref,
          args: call.args,
        });
        return ledger.hooks;
      },
      });
    } catch (cause) {
      // Thrown on this node before the call was sent: a service's failure is an answer, not a throw.
      const opened = ledger?.opened();
      if (opened !== undefined) {
        settleActionEffect(services, opened, { kind: "not-sent", reason: cause instanceof Error ? cause.message : String(cause) });
      }
      throw cause;
    }
    if (!invoked.ok) return { ok: false, code: invoked.code, message: invoked.message };
    settleCallOutcome(services, ledger?.opened(), invoked.outcome);
    if (invoked.job?.origin.invocationId !== undefined) {
      // The press that asked keeps one answer: the same invocation id arriving again reads this job, not a new one.
      settleApprovedInvokeJob(services.conductor, {
        invocationId: invoked.job.origin.invocationId,
        instanceId: invoked.job.origin.instanceId,
        actionBindingId: invoked.job.origin.actionBindingId,
        approvalId: input.approvalId,
        jobId: invoked.job.record.jobId,
      });
    }
    appendHostReply(services, { conversationId: input.conversationId, blocks: invoked.blocks, at: input.at });
    appendAuditEvent(services.runtime.db, {
      auditId: services.conductor.newId("audit"),
      principalId: services.runtime.identity.ownerPrincipalId,
      nodeId: services.runtime.identity.nodeId,
      kind: "approval",
      summary: invoked.description,
      outcome: invoked.succeeded ? "done" : "failed",
      ref: input.approvalId,
      ...askedByRecord,
      at: input.at,
    });
    return { ok: true, outcome: invoked.description };
  }

  const ran = await runApprovedCommand({
    payload,
    expectedDigest: decided.approval.operationDigest,
    approvalId: input.approvalId,
    // Re-checked here rather than trusted from the card: the folders this node owns can change between the card being
    // drawn and the decision being made, and this is the moment it matters.
    resources: ownedResourcesFor(services),
    conversationId: input.conversationId,
    // The row it leaves is the host's words, in the language the refusal above would have been written in.
    language: locale,
  });
  if (!ran.ok) return { ok: false, code: ran.code, message: ran.message };

  appendHostReply(services, { conversationId: input.conversationId, blocks: ran.blocks, at: input.at });

  // The approved path is audited here rather than in the runner, because this is where the decision and the outcome
  // are both known: what a person approved, and what came of running it.
  appendAuditEvent(services.runtime.db, {
    auditId: services.conductor.newId("audit"),
    principalId: services.runtime.identity.ownerPrincipalId,
    nodeId: services.runtime.identity.nodeId,
    kind: "command",
    summary: ran.description,
    outcome: ran.outcome.exitCode === 0 && !ran.outcome.timedOut ? "done" : "failed",
    ref: input.approvalId,
    ...askedByRecord,
    at: input.at,
  });

  /*
   * Hand the outcome back to the agent.
   *
   * The turn that proposed this command ended with the card: the model asked, the tool returned an
   * acknowledgement, and the turn was over. Nothing else will ever tell it what happened, so without this the
   * transcript shows a command that ran and an agent that never noticed - a receipt, and then silence, which is
   * exactly what it looked like.
   *
   * The result is fed back as what it is: real output rather than a prediction, with the instruction to carry
   * on. It is a new turn in the same conversation, so it costs a model call, and that cost is the difference
   * between an agent that asked for help and one that stops at the asking.
   */
  const receipt = receiptForModel(ran.blocks);
  const continued = await handleUserMessage(services.conductor, {
    conversationId: input.conversationId as never,
    principal: input.principal as never,
    text: "Lệnh đã được duyệt và đã chạy xong.",
    /*
     * The receipt goes to the model rather than into the transcript.
     *
     * The card above the line already shows the command, its verdict and its output as a code block, and the
     * model needs the output to carry on. Putting it in the message as well printed the same output twice -
     * once in the receipt, once in the message that followed it - which is what a reader complained about.
     */
    note: `${receipt}\n\nĐây là kết quả thật, không phải dự đoán. Hãy tiếp tục công việc đang làm dở.`,
    at: input.at,
    // The turn carries on with the plan of whoever asked for the command, so it keeps their origin: approving one
    // effect is not approving the rest. A card without an origin was raised by the person's own turn.
    origin: askedBy ?? "person",
    // Nobody typed the sentence above: it exists so the turn has a message to answer. Marked, so the transcript draws
    // a quiet line from the host instead of a bubble of words the person never said.
    hostWritten: { kind: "host-continuation", version: HOST_WRITTEN_MESSAGE_VERSION },
  });
  // Indexed where the messages were written, so a continuation is findable like anything else said.
  indexMessages(services.search, {
    conversationId: input.conversationId,
    messages: continued.messages,
    at: input.at,
  });
  const said = continued.messages
    .filter((message) => message.role === "assistant")
    .map((message) => textOfMessage(message))
    .join("\n\n")
    .trim();

  return { ok: true, outcome: ran.description, ...(said === "" ? {} : { continuation: said }) };
}
/**
 * A channel participant's call the owner approved: carried on as the participant's turn, holding that one call.
 *
 * Nothing runs here. The payload is hashed again against the digest the decision covered and the binding read again —
 * its grants are what the turn holds, and a binding that is gone or paused carries nothing on. The turn that follows is
 * a participant's turn like the one that asked (`ChannelTurnAuthority`): none of the owner's context, every other call
 * held as before, and the approved call let through once by the gate, which checks the approval again when it is made.
 * What it answers stays in this conversation; it is not sent back to the channel.
 */
async function runApprovedChannelTool(
  services: Pick<NodeServices, "runtime" | "conductor" | "search">,
  input: {
    payload: string;
    call: ChannelToolPayload;
    approvalId: string;
    operationDigest: string;
    conversationId: string;
    principal: { principalId: string; kind: "user"; nodeId: string };
    at: Instant;
    locale: "vi" | "en";
  },
): Promise<{ ok: true; outcome?: string; continuation?: string } | { ok: false; code: string; message: string }> {
  const say = hostText(input.locale).channels;
  const notRun = (code: string, reason: string): { ok: false; code: string; message: string } => {
    // The approval is spent, so the card is answered here too, or it would keep offering Approve.
    appendHostReply(services, {
      conversationId: input.conversationId,
      blocks: [
        {
          type: "tool-activity",
          toolCallId: `channel-tool-${input.approvalId}`,
          name: input.call.tool,
          label: say.toolApprovedNotRun(reason),
          status: "failed",
          args: { approvalId: input.approvalId, decision: "granted" },
          startedAt: input.at,
          endedAt: input.at,
        },
      ],
      at: input.at,
    });
    return { ok: false, code, message: reason };
  };
  if (channelToolDigest(input.payload) !== input.operationDigest) {
    return notRun("APPROVAL_DIGEST_MISMATCH", "the call changed after it was shown");
  }
  const binding = getChannelBinding(services.runtime.db, input.call.bindingId);
  if (binding === undefined || binding.state !== "active" || binding.conversationId !== input.conversationId) {
    return notRun("CHANNEL_BINDING_UNAVAILABLE", "the chat it was asked from is no longer connected here");
  }
  appendAuditEvent(services.runtime.db, {
    auditId: services.conductor.newId("audit"),
    principalId: services.runtime.identity.ownerPrincipalId,
    nodeId: services.runtime.identity.nodeId,
    kind: "approval",
    summary: `approved ${input.call.tool} for a channel participant`,
    outcome: "done",
    ref: input.approvalId,
    origin: "channel",
    at: input.at,
  });
  const continued = await handleUserMessage(services.conductor, {
    conversationId: input.conversationId as never,
    principal: input.principal as never,
    text: say.toolApprovedLine,
    note: channelToolWords.approvedNote(input.call.tool, canonicalJson(input.call.args)),
    at: input.at,
    origin: "channel",
    channelAuthority: {
      standing: "participant",
      bindingId: binding.bindingId,
      grants: binding.grantRefs,
      approvedCall: { approvalId: input.approvalId, operationDigest: input.operationDigest },
    },
    hostWritten: { kind: "host-continuation", version: HOST_WRITTEN_MESSAGE_VERSION },
  });
  indexMessages(services.search, { conversationId: input.conversationId, messages: continued.messages, at: input.at });
  const said = continued.messages
    .filter((message) => message.role === "assistant")
    .map((message) => textOfMessage(message))
    .join("\n\n")
    .trim();
  return { ok: true, outcome: say.toolApprovedLine, ...(said === "" ? {} : { continuation: said }) };
}

/**
 * Write one server-sent event.
 *
 * The payload is JSON on a single `data:` line rather than a raw string, because a delta can contain
 * a newline and a bare newline ends the event: the reader would then see the rest of the text as a
 * malformed frame and drop it. JSON encodes that character, and the size cost is a few bytes.
 */
function sse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Answer one message, reporting the reply as it is written.
 *
 * `done` carries the same timeline the non-streaming route returns, so the caller replaces its
 * optimistic view with the node's own record rather than keeping two accounts of the conversation.
 * It is sent on every path that produced a message, including a failed model turn: the failure is a
 * host card in the timeline, which is a result and not a stream error. `error` is reserved for the
 * case where there is no message at all, and it is sent on the stream because the status line has
 * long since been written.
 */
async function streamUserMessage(
  services: Pick<NodeServices, "runtime" | "conductor" | "search" | "hostControl" | "widgetPerforms">,
  input: {
    conversationId: string;
    principal: Principal;
    text: string;
    at: Instant;
    attachmentRefs?: readonly AttachmentRef[];
    referenceBlocks?: readonly ReferenceBlock[];
    demo?: boolean;
    surface?: MessageSurface;
    /** The caller runs `widget-perform` events (`performsWidgets`); without it none is sent or waited for. */
    performsWidgets?: boolean;
    origin?: TurnOrigin;
  },
  send: (chunk: string) => void,
): Promise<void> {
  try {
    const outcome = await handleUserMessage(services.conductor, {
      conversationId: input.conversationId as never,
      principal: input.principal,
      text: input.text,
      at: input.at,
      attachmentRefs: input.attachmentRefs ?? [],
      referenceBlocks: input.referenceBlocks ?? [],
      ...(input.demo === true ? { demo: true } : {}),
      ...(input.surface === undefined ? {} : { surface: input.surface }),
      ...(input.origin === undefined ? {} : { origin: input.origin }),
      emit: (event) => {
        // One frame per event the turn produced, named as the turn named it. Translating here would
        // mean two vocabularies for the same facts, and the transcript stores one of them.
        if (event.type === "text-delta") send(sse("delta", { text: event.text }));
        else if (event.type === "reasoning-delta") send(sse("reasoning", { text: event.text }));
        else if (event.type === "tool-start") {
          send(sse("tool-start", { toolCallId: event.toolCallId, name: event.name, label: event.label, args: event.args }));
        } else if (event.type === "tool-end") {
          send(sse("tool-end", { toolCallId: event.toolCallId, status: event.status, result: event.result }));
        } else if (event.type === "host-control") {
          // An agent-issued app-control action, delivered as its own frame rather than folded into a
          // tool-end result: the client's one executor (`runAppIntent`) reads a decision, and the
          // `control_app` tool's own text result stays a report to the model, not a second copy of it.
          // Expected before it is sent: this stream is a live screen that reports what it did, and the
          // tool is waiting to hear it.
          services.hostControl.expect(event.decision);
          send(sse("host-control", { decision: event.decision }));
        } else if (event.type === "widget-perform") {
          // An action Clark asked a widget's frame to perform. Only this page can reach the mounted frame, so it is
          // expected before it is sent, and the dispatch waits for the page's report of what the frame answered. A caller
          // that cannot run one is sent nothing and nothing is expected, so the dispatch hears "nobody to ask" at once.
          if (input.performsWidgets === true) {
            services.widgetPerforms.expect(event.request.performId);
            send(sse("widget-perform", { request: event.request }));
          }
        }
      },
    });

    // Indexed here for the same reason the non-streaming route indexes here: a message that the
    // conversation shows has to be one that search finds, and a crash between the two is the gap
    // this ordering closes.
    indexMessages(services.search, { conversationId: input.conversationId, messages: outcome.messages, at: input.at });

    send(
      sse("done", {
        resolution: outcome.resolution,
        taskId: outcome.taskId ?? null,
        messageIds: outcome.messages.map((message) => message.messageId),
        timeline: buildTimeline(services, { conversationId: input.conversationId }),
      }),
    );
  } catch (cause) {
    send(
      sse("error", {
        code: "TURN_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }
}

/**
 * Raw command envelope route.
 *
 * Kept alongside the conversation routes because the envelope is the durable, idempotent
 * path: a client that must not double-execute sends here, and the same `idempotencyKey`
 * is what makes a retry safe.
 */
export function handleRawCommand(deps: RawCommandRouteDeps): GatewayResponse {
  const { request, at } = deps;
  const { services } = deps;
  const { runtime } = services;

  const parsed = readJson(request);
  if (!parsed.ok) return parsed.response;

  const envelope = commandEnvelopeSchema.safeParse(parsed.value);
  if (!envelope.success) {
    return fail(400, "INVALID_SCHEMA", "the command envelope does not match the contract", {
      issues: envelope.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }

  return json(202, {
    accepted: true,
    commandId: envelope.data.commandId,
    // Derived from the authenticated channel, never from the body.
    principal: {
      principalId: runtime.identity.ownerPrincipalId,
      kind: "user",
      nodeId: runtime.identity.nodeId,
    },
    receivedAt: at(),
    note: "accepted for durable processing; this is not an outcome",
  });
}
