/**
 * Needs-based guided setup.
 *
 * The setup is planned from what the user said they want to do, not from a fixed wizard. A user
 * who only wants to read their calendar is not walked through browser permissions, and a user who
 * has already connected something is not asked to connect it again.
 *
 * Each step declares the need it serves and what it requires to be already satisfied, so the plan
 * is computed rather than written out. That is what makes "needs-based" a property of the code
 * instead of a claim in the documentation.
 */

import { type Instant } from "@clarkcant/contracts";
import { type Database, allRows, oneRow, toJson, parseJson, transaction } from "@clarkcant/storage";

export type StepStatus = "pending" | "active" | "done" | "skipped" | "blocked";

export interface OnboardingDeps {
  db: Database;
  now: () => Instant;
}

/** What the user says they want to do. Free-form enough to describe a goal, specific enough to plan from. */
export type Need = "read-calendar" | "browse-web" | "write-files" | "use-voice" | "connect-mcp-server";

export interface SetupStep {
  stepId: string;
  /** The need this step serves, shown to the user so the ask is justified. */
  serves: Need;
  title: string;
  /** Why this step is being asked for, in the user's terms. */
  why: string;
  /** Steps that must be done first. A step whose prerequisite is unmet is blocked, not hidden. */
  requires: readonly string[];
}

/**
 * The catalogue.
 *
 * Deliberately has no entry that is not tied to a need: a step nobody's stated need requires
 * cannot appear in a plan.
 */
export const SETUP_STEPS: readonly SetupStep[] = [
  {
    stepId: "connect-google-calendar",
    serves: "read-calendar",
    title: "Connect Google Calendar",
    why: "Your calendar has to be connected before anything can read your agenda.",
    requires: [],
  },
  {
    stepId: "grant-browser-profile",
    serves: "browse-web",
    title: "Allow a managed browser profile",
    why: "Browsing runs in a separate profile, so your own logged-in browser is not used.",
    requires: [],
  },
  {
    stepId: "grant-project-folder",
    serves: "write-files",
    title: "Choose a project folder",
    why: "Only the folder you choose can be read or written.",
    requires: [],
  },
  {
    stepId: "grant-microphone",
    serves: "use-voice",
    title: "Allow microphone access",
    why: "Voice needs the microphone, and it is used only while you are speaking.",
    requires: ["grant-browser-profile"],
  },
  {
    stepId: "add-mcp-server",
    serves: "connect-mcp-server",
    title: "Add an MCP server",
    why: "Tools from that server become available once it is reachable.",
    requires: [],
  },
];

export interface PlannedStep extends SetupStep {
  status: StepStatus;
  /** Why the step is in this state, shown next to it rather than left to be inferred. */
  note: string;
}

export interface OnboardingPlan {
  principalId: string;
  nodeId: string;
  steps: PlannedStep[];
  /** Needs the user stated that nothing in the catalogue serves. */
  unservedNeeds: Need[];
  nextStep: PlannedStep | undefined;
}

interface CheckpointRow {
  step_id: string;
  status: string;
  context: string | null;
  updated_at: string;
}

function readCheckpoints(
  deps: OnboardingDeps,
  input: { principalId: string; nodeId: string; recipeId: string },
): Map<string, CheckpointRow> {
  const rows = allRows<CheckpointRow>(
    deps.db,
    "SELECT step_id, status, context, updated_at FROM onboarding_checkpoints WHERE principal_id = ? AND node_id = ? AND recipe_id = ?",
    input.principalId,
    input.nodeId,
    input.recipeId,
  );
  return new Map(rows.map((row) => [row.step_id, row]));
}

/**
 * Work out which steps this user actually needs, and in what order.
 *
 * A step already done is not asked again. A step whose prerequisite is unfinished is `blocked`
 * rather than dropped, because a step that silently disappears is one the user never learns they
 * will need.
 */
