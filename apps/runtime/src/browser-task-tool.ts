import type { ConversationId } from "@clarkcant/contracts";
import { type TaskServiceDeps, advanceResolving, applyTaskEvent, createTask } from "@clarkcant/core";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import { BROWSER_CAPABILITY, browserTaskOrigins } from "./task-browser.ts";
import type { TaskDispatcher } from "./task-dispatch.ts";

/**
 * "Fill in this form on example.com and send it": the person's request, handed to a browser task.
 *
 * The main turn does not drive a browser itself. It starts a task on this node whose worker is given `use_browser`
 * and nothing else, and whose every action the node carries out (`task-browser.ts`): the task's effect ledger holds each
 * submission, and one whose answer never came is put to the person in the inbox rather than guessed at.
 *
 * What this tool decides is only which sites the task may act on, and it decides them from the person's own words:
 * every web address the model passes, or writes into the goal, has to be a site the person named in this conversation.
 * A page the task later reads cannot add one, and neither can the model. Whether the task may act on those sites at all
 * is the execution policy's question, asked by the dispatcher before the worker starts — where the person's policy
 * says to ask, it waits for them in the inbox, like any other task.
 */

const MAX_GOAL_CHARS = 2000;
const MAX_URLS = 8;
const MAX_URL_CHARS = 2000;

export interface BrowserTaskToolDeps {
  /** The node's task store and clock. */
  tasks: TaskServiceDeps;
  /** Who asked: the person this turn answers. */
  principalId: string;
  conversationId: string;
  /** What the person wrote in this conversation lately: the only place a site this tool accepts can come from. */
  personText: () => string;
  /** The node's dispatcher, read when the tool runs. Absent means this node runs no background task. */
  dispatcher: () => TaskDispatcher | undefined;
}

type Checked = { ok: true; goal: string; urls: URL[] } | { ok: false; text: string };

/**
 * A site as a person would have typed it: its host (with its port, when it has one), with or without a leading `www.`.
 *
 * Matched as a whole name, not as text inside a longer one: a person who named `shop.example.com` did not name
 * `example.com`, and one who named `example.com.other.net` did not name `example.com`.
 */
function namedByPerson(url: URL, said: string): boolean {
  const host = url.host.toLowerCase();
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![a-z0-9.-])(?:www\\.)?${escaped}(?![a-z0-9-]|\\.[a-z0-9])`, "u").test(said);
}

function check(params: Record<string, unknown>, said: string): Checked {
  const goal = typeof params["goal"] === "string" ? params["goal"].trim() : "";
  if (goal === "" || goal.length > MAX_GOAL_CHARS) {
    return { ok: false, text: `Not started: "goal" must be the person's request in one to ${String(MAX_GOAL_CHARS)} characters.` };
  }
  const raw = params["urls"];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_URLS) {
    return { ok: false, text: `Not started: "urls" must list the one to ${String(MAX_URLS)} web addresses the task works on.` };
  }
  const urls: URL[] = [];
  for (const entry of raw) {
    let url: URL;
    try {
      if (typeof entry !== "string" || entry.length > MAX_URL_CHARS) throw new Error("not a string");
      url = new URL(entry);
    } catch {
      return { ok: false, text: `Not started: ${String(entry).slice(0, 200)} is not an absolute web address.` };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, text: `Not started: ${url.href.slice(0, 200)} is not an http or https address.` };
    }
    urls.push(url);
  }
  // The goal's own addresses are the task's sites too (the dispatcher reads them back from it), so they are held to
  // the same rule as the list.
  const inGoal = browserTaskOrigins(goal).map((origin) => new URL(origin));
  const lower = said.toLowerCase();
  const stranger = [...urls, ...inGoal].find((url) => !namedByPerson(url, lower));
  if (stranger !== undefined) {
    return {
      ok: false,
      text:
        `Not started: ${stranger.host} is not a site the person named in this conversation. A browser task acts only on ` +
        `sites the person named themselves; ask them to name it if it is what they meant.`,
    };
  }
  return { ok: true, goal, urls };
}

export function createBrowserTaskTool(deps: BrowserTaskToolDeps): ToolDefinition {
  return {
    name: "start_browser_task",
    label: "Làm việc trên trình duyệt",
    description:
      "Start a background task that uses this node's managed browser to do what the person asked on a website: open " +
      "pages, fill in forms, press buttons, submit. Use it when the person asks for something to be done on a site " +
      "they name. Pass the person's request as `goal`, and in `urls` the web addresses the task starts from; every " +
      "site must be one the person named in this conversation. The task runs in the background and reports in this " +
      "conversation. If a submission's outcome is unknown, the person is asked in the inbox; never tell them it " +
      "succeeded.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        goal: { type: "string", description: "What the person asked for, in their words." },
        urls: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_URLS,
          description: "The absolute http(s) addresses the task works on, each on a site the person named.",
        },
      },
      required: ["goal", "urls"],
    },
    promptSnippet: "start_browser_task — do something on a website the person named, in a managed browser, as a background task",
    execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
      const dispatcher = deps.dispatcher();
      if (dispatcher === undefined) {
        return { text: "Not started: this node runs no background tasks, so it has no browser to give one." };
      }
      let said: string;
      try {
        said = deps.personText();
      } catch {
        return { text: "Not started: this conversation could not be read back, so no site could be checked. Nothing was changed." };
      }
      const checked = check(params, said);
      if (!checked.ok) return { text: checked.text };

      const origins = [...new Set(checked.urls.map((url) => url.origin))];
      // The goal carries the addresses, because it is all a task re-dispatched after its approval has to go on.
      const goal = `${checked.goal}\n\nStart at: ${checked.urls.map((url) => url.href).join(" ")}`.slice(0, 4000);
      try {
        const task = createTask(deps.tasks, {
          conversationId: deps.conversationId as ConversationId,
          goal,
          principal: { principalId: deps.principalId as never, kind: "user", nodeId: deps.tasks.nodeId as never },
        });
        const started = applyTaskEvent(deps.tasks, task.taskId, "resolve.start");
        const ready = started.ok
          ? advanceResolving(deps.tasks, task.taskId, { kind: "ready", executionNodeId: deps.tasks.nodeId })
          : started;
        const acknowledged = ready.ok ? applyTaskEvent(deps.tasks, task.taskId, "dispatch.acknowledged") : ready;
        if (!acknowledged.ok) {
          return { text: `Not started: the task could not be made ready (${acknowledged.message}).` };
        }
        const queued = dispatcher.dispatch({
          taskId: task.taskId,
          capabilityRef: BROWSER_CAPABILITY,
          executionNodeId: deps.tasks.nodeId,
        });
        if (!queued) {
          return { text: `Task ${task.taskId} was not run: this node refused it, and said why in this conversation.` };
        }
        return {
          text:
            `Started browser task ${task.taskId} on ${origins.join(", ")}. It runs in the background and reports its ` +
            `result in this conversation; if this node's policy wants the person's approval first, it waits for them ` +
            `in the inbox. Tell the person it has started, not that it is done.`,
        };
      } catch (cause) {
        process.stderr.write(
          `start_browser_task: ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
        return { text: "Not started: the task could not be recorded on this node. Nothing was sent anywhere." };
      }
    },
  };
}

/** The person's recent words in a conversation, for `personText`. Exported so the bootstrap and a test build it alike. */
export function personTextOf(messages: readonly { role: string; text: string }[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.text)
    .join("\n");
}
