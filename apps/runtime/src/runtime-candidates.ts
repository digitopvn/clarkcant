import { type Instant } from "@clarkcant/contracts";
import type { ToolDefinition } from "@clarkcant/pi-adapter";
import { type Database, allRows, oneRow } from "@clarkcant/storage";

/**
 * Running runtimes on this node.
 *
 * This is the **structured filter** layer of path A: what is actually running right now, read from
 * state tables rather than from a text index. "Which worker is running" is a lookup, not a search,
 * and keeping the two apart is what stops a keyword query from ever claiming to report live status.
 *
 * Candidates are described to a selector with a short label and an opaque id. The id is stable but
 * meaningless — it is something to echo back, not something to construct — and the description
 * carries no paths, no goals and no credentials.
 */

export type RuntimeCandidateKind = "lease" | "live-owner" | "voice-session" | "task" | "node" | "capability";

export interface RuntimeCandidate {
  /** Opaque handle the selector may choose. Never a path or a capability name. */
  id: string;
  kind: RuntimeCandidateKind;
  /** One short line for a reader and for the selector. Bounded. */
  label: string;
  /** Capabilities the running thing can use, for structured filtering. Not sent to the selector. */
  capabilities: readonly string[];
  /**
   * What a selector is told about this candidate, when `kind` and `load` would not tell two of them
   * apart.
   *
   * A routing candidate is a capability rather than a running thing, so "capability, đang rảnh" is
   * the same line for every candidate and choosing between them would be a coin flip. This field
   * carries the registry's own summary and effect class instead.
   *
   * Registry metadata only, never user text: `label` above is the human line, and it is deliberately
   * not what leaves the machine.
   */
  describe?: string;
  /** Whether it is live now, as of this read. */
  live: boolean;
  /** How much it is already doing, so "pick the idle one" is a real tiebreak. */
  load: number;
  /** When it stops being live, when the source knows. */
  expiresAt?: string;
}

export interface RuntimeCandidateDeps {
  db: Database;
  nodeId: string;
  now: () => Instant;
}

/** How many candidates a selector is ever offered. More than this is not a choice, it is a list. */
export const MAX_RUNTIME_CANDIDATES = 12;

/**
 * Read what is running.
 *
 * Five sources, each one a different kind of "live": a lease is a writer, a live owner is a mounted
 * surface, a voice session is an open microphone, a task is work in flight, and the node itself is
 * always a candidate so a question about "this machine" has an answer.
 */
