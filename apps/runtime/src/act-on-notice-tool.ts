import { NOTICE_OPERATION_IDS, type Instant, isNoticeOperation } from "@clarkcant/contracts";
import { recordAppIntentEvent } from "@clarkcant/core";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import { type NoticeOperationOutcome, type NoticeOperationServices, performNoticeOperation } from "./notice-operations.ts";

/**
 * Acting on a notice from the conversation: "mark that read", "try the failed work again", "install that update".
 *
 * The same `performNoticeOperation` the inbox's `POST /inbox/notices/:id/actions/:action` calls, so a sentence to the
 * main agent, a sentence to the voice agent and a press in the panel are one action with one set of checks: the node
 * reads the notice, works out what it offers now, and refuses anything else. What the model is told is what the node
 * did — never more — and an install that needs approval says so and stops there, because that approval is the person's.
 *
 * Each call is recorded as an `app.intent` event (`notice.act`), with `source` `agent` or `voice-agent`, so the audit
 * can tell a model's own call from a person's click or command.
 */
export interface ActOnNoticeToolDeps {
  services: () => NoticeOperationServices;
  now: () => Instant;
  conversationId?: string;
  /** Which surface the message came in on, read at call time: the tool list outlives any one message. */
  channel: () => "voice" | "chat";
}

/** The longest snooze the tool asks for, in hours: the node's own limit (`NOTICE_SNOOZE_MAX_MS`) is 30 days. */
const SNOOZE_HOURS_MAX = 720;
const SNOOZE_HOURS_DEFAULT = 1;

export function createActOnNoticeTool(deps: ActOnNoticeToolDeps): ToolDefinition {
  return {
    name: "act_on_notice",
    label: "Xử lý thông báo",
    description:
      "Carry out one action on a notice in the user's inbox when the user asks you to: mark it read or unread, " +
      "dismiss it, snooze it or bring it back, stop or resume notifications of its kind, retry the failed background " +
      "work it reports, install the update it announces, skip that version, or ask an expired question again. Call " +
      "read_inbox first to get the notice id and the actions that notice offers now; an action it does not offer is " +
      "refused. Approving commands, capabilities or tasks and answering whether an effect took effect are the user's " +
      "alone and are not possible here. The result says exactly what the node did — only say it happened when it says so.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["noticeId", "action"],
      properties: {
        noticeId: { type: "string", description: "The notice id, from read_inbox." },
        action: { type: "string", enum: [...NOTICE_OPERATION_IDS], description: "What to do with the notice." },
        snoozeHours: {
          type: "number",
          minimum: 1,
          maximum: SNOOZE_HOURS_MAX,
          description: `Only for snooze: how many hours until the notice returns (default ${String(SNOOZE_HOURS_DEFAULT)}).`,
        },
      },
    },
    promptSnippet: "act_on_notice — mark read/unread, dismiss, snooze, retry, update, skip a version or ask again, on one inbox notice",
    execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
      const noticeId = typeof params.noticeId === "string" ? params.noticeId.trim() : "";
      const action = typeof params.action === "string" ? params.action : "";
      if (noticeId === "" || noticeId.length > 128) return { text: "A noticeId from read_inbox is needed. Nothing was changed." };
      if (!isNoticeOperation(action)) {
        return { text: `"${action}" is not a notice action; use one of ${NOTICE_OPERATION_IDS.join(", ")}. Nothing was changed.` };
      }
      let until: string | undefined;
      if (action === "snooze") {
        const hours = params.snoozeHours === undefined ? SNOOZE_HOURS_DEFAULT : params.snoozeHours;
        if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 1 || hours > SNOOZE_HOURS_MAX) {
          return { text: `snoozeHours must be a number from 1 to ${String(SNOOZE_HOURS_MAX)}. Nothing was changed.` };
        }
        until = new Date(Date.parse(deps.now()) + hours * 60 * 60_000).toISOString();
      }

      const services = deps.services();
      const runtime = services.runtime;
      // Recorded before it is carried out, like `control_app`: the audit answers who asked, whatever came of it.
      recordAppIntentEvent(
        { db: runtime.db, nodeId: runtime.identity.nodeId, now: deps.now, newId: services.conductor.newId },
        {
          intent: { kind: "notice.act", noticeId, noticeAction: action },
          source: deps.channel() === "voice" ? "voice-agent" : "agent",
          confirmed: false,
          ...(deps.conversationId === undefined ? {} : { conversationId: deps.conversationId as never }),
        },
      );
      let outcome: NoticeOperationOutcome;
      try {
        outcome = await performNoticeOperation(services, { noticeId, action, ...(until === undefined ? {} : { until }) }, deps.now);
      } catch {
        // The cause stays on the node: it names storage or install internals, which is nothing the model can act on.
        return { text: `Could not ${action} that notice: the node failed while doing it. Nothing is known to have changed; the user can try from the inbox.` };
      }
      return { text: describeNoticeOperation(outcome) };
    },
  };
}

/** What the model is told for each outcome. Exported so the wording can be asserted without a turn. */
export function describeNoticeOperation(outcome: NoticeOperationOutcome): string {
  if (!outcome.ok) {
    const why = outcome.reason === undefined ? "" : ` (${outcome.reason})`;
    return `Not done: ${outcome.message}${why} [${outcome.code}]. Nothing was changed.`;
  }
  const { response } = outcome;
  switch (response.action) {
    case "mark-read":
      return "Done: the notice is marked read.";
    case "mark-unread":
      return "Done: the notice is marked unread.";
    case "dismiss":
      return "Done: the notice is dismissed; the user can undo it from the inbox for a short while.";
    case "snooze":
      return `Done: the notice is snoozed until ${response.snoozedUntil ?? "later"}; it returns to the inbox unread then.`;
    case "unsnooze":
      return "Done: the notice is back in the inbox.";
    case "suppress":
      return "Done: notices of this kind will no longer notify the user; they can turn it back on from the inbox.";
    case "unsuppress":
      return "Done: notices of this kind will notify the user again.";
    case "retry":
      return response.state === "queued"
        ? `Done: the background work was started again as ${response.workId ?? "new work"} and is queued${response.position === undefined ? "" : ` at position ${String(response.position)}`}.`
        : `Done: the background work was started again as ${response.workId ?? "new work"} and is running.`;
    case "update":
      return response.outcome === "approval-required"
        ? `Not installed: the user's execution mode asks for approval before installing ${response.version ?? "this version"}, so nothing was installed. Only the user can approve it.`
        : `Done: version ${response.version ?? ""} is installed and the notice is dismissed.`;
    case "skip-version":
      return `Done: version ${response.version ?? ""} and older will not be reported again, and the notice is dismissed.`;
    case "ask-again":
      return "Done: the question is asked again in its conversation.";
    default: {
      const unhandled: never = response.action;
      return unhandled;
    }
  }
}
