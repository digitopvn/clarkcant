import { isAbsolute, posix, resolve, win32 } from "node:path";

import type {
  AutomationSchedule,
  EffectCategory,
  Instant,
  IntentAction,
  MatchCondition,
  PersistentIntent,
  TaskResource,
} from "@clarkcant/contracts";
import {
  type AutomationChange,
  createAutomation,
  listAutomations,
  updateAutomation,
  writeRegisteredPreference,
} from "@clarkcant/core";
import type { ToolDefinition } from "@clarkcant/pi-adapter";
import {
  GITHUB_EVENTS,
  GITHUB_WEBHOOK_CONSUMER,
  GITHUB_WEBHOOK_SECRET_NAME,
  WEBHOOK_SIGNATURE_HEADER,
  webhookConsumer,
  webhookSecretName,
  webhookSourceOfTopic,
} from "@clarkcant/signal-sources";
import {
  type Database,
  getPeer,
  getSecretMetadata,
  listPeers,
  livePeerAllowance,
  putPeerAllowance,
  revokePeerAllowance,
  secretBackendFor,
} from "@clarkcant/storage";

import { TASK_GRANT_LIFETIME_MS, taskGrant, writeGrant } from "./delegation.ts";
import { containingRoot, ownedResources } from "./preflight.ts";
import { GITHUB_SELF_LOGINS_PREFERENCE, GITHUB_SIGNAL_PATH, githubSelfLogins } from "./routes/github-signals.ts";
import { WEBHOOK_SIGNAL_PATH_PREFIX } from "./routes/webhook-signals.ts";

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
  /** This node's owner: only they hand work to a paired node, or let one run work here. The principal when absent. */
  ownerPrincipalId?: string;
  /** Wake the outbox, so what was just written for a peer reaches it now rather than on the next round. */
  kickDelivery?: () => void;
  /** This node's key fingerprint, which a grant it sends is confirmed under. Absent, no work is handed to a peer. */
  fingerprint?: string;
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
  const where = action.executor === undefined ? "" : ` · runs on ${action.executor}`;
  return `task: ${action.goal} · in ${places.join(", ")} · may ${action.allowedCategories.join(", ") || "only read"}${where}`;
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

/**
 * The folders and repositories named, as task resources.
 *
 * On this node each has to be inside a folder it owns. On a paired node (`owned` absent) it is that node's path, which
 * only that node can check, so it is kept exactly as written: absolute in that node's own terms, whichever system it
 * runs.
 */
function readResources(
  params: Record<string, unknown>,
  owned: ReturnType<typeof ownedResources> | undefined,
): { ok: true; resources: TaskResource[] } | { ok: false; text: string } {
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
    if (owned === undefined) {
      if (!posix.isAbsolute(resource.path) && !win32.isAbsolute(resource.path)) {
        return { ok: false, text: `${resource.path} is not an absolute path on that node` };
      }
      continue;
    }
    if (!isAbsolute(resource.path)) return { ok: false, text: `${resource.path} is not an absolute path` };
    if (containingRoot(owned, resource.path) === undefined) {
      return { ok: false, text: `${resource.path} is not inside a folder this node owns, so it cannot be given` };
    }
    resource.path = resolve(resource.path);
  }
  return { ok: true, resources };
}

function readEffects(params: Record<string, unknown>): { ok: true; allowedCategories: EffectCategory[] } | { ok: false; text: string } {
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
  return { ok: true, allowedCategories };
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
  const executor = typeof params.executor === "string" && params.executor.trim() !== "" ? params.executor.trim() : undefined;
  const resources = readResources(params, executor === undefined ? owned : undefined);
  if (!resources.ok) return resources;
  const effects = readEffects(params);
  if (!effects.ok) return effects;
  return {
    ok: true,
    action: {
      kind: "task",
      goal,
      resources: resources.resources,
      allowedCategories: effects.allowedCategories,
      ...(executor === undefined ? {} : { executor }),
    },
  };
}

function confirmedPeer(db: Database, peerNodeId: string): boolean {
  const peer = getPeer(db, peerNodeId);
  return peer !== undefined && peer.trustedAt !== null && peer.revokedAt === null;
}

function describePlaces(resources: readonly TaskResource[]): string {
  return resources
    .map((resource) => (resource.kind === "repository" ? `${resource.path} (repository)` : `${resource.path} (${resource.access})`))
    .join(", ");
}

function hasSecret(db: Database, principalId: string, name: string): boolean {
  const metadata = getSecretMetadata(db, principalId, name);
  return metadata !== undefined && secretBackendFor(db, principalId, metadata.backend)?.has(metadata.backendRef) === true;
}

