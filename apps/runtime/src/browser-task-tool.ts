import type { ConversationId, MessageRecord, TurnOrigin } from "@clarkcant/contracts";
import { type TaskServiceDeps, advanceResolving, applyTaskEvent, createTask } from "@clarkcant/core";
import type { ToolDefinition } from "@clarkcant/pi-adapter";

import {
  BROWSER_CAPABILITY,
  BROWSER_GOAL_ADDRESSES,
  MAX_TASK_ORIGINS,
  browserGoalUrls,
  browserTaskOrigins,
  hasUserinfo,
  sameSites,
} from "./task-browser.ts";
import type { TaskDispatcher } from "./task-dispatch.ts";

/**
 * "Fill in this form on example.com and send it": the person's request, handed to a browser task.
 *
 * The main turn does not drive a browser itself. It starts a task on this node whose worker is given `use_browser`
 * and nothing else, and whose every action the node carries out (`task-browser.ts`): the task's effect ledger holds each
 * submission, and one whose answer never came is put to the person in the inbox rather than guessed at.
 *
 * What this tool decides is only which sites the task may act on, and it decides them from the person's own words:
 * every web address the model passes, or writes into the goal, has to be a site the person named in this conversation,
 * on a surface only the person uses. A page the task later reads cannot add one, and neither can the model or a machine
 * client. The checked list is stored on the task itself (`origin.sites`), and that stored list — not the goal's text —
 * is what the dispatcher lets the browser onto. Whether the task may act on those sites at all is the execution
 * policy's question, asked by the dispatcher before the worker starts — where the person's policy says to ask, it waits
 * for them in the inbox, like any other task.
 */

const MAX_GOAL_CHARS = 2000;
const MAX_URLS = 8;
const MAX_URL_CHARS = 2000;
/** The longest goal a task record holds. A goal that would not fit is refused, never cut: a cut can land inside a host. */
const MAX_TASK_GOAL_CHARS = 4000;

export interface BrowserTaskToolDeps {
  /** The node's task store and clock. */
  tasks: TaskServiceDeps;
  /** Who asked: the person this turn answers. */
  principalId: string;
  conversationId: string;
  /**
   * What the person wrote in this conversation lately, on their own surfaces (`personTextOf`): the only place a site
   * this tool accepts can come from.
   */
  personText: () => string;
  /** The node's dispatcher, read when the tool runs. Absent means this node runs no background task. */
  dispatcher: () => TaskDispatcher | undefined;
  /** The language the person reads the interface in, for the sentence the model is asked to pass on. Defaults to Vietnamese. */
  language?: () => "vi" | "en";
  /**
   * Who asked for the turn (`TurnOrigin`), read when the tool runs. Stored on the task's origin, so the dispatcher's
   * policy decision before the worker starts sees it. Absent is the person.
   */
  origin?: () => TurnOrigin | undefined;
}

/**
 * What the person is told when no model this node could start the task on can call tools, naming the setting to change.
 *
 * Written out in both languages the interface has, because the model is asked to pass it on as it stands: the words of
 * the setting have to match what the person sees in Settings.
 */
const NO_TOOL_CAPABLE_MODEL: Readonly<Record<"vi" | "en", string>> = {
  vi:
    "Không model nào đang cấu hình ở đây gọi được tool, nên không model nào dùng được trình duyệt. " +
    "Hãy chọn một model gọi được tool trong Cài đặt → AI & Định tuyến → Chọn provider và model.",
  en:
    "None of the models set up here can call tools, so none of them can use the browser. " +
    "Choose one that can in Settings → AI & Routing → Choose provider and model.",
};

/** The turn's origin for the task record, read when the task is created. */
function turnOriginOf(deps: BrowserTaskToolDeps): { turnOrigin?: TurnOrigin } {
  const origin = deps.origin?.();
  return origin === undefined ? {} : { turnOrigin: origin };
}

type Checked = { ok: true; goal: string; urls: URL[]; sites: string[] } | { ok: false; text: string };

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * A site as a person would have typed it: its host (with its port, when it has one), with or without a leading `www.`.
 *
 * Matched as a whole name, not as text inside a longer one: a person who named `shop.example.com` did not name
 * `example.com`, and one who named `example.com.other.net` did not name `example.com`. A plain `http` address is only
 * the person's when they wrote `http://` in front of that host themselves: a site they named without a scheme is
 * reached over https.
 */
