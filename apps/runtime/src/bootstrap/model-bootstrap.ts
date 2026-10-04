import { join } from "node:path";

import { instantSchema, type TurnOrigin } from "@clarkcant/contracts";

import { directoryIndexPath, readPersonalInstructions } from "@clarkcant/core";
import { SAMPLE_DATASET } from "@clarkcant/data-canvas/sample";
import { credentialNames, getNotification, latestMessages, readPreference } from "@clarkcant/storage";

import { preferredAppIntentLocale } from "../app-intents.ts";
import { capabilityInvokeDeps } from "../application/capability-invoke.ts";
import { packageInstallDepsOf } from "../application/package-install.ts";
import { readThemeRegistry, themeRegistryDeps } from "../application/themes.ts";
import { attachmentRefsForLastUserMessage } from "../attachments.ts";
import { referenceBrief, referencesForLastUserMessage } from "../composer-references.ts";
import { type BrowserTaskToolDeps, personTextOf } from "../browser-task-tool.ts";
import { readInbox } from "../inbox.ts";
import { type InteractionDeps } from "../interactions.ts";
import { decideModelRoute } from "../jev-decider.ts";
import { readCurrentAlias, readModelPool } from "../model-registry.ts";
import { filterBackgroundCandidates, routeBackgroundModel, toolCallsIn } from "../model-router.ts";
import { type ModelTurn, type ViewDescriptor, createModelTurn } from "../model-turn.ts";
import type { Runtime } from "../node.ts";
import { createNodeTools, type CommandToolDeps } from "../node-tools.ts";
import { askPeerCapabilities } from "../peer-capabilities.ts";
import { type ProjectFinderDeps, resolveProject } from "../project-finder.ts";
import { ownedResources } from "../preflight.ts";
import type { RequestSecretDeps } from "../request-secret.ts";
import { registerSessionFile } from "../session-store.ts";
import { type NodeServices } from "../services.ts";
import { registerNodeTools } from "../tool-catalogue.ts";
import { conversationUiContext } from "../widget-semantic.ts";
import { contextWiring } from "./context-wiring.ts";

/**
 * The model turn, and everything it reads from the node.
 *
 * Built before the services are, because whether this node has a model decides how the conductor is assembled. The
 * seams that therefore cannot be values yet - the session store, the search index, the project finder, the command
 * path, the interaction manager, the secret broker - are getters, and every one of them is called only once a turn
 * runs, long after the node is built.
 *
 * Two reads are deliberately lazy for a second reason: the model a person chose and the instructions they wrote are
 * read per turn rather than captured at boot, so a change made in Settings reaches the next turn instead of the next
 * start.
 *
 * `undefined` is a real answer: a node with no provider answers from scripts and capabilities only, and it says so at
 * startup rather than failing a turn later.
 */

/**
 * The seams the node publishes after it is built.
 *
 * A getter per seam rather than one object, because the node wires each of them at a different point and none of them
 * exists when this module is called.
 */
export interface ModelWiring {
  sessionIndex: () => NodeServices["sessions"] | undefined;
  sessionPrincipalId: () => string | undefined;
  search: () => NodeServices["search"] | undefined;
  projects: () => ProjectFinderDeps | undefined;
  command: () => CommandToolDeps | undefined;
  interactions: (conversationId: string) => InteractionDeps | undefined;
  secrets: () => RequestSecretDeps | undefined;
}

export interface ModelBootstrapDeps {
  env: Record<string, string | undefined>;
  dataDir: string;
  /** The runtime opened by the entry point, so one database file is one connection. */
  runtime: Runtime;
  /** The node, read inside the callbacks that run after it exists. */
  services: () => NodeServices;
  /** The views the model may show, filled before a turn runs. */
  viewCatalog: () => readonly ViewDescriptor[];
  wiring: ModelWiring;
}

/**
 * What `start_browser_task` needs, or nothing when the tool is not to be offered.
 *
 * Offered only by a node that runs background tasks and whose dispatched workers run its model: without both, the tool
 * could start a task but nothing could ever do the work, which is a control that cannot do what it says. The sites a
 * task may act on are checked against what the person wrote on their own surfaces in this conversation, read back when
 * the tool is called.
 */
