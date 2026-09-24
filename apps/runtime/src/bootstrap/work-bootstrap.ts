import { nowInstant, type Instant, type Principal } from "@clarkcant/contracts";
import { getPreference, readExecutionPolicy } from "@clarkcant/core";
import { listSecretMetadata } from "@clarkcant/storage";

import { withholdFromChildren } from "../child-env.ts";
import { machineBootId } from "../process-tree.ts";
import { appendHostReply, startBackgroundWork } from "../routes/conversations.ts";
import { listRunningCommands, setCommandJournal, stopCommand } from "../run-command.ts";
import type { NodeServices } from "../services.ts";
import { createWorkJournal, type NodeWorkJournal } from "../work-journal.ts";
import { recoverUnfinishedWork, type WorkRecoveryReport } from "../work-recovery.ts";
import {
  backgroundDeadlineFromEnv,
  configureNodeWork,
  createWorkSupervisor,
  normalizeBackgroundLimit,
  type WorkSource,
  type WorkSupervisor,
} from "../work-supervisor.ts";

/**
 * Give the node its work supervisor, its journal, and the rule for what a child inherits.
 *
 * Called once from `main.ts`, after the services exist and before anything can start work: a command run in the
 * first second has to be journaled like every later one, and a shell opened in the first second must already have the
 * node's keys withheld. The recovery pass is returned rather than run here, because it reports into conversations and
 * re-submits background work, which needs the turn control `wireRuntime` publishes after this.
 */
export interface NodeWork {
  supervisor: WorkSupervisor;
  journal: NodeWorkJournal;
  /** Register the task dispatcher once it exists. */
  addSource(source: WorkSource): void;
  /** Report and settle what an earlier process left open. Run once, after `wireRuntime`. */
  recover(): WorkRecoveryReport;
}

export function attachNodeWork(input: {
  services: NodeServices;
  env: NodeJS.ProcessEnv;
  /** Names `.env` put into this process, which no child inherits. */
  envLoaded: readonly string[];
}): NodeWork {
  const { services } = input;
  const { runtime } = services;
  const principalId = runtime.identity.ownerPrincipalId;
  const nodeId = runtime.identity.nodeId;
  const coordination = { db: runtime.db, now: (): Instant => nowInstant() };

  /*
   * What no child inherits, beyond the provider keys `child-env.ts` always withholds: what `.env` loaded, and any
   * secret the broker is told to serve from the environment. Read per child, so a secret stored after boot is
   * withheld from the next shell without a restart.
   */
  const envLoaded = [...input.envLoaded];
  withholdFromChildren(() => {
    const fromBroker = (() => {
      try {
        return listSecretMetadata(runtime.db, principalId)
          .filter((secret) => secret.backend === "environment")
          .map((secret) => secret.backendRef);
      } catch {
        return [];
      }
    })();
    return [...envLoaded, ...fromBroker];
  });

  const journal = createWorkJournal({ db: runtime.db, nodeId, machineBootId: machineBootId() });
  setCommandJournal(journal);

  const supervisor = configureNodeWork(
    createWorkSupervisor({
      journal,
      deadlineMs: backgroundDeadlineFromEnv(input.env),
      // Read at every admission, so a change in Settings applies to the next request.
      backgroundLimit: () =>
        normalizeBackgroundLimit(
          getPreference(
            coordination,
            { principalId, key: "execution.backgroundLimit", scope: "node" },
          )?.value,
        ),
    }),
  );

  supervisor.addSource({
    kind: "command",
    list: () =>
      listRunningCommands().map((entry) => ({
        workId: entry.workId,
        kind: "command",
        title: entry.command.slice(0, 200),
        state: "running",
        ...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
        startedAt: entry.startedAt,
      })),
    cancel: (workId) => stopCommand(workId),
  });
  supervisor.addSource({
    kind: "terminal",
    list: () =>
      services.terminals
        .list()
        .filter((terminal) => terminal.status === "running")
        .map((terminal) => ({
          workId: terminal.terminalId,
          kind: "terminal",
          title: terminal.running?.command ?? terminal.title,
          state: "running",
          ...(terminal.conversationId === undefined ? {} : { conversationId: terminal.conversationId }),
          startedAt: terminal.startedAt,
        })),
    cancel: (workId) => services.terminals.get(workId) !== undefined && services.terminals.kill(workId),
  });

  const owner: Principal = {
    principalId: principalId as Principal["principalId"],
    kind: "user",
    nodeId: nodeId as Principal["nodeId"],
  };

  return {
    supervisor,
    journal,
    addSource: (source) => void supervisor.addSource(source),
    recover: () =>
      recoverUnfinishedWork({
        db: runtime.db,
        nodeId,
        nodeBootId: journal.nodeBootId,
        machineBootId: machineBootId(),
        now: () => nowInstant(),
        newId: services.conductor.newId,
        policyMode: () => readExecutionPolicy(coordination, principalId).mode,
        report: (conversationId, text) => {
          appendHostReply(services, { conversationId, text, at: nowInstant() });
        },
        rerun: (run) => {
          const started = startBackgroundWork(services, owner, () => nowInstant(), run.conversationId, run.requestText, {
            workId: run.workId,
            attempt: run.attempt + 1,
          });
          return !("refusal" in started);
        },
      }),
  };
}
