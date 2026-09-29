import { isAbsolute, resolve } from "node:path";

import type {
  AutomationSchedule,
  EffectCategory,
  Instant,
  IntentAction,
  MatchCondition,
  PersistentIntent,
  TaskResource,
} from "@clarkcant/contracts";
import { type AutomationChange, createAutomation, listAutomations, updateAutomation } from "@clarkcant/core";
import type { ToolDefinition } from "@clarkcant/pi-adapter";
import type { Database } from "@clarkcant/storage";

import { containingRoot, ownedResources } from "./preflight.ts";

/**
 * "From now on, when X happens, do Y", as tools the main agent calls.
 *
 * The person says it once, in their own words; the agent turns it into data a matcher reads the same way every time —
 * a topic, conditions on the signal, what to do — and the node keeps it. Nothing here runs anything: the automation
 * service does that when a matching signal arrives, through the same dispatch and policy a task from the conversation
 * goes through.
 *
 * An automation carries only what the person gave it: the folders it may touch, and the effects it may have without
 * asking. Destructive and financial effects are never given to one; those are asked about each time they come up.
 */

export interface AutomationToolDeps {
  db: Database;
  nodeId: string;
  principalId: string;
  conversationId: string;
  now: () => Instant;
  newId: (prefix: string) => string;
  /** Every folder this node owns. A folder an automation names must be inside one. */
  ownedRoots: () => readonly string[];
  /** Ask the service to look again now, so a new timer or an edit is picked up without waiting for the interval. */
  kick?: () => void;
}

const GIVABLE_EFFECTS: readonly EffectCategory[] = ["read", "local-write", "external-write", "communication"];
const OPS = ["equals", "in", "contains", "exists"] as const;

const MATCH_SCHEMA = {
  type: "array",
  maxItems: 16,
  description:
    "Conditions on the signal, all of which must hold. path reads the signal with dots, e.g. payload.label, " +
    "subject.refs.repository, source.provider, payload.labels.0.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["path", "op"],
    properties: {
      path: { type: "string" },
      op: { type: "string", enum: [...OPS] },
      value: { description: "What to compare with. A list for in; omitted for exists." },
    },
  },
};

function describeWhen(intent: PersistentIntent): string {
  const schedule = intent.schedule;
  if (schedule !== undefined) return "everyMinutes" in schedule ? `every ${String(schedule.everyMinutes)} min` : `at ${schedule.at}`;
  const conditions = intent.match.map((condition) =>
    condition.op === "exists" ? `${condition.path} exists` : `${condition.path} ${condition.op} ${JSON.stringify(condition.value)}`,
  );
  return conditions.length === 0 ? intent.when.topic : `${intent.when.topic} where ${conditions.join(" and ")}`;
}

function describeDo(action: IntentAction): string {
  if (action.kind === "remind") return `remind: ${action.message}`;
  const places = action.resources.map((resource) =>
    resource.kind === "repository" ? `${resource.path} (repository, in its own worktree)` : `${resource.path} (${resource.access})`,
  );
  return `task: ${action.goal} · in ${places.join(", ")} · may ${action.allowedCategories.join(", ") || "only read"}`;
}

function describe(intent: PersistentIntent, runs: readonly { state: string; createdAt: string }[]): string {
  const last = runs[0];
  const lately = last === undefined ? "not run yet" : `last ${last.state} at ${last.createdAt}`;
  const next = intent.nextFireAt === undefined ? "" : ` · next ${intent.nextFireAt}`;
  return `- ${intent.intentId} · ${intent.state} · ${intent.summary}\n  when ${describeWhen(intent)} → ${describeDo(intent.do)} · ${lately}${next}`;
}

function readMatch(raw: unknown): { ok: true; match: MatchCondition[] } | { ok: false; text: string } {
  if (raw === undefined) return { ok: true, match: [] };
  if (!Array.isArray(raw)) return { ok: false, text: "match must be a list of conditions" };
  const match: MatchCondition[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false, text: "each condition is an object with path and op" };
    const { path, op, value } = entry as Record<string, unknown>;
    if (typeof path !== "string" || !OPS.includes(op as (typeof OPS)[number])) {
      return { ok: false, text: `each condition needs a path and one of ${OPS.join(", ")}` };
    }
    if (op === "exists") match.push({ path, op });
    else if (op === "in") {
      if (!Array.isArray(value)) return { ok: false, text: `the in condition on ${path} needs a list of values` };
      match.push({ path, op, value });
    } else match.push({ path, op: op as "equals" | "contains", value });
  }
  return { ok: true, match };
}

