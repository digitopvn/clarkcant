import { type Principal, nowInstant } from "@clarkcant/contracts";
import { cancelTask } from "@clarkcant/core";

import { nodeBackgroundSessions } from "../background-sessions.ts";
import { performEmergencyStop } from "../application/emergency-stop.ts";
import { type NodeServices } from "../services.ts";
import { appendHostReply, startBackgroundWork } from "./conversations.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The routes that start, stop and answer for work that is running.
 *
 * The stop, the background sessions a person asks for directly, the cancel of one task, and the takeover/stop of a
 * controlled surface. They are one family because they are the same decision seen from four sides: what is running,
 * and how it ends.
 *
 * `services` is narrowed to the fields this family needs rather than taken as the whole bundle the gateway was
 * itself handed: the node it runs on, the conductor, the controlled surfaces it stops or takes over, the turn
 * control a background request runs through, and the search service the reply it writes is indexed into. Every
 * field was injected at composition, so this is not a lookup, and nothing here can reach a seam the interface
 * does not name.
 *
 * `undefined` means "not one of mine", which is how the dispatch keeps the route order it had when these branches
 * lived in the gateway.
 */
export interface ControlRouteDeps {
  services: Pick<
    NodeServices,
    "runtime" | "conductor" | "controlSessions" | "search" | "turnControl"
  >;
  request: GatewayRequest;
  segments: string[];
  at: () => string;
}

/**
 * The control family. `undefined` means the request is not one of these routes.
 */
export async function handleControlRoutes(deps: ControlRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments, services } = deps;
  const { runtime } = services;

  /*
   * The emergency stop.
   *
   * It kills rather than asks, because the point of a stop is that it works on something that is not listening. The
   * order is the order of reach, and the audit row is written by the flow: a stop is the event most likely to need
   * explaining later.
   */
  if (request.method === "POST" && request.path === "/stop") {
    const stopped = await performEmergencyStop({
      db: runtime.db,
      ownerPrincipalId: runtime.identity.ownerPrincipalId,
      nodeId: runtime.identity.nodeId,
      newId: services.conductor.newId,
      turnControl: services.turnControl,
    });
    return json(200, { ok: true, stopped });
  }

  /*
   * The work running behind the conversation.
   *
   * A count and a list rather than a single flag, because the useful question is not "is something running" but
   * "what is running, and did the last one finish". Newest first, and empty when nothing has been started - an
   * invented placeholder entry would make the count meaningless.
   */
  /*
   * One request, run somewhere else, asked for directly.
   *
   * The decider is one way a background request happens; a person highlighting a passage and saying "do this
   * elsewhere" is the other, and it must not depend on the decider having an opinion about it.
   */
  if (segments.length === 1 && segments[0] === "background-sessions" && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const text = typeof parsed.value.text === "string" ? parsed.value.text.trim() : "";
    const requested = typeof parsed.value.conversationId === "string" ? parsed.value.conversationId : "";
    if (text === "" || requested === "") {
      return fail(400, "INVALID_SCHEMA", "a background request needs a conversationId and a non-empty text");
    }
    // The owner of this node, built here because this route sits above the branch where the request's own principal is
    // resolved: a background request from a selection is the owner's, and there is no other person it could be.
    const owner: Principal = {
      principalId: runtime.identity.ownerPrincipalId as Principal["principalId"],
      kind: "user",
      nodeId: runtime.identity.nodeId as Principal["nodeId"],
    };
    const started = startBackgroundWork(services, owner, () => deps.at() as never, requested, text);
    if ("refusal" in started) return fail(409, "BACKGROUND_UNAVAILABLE", started.refusal);
    return json(202, { accepted: true, sessionId: started.sessionId });
  }

  if (segments.length === 1 && segments[0] === "background-sessions" && request.method === "GET") {
    return json(200, {
      running: nodeBackgroundSessions.running(),
      sessions: nodeBackgroundSessions.list(),
    });
  }

  /*
   * Ask a task to stop, and record the answer in the conversation.
   *
   * A stop that only lived in the response to this call would leave the transcript showing a task still going,
   * so the node writes what it did. `confirmed` is the part a caller must not round up: with an executor still
   * running the task holds `cancel_requested` until that executor says what happened.
   */
  if (segments.length === 3 && segments[0] === "tasks" && segments[2] === "cancel" && request.method === "POST") {
    const taskId = decodeURIComponent(segments[1] ?? "");
    const outcome = cancelTask(
      { db: runtime.db, nodeId: runtime.identity.nodeId, now: nowInstant, newId: services.conductor.newId },
      taskId,
    );
    if (!outcome.ok) return fail(409, outcome.code, outcome.message, { taskId });
    appendHostReply(services, {
      conversationId: outcome.task.conversationId,
      at: nowInstant(),
      text: outcome.confirmed
        ? `Đã dừng task ${taskId}. Không có việc nào đang chạy nên không còn gì đang chờ.`
        : `Đã ghi nhận yêu cầu dừng task ${taskId}. Việc đang chạy vẫn có thể đang hoàn tất, nên task chưa được coi là đã dừng cho tới khi nơi chạy xác nhận.`,
    });
    return json(200, { taskId: outcome.task.taskId, state: outcome.task.state, confirmed: outcome.confirmed });
  }

  /*
   * Who is driving a controlled surface — a browser session or a desktop session.
   *
   * Takeover hands the wheel to the user by bumping the lease epoch, which invalidates the action the agent had
   * already planned rather than reaching into a process this node does not control. Stop ends the session and
   * bumps the epoch for the same reason: an action already in flight must not land on a session that has ended.
   *
   * A session that is missing or already stopped is refused rather than quietly reported as done, because a
   * takeover that silently did nothing leaves the user believing they have the wheel.
   */
  if (
    segments.length === 3 &&
    segments[0] === "control-sessions" &&
    (segments[2] === "takeover" || segments[2] === "stop") &&
    request.method === "POST"
  ) {
    const sessionId = decodeURIComponent(segments[1] ?? "");
    const at = nowInstant();
    const session =
      segments[2] === "takeover"
        ? services.controlSessions.takeover(sessionId, at)
        : services.controlSessions.stop(sessionId, at);
    if (session === undefined) {
      return fail(409, "CONTROL_SESSION_UNAVAILABLE", "Không đổi được phiên này vì phiên không tồn tại hoặc đã dừng.", {
        sessionId,
      });
    }
    return json(200, { session });
  }

  return undefined;
}
