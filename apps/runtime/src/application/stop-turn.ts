import { type AppIntentResolution, nowInstant } from "@clarkcant/contracts";
import { appendAuditEvent } from "@clarkcant/storage";
import type { Database } from "@clarkcant/storage";

import { type NodeServices } from "../services.ts";
import { cancelActionRuns } from "./action-runs.ts";

/**
 * Stopping the reply one conversation is writing.
 *
 * The narrow sibling of the emergency stop: it reaches only this conversation's turn and the widget actions running in
 * it, and leaves the commands, terminals and background work of the node running, because a person who presses Stop
 * under a reply is stopping what this conversation is doing and nothing else. The Stop button, Escape, "dừng lại" said or typed, and `POST
 * /conversations/:id/stop` all arrive here, so there is one answer to "what does stopping do".
 *
 * What the turn had already written is kept: the model turn ends with its partial reply and a stopped label rather
 * than with a failure (`model-turn.ts`). Nothing running is a quiet answer of `false`, not an error: a stop that races
 * the end of the reply has nothing left to do, and saying so is all there is.
 */
export interface StopTurnDeps {
  db: Database;
  ownerPrincipalId: string;
  nodeId: string;
  newId: (prefix: string) => string;
  /** Absent on a node with no turns to control, which answers that nothing was running. */
  turnControl?: { interrupt(conversationId: string): boolean } | undefined;
}

/** Where the stop came from, recorded so the audit row says how a person asked for it. */
export type StopTurnSource = "chat" | "voice" | "api";

export function stopConversationTurn(
  deps: StopTurnDeps,
  input: { conversationId: string; source: StopTurnSource },
): { stopped: boolean } {
  const interrupted = deps.turnControl?.interrupt(input.conversationId) ?? false;
  // A button's service call or workflow running in this conversation is stopped by the same Stop: to the person it is
  // what this conversation is doing, and there is no second control for it (`action-runs.ts`).
  const actions = cancelActionRuns(input.conversationId);
  const stopped = interrupted || actions > 0;
  if (stopped) {
    const what = [
      ...(interrupted ? ["lượt trả lời"] : []),
      ...(actions > 0 ? [`${String(actions)} thao tác của widget`] : []),
    ].join(" và ");
    // Written only for a stop that stopped something: a no-op is not an event, and a row for every idle press would
    // bury the ones that explain why a reply ended early.
    appendAuditEvent(deps.db, {
      auditId: deps.newId("audit"),
      principalId: deps.ownerPrincipalId,
      nodeId: deps.nodeId,
      kind: "stop",
      summary: `dừng ${what} theo yêu cầu (${input.source})`,
      outcome: "stopped",
      at: nowInstant(),
      ref: input.conversationId,
    });
  }
  return { stopped };
}

/** Said when a stop is asked for and the reply has already ended: what happened, not what was asked. */
export const NOTHING_TO_STOP_SAY = "Không có câu trả lời nào đang chạy, nên không có gì để dừng.";

/** The same stop, wired from a node's services, for the routes and the voice session that both reach it. */
export function stopTurnOnNode(
  services: Pick<NodeServices, "runtime" | "conductor" | "turnControl">,
  input: { conversationId: string; source: StopTurnSource },
): { stopped: boolean } {
  return stopConversationTurn(
    {
      db: services.runtime.db,
      ownerPrincipalId: services.runtime.identity.ownerPrincipalId,
      nodeId: services.runtime.identity.nodeId,
      newId: services.conductor.newId,
      turnControl: services.turnControl,
    },
    input,
  );
}

/**
 * A spoken "dừng lại", carried out on the node.
 *
 * Here rather than on the page, because the node is what knows the sentence was heard: the audit row says voice
 * rather than whatever the page would call it. The page still runs the decision it is sent, and its own stop then
 * finds nothing left to stop, which writes nothing. A stop with nothing running is answered as that, not read back as
 * done. Every other decision passes through untouched.
 */
export function carryOutSpokenStop(
  services: Pick<NodeServices, "runtime" | "conductor" | "turnControl">,
  decision: AppIntentResolution,
  conversationId: string | undefined,
): AppIntentResolution {
  if (decision.kind !== "intent" || decision.intent.kind !== "turn.stop" || conversationId === undefined) return decision;
  const { stopped } = stopTurnOnNode(services, { conversationId, source: "voice" });
  return stopped ? decision : { kind: "refused", say: NOTHING_TO_STOP_SAY };
}