/**
 * What a GitHub automation still needs before a delivery can reach it, said to the agent right after it is set up.
 *
 * Asked for only now, when something needs it: the webhook secret through `request_secret`, so its value never enters
 * the conversation; which account is Clark's own, so its own labels and comments do not start the work again; and the
 * repository the automation is about, so a label anywhere else does not start work in this checkout.
 */
/** The token a coding task pushes and opens pull requests with, and the two commands it is for. */
const GITHUB_TOKEN_SECRET_NAME = "github_token";
const GITHUB_TOKEN_CONSUMERS = "command:gh,command:git";

function githubSetup(deps: AutomationToolDeps, intent: PersistentIntent): string {
  const lines = [
    `GitHub reaches this automation with a repository webhook to POST ${GITHUB_SIGNAL_PATH} on this node's public address, ` +
      `content type application/json, for the events it answers (${GITHUB_EVENTS.join(", ")}).`,
  ];
  if (!hasSecret(deps.db, deps.principalId, GITHUB_WEBHOOK_SECRET_NAME)) {
    lines.push(
      `No webhook secret is set yet, and a delivery without one is refused. Call request_secret with name ` +
        `"${GITHUB_WEBHOOK_SECRET_NAME}", secretKind "webhook-secret", consumer "${GITHUB_WEBHOOK_CONSUMER}", and tell the ` +
        `user to put the same secret in the webhook's settings on GitHub.`,
    );
  }
  const selfLogins = githubSelfLogins(deps.db, deps.principalId, deps.now);
  lines.push(
    selfLogins.length === 0
      ? "No GitHub account is recorded as Clark's own. Ask the user which login Clark pushes and comments as, and pass it as githubSelfLogins, so what Clark does is not taken as new work."
      : `Signals caused by ${selfLogins.join(", ")} are Clark's own and do not start it${intent.allowSelfTriggered ? " — except this one, which was asked to" : ""}.`,
  );
  if (intent.do.kind === "task" && !hasSecret(deps.db, deps.principalId, GITHUB_TOKEN_SECRET_NAME)) {
    lines.push(
      `The task's worker pushes and opens pull requests with run_command, passing secretRef "${GITHUB_TOKEN_SECRET_NAME}" ` +
        `to git push and gh. No such token is set: call request_secret with name "${GITHUB_TOKEN_SECRET_NAME}", secretKind ` +
        `"token", consumer "${GITHUB_TOKEN_CONSUMERS}", so it reaches those two commands' environment and nothing else.`,
    );
  }
  const bound = intent.match.some((condition) => condition.path === "subject.refs.repository");
  if (!bound && intent.do.kind === "task") {
    lines.push("It is not bound to one repository: add match subject.refs.repository equals owner/name, or every repository's events will reach it and be refused against its checkout.");
  }
  return lines.join("\n");
}

/**
 * What a signed webhook automation needs before a delivery can reach it: where the sender posts, how it signs and what
 * it sends, and — asked for only now — the shared secret, through `request_secret` so its value never enters the
 * conversation.
 */
function webhookSetup(deps: AutomationToolDeps, sourceId: string): string {
  const lines = [
    `The sender reaches this automation with POST ${WEBHOOK_SIGNAL_PATH_PREFIX}${sourceId} on this node's public address: ` +
      `a JSON body { "id": its own id for the event, "topic": what happened (dotted lower-case words), "payload": {…} } ` +
      `signed with the shared secret as ${WEBHOOK_SIGNATURE_HEADER}: sha256=<hex HMAC-SHA256 of the exact body>. ` +
      `A body with topic x.y becomes the signal webhook.${sourceId}.x.y.`,
  ];
  if (!hasSecret(deps.db, deps.principalId, webhookSecretName(sourceId))) {
    lines.push(
      `No shared secret is set for ${sourceId} yet, and a delivery to it is refused until there is one. Call request_secret ` +
        `with name "${webhookSecretName(sourceId)}", secretKind "webhook-secret", consumer "${webhookConsumer(sourceId)}", ` +
        `and tell the user to give the sender the same secret.`,
    );
  }
  return lines.join("\n");
}

function rememberSelfLogins(deps: AutomationToolDeps, raw: unknown): { ok: true } | { ok: false; text: string } {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === "string")) {
    return { ok: false, text: "githubSelfLogins is a list of GitHub logins" };
  }
  const merged = [...githubSelfLogins(deps.db, deps.principalId, deps.now), ...(raw as string[])];
  const written = writeRegisteredPreference(
    { db: deps.db, now: deps.now },
    { principalId: deps.principalId, key: GITHUB_SELF_LOGINS_PREFERENCE, value: merged, source: "user" },
  );
  return written.ok ? { ok: true } : { ok: false, text: `githubSelfLogins not kept: ${written.message}` };
}

