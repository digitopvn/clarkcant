import type { ToolDefinition } from "@clarkcant/pi-adapter";

import { nodeWork, type WorkSupervisor, type WorkView } from "./work-supervisor.ts";

/**
 * "What is running" and "stop that", as tools the main agent can call.
 *
 * The person talks to one Clark and never sees a process list, so these questions reach the node through the
 * conversation: "what are you still doing?", "stop the one about the report". The agent answers from the same list
 * the process panel shows, and stops through the same supervisor the panel's button uses — one path, whichever way
 * the request arrived.
 *
 * The listing carries a title, a kind, a state and an id. Never a pid, a working directory or an environment: the id
 * is the handle, and it is only good for a stop on this node.
 *
 * A terminal is listed but not stoppable here. A shell is the person's own; closing one is theirs to do, from the
 * terminal card, and an agent that could close it could end what they were typing.
 */

const KIND_LABEL: Record<WorkView["kind"], string> = {
  background: "việc nền",
  command: "lệnh",
  task: "task",
  terminal: "terminal",
};

const STATE_LABEL: Record<WorkView["state"], string> = {
  queued: "đang chờ",
  running: "đang chạy",
  done: "xong",
  failed: "không xong",
  stopped: "đã dừng",
  interrupted: "bị gián đoạn",
};

function describe(view: WorkView): string {
  const place = view.position === undefined ? "" : ` (thứ ${String(view.position)} trong hàng chờ)`;
  return `- ${view.workId} · ${KIND_LABEL[view.kind]} · ${STATE_LABEL[view.state]}${place} · ${view.title}`;
}

export function createWorkTools(input: {
  /** The conversation this turn belongs to, which the listing looks at first. */
  conversationId?: string;
  supervisor?: () => WorkSupervisor;
}): ToolDefinition[] {
  const supervisor = input.supervisor ?? nodeWork;
  return [
    {
      name: "list_work",
      label: "Xem việc đang chạy",
      description:
        "List the work running on this node: background requests, commands you ran, task workers and terminals. " +
        "Use it when the user asks what is still running or wants to stop something. Each line has an id to pass " +
        "to stop_work. By default only this conversation's work is listed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          scope: {
            type: "string",
            enum: ["conversation", "node"],
            description: "conversation (default) for this conversation's work, node for everything on this node.",
          },
          includeFinished: { type: "boolean", description: "Also list background work that ended recently." },
        },
      },
      promptSnippet: "list_work — what is running on this node, with ids to stop",
      execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
        const whole = params.scope === "node" || input.conversationId === undefined;
        const work = supervisor().list({
          ...(whole ? {} : { conversationId: input.conversationId }),
          includeFinished: params.includeFinished === true,
        });
        const limit = supervisor().backgroundLimit();
        if (work.length === 0) {
          return { text: whole ? "Nothing is running on this node." : "Nothing is running for this conversation." };
        }
        return {
          text: [`Background limit: ${String(limit)} at a time.`, ...work.map(describe)].join("\n"),
        };
      },
    },
    {
      name: "stop_work",
      label: "Dừng một việc đang chạy",
      description:
        "Stop one piece of running work by the id list_work showed. Use it when the user asks to stop something. " +
        "Stopping is immediate; a background request that is stopped reports that in the conversation. Terminals " +
        "are closed by the user from their card, not here.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["workId"],
        properties: { workId: { type: "string", description: "The id from list_work." } },
      },
      promptSnippet: "stop_work — stop one running piece of work by id",
      execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
        const workId = typeof params.workId === "string" ? params.workId.trim() : "";
        if (workId === "") return { text: "workId is required; call list_work to see the ids." };
        const known = supervisor()
          .list({ includeFinished: true })
          .find((view) => view.workId === workId);
        if (known?.kind === "terminal") {
          return { text: `${workId} is a terminal; the user closes it from its card.` };
        }
        const outcome = supervisor().cancel(workId);
        switch (outcome) {
          case "stopped":
            return { text: `Stopped ${workId}.` };
          case "dequeued":
            return { text: `Removed ${workId} from the queue before it started.` };
          case "already-ended":
            return { text: `${workId} had already ended; nothing was stopped.` };
          default:
            return { text: `No running work has the id ${workId}; call list_work to see the current ids.` };
        }
      },
    },
  ];
}
