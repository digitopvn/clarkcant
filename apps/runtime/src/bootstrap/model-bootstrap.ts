import { join } from "node:path";

import { instantSchema, type MessageRecord } from "@clarkcant/contracts";
import { directoryIndexPath, readPersonalInstructions } from "@clarkcant/core";
import { SAMPLE_DATASET } from "@clarkcant/data-canvas/sample";
import { credentialNames, messagesSince, readPreference } from "@clarkcant/storage";

import { attachmentRefsForLastUserMessage } from "../attachments.ts";
import { type InteractionDeps } from "../interactions.ts";
import { decideModelRoute } from "../jev-decider.ts";
import { memoryBrief } from "../memory.ts";
import { readCurrentAlias, readModelPool } from "../model-registry.ts";
import { filterBackgroundCandidates, routeBackgroundModel } from "../model-router.ts";
import { type ModelTurn, type ViewDescriptor, createModelTurn } from "../model-turn.ts";
import type { Runtime } from "../node.ts";
import { createNodeTools, type CommandToolDeps } from "../node-tools.ts";
import { type ProjectFinderDeps, resolveProject } from "../project-finder.ts";
import type { RequestSecretDeps } from "../request-secret.ts";
import { textOfMessage } from "../session-search.ts";
import { registerSessionFile } from "../session-store.ts";
import { type NodeServices } from "../services.ts";
import { registerNodeTools } from "../tool-catalogue.ts";

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

  /**
   * Which model a background worker runs.
   *
   * Deterministic filters first — the pool's own settings, the credentials this node has, provider health, context and
   * tool needs — and only then the policy layer, which may choose among what survived. When nothing is eligible, or
   * when the policy layer cannot be reached, this returns nothing and the worker runs what the node is configured
   * with: routing must never be the reason a job does not start.
   */
  const routeBackground = async (): Promise<{ provider: string; id: string } | undefined> => {
    const owner = deps.services().runtime.identity.ownerPrincipalId;
    const pool = readModelPool(deps.services().runtime.db, owner);
    if (pool.profiles.length === 0) return undefined;
    const catalogue = await (deps.services().modelCatalogue?.() ?? Promise.resolve([]));
    const credentials = credentialNames(deps.services().runtime.db, owner);
    const currentAlias = readCurrentAlias(deps.services().runtime.db, owner);

    const filtered = filterBackgroundCandidates({
      pool,
      // The mapping from a provider to the name its credential is stored under is the adapter's business; until it
      // exposes one, a provider counts as credentialed when it is the one this node runs, or when a credential is
      // stored under the provider's own name.
      hasCredential: (provider) => deps.services().model?.provider === provider || credentials.includes(provider),
      isHealthy: () => true,
      contextWindowFor: (provider, modelId) =>
        catalogue.find((entry) => entry.id === provider)?.models.find((model) => model.id === modelId)?.contextWindow,
      // Unknown rather than false: this build cannot confirm tool support per model, and filtering on a guess would
      // empty the pool on any installation whose catalogue is thin.
      supportsTools: () => undefined,
      needsTools: true,
    });

    const decider = deps.services().projects.decider;
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
  };

  const modelTurn = await createModelTurn({
    env: deps.env,
    cwd: process.cwd(),
    model: chosenModel,
    backgroundModel: routeBackground,

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
    // The conversation so far, for a session that has just been created.
    //
    // A session is dropped when a turn fails, because a session that failed a turn is the thing that is broken;
    // the thread is not, so the next message is answered by an agent that has been told what it is joining
    // rather than by one that has never heard of it.
    history: async (conversationId) => {
      const records = messagesSince(deps.services().runtime.db, conversationId, 0, 40);
      return records
        .filter((record): record is MessageRecord & { role: "user" | "assistant" } => record.role === "user" || record.role === "assistant")
        .map((record) => ({ role: record.role, text: textOfMessage(record) }));
    },
    // The files the current message carries, read back from the row that message was stored as. The
    // timeline and this prompt are then the same reading, so a conversation reopened tomorrow attaches
    // the same files to the same turn. `attachmentBrief` inlines a text file's content and names anything
    // binary by id; no path is ever part of it.
    attachments: {
      dataDir: deps.dataDir,
      refsFor: (conversationId) =>
        attachmentRefsForLastUserMessage({ db: deps.services().runtime.db, conversationId }),
    },
    // The node registers the sample dataset itself, so this is the complete set it holds rather
    // than a guess. The model is told these names because a view over data that is not there
    // renders as nothing, which reads as a broken widget instead of a missing fact.
    datasetRefs: () => [SAMPLE_DATASET.datasetId],
    /*
     * What was remembered, for the turn about to run.
     *
     * Read per turn rather than captured once, so a record somebody deletes in the Memory tab stops being
     * sent on the very next turn. That is what makes that screen's promise true rather than decorative.
     */
    memoryBrief: (conversationId) =>
      memoryBrief(
        { db: deps.services().runtime.db, now: () => new Date().toISOString(), newId: deps.services().conductor.newId },
        { principalId: deps.services().runtime.identity.ownerPrincipalId, conversationId },
      ),
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
      const tools = createNodeTools({
        search,
        projects,
        command,
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
        },
        // Reading an attached file is scoped to the conversation this turn belongs to, which is the
        // only thing the tool needs to check beyond the principal.
        attachments: { dataDir: deps.dataDir, conversationId: turn.conversationId },
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
        // Always passed: an unconfigured directory is something the tool reports, not a reason to hide it.
        directory: { indexPath: directoryIndexPath(deps.env), newId: deps.services().conductor.newId },
        // Remembering is scoped to the turn's conversation the same way, and the id comes from the node's own
        // generator: the model supplies what to remember, never who it belongs to.
        memory: { conversationId: turn.conversationId, newId: deps.services().conductor.newId },
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