function namedByPerson(url: URL, said: string): boolean {
  const host = url.host.toLowerCase();
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  const scheme = url.protocol === "http:" ? "http://" : "";
  const before = scheme === "" ? "(?<![a-z0-9.-])" : "(?<![a-z0-9+.-])";
  return new RegExp(
    `${before}${escapeForPattern(scheme)}(?:www\\.)?${escapeForPattern(bare)}(?![a-z0-9-]|\\.[a-z0-9])`,
    "u",
  ).test(said);
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
  // The goal's own addresses are the task's sites too, so they are held to the same rules as the list.
  const written = browserGoalUrls(goal);
  // A user or password before the host is where an address can say one site to a parser and another to a reader.
  const disguised = [...urls, ...written].find(hasUserinfo);
  if (disguised !== undefined) {
    return {
      ok: false,
      text: `Not started: an address for ${disguised.host} was given with a user name or password in front of its host; a browser task takes plain addresses only.`,
    };
  }
  const inGoal = browserTaskOrigins(goal).map((origin) => new URL(origin));
  const lower = said.toLowerCase();
  const stranger = [...urls, ...inGoal].find((url) => !namedByPerson(url, lower));
  if (stranger !== undefined) {
    const plain = stranger.protocol === "http:" && namedByPerson(new URL(`https://${stranger.host}/`), lower);
    return {
      ok: false,
      text: plain
        ? `Not started: the person named ${stranger.host} but not as a plain http address; use https, or ask them to write the http address themselves if that is what they meant.`
        : `Not started: ${stranger.host} is not a site the person named in this conversation. A browser task acts only on ` +
          `sites the person named themselves; ask them to name it if it is what they meant.`,
    };
  }
  const sites = [...new Set([...urls, ...inGoal].map((url) => url.origin))];
  if (sites.length > MAX_TASK_ORIGINS) {
    return { ok: false, text: `Not started: one browser task works on at most ${String(MAX_TASK_ORIGINS)} sites.` };
  }
  return { ok: true, goal, urls, sites };
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
      // A task only a tool can do is not started on models that are all stated unable to call one. Unknown goes ahead.
      if ((await dispatcher.workersCallTools()) === false) {
        const sentence = NO_TOOL_CAPABLE_MODEL[deps.language?.() ?? "vi"];
        return {
          text:
            "Not started: the model catalogue states that no model this node could run the task on can call tools, so " +
            `none of them could use the browser. No task was created. Tell the person, in these words: ${sentence}`,
        };
      }
      let said: string;
      try {
        said = deps.personText();
      } catch {
        return { text: "Not started: this conversation could not be read back, so no site could be checked. Nothing was changed." };
      }
      const checked = check(params, said);
      if (!checked.ok) return { text: checked.text };

      // The goal carries the addresses so the worker knows where to start; the sites it may act on are carried beside
      // it, on the task's origin, and must be exactly what the goal names — a goal read differently is refused.
      const goal = `${checked.goal}${BROWSER_GOAL_ADDRESSES}${checked.urls.map((url) => url.href).join(" ")}`;
      if (goal.length > MAX_TASK_GOAL_CHARS) {
        return {
          text: `Not started: the request and its addresses come to more than ${String(MAX_TASK_GOAL_CHARS)} characters; shorten the goal.`,
        };
      }
      if (!sameSites(browserTaskOrigins(goal), checked.sites)) {
        return { text: "Not started: the addresses could not be read back from the task the same way they were checked." };
      }
      try {
        const task = createTask(deps.tasks, {
          conversationId: deps.conversationId as ConversationId,
          goal,
          principal: { principalId: deps.principalId as never, kind: "user", nodeId: deps.tasks.nodeId as never },
          origin: { kind: "interactive", principalId: deps.principalId, sites: checked.sites, ...turnOriginOf(deps) },
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
            `Started browser task ${task.taskId} on ${checked.sites.join(", ")}. It runs in the background and reports its ` +
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

/**
 * The person's own recent words in a conversation, for `personText`.
 *
 * Only what the person typed into this node's page or said to it counts: a user-role message this node stored from its
 * own composer or voice (`surface`). A message a machine surface posted — MCP, the WebSocket relay, `clarkcant api` —
 * or one a peer put into the conversation carries no such mark, and neither does one stored before the mark existed,
 * so none of them can name a site. Only text blocks are read: a widget's or an artifact's text alternative is content
 * the person did not write.
 */
export function personTextOf(messages: readonly MessageRecord[], nodeId: string): string {
  return messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.authorNodeId === nodeId &&
        (message.surface === "composer" || message.surface === "voice"),
    )
    .flatMap((message) => message.blocks.flatMap((block) => (block.type === "text" ? [block.content] : [])))
    .join("\n");
}