const FOLDERS_SCHEMA = {
  type: "array",
  maxItems: 8,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["path", "access"],
    properties: { path: { type: "string" }, access: { type: "string", enum: ["read", "write"] } },
  },
};

export function createAutomationTools(deps: AutomationToolDeps): ToolDefinition[] {
  const serviceDeps = { db: deps.db, nodeId: deps.nodeId, now: deps.now, newId: deps.newId };
  const owner = deps.ownerPrincipalId ?? deps.principalId;
  const fingerprint = deps.fingerprint;
  const grantExpiry = (): Instant => new Date(Date.parse(deps.now()) + TASK_GRANT_LIFETIME_MS).toISOString() as Instant;

  /** Hand a task automation to a paired node: the grant this node's owner writes for it, sent to it now. */
  const handOver = (
    action: Extract<IntentAction, { kind: "task" }> & { executor: string },
  ): { ok: true; send: () => boolean } | { ok: false; text: string } => {
    if (deps.principalId !== owner) return { ok: false, text: "only this node's owner can hand work to another node" };
    if (fingerprint === undefined) return { ok: false, text: "this node cannot hand work to another node from here" };
    if (!confirmedPeer(deps.db, action.executor)) {
      return { ok: false, text: `${action.executor} is not a paired node; call list_peers to see the nodes this one is paired with` };
    }
    const built = taskGrant({
      grantId: deps.newId("grt"),
      ownerPrincipalId: owner,
      senderNodeId: deps.nodeId,
      receiverNodeId: action.executor,
      resources: action.resources,
      allowedCategories: action.allowedCategories,
      expiresAt: grantExpiry(),
    });
    if (!built.ok) return { ok: false, text: `that cannot be handed over: ${built.message}` };
    return {
      ok: true,
      send: () => {
        const identity = { nodeId: deps.nodeId, ownerPrincipalId: owner, fingerprint };
        const written = writeGrant({ db: deps.db, identity, now: deps.now, newId: deps.newId }, built.grant);
        if (written.ok) deps.kickDelivery?.();
        return written.ok;
      },
    };
  };

  return [
    {
      name: "create_automation",
      label: "Tạo việc tự động",
      description:
        "Set up something that happens on its own from now on: when a signal arrives (e.g. topic github.issue.labeled " +
        "where payload.label equals ai-handle) or on a schedule (every N minutes, or once at a time). Use it only when " +
        "the user asks for something to keep happening later, never for work to do now. Anything else that can sign an " +
        "HTTP POST becomes a source the user names: topic webhook.<source>.<what happened>, e.g. webhook.deploys.build.failed. " +
        "action task runs Clark work " +
        "in the folders/repositories named, with only the effects the user gave it (allowedEffects); action remind " +
        "says a message in this conversation and the inbox. A task can run on another of the user's paired nodes " +
        "(executor, from list_peers): its folders are then that node's paths, and it runs there only within what that " +
        "node's owner allows this one. Ask the user for anything missing instead of guessing.",
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
          folders: FOLDERS_SCHEMA,
          repositories: {
            type: "array",
            maxItems: 8,
            items: { type: "string" },
            description: "Repositories to change; each run works in its own worktree, never in the user's tree.",
          },
          executor: {
            type: "string",
            description: "For task: the node id of a paired node that runs it instead of this one. Omit to run it here.",
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
          githubSelfLogins: {
            type: "array",
            maxItems: 20,
            items: { type: "string" },
            description: "GitHub logins that are Clark itself on this node (the account it pushes and comments as). Kept for every GitHub automation.",
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
        const task = action.action.kind === "task" ? action.action : undefined;
        const handed = task?.executor === undefined ? undefined : handOver({ ...task, executor: task.executor });
        if (handed !== undefined && !handed.ok) return { text: handed.text };
        const remembered = rememberSelfLogins(deps, params.githubSelfLogins);
        if (!remembered.ok) return { text: remembered.text };
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
        if (handed !== undefined && !handed.send()) {
          // The peer was confirmed a moment ago; whatever changed since, an automation that cannot hand over is not kept.
          updateAutomation(serviceDeps, { intentId: created.intent.intentId, principalId: deps.principalId, change: { state: "removed" } });
          return { text: `Not set up: ${task?.executor ?? ""} can no longer be handed work.` };
        }
        deps.kick?.();
        const there =
          task?.executor === undefined
            ? ""
            : `\nIt runs on ${task.executor}, which runs it only within what its owner allows this node; until they allow ` +
              `${describePlaces(task.resources)} there, each run is refused on that node and said here.`;
        const setUp = `Set up. It reports in this conversation.${there}\n${describe(created.intent, [])}`;
        if (created.intent.when.topic.startsWith("github.")) return { text: `${setUp}\n${githubSetup(deps, created.intent)}` };
        const webhookSource = webhookSourceOfTopic(created.intent.when.topic);
        return { text: webhookSource === undefined ? setUp : `${setUp}\n${webhookSetup(deps, webhookSource)}` };
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
    {
      name: "list_peers",
      label: "Xem các node đã ghép đôi",
      description:
        "List the user's other nodes this one is paired with, by node id, and what each may run here. Use it before " +
        "handing a task automation to one (create_automation executor) or letting one run work here (allow_peer_tasks).",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      promptSnippet: "list_peers — the paired nodes, and what each may run here",
      execute: async (): Promise<{ text: string }> => {
        const at = deps.now();
        const peers = listPeers(deps.db).filter((peer) => peer.trustedAt !== null && peer.revokedAt === null);
        if (peers.length === 0) return { text: "This node is not paired with any other node." };
        return {
          text: peers
            .map((peer) => {
              const allowance = livePeerAllowance(deps.db, peer.peerNodeId, at);
              const here =
                allowance === undefined
                  ? "may not run work here"
                  : `may run work here in ${allowance.grant.resources
                      .map((resource) => `${resource.resourceId} (${resource.kind === "repository" ? "repository" : resource.access})`)
                      .join(", ")}, may ${(allowance.grant.allowedEffectCategories ?? []).join(", ") || "only read"}`;
              return `- ${peer.peerNodeId} · fingerprint ${peer.fingerprint} · ${here}`;
            })
            .join("\n"),
        };
      },
    },
    {
      name: "allow_peer_tasks",
      label: "Cho node khác chạy việc ở đây",
      description:
        "Let one of the user's paired nodes run the tasks it hands over on this node: only in the folders and " +
        "repositories named here, and only with the effects given. Saying it again replaces what was allowed; stop " +
        "withdraws it. Work a node hands over reports in this conversation. Use it only when the user says so.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["peer"],
        properties: {
          peer: { type: "string", description: "The node id, from list_peers." },
          folders: FOLDERS_SCHEMA,
          repositories: { type: "array", maxItems: 8, items: { type: "string" } },
          allowedEffects: {
            type: "array",
            items: { type: "string", enum: [...GIVABLE_EFFECTS] },
            description: "Only what the user said that node's work may do here without asking.",
          },
          stop: { type: "boolean", description: "Withdraw what that node was allowed. Tasks it hands over are refused after." },
        },
      },
      promptSnippet: "allow_peer_tasks — let a paired node run its tasks here, in named folders only; stop withdraws it",
      execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
        if (deps.principalId !== owner) return { text: "Only this node's owner can let another node run work here." };
        const peer = typeof params.peer === "string" ? params.peer.trim() : "";
        if (!confirmedPeer(deps.db, peer)) return { text: `${peer || "That"} is not a paired node; call list_peers to see them.` };
        if (params.stop === true) {
          return {
            text: revokePeerAllowance(deps.db, peer, deps.now())
              ? `${peer} may no longer run work here. What it already started goes on until it ends or is stopped.`
              : `${peer} was not allowed to run work here.`,
          };
        }
        const resources = readResources(params, ownedResources(deps.ownedRoots()));
        if (!resources.ok) return { text: resources.text };
        if (resources.resources.length === 0) {
          return { text: "name the folders or repositories that node's work may use here; ask the user which" };
        }
        const effects = readEffects(params);
        if (!effects.ok) return { text: effects.text };
        // Written as a grant from that node to this one, so it intersects with that node's own grant field by field.
        const built = taskGrant({
          grantId: deps.newId("alw"),
          ownerPrincipalId: owner,
          senderNodeId: peer,
          receiverNodeId: deps.nodeId,
          resources: resources.resources,
          allowedCategories: effects.allowedCategories,
          expiresAt: grantExpiry(),
        });
        if (!built.ok) return { text: `Not allowed: ${built.message}` };
        putPeerAllowance(deps.db, { peerNodeId: peer, ownerPrincipalId: owner, conversationId: deps.conversationId, grant: built.grant, at: deps.now() });
        return {
          text:
            `${peer} may now run the tasks it hands over here, in ${describePlaces(resources.resources)}, and may ` +
            `${effects.allowedCategories.join(", ") || "only read"} without asking. Anything outside that is refused, a ` +
            "risky effect outside it waits for the user, and that work reports in this conversation.",
        };
      },
    },
  ];
}