export function planOnboarding(
  deps: OnboardingDeps,
  input: { principalId: string; nodeId: string; recipeId?: string; needs: readonly Need[] },
): OnboardingPlan {
  const recipeId = input.recipeId ?? "default";
  const checkpoints = readCheckpoints(deps, {
    principalId: input.principalId,
    nodeId: input.nodeId,
    recipeId,
  });

  const wanted = new Set(input.needs);
  const relevant = SETUP_STEPS.filter((step) => wanted.has(step.serves));
  const doneIds = new Set<string>();
  for (const [stepId, row] of checkpoints) {
    if (row.status === "done") doneIds.add(stepId);
  }

  const steps: PlannedStep[] = relevant.map((step) => {
    const checkpoint = checkpoints.get(step.stepId);
    if (checkpoint?.status === "done") {
      return { ...step, status: "done", note: "Already done, so this is not asked again." };
    }
    if (checkpoint?.status === "skipped") {
      return { ...step, status: "skipped", note: "You skipped this earlier." };
    }
    const unmet = step.requires.filter((requirement) => !doneIds.has(requirement));
    if (unmet.length > 0) {
      return {
        ...step,
        status: "blocked",
        note: `Waiting on ${unmet.join(", ")} before this can be completed.`,
      };
    }
    return { ...step, status: "pending", note: "Needed for what you asked to do." };
  });

  const servedNeeds = new Set(SETUP_STEPS.map((step) => step.serves));
  return {
    principalId: input.principalId,
    nodeId: input.nodeId,
    steps,
    // A stated need that nothing serves is reported, rather than the user being shown a short
    // setup with no explanation of why their goal is not covered.
    unservedNeeds: input.needs.filter((need) => !servedNeeds.has(need)),
    nextStep: steps.find((step) => step.status === "pending"),
  };
}

/**
 * Record how a step went.
 *
 * The context is stored alongside so a later reader can see what was actually agreed to, not just
 * that the step finished. A "done" with no recorded context is indistinguishable from a step that
 * was marked done by mistake.
 */
export function recordStep(
  deps: OnboardingDeps,
  input: {
    principalId: string;
    nodeId: string;
    stepId: string;
    status: StepStatus;
    recipeId?: string;
    context?: Record<string, unknown>;
  },
): void {
  const step = SETUP_STEPS.find((candidate) => candidate.stepId === input.stepId);
  if (!step) throw new Error(`setup step ${input.stepId} is not in the catalogue`);

  const recipeId = input.recipeId ?? "default";
  const at = deps.now();
  transaction(deps.db, () => {
    deps.db
      .prepare(
        `INSERT INTO onboarding_checkpoints (principal_id, node_id, recipe_id, step_id, status, context, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (principal_id, node_id, recipe_id, step_id) DO UPDATE SET
           status = excluded.status,
           context = excluded.context,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.principalId,
        input.nodeId,
        recipeId,
        input.stepId,
        input.status,
        input.context === undefined ? null : toJson(input.context),
        at,
      );
  });
}

export interface OnboardingProgress {
  done: number;
  total: number;
  blocked: number;
  complete: boolean;
  /** Context recorded for each finished step. */
  recorded: Record<string, unknown>;
}

export function onboardingProgress(
  deps: OnboardingDeps,
  input: { principalId: string; nodeId: string; recipeId?: string },
): OnboardingProgress {
  const recipeId = input.recipeId ?? "default";
  const checkpoints = readCheckpoints(deps, {
    principalId: input.principalId,
    nodeId: input.nodeId,
    recipeId,
  });

  let done = 0;
  let blocked = 0;
  const recorded: Record<string, unknown> = {};
  for (const step of SETUP_STEPS) {
    const checkpoint = checkpoints.get(step.stepId);
    if (checkpoint?.status === "done") {
      done += 1;
      if (checkpoint.context !== null) {
        recorded[step.stepId] = parseJson<unknown>(checkpoint.context, "onboarding_checkpoints.context");
      }
    }
    if (checkpoint?.status === "blocked") blocked += 1;
  }

  return { done, total: SETUP_STEPS.length, blocked, complete: done === SETUP_STEPS.length, recorded };
}

/** Whether the user has finished everything a particular need requires. */
export function needIsReady(
  deps: OnboardingDeps,
  input: { principalId: string; nodeId: string; need: Need; recipeId?: string },
): { ready: boolean; missing: string[] } {
  const plan = planOnboarding(deps, {
    principalId: input.principalId,
    nodeId: input.nodeId,
    ...(input.recipeId === undefined ? {} : { recipeId: input.recipeId }),
    needs: [input.need],
  });
  const missing: string[] = [];
  for (const step of plan.steps) {
    if (step.status !== "done") missing.push(step.stepId);
  }
  return { ready: missing.length === 0, missing };
}

/** Read one checkpoint back, so a caller can see what was recorded without a full plan. */
export function readStep(
  deps: OnboardingDeps,
  input: { principalId: string; nodeId: string; stepId: string; recipeId?: string },
): { status: StepStatus; context: unknown } | undefined {
  const row = oneRow<CheckpointRow>(
    deps.db,
    "SELECT step_id, status, context, updated_at FROM onboarding_checkpoints WHERE principal_id = ? AND node_id = ? AND recipe_id = ? AND step_id = ?",
    input.principalId,
    input.nodeId,
    input.recipeId ?? "default",
    input.stepId,
  );
  if (!row) return undefined;
  return {
    status: row.status as StepStatus,
    context: row.context === null ? undefined : parseJson<unknown>(row.context, "onboarding_checkpoints.context"),
  };
}