export function browserTaskToolDepsFor(
  services: NodeServices,
  turn: { principalId: string; conversationId: string; origin?: () => TurnOrigin | undefined },
): BrowserTaskToolDeps | undefined {
  if (services.taskDispatch?.workersRunAModel() !== true) return undefined;
  return {
    tasks: {
      db: services.runtime.db,
      nodeId: services.runtime.identity.nodeId,
      now: () => instantSchema.parse(new Date().toISOString()),
      newId: services.conductor.newId,
    },
    principalId: turn.principalId,
    conversationId: turn.conversationId,
    personText: () =>
      personTextOf(latestMessages(services.runtime.db, turn.conversationId, 30), services.runtime.identity.nodeId),
    dispatcher: () => services.taskDispatch,
    // The interface language the person chose, so a refusal names the setting in the words Settings shows them.
    language: () =>
      preferredAppIntentLocale(
        { db: services.runtime.db, now: () => instantSchema.parse(new Date().toISOString()) },
        turn.principalId,
      ),
    ...(turn.origin === undefined ? {} : { origin: turn.origin }),
  };
}

/**
 * Every model a dispatched worker could be started on: the one this node runs, which is where routing falls back, and
 * every enabled profile of the pool routing chooses among.
 */
export function workerModelCandidates(
  services: NodeServices,
  configured: { provider: string; id: string } | undefined,
): { provider: string; id: string }[] {
  const pool = readModelPool(services.runtime.db, services.runtime.identity.ownerPrincipalId);
  return [
    ...(configured === undefined ? [] : [{ provider: configured.provider, id: configured.id }]),
    ...pool.profiles.filter((profile) => profile.enabled).map((profile) => ({ provider: profile.provider, id: profile.modelId })),
  ];
}

/**
 * Which model a background worker runs.
 *
 * Deterministic filters first — the pool's own settings, the credentials this node has, provider health, context and
 * tool needs — and only then the policy layer, which may choose among what survived. When nothing is eligible, or
 * when the policy layer cannot be reached, this returns nothing and the worker runs what the node is configured
 * with: routing must never be the reason a job does not start. A configured model the catalogue states cannot call
 * tools is then refused by the dispatcher before its worker starts, rather than here.
 */
export async function routeNodeBackgroundModel(
  services: NodeServices,
): Promise<{ provider: string; id: string } | undefined> {
  const owner = services.runtime.identity.ownerPrincipalId;
  const pool = readModelPool(services.runtime.db, owner);
  if (pool.profiles.length === 0) return undefined;
  const catalogue = await (services.modelCatalogue?.() ?? Promise.resolve([]));
  const credentials = credentialNames(services.runtime.db, owner);
  const currentAlias = readCurrentAlias(services.runtime.db, owner);

  const filtered = filterBackgroundCandidates({
    pool,
    // The mapping from a provider to the name its credential is stored under is the adapter's business; until it
    // exposes one, a provider counts as credentialed when it is the one this node runs, or when a credential is
    // stored under the provider's own name.
    hasCredential: (provider) => services.model?.provider === provider || credentials.includes(provider),
    isHealthy: () => true,
    contextWindowFor: (provider, modelId) =>
      catalogue.find((entry) => entry.id === provider)?.models.find((model) => model.id === modelId)?.contextWindow,
    // What the catalogue states, and unknown where it states nothing: filtering on a guess would empty the pool on any
    // installation whose catalogue is thin, so only a stated "no" leaves a profile out.
    supportsTools: (provider, modelId) => toolCallsIn(catalogue, provider, modelId),
    needsTools: true,
  });

  const decider = services.projects.decider;
  const routed = await routeBackgroundModel({
    eligible: filtered.eligible,
    ...(decider === undefined
      ? {}
      : {
          decide: async (candidates) =>
            await decideModelRoute(decider, { task: "background worker", role: "background", candidates }),
        }),
    ...(currentAlias === undefined ? {} : { foregroundAlias: currentAlias }),
    // Checked after the decision as well as before it: a pool can change while a selector is thinking.
    verify: (alias) => pool.profiles.some((profile) => profile.alias === alias && profile.enabled),
  });
  return routed === undefined ? undefined : { provider: routed.provider, id: routed.modelId };
}
/**
 * Build the model turn, or `undefined` when this node has no model.
 */