export function listRuntimeCandidates(deps: RuntimeCandidateDeps): RuntimeCandidate[] {
  const at = deps.now();
  const candidates: RuntimeCandidate[] = [];

  const leases = allRows<{
    lease_id: string;
    resource_id: string;
    resource_kind: string;
    holder_task_id: string | null;
    expires_at: string;
  }>(
    deps.db,
    `SELECT lease_id, resource_id, resource_kind, holder_task_id, expires_at
       FROM leases
      WHERE released_at IS NULL AND expires_at > ?
      ORDER BY acquired_at DESC
      LIMIT ?`,
    at,
    MAX_RUNTIME_CANDIDATES,
  );
  for (const lease of leases) {
    candidates.push({
      id: `runtime:lease:${lease.lease_id}`,
      kind: "lease",
      // The resource id is a project or workspace handle the user already named, so it is the part
      // they will recognise. It is not a path.
      label: `đang giữ ${lease.resource_kind} ${lease.resource_id}`,
      capabilities: [],
      live: true,
      load: 1,
      expiresAt: lease.expires_at,
    });
  }

  const owners = allRows<{ instance_id: string; owner_surface: string; claimed_at: string; lease_expires_at: string | null }>(
    deps.db,
    "SELECT instance_id, owner_surface, claimed_at, lease_expires_at FROM widget_live_owners LIMIT ?",
    MAX_RUNTIME_CANDIDATES,
  );
  for (const owner of owners) {
    const expired = owner.lease_expires_at !== null && new Date(owner.lease_expires_at).getTime() <= new Date(at).getTime();
    if (expired) continue;
    candidates.push({
      id: `runtime:surface:${owner.instance_id}`,
      kind: "live-owner",
      label: `bề mặt đang mở (${owner.owner_surface})`,
      capabilities: [],
      live: true,
      load: 0,
      ...(owner.lease_expires_at === null ? {} : { expiresAt: owner.lease_expires_at }),
    });
  }

  const voice = allRows<{ voice_session_id: string; state: string; provider: string; started_at: string }>(
    deps.db,
    "SELECT voice_session_id, state, provider, started_at FROM voice_sessions WHERE ended_at IS NULL LIMIT ?",
    MAX_RUNTIME_CANDIDATES,
  );
  for (const session of voice) {
    candidates.push({
      id: `runtime:voice:${session.voice_session_id}`,
      kind: "voice-session",
      label: `phiên thoại đang mở (${session.state})`,
      capabilities: [],
      live: session.state !== "ended",
      load: 1,
    });
  }

  const tasks = allRows<{ task_id: string; state: string; goal: string; execution_node_id: string | null }>(
    deps.db,
    `SELECT task_id, state, goal, execution_node_id
       FROM tasks
      WHERE state NOT IN ('succeeded','failed','cancelled')
      ORDER BY updated_at DESC
      LIMIT ?`,
    MAX_RUNTIME_CANDIDATES,
  );
  for (const task of tasks) {
    candidates.push({
      id: `runtime:task:${task.task_id}`,
      kind: "task",
      // The goal is the user's own words, truncated: it is what they will recognise. It never goes
      // to a selector, which is why the label is separate from that payload.
      label: `việc đang chạy: ${task.goal.slice(0, 80)}`,
      capabilities: [],
      live: true,
      load: 1,
    });
  }

  const node = oneRow<{ node_id: string; label: string }>(
    deps.db,
    "SELECT node_id, label FROM nodes WHERE node_id = ? AND revoked_at IS NULL",
    deps.nodeId,
  );
  candidates.push({
    id: `runtime:node:${deps.nodeId}`,
    kind: "node",
    label: node === undefined ? "máy này" : `máy này (${node.label})`,
    capabilities: [],
    live: true,
    load: 0,
  });

  return candidates;
}

export interface RuntimeFilter {
  kind?: RuntimeCandidateKind;
  /** Case- and diacritic-insensitive substring of the label. */
  labelContains?: string;
  /** Capability the candidate must be able to use. */
  requiredCapability?: string;
  liveOnly?: boolean;
}

/** Normalise Vietnamese text for a substring match, so "đăng nhập" and "dang nhap" agree. */
function normalise(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase();
}

/**
 * Narrow the candidate set before anything is asked to choose.
 *
 * A structured filter runs first because it is exact and free: if the user named a capability, a
 * candidate that cannot use it is not a candidate. The selector then only sees what survived.
 */
export function filterRuntimeCandidates(
  candidates: readonly RuntimeCandidate[],
  filter: RuntimeFilter,
): RuntimeCandidate[] {
  return candidates.filter((candidate) => {
    if (filter.liveOnly !== false && !candidate.live) return false;
    if (filter.kind !== undefined && candidate.kind !== filter.kind) return false;
    if (filter.requiredCapability !== undefined && !candidate.capabilities.includes(filter.requiredCapability)) {
      return false;
    }
    if (filter.labelContains !== undefined && !normalise(candidate.label).includes(normalise(filter.labelContains))) {
      return false;
    }
    return true;
  });
}

/**
 * Rank for the deterministic path.
 *
 * Used when no selector is available, and as the comparison for the calibration in this phase: the
 * ordering is "idle first, then the kind that is most likely to be what was meant".
 */
