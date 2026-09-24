import { type Instant } from "@clarkcant/contracts";
import { type CoordinationDeps, readExecutionPolicy } from "@clarkcant/core";
import { appendAuditEvent } from "@clarkcant/storage";

import { DEFAULT_NARROWING } from "../autonomy-settings.ts";
import { machineRoots } from "../fs-search.ts";
import { interactionDepsFor } from "../gateway.ts";
import { guardOperation } from "../jev-decider.ts";
import { type InteractionDeps } from "../interactions.ts";
import { createModelCatalogue, type ModelTurn, type ViewDescriptor } from "../model-turn.ts";
import { type CommandToolDeps } from "../node-tools.ts";
import { ownedResources } from "../preflight.ts";
import { refreshProjectIndex } from "../project-finder.ts";
import { startExpiryNoticeSweep } from "../expiry-notices.ts";
import { tryRecordNodeNotice, workerSettledNotice } from "../notices.ts";
import { appendHostReply } from "../routes/conversations.ts";
import { createSecretBroker } from "../secret-broker.ts";
import { type RequestSecretDeps } from "../request-secret.ts";
import { sessionsDirectory } from "../session-store.ts";
import { type NodeServices } from "../services.ts";
import type { NodeWork } from "./work-bootstrap.ts";
import { createTaskDispatcher } from "../task-dispatch.ts";
import { startUpdateCheckTimer } from "../update-checks.ts";
import { buildViewCatalog } from "../view-catalog.ts";
import { type FixtureGates } from "./fixtures.ts";

/**
 * The wiring that runs once the node exists.
 *
 * The conductor is assembled with the model turn already in hand, but a turn reads most of what the node owns only
 * when a message arrives - the session store, the search index, the project finder, the command path, the
 * interaction manager, the secret broker. This is where each of those is published, after `bootNodeServices` has
 * returned, which is the first moment any of them exists.
 *
 * Nothing here changes what a route sees: the same fields are assigned in the same order as they were when this was
 * the middle of `main.ts`, including the startup lines and the bounded project index scan, which is started here
 * rather than awaited so the node is listening while it runs.
 */

/** The mutable seams this module fills in, and the model turn reads back through getters. */
export interface RuntimeWiring {
  session: { index?: NodeServices["sessions"]; principalId?: string };
  search: { deps?: NodeServices["search"] };
  project: { deps?: NodeServices["projects"] };
  approval: { deps?: CoordinationDeps };
  command: { deps?: CommandToolDeps };
  interaction: { deps?: (conversationId: string) => InteractionDeps };
  secret: { deps?: RequestSecretDeps };
  model: { compose?: NodeServices["compose"] };
}

/** One empty seam per wiring, so the entry point never builds one of these itself. */
export function createRuntimeWiring(): RuntimeWiring {
  return { session: {}, search: {}, project: {}, approval: {}, command: {}, interaction: {}, secret: {}, model: {} };
}

/**
 * What the scripted composition offers here, typed structurally so this module never names `test-support/`.
 *
 * Each seam is called under a gate the entry point read from the environment, so a node without a gate is never
 * handed this object and no fixture code is reached.
 */
export interface ScriptedRuntimeSeams {
  arrangeModelNode: (input: { services: NodeServices; dataDir: string }) => void;
  applyScriptedTurnControl: (services: Pick<NodeServices, "turnControl">) => void;
  applyScriptedBackgroundControl: (services: NodeServices) => void;
}

export interface RuntimeBootstrapDeps {
  services: NodeServices;
  dataDir: string;
  wiring: RuntimeWiring;
  /** Read once, so a node either says it is running a fixture or it does not. */
  gates: FixtureGates;
  fixtures: ScriptedRuntimeSeams | undefined;
  modelTurn: ModelTurn | undefined;
  /** Filled here, so the model may show a surface from its first turn. */
  viewCatalog: ViewDescriptor[];
  /** The node's work supervisor and journal (`work-bootstrap.ts`); absent in a caller that runs no supervisor. */
  work?: NodeWork;
}