function readSchedule(raw: unknown): { ok: true; schedule?: AutomationSchedule } | { ok: false; text: string } {
  if (raw === undefined) return { ok: true };
  if (typeof raw !== "object" || raw === null) return { ok: false, text: "schedule is { everyMinutes } or { at }" };
  const { everyMinutes, at } = raw as Record<string, unknown>;
  if (typeof everyMinutes === "number") return { ok: true, schedule: { everyMinutes } };
  if (typeof at === "string" && !Number.isNaN(Date.parse(at))) {
    return { ok: true, schedule: { at: new Date(at).toISOString() as Instant } };
  }
  return { ok: false, text: "schedule is { everyMinutes: number } or { at: an ISO time }" };
}

function readAction(
  params: Record<string, unknown>,
  owned: ReturnType<typeof ownedResources>,
): { ok: true; action: IntentAction } | { ok: false; text: string } {
  if (params.action === "remind") {
    const message = typeof params.message === "string" ? params.message.trim() : "";
    if (message === "") return { ok: false, text: "a reminder needs the message to say" };
    return { ok: true, action: { kind: "remind", message } };
  }
  if (params.action !== "task") return { ok: false, text: "action is task or remind" };
  const goal = typeof params.goal === "string" ? params.goal.trim() : "";
  if (goal === "") return { ok: false, text: "a task needs a goal: what to do when it matches" };

  const resources: TaskResource[] = [];
  const folders = Array.isArray(params.folders) ? params.folders : [];
  const repositories = Array.isArray(params.repositories) ? params.repositories : [];
  for (const folder of folders) {
    const { path, access } = (typeof folder === "object" && folder !== null ? folder : {}) as Record<string, unknown>;
    if (typeof path !== "string" || (access !== "read" && access !== "write")) {
      return { ok: false, text: "each folder is { path, access: read | write }" };
    }
    resources.push({ kind: "folder", path, access });
  }
  for (const repository of repositories) {
    if (typeof repository !== "string") return { ok: false, text: "each repository is a path" };
    resources.push({ kind: "repository", path: repository });
  }
  if (resources.length === 0) {
    return {
      ok: false,
      text: "a task that runs on its own must name the folders or repositories it may touch; ask the user which, and pass them",
    };
  }
  for (const resource of resources) {
    if (!isAbsolute(resource.path)) return { ok: false, text: `${resource.path} is not an absolute path` };
    if (containingRoot(owned, resource.path) === undefined) {
      return { ok: false, text: `${resource.path} is not inside a folder this node owns, so an automation cannot be given it` };
    }
    resource.path = resolve(resource.path);
  }

  const effects = Array.isArray(params.allowedEffects) ? params.allowedEffects : ["read"];
  const allowedCategories: EffectCategory[] = [];
  for (const effect of effects) {
    if (!GIVABLE_EFFECTS.includes(effect as EffectCategory)) {
      return {
        ok: false,
        text: `${String(effect)} cannot be given to an automation; it may be given ${GIVABLE_EFFECTS.join(", ")}, and anything else is asked about when it comes up`,
      };
    }
    if (!allowedCategories.includes(effect as EffectCategory)) allowedCategories.push(effect as EffectCategory);
  }
  return { ok: true, action: { kind: "task", goal, resources, allowedCategories } };
}