export function rankRuntimeCandidates(candidates: readonly RuntimeCandidate[]): RuntimeCandidate[] {
  const kindWeight: Record<RuntimeCandidateKind, number> = {
    lease: 0,
    "live-owner": 1,
    task: 2,
    "voice-session": 3,
    node: 4,
    // A routing target built from the capability registry. It never shares a list with the kinds
    // above — the conductor asks about capabilities, `find_runtime` reports what is running — so the
    // weight only has to exist for the record to be exhaustive.
    capability: 5,
  };
  return [...candidates].sort((left, right) => {
    if (left.live !== right.live) return left.live ? -1 : 1;
    if (left.load !== right.load) return left.load - right.load;
    return kindWeight[left.kind] - kindWeight[right.kind];
  });
}

/**
 * Whether a chosen candidate is still real.
 *
 * Checked after a selection and before anything is dispatched, because the state can change while a
 * selector is thinking: a lease can be released, a tab can be closed, a task can finish. A selection
 * that no longer verifies falls back rather than being dispatched to a target that is gone.
 */
export function verifyRuntimeCandidate(deps: RuntimeCandidateDeps, id: string): boolean {
  if (id.startsWith("runtime:node:")) return id === `runtime:node:${deps.nodeId}`;

  const current = new Set(
    listRuntimeCandidates(deps)
      .filter((candidate) => candidate.live)
      .map((candidate) => candidate.id),
  );
  return current.has(id);
}

/**
 * `find_runtime`, as the Session Manager exposes it to the main model.
 *
 * The tool answers one question — what is running on this machine — and returns only what it read.
 * It does not dispatch, cancel or lease anything: those are gateway operations with their own
 * authorization, and a model that could start or stop work from a search tool would be a model that
 * bypasses the approval path.
 */
export function createFindRuntimeTool(deps: RuntimeCandidateDeps): ToolDefinition {
  return {
    name: "find_runtime",
    label: "Find what is running",
    description:
      "List the workers, leases, open voice sessions and running tasks on this machine. " +
      "Use it when the user refers to something that is running right now. It only reports state; " +
      "it cannot start or stop anything.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        labelContains: { type: "string", description: "Only list entries whose description contains this text." },
        kind: {
          type: "string",
          description: "Restrict to one kind of running thing.",
          // Deliberately not every member of `RuntimeCandidateKind`: `capability` is a routing target
          // the conductor builds, not something this tool reads from the running state, so offering
          // it here would advertise a filter that can never match.
          enum: ["lease", "live-owner", "voice-session", "task", "node"],
        },
      },
    },
    promptSnippet: "find_runtime — what is running on this machine right now",
    execute: async (params: Record<string, unknown>): Promise<{ text: string }> => {
      const filter: RuntimeFilter = {};
      if (typeof params.labelContains === "string") filter.labelContains = params.labelContains;
      if (
        params.kind === "lease" ||
        params.kind === "live-owner" ||
        params.kind === "voice-session" ||
        params.kind === "task" ||
        params.kind === "node"
      ) {
        filter.kind = params.kind;
      }

      const candidates = rankRuntimeCandidates(filterRuntimeCandidates(listRuntimeCandidates(deps), filter));
      if (candidates.length === 0) {
        return { text: "Nothing matching that is running on this machine right now." };
      }
      // Only the label is returned: the opaque ids exist so a decision can name a target, and the
      // model has no use for them in a sentence to the user.
      const listed = candidates.map((candidate) => `- ${candidate.label}`).join("\n");
      return { text: `${candidates.length} running:\n${listed}` };
    },
  };
}

/** A short, path-free description for the selector. Bounded to what the policy allows. */
export function describeRuntimeCandidate(candidate: RuntimeCandidate): string {
  if (candidate.describe !== undefined) return candidate.describe.slice(0, 300);
  const parts = [candidate.kind, candidate.load > 0 ? "đang bận" : "đang rảnh"];
  if (candidate.expiresAt !== undefined) parts.push("có hạn");
  return `${parts.join(", ")}`.slice(0, 300);
}