export async function createNodeModelTurn(deps: ModelBootstrapDeps): Promise<ModelTurn | undefined> {
  const chosenModel = (): { provider: string; id: string } | undefined => {
    const stored = readPreference(deps.runtime.db, deps.runtime.identity.ownerPrincipalId, "model", "node");
    const [provider, id] = (stored ?? "").split("/");
    return provider === undefined || provider === "" || id === undefined || id === ""
      ? undefined
      : { provider, id };
  };

  const context = contextWiring({
    env: deps.env,
    db: () => deps.services().runtime.db,
    ownerPrincipalId: () => deps.services().runtime.identity.ownerPrincipalId,
    historyPrincipalId: () => deps.wiring.search()?.principalId,
    decider: () => deps.services().projects.decider,
    newId: (prefix) => deps.services().conductor.newId(prefix),
  });

  const modelTurn = await createModelTurn({
    env: deps.env,
    cwd: process.cwd(),
    model: chosenModel,
    backgroundModel: async () => await routeNodeBackgroundModel(deps.services()),

    /*
     * The user's own instructions, read on every turn rather than captured here.
     *
     * The same laziness as `chosenModel`, for the same ordering reason and one more: the promise of the
     * feature is that a preference written while the app is open reaches the next turn. A value captured at
     * boot would make it a restart instead.
     *
     * `readPersonalInstructions` answers nothing unless the toggle is on and there is text, so a disabled
     * preference leaves the system prompt byte-for-byte as it was rather than adding an empty section.
     */
    personalInstructions: () =>
      readPersonalInstructions(
        { db: deps.runtime.db, now: () => new Date().toISOString() as never },
        deps.runtime.identity.ownerPrincipalId,
      ),
    sessionDir: join(deps.dataDir, "sessions"),
    onSessionFile: ({ sessionId, sessionFile }) => {
      const index = deps.wiring.sessionIndex();
      const principalId = deps.wiring.sessionPrincipalId();
      if (index === undefined || principalId === undefined) return;
      const registered = registerSessionFile(index, {
        sessionId,
        principalId,
        path: sessionFile,
      });
      if (!registered.ok) {
        process.stderr.write(`session ${sessionId}: ${registered.message}\n`);
      }
    },
    views: () => deps.viewCatalog(),
    // The recap, its focus, the memory brief, background retrieval and tool disclosure (#433); see `contextWiring`.
    ...context,
    // The files the current message carries, read back from the row that message was stored as. The
    // timeline and this prompt are then the same reading, so a conversation reopened tomorrow attaches
    // the same files to the same turn. `attachmentBrief` inlines a text file's content and names anything
    // binary by id; no path is ever part of it.
    attachments: {
      dataDir: deps.dataDir,
      refsFor: (conversationId) =>
        attachmentRefsForLastUserMessage({ db: deps.services().runtime.db, conversationId }),
    },
    // What the current message points at, read back from its stored row like the attachments above. A skill's
    // instructions are read through the adapter this turn runs on, so they are the installation's words, checked
    // against the version the message named.
    references: {
      briefFor: (conversationId, skillBody) =>
        referenceBrief({
          blocks: referencesForLastUserMessage({ db: deps.services().runtime.db, conversationId }),
          projects: deps.services().projects,
          skillBody,
          notice: (noticeId) =>
            getNotification(deps.services().runtime.db, deps.services().runtime.identity.ownerPrincipalId, noticeId)?.notice,
        }),
    },
    // The node registers the sample dataset itself, so this is the complete set it holds rather
    // than a guess. The model is told these names because a view over data that is not there
    // renders as nothing, which reads as a broken widget instead of a missing fact.
    datasetRefs: () => [SAMPLE_DATASET.datasetId],
    /*
     * What the widgets the person changed now mean, read when a turn starts (#195).
     *
     * Rebuilding them here is what turns the edits since the last turn into one change or none; changing a widget
     * never calls a model, it only marks the widget as touched.
     */
    uiContext: (conversationId) => conversationUiContext(deps.services().conductor, conversationId),
    // The Session Manager's search surface, exposed to the main model as its own tool. Read from a
    // closure so the services it needs, which are assembled below, exist by the time a turn runs.
    // The Session Manager's read-only reports, including the project finder. Built by a function a
    // test can call: an inline list here is how `find_project` came to exist without ever being
    // registered, and nothing could see the difference.
    extraTools: (turn) => {
      const search = deps.wiring.search();
      const projects = deps.wiring.projects();
      const command = deps.wiring.command();
      if (search === undefined || projects === undefined || command === undefined) return [];
      const interactions = deps.wiring.interactions(turn.conversationId);
      const secrets = deps.wiring.secrets();
      const browserTasks = browserTaskToolDepsFor(deps.services(), {
        principalId: search.principalId,
        conversationId: turn.conversationId,
        origin: turn.origin,
      });
      const tools = createNodeTools({
        search,
        projects,
        command,
        // Who asked for the turn, read per call: the command and terminal tools hand it to the execution policy.
        origin: turn.origin,
        // The main agent's app-control channel: the same contract and audit trail a click or a typed
        // command uses, with `source: "agent"` on the record so the two are never indistinguishable
        // after the fact. `onEvent` is read lazily because this tool list is built once per session, not
        // once per message — see the getter's own doc in `model-turn.ts`.
        appControl: {
          db: deps.services().runtime.db,
          nodeId: deps.services().runtime.identity.nodeId,
          now: () => instantSchema.parse(new Date().toISOString()),
          newId: deps.services().conductor.newId,
          principalId: search.principalId,
          conversationId: turn.conversationId as never,
          onEvent: turn.onEvent,
          channel: turn.channel,
          hostControl: deps.services().hostControl,
          themes: () => readThemeRegistry(themeRegistryDeps(deps.services())),
        },
        // Reading an attached file is scoped to the conversation this turn belongs to, which is the
        // only thing the tool needs to check beyond the principal.
        attachments: { dataDir: deps.dataDir, conversationId: turn.conversationId },
        // "What are you still doing" and "stop that" are asked in the conversation, so they are answered from it.
        work: { conversationId: turn.conversationId },
        // And the same conversation is what a question is recorded against, which is why this is built from
        // the turn rather than once for the node.
        ...(interactions === undefined ? {} : { interactions }),
        ...(secrets === undefined ? {} : { secrets }),
        /*
         * Where a command that runs without a card leaves its record in the effect ledger.
         *
         * The same event log the task lifecycle writes to, because autonomy is only checkable if the
         * effects it performed are findable afterwards. The trail in audit_log is the other half of that
         * story: who asked for what, and how it came out.
         *
         * The clock is read here rather than captured when the node booted, because the promise of this
         * setting is that it changes what happens next.
         */
        effectAudit: () => ({
          deps: {
            db: deps.services().runtime.db,
            nodeId: deps.services().runtime.identity.nodeId,
            newId: deps.services().conductor.newId,
            now: () => instantSchema.parse(new Date().toISOString()),
          },
          principalId: search.principalId,
          conversationId: turn.conversationId,
        }),
        /* The card's id has to outlive the turn, so it comes from the node's own id generator. */
        questions: { newId: deps.services().conductor.newId },
        // Terminals opened from this turn belong to its conversation; the card id comes from the node like a question's.
        terminals: {
          registry: deps.services().terminals,
          newId: deps.services().conductor.newId,
          conversationId: turn.conversationId,
        },
        // Always passed: an unconfigured directory is something the tool reports, not a reason to hide it.
        directory: { indexPath: directoryIndexPath(deps.env), newId: deps.services().conductor.newId },
        // Remembering is scoped to the turn's conversation the same way, and the id comes from the node's own
        // generator: the model supplies what to remember, never who it belongs to.
        memory: { conversationId: turn.conversationId, newId: deps.services().conductor.newId },
        // "Anything waiting for me?" is answered from the same read the inbox panel makes, at the moment it is asked.
        inbox: () => readInbox(deps.services(), instantSchema.parse(new Date().toISOString())),
        // "Dismiss that", "try it again", said to either agent: the same action the inbox's own buttons and routes take.
        notices: {
          services: deps.services,
          now: () => instantSchema.parse(new Date().toISOString()),
          conversationId: turn.conversationId,
          channel: turn.channel,
        },
        // What the widgets the person changed show now, read from the same documents the turn's UI note is built from.
        ui: { deps: () => deps.services().conductor, conversationId: turn.conversationId },
        // "From now on, when X happens, do Y": kept for the owner, reporting in the conversation it was set up in, and
        // given only folders this node owns — the same set the dispatcher checks again before a worker starts.
        automations: {
          db: deps.services().runtime.db,
          nodeId: deps.services().runtime.identity.nodeId,
          principalId: search.principalId,
          ownerPrincipalId: deps.services().runtime.identity.ownerPrincipalId,
          conversationId: turn.conversationId,
          now: () => instantSchema.parse(new Date().toISOString()),
          newId: deps.services().conductor.newId,
          ownedRoots: () =>
            ownedResources([...deps.services().projects.roots(), deps.services().runtime.dataDir, process.cwd()]).roots,
          kick: () => deps.services().automation?.kick(),
          kickDelivery: () => deps.services().peerDelivery?.kick(),
          fingerprint: deps.services().runtime.identity.fingerprint,
          peerCapabilities: (peerNodeId) => askPeerCapabilities(deps.services().runtime, peerNodeId),
        },
        // "Do this on example.com": a browser task, offered only where its worker runs a model (see the function).
        ...(browserTasks === undefined ? {} : { browserTasks }),
        // The same action as the Settings buttons, so a spoken or typed "uninstall it" and a click are one path.
        packages: {
          packages: packageInstallDepsOf(deps.services()),
          connections: deps.services().connections,
          conversationId: turn.conversationId,
          channel: turn.channel,
          origin: turn.origin,
        },
        // The same path a widget button takes, so "add a note" typed or said and a click are one action.
        capabilities: {
          deps: () => capabilityInvokeDeps(deps.services()),
          conversationId: turn.conversationId,
          channel: turn.channel,
          origin: turn.origin,
          // A long-running capability starts through this conversation's widget binding to it, which follows the job.
          widgets: () => deps.services(),
        },
        // "Show map tiles from X" or "turn map tiles off": the same write Settings makes, as the execution policy decides.
        mapTiles: {
          deps: () => ({
            db: deps.services().runtime.db,
            nodeId: deps.services().runtime.identity.nodeId,
            now: () => instantSchema.parse(new Date().toISOString()),
            newId: deps.services().conductor.newId,
            principalId: deps.services().runtime.identity.ownerPrincipalId,
          }),
          conversationId: turn.conversationId,
          channel: turn.channel,
          origin: turn.origin,
        },
        // "Where should this go?" goes through the finder, which is where Jev decides when several folders
        // could be meant. The model is told to look before it proposes, and an ambiguous answer comes back
        // as a question rather than as a guess.
        resolveFolder: async (intent) => {
          const resolution = await resolveProject(projects, { intent });
          if (resolution.status === "resolved") {
            return { status: "resolved", cwd: resolution.project.path, relPath: resolution.relPath };
          }
          if (resolution.status === "clarify") {
            return { status: "ask", message: resolution.question, options: resolution.options };
          }
          return {
            status: "ask",
            message: resolution.status === "rejected" ? resolution.message : resolution.question,
            options: [],
          };
        },
      });
      // Published for the Tools tab, from the same call that hands them to the model: a tab that built its own list
      // would be a second source of truth for what this node can do, and the first thing to drift from it.
      registerNodeTools(tools.map((tool) => ({ name: tool.name, label: tool.label, description: tool.description })));
      return tools;
    },
  });
  process.stderr.write(
    modelTurn === undefined
      ? "no model configured; the node will answer with scripts and capabilities only\n"
      : `model: ${modelTurn.selection.provider}/${modelTurn.selection.id}` +
          ` (turn limit ${modelTurn.budget.maxWallClockMs} ms, ${modelTurn.budget.maxTokens} tokens)\n`,
  );

  return modelTurn;
}