export function createAutomationTools(deps: AutomationToolDeps): ToolDefinition[] {
  const serviceDeps = { db: deps.db, nodeId: deps.nodeId, now: deps.now, newId: deps.newId };
  return [
    {
      name: "create_automation",
      label: "Tạo việc tự động",
      description:
        "Set up something that happens on its own from now on: when a signal arrives (e.g. topic github.issue.labeled " +
        "where payload.label equals ai-handle) or on a schedule (every N minutes, or once at a time). Use it only when " +
        "the user asks for something to keep happening later, never for work to do now. action task runs Clark work " +
        "in the folders/repositories named, with only the effects the user gave it (allowedEffects); action remind " +
        "says a message in this conversation and the inbox. Ask the user for anything missing instead of guessing.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "action"],
        properties: {
          summary: { type: "string", description: "What it does, in the user's words, one line." },
          topic: { type: "string", description: "Dotted lower-case signal topic to answer. Omit when using schedule." },
          match: MATCH_SCHEMA,
          schedule: {
            type: "object",
            additionalProperties: false,
            description: "{ everyMinutes } or { at: ISO time }. Omit when answering a topic.",
            properties: { everyMinutes: { type: "integer", minimum: 1 }, at: { type: "string" } },
          },
          action: { type: "string", enum: ["task", "remind"] },
          goal: { type: "string", description: "For task: what to do each time it matches." },
          message: { type: "string", description: "For remind: what to say." },
          folders: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "access"],
              properties: { path: { type: "string" }, access: { type: "string", enum: ["read", "write"] } },
            },
          },
          repositories: {
            type: "array",
            maxItems: 8,
            items: { type: "string" },
            description: "Repositories to change; each run works in its own worktree, never in the user's tree.",
          },
          allowedEffects: {
            type: "array",
            items: { type: "string", enum: [...GIVABLE_EFFECTS] },
            description: "Only what the user said it may do. external-write covers pushing or posting outside this machine.",
          },
          allowSelfTriggered: {
            type: "boolean",
            description: "Whether a signal Clark's own work caused may start it again. Default false.",
          },
        },
      },
      promptSnippet: "create_automation — keep doing something later, when a signal arrives or on a schedule",
      execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
        const summary = typeof params.summary === "string" ? params.summary.trim() : "";
        if (summary === "") return { text: "summary is required: one line saying what it does." };
        const match = readMatch(params.match);
        if (!match.ok) return { text: match.text };
        const schedule = readSchedule(params.schedule);
        if (!schedule.ok) return { text: schedule.text };
        const topic = typeof params.topic === "string" ? params.topic.trim() : undefined;
        if (schedule.schedule === undefined && (topic === undefined || topic === "")) {
          return { text: "say when it happens: a topic to answer, or a schedule." };
        }
        const action = readAction(params, ownedResources(deps.ownedRoots()));
        if (!action.ok) return { text: action.text };
        const created = createAutomation(serviceDeps, {
          principalId: deps.principalId,
          conversationId: deps.conversationId,
          summary,
          ...(schedule.schedule === undefined ? { topic } : { schedule: schedule.schedule }),
          match: match.match,
          do: action.action,
          allowSelfTriggered: params.allowSelfTriggered === true,
        } as Parameters<typeof createAutomation>[1]);
        if (!created.ok) return { text: `Not set up: ${created.message}` };
        deps.kick?.();
        return { text: `Set up. It reports in this conversation.\n${describe(created.intent, [])}` };
      },
    },
    {
      name: "list_automations",
      label: "Xem việc tự động",
      description:
        "List what the user has set up to happen on its own, with what each one answers, what it does and when it last " +
        "ran. Use it when they ask what is automated, or before changing one, to find its id.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      promptSnippet: "list_automations — what is set up to happen on its own, with ids",
      execute: async (): Promise<{ text: string }> => {
        const listed = listAutomations({ db: deps.db }, deps.principalId);
        if (listed.length === 0) return { text: "Nothing is set up to happen on its own." };
        return { text: listed.map((entry) => describe(entry.intent, entry.recentRuns)).join("\n") };
      },
    },
    {
      name: "update_automation",
      label: "Đổi việc tự động",
      description:
        "Pause, resume, remove or edit one automation by the id list_automations showed. Removing stops it for good " +
        "and keeps a record of what it did; pausing keeps it until resumed. A run already waiting when it is paused " +
        "does not start.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["intentId"],
        properties: {
          intentId: { type: "string" },
          change: { type: "string", enum: ["pause", "resume", "remove"] },
          summary: { type: "string" },
          match: MATCH_SCHEMA,
          goal: { type: "string", description: "A new goal for a task automation." },
          message: { type: "string", description: "A new message for a reminder." },
        },
      },
      promptSnippet: "update_automation — pause, resume, remove or edit an automation by id",
      execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
        const intentId = typeof params.intentId === "string" ? params.intentId.trim() : "";
        if (intentId === "") return { text: "intentId is required; call list_automations to see the ids." };
        const change: AutomationChange = {};
        if (params.change === "pause") change.state = "paused";
        else if (params.change === "resume") change.state = "active";
        else if (params.change === "remove") change.state = "removed";
        if (typeof params.summary === "string" && params.summary.trim() !== "") change.summary = params.summary.trim();
        if (params.match !== undefined) {
          const match = readMatch(params.match);
          if (!match.ok) return { text: match.text };
          change.match = match.match;
        }
        const newGoal = typeof params.goal === "string" ? params.goal.trim() : "";
        const newMessage = typeof params.message === "string" ? params.message.trim() : "";
        if (newGoal !== "" || newMessage !== "") {
          const current = listAutomations({ db: deps.db }, deps.principalId).find((entry) => entry.intent.intentId === intentId);
          if (current === undefined) return { text: `There is no automation ${intentId}.` };
          const action = current.intent.do;
          if (action.kind === "task" && newGoal !== "") change.do = { ...action, goal: newGoal };
          else if (action.kind === "remind" && newMessage !== "") change.do = { ...action, message: newMessage };
          else return { text: action.kind === "task" ? "a task automation is edited with goal" : "a reminder is edited with message" };
        }
        if (Object.keys(change).length === 0) return { text: "Nothing to change: pass change, summary, match, goal or message." };
        const updated = updateAutomation({ db: deps.db, nodeId: deps.nodeId, now: deps.now, newId: deps.newId }, {
          intentId,
          principalId: deps.principalId,
          change,
        });
        if (!updated.ok) return { text: `Not changed: ${updated.message}` };
        deps.kick?.();
        return {
          text:
            updated.intent.state === "removed"
              ? `Removed ${intentId}; it will not run again.`
              : `Changed.\n${describe(updated.intent, [])}`,
        };
      },
    },
  ];
}
