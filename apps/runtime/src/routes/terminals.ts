import { homedir } from "node:os";

import { nowInstant, terminalSessionCardSchema } from "@clarkcant/contracts";
import { getConversation } from "@clarkcant/storage";

import { listRunningCommands } from "../run-command.ts";
import { type NodeServices } from "../services.ts";
import { terminalCard } from "../terminal-tools.ts";
import { nodeWork } from "../work-supervisor.ts";
import { appendHostReply } from "./conversations.ts";
import { type GatewayRequest, type GatewayResponse, fail, json, readJson } from "./http.ts";

/**
 * The terminal routes: what is running on this node, and opening or closing a shell a person asked for.
 *
 * The live stream is not here — it is the `/terminal` socket. These answer the questions a card asks once: can this
 * node open a terminal at all, what else is running, and what did the last command print.
 */
export interface TerminalRouteDeps {
  services: Pick<NodeServices, "runtime" | "conductor" | "search" | "terminals" | "piSessions">;
  request: GatewayRequest;
  segments: string[];
}

export async function handleTerminalRoutes(deps: TerminalRouteDeps): Promise<GatewayResponse | undefined> {
  const { request, segments, services } = deps;
  if (segments[0] !== "terminals") return undefined;

  /*
   * Everything running, in one answer: terminals, the commands `run_command` started, the background work, and the
   * Pi sessions on this machine. One list because the question a person asks is "what is running", and the answer
   * should not depend on knowing which of four mechanisms started it.
   */
  if (segments.length === 1 && request.method === "GET") {
    const availability = await services.terminals.availability();
    return json(200, {
      available: availability.ok,
      ...(availability.ok ? {} : { reason: availability.reason }),
      terminals: services.terminals.list().map(({ driver: _driver, ...info }) => info),
      commands: listRunningCommands().map(({ workId, command, cwd, startedAt }) => ({ workId, command, cwd, startedAt })),
      background: nodeWork().background().sessions,
      piSessions: services.piSessions.list(),
    });
  }

  /*
   * A terminal a person opened themselves.
   *
   * Not routed through the execution policy: opening a shell runs nothing, and what the person types in it is their
   * own action on their own machine. With a conversation named, the card is written into it, so the terminal is in
   * the conversation like one the agent opened.
   */
  if (segments.length === 1 && request.method === "POST") {
    const parsed = readJson(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const cwd = typeof body.cwd === "string" && body.cwd.trim() !== "" ? body.cwd.trim() : homedir();
    const conversationId = typeof body.conversationId === "string" && body.conversationId !== "" ? body.conversationId : undefined;
    // Checked before the shell starts: a card that cannot be written would leave a shell nobody can see or close.
    if (conversationId !== undefined && getConversation(services.runtime.db, conversationId) === undefined) {
      return fail(404, "CONVERSATION_NOT_FOUND", "Không có hội thoại này, nên không mở terminal cho nó.", { conversationId });
    }
    const opened = await services.terminals.open({
      cwd,
      ...(typeof body.title === "string" && body.title.trim() !== "" ? { title: body.title.trim().slice(0, 300) } : {}),
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(typeof body.cols === "number" ? { cols: body.cols } : {}),
      ...(typeof body.rows === "number" ? { rows: body.rows } : {}),
    });
    if (!opened.ok) return fail(409, "TERMINAL_UNAVAILABLE", opened.reason);
    const card = terminalSessionCardSchema.parse(terminalCard(services.conductor.newId, opened.info, {}));
    if (conversationId !== undefined) {
      try {
        appendHostReply(services, { conversationId, at: nowInstant(), blocks: [card] });
      } catch (cause) {
        services.terminals.kill(opened.info.terminalId);
        throw cause;
      }
    }
    const { driver: _driver, ...info } = opened.info;
    return json(201, { terminal: info, card });
  }

  if (segments.length === 3 && segments[2] === "kill" && request.method === "POST") {
    const terminalId = decodeURIComponent(segments[1] ?? "");
    if (!services.terminals.kill(terminalId)) {
      return fail(409, "TERMINAL_UNAVAILABLE", "Terminal này không còn chạy.", { terminalId });
    }
    return json(200, { terminalId, stopping: true });
  }

  if (segments.length === 3 && segments[2] === "commands" && request.method === "GET") {
    const terminalId = decodeURIComponent(segments[1] ?? "");
    if (services.terminals.get(terminalId) === undefined) {
      return fail(404, "TERMINAL_GONE", "Terminal này không còn trên node.", { terminalId });
    }
    return json(200, { terminalId, commands: services.terminals.commands(terminalId) });
  }

  return undefined;
}