/** What `wireRuntime` starts that the entry point has to stop again when the node closes. */
export interface RuntimeHandles {
  /** Stops the periodic update-check timer (§ update-checks.ts). A no-op on a fixture node, which never starts one. */
  stopUpdateChecks: () => void;
}

/**
 * Publish every seam the node owns, and report what the node is.
 */
export function wireRuntime(deps: RuntimeBootstrapDeps): RuntimeHandles {
  const { wiring } = deps;
  const modelTurn = deps.modelTurn;
  const modelFixture = deps.gates.model;
  const sessionFixture = deps.gates.session;
  const fixtures = deps.fixtures;

  wiring.session.index = deps.services.sessions;
  wiring.session.principalId = deps.services.runtime.identity.ownerPrincipalId;
  wiring.search.deps = deps.services.search;
  // The turn control the gateway needs to answer a message that arrives while something is running. Assigned here
  // rather than passed into bootNodeServices, because the model turn is built above and the services just below it,
  // and this is the first line where both exist.
  if (modelTurn !== undefined) {
    deps.services.turnControl = {
      running: () => modelTurn.running(),
      interrupt: (conversationId) => modelTurn.interrupt(conversationId),
      steer: (conversationId, text) => modelTurn.steer(conversationId, text),
      runInBackground: (input) => modelTurn.runInBackground(input),
      runningMs: (conversationId) => modelTurn.runningMs(conversationId),
    };
    // The same line, for the same reason: the adapter exists above this and the services below it.
    deps.services.extensions = modelTurn.extensions;
    deps.services.piSettings = modelTurn.piSettings;
  }
  /*
   * A turn control for a fixture node.
   *
   * Starting a background session is the one path a node cannot answer from a recipe: it goes through the turn control,
   * which only exists when a model turn does — and a fixture node has none by design, because it answers with scripts
   * rather than a provider. Without this, the browser half of that path is untestable: the client would report the
   * node's refusal, which is correct behaviour and not the thing a test of the selection menu should be measuring.
   *
   * It is not a model. It says so, waits a moment, and answers with a fixture sentence. The wait is the point: a session
   * that starts and finishes inside the same millisecond is a session no client can ever draw, and drawing it — the
   * chip in the header, the reply in the conversation — is exactly what the browser test asserts.
   */
  if (modelFixture) {
    fixtures?.applyScriptedTurnControl(deps.services);
  }

  /*
   * The catalogue is published whether or not a turn exists, because it is how a node stops having no model: the
   * picker that fills that gap reads it, and publishing it only alongside a turn is what left every fresh node with an
   * empty list and no way to choose. Published as a function rather than a snapshot, so a provider added by upgrading
   * pi is visible without restarting the node.
   *
   * Not on a fixture node. That one deliberately reports no model and no catalogue, and other journeys assert exactly
   * that; reading whatever pi the machine running the suite happens to have would also make the suite depend on the
   * machine it runs on.
   */
  if (modelTurn !== undefined) {
    deps.services.modelCatalogue = modelTurn.catalogue;
  } else if (!modelFixture) {
    deps.services.modelCatalogue = createModelCatalogue({ cwd: process.cwd() });
  }
  wiring.project.deps = deps.services.projects;
  wiring.approval.deps = {
    db: deps.services.runtime.db,
    nodeId: deps.services.runtime.identity.nodeId,
    now: () => new Date().toISOString() as never,
    // The conductor's own id generator, so an approval id looks like every other id this node writes.
    newId: deps.services.conductor.newId,
  };
  wiring.command.deps = {
    // Omitted when the node has no approval route at all, so `confirm` refuses honestly instead of
    // throwing from inside the tool.
    ...(wiring.approval.deps === undefined ? {} : { approvals: () => wiring.approval.deps as CoordinationDeps }),
    // The one canonical reader, at the proposal rather than at boot: a mode change has to change what happens to
    // the next command, not the next process. It answers whether or not this node has ever stored a policy — a node
    // that stored one of the two legacy families gets that family, joined pointwise and stored.
    autonomy: () =>
      readExecutionPolicy(
        { db: deps.services.runtime.db, now: () => new Date().toISOString() as Instant },
        deps.services.runtime.identity.ownerPrincipalId,
      ),
    // The folders this node owns, which is the whole of the containment check: the workspace roots from
    // settings, the node's own data directory, and the directory the operator launched it from. The last
    // one matters because a node started inside a checkout is being pointed at that checkout by a person.
    resources: () => ownedResources([...deps.services.projects.roots(), deps.services.runtime.dataDir, process.cwd()]),
    fallbackCwd: () => process.cwd(),
    // The same decision layer the finder uses: one adapter, one policy, one fallback chain. A node with
    // no configured selector reports `unavailable`, and the person's fail-open setting decides what that
    // means — which is not the same thing as a guardrail that said yes.
    guardrails: (input) => {
      const decider = deps.services.projects.decider;
      if (decider === undefined) {
        return Promise.resolve({ status: "unavailable" as const, reason: "node này chưa nối policy layer nào" });
      }
      return guardOperation(decider, input);
    },
    narrowing: DEFAULT_NARROWING,
    /**
     * The secret broker, with the trail attached.
     *
     * Wired here rather than inside the tool because the broker is the only thing that reads a value: every use of a
     * secret passes through `withSecret` or `environmentFor`, so this is the one place an audit entry cannot be
     * forgotten.
     */
    broker: createSecretBroker({
      db: deps.services.runtime.db,
      principalId: deps.services.runtime.identity.ownerPrincipalId,
      now: () => new Date().toISOString() as Instant,
      audit: (event) =>
        appendAuditEvent(deps.services.runtime.db, {
          auditId: deps.services.conductor.newId("audit"),
          principalId: deps.services.runtime.identity.ownerPrincipalId,
          nodeId: deps.services.runtime.identity.nodeId,
          kind: "secret-use",
          summary: event.summary,
          outcome: "done",
          ref: event.ref,
          at: new Date().toISOString() as Instant,
        }),
    }),
    newId: () => deps.services.conductor.newId("run"),
    // Where a finished command is written down. The trail is the node's, and the sink is how a tool that does not know
    // about the database still ends up in it.
    audit: (event) =>
      appendAuditEvent(deps.services.runtime.db, {
        auditId: deps.services.conductor.newId("audit"),
        principalId: deps.services.runtime.identity.ownerPrincipalId,
        nodeId: deps.services.runtime.identity.nodeId,
        kind: "command",
        summary: event.summary,
        outcome: event.outcome,
        ...(event.ref === undefined ? {} : { ref: event.ref }),
        at: new Date().toISOString() as Instant,
      }),
  };
  wiring.interaction.deps = (conversationId) => interactionDepsFor(deps.services, conversationId);
  wiring.secret.deps = {
    db: deps.services.runtime.db,
    principalId: deps.services.runtime.identity.ownerPrincipalId,
    newId: deps.services.conductor.newId,
    now: () => new Date().toISOString() as Instant,
    nodeId: deps.services.runtime.identity.nodeId,
  };

  // A fixture node arranges its own precondition: the scripted command proposal has to have somewhere to
  // run, and a browser run must never depend on a developer's real approved folders.
  if (modelFixture) {
    fixtures?.arrangeModelNode({ services: deps.services, dataDir: deps.dataDir });
  }
  wiring.model.compose = deps.services.compose;

  /*
   * The dispatch vertical slice: a dispatched task now has a worker behind it.
   *
   * Not on a fixture node, for the same reason the pack probe skips it: `CC_SESSION_FIXTURE` exists so
   * a scripted node never spawns a real process, and a task the fixture path dispatches should stay
   * honestly parked in `dispatched` rather than quietly running a worker no browser test expects.
   *
   * The reporting closure is built here, not inside `task-dispatch.ts`, because it is the one place
   * both the dispatcher and `appendHostReply` exist — the module that owns the route family already
   * exports it for exactly this reason (`startBackgroundWork` uses the same shape).
   */
  if (!sessionFixture) {
    const dispatcher = createTaskDispatcher({
      conductor: deps.services.conductor,
      projectRoots: () => deps.services.projects.roots(),
      ownedRoots: () =>
        ownedResources([...deps.services.projects.roots(), deps.services.runtime.dataDir, process.cwd()]).roots,
      ownerPrincipalId: () => deps.services.runtime.identity.ownerPrincipalId,
      ...(deps.work === undefined ? {} : { journal: deps.work.journal }),
      onSettled: ({ taskId, conversationId, outcome, message }) => {
        const label =
          outcome === "succeeded"
            ? "Xong"
            : outcome === "failed"
              ? "Không xong"
              : outcome === "cancelled"
                ? "Đã hủy"
                : "Chưa rõ kết quả";
        const at = new Date().toISOString() as Instant;
        appendHostReply(deps.services, {
          conversationId,
          text: `${label} (task ${taskId}): ${message}`,
          at,
        });
        // The pointer for a person who is not looking at that conversation.
        tryRecordNodeNotice(deps.services, workerSettledNotice({ taskId, conversationId, outcome, message, at }));
      },
      // A park is not a settlement: it is reported to the conversation so the wait is not silent, but never
      // through `tryRecordNodeNotice`/`workerSettledNotice` above - that dedup key (`worker:<taskId>`) belongs to
      // this run's eventual real outcome, and a notice recorded here would suppress it once the approval is
      // decided and the run actually settles. The inbox already surfaces the pending approval itself as a
      // waiting item, derived live, so no separate notice is needed for the park to be visible.
      onWaitingApproval: ({ taskId, conversationId, message }) => {
        appendHostReply(deps.services, {
          conversationId,
          text: `Đang chờ bạn duyệt (task ${taskId}): ${message}`,
          at: new Date().toISOString() as Instant,
        });
      },
    });
    deps.services.taskDispatch = dispatcher;
    // Task workers are listed and stopped with everything else, by task id.
    deps.work?.addSource({ kind: "task", list: () => dispatcher.work(), cancel: (taskId) => dispatcher.stop(taskId) });
    deps.services.conductor.runTask = (input) => dispatcher.dispatch(input);
  }

  /*
   * A person who never looked deserves to learn that something they might have wanted to run never ran, or
   * that a question went unanswered - not silence. Runs on every node, fixture or not: it only reads the
   * approvals table and the transcript, and reuses `expireQuestions`, the same idempotent close a real answer
   * route would race against.
   */
  deps.services.expirySweep = startExpiryNoticeSweep(deps.services);

  if (sessionFixture) {
    process.stderr.write(
      "project sessions: FIXTURE starter loaded — a session is reported, and no worker is spawned\n",
    );
  }

  /*
   * The periodic update-check job: installed packages/widgets against the directory index, and the Pi SDK
   * against the npm registry when there is network.
   *
   * Not on a fixture node, for the same reason the task dispatcher skips it above: a browser suite must never
   * depend on a real npm registry answering, and a scripted node has nothing installed worth checking. The timer
   * is unref'd (see `update-checks.ts`) so it never holds the process open on its own; `stopUpdateChecks` below is
   * what the entry point calls when the node closes, the same as every other resource this function starts.
   */
  const updateChecks = sessionFixture
    ? undefined
    : startUpdateCheckTimer({
        services: deps.services,
        installDeps: {
          db: deps.services.runtime.db,
          nodeId: deps.services.runtime.identity.nodeId,
          now: () => new Date().toISOString() as Instant,
          newId: deps.services.conductor.newId,
        },
      });

  if (modelFixture) {
    // Said out loud, because a fixture that is indistinguishable from a model is worse than no
    // fixture: a screenshot from this node must not be read as model output.
    process.stderr.write(
      "overview: FIXTURE composer loaded — overview requests are scripted, and no provider is called for them\n",
    );
    fixtures?.applyScriptedBackgroundControl(deps.services);
  }

  // The model may now ask for these views. When there are none the `show_view` tool is not
  // registered at all, which is why this is reported rather than left to be discovered: a node
  // that cannot show anything should say so once at startup, not fail a turn later.
  deps.viewCatalog.push(...buildViewCatalog(deps.services.conductor, deps.services.compose));
  // Said out loud because it is a capability with a privacy shape: the model may search this machine's
  // files, the walk is read-only and bounded, and the lines it finds go to the provider as the tool's
  // result. An operator who did not want that should be able to learn it from the startup line.
  process.stderr.write(
    `filesystem search: read-only over ${machineRoots().join(", ")} — no index is built; matches are sent to the model provider\n`,
  );

  /*
   * Build the project index, in the background and after the node is listening.
   *
   * Nothing at runtime ever refreshed it before this: it was written only when somebody picked a project, so
   * asking which projects are on this machine answered with the two folders that had already been opened, and an
   * agent looking for a folder it could see on disk found nothing.
   *
   * Bounded in time as well as in entries, because one of this machine's roots is a cloud drive and a scan that
   * waits for it can run for minutes. An aborted scan is not allowed to prune - the finder checks that itself -
   * so stopping early leaves the previous index alone rather than emptying it.
   */
  const indexScan = new AbortController();
  const indexBudget = setTimeout(() => indexScan.abort(), 60_000);
  void refreshProjectIndex(deps.services.projects, { signal: indexScan.signal })
    .then((outcome) => {
      clearTimeout(indexBudget);
      process.stderr.write(
        `project index: ${outcome.scanned} scanned, ${outcome.kept} kept, ${outcome.removed} removed` +
          (outcome.truncated || outcome.stoppedEarly ? " — the scan stopped early, so the index is partial\n" : "\n"),
      );
    })
    .catch((cause: unknown) => {
      clearTimeout(indexBudget);
      process.stderr.write(
        `project index: not built — ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    });

  /*
   * Load the project-work pack, in the background and after the node is listening.
   *
   * The pack's capabilities are registered at boot and used to stay exactly as they were registered:
   * `loaded: false` for the life of the process, with the reason "the pack is declared but no worker
   * has loaded it on this node". That sentence was true only because nothing ever tried. This is the
   * thing that tries — one worker session with the pack's capabilities granted, and then the
   * readiness written from the record that came back rather than from the intention behind it.
   *
   * Not on a fixture node. `CC_SESSION_FIXTURE` exists so that a scripted node never spawns a worker,
   * and that reason does not stop applying because this spawn happens once at boot instead of per
   * request. A fixture node keeps reporting the pack as one no worker has loaded, which is the truth
   * about it.
   *
   * Bounded, because a wedged worker must not hold a boot open; and reported rather than thrown,
   * because a node whose pack cannot be loaded is still a node.
   */
  if (!sessionFixture) {
    void deps.services
      .loadProjectWorkPack({ timeoutMs: 60_000 })
      .then((outcome) => {
        if (!outcome.ran) {
          process.stderr.write(
            `project-work pack: not loaded — ${outcome.readiness.blockedReason ?? "no reason given"}\n`,
          );
          return;
        }
        process.stderr.write(
          outcome.readiness.healthy
            ? "project-work pack: loaded; a run demonstrated something\n"
            : `project-work pack: loaded; ${outcome.readiness.blockedReason ?? "no run demonstrated anything"}\n`,
        );
      })
      .catch((cause: unknown) => {
        process.stderr.write(
          `project-work pack: not loaded — ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
      });
  }
  process.stderr.write(
    deps.viewCatalog.length === 0
      ? "no widget definitions on this node; the model can answer in words only\n"
      : `views: ${deps.viewCatalog.length} definition(s) the model may show — ${deps.viewCatalog.map((view) => view.id).join(", ")}\n`,
  );
  process.stderr.write(
    deps.services.missingFamilies.length === 0
      ? "catalog: every family a composed surface needs is drawable\n"
      : `catalog: a composed surface would be missing ${deps.services.missingFamilies.join(", ")}\n`,
  );
  process.stderr.write(`session transcripts: ${sessionsDirectory(deps.dataDir)}\n`);
  process.stderr.write(
    deps.services.jev.config.enabled
      ? `selector: ${deps.services.jev.config.model} pinned, ${deps.services.jev.config.timeoutMs} ms per turn\n`
      : "selector: disabled (no credential or local-only); composed surfaces use the deterministic path\n",
  );
  process.stderr.write(
    sessionFixture
      ? "update check: FIXTURE — no periodic job started, no registry is called\n"
      : "update check: periodic job started — installed packages/widgets against the directory index, the Pi SDK against npm when there is network\n",
  );

  return { stopUpdateChecks: () => updateChecks?.stop() };
}
