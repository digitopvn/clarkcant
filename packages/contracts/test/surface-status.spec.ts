import { describe, expect, it } from "vitest";


import {
  approvalCardBlockSchema,
  connectionCardBlockSchema,
  reconnectCardSchema,
  systemCardBlockSchema,
  taskOverviewCardSchema,
  taskSummaryCardSchema,
} from "../src/surfaces.ts";
import {
  APPROVAL_PHASE,
  CONNECTION_NEXT_ACTION,
  CONNECTION_PHASE,
  FEEDBACK_PUBLICATION_PHASE,
  OUTCOME_PHASES,
  RECONNECT_PHASE,
  SURFACE_PHASE_MARK,
  SURFACE_PHASE_TONE,
  SURFACE_PHASES,
  SYSTEM_CARD_PHASE,
  TASK_OVERVIEW_PHASE,
  canRetry,
  freshnessState,
  marketplacePhase,
  readReportedValue,
  reportedValueSchema,
  reportedValueText,
  settleSurfaceStatus,
  surfaceAnnouncement,
  surfaceStatusSchema,
  taskSummaryPhase,
  type SurfacePhase,
  type SurfaceStatus,
} from "../src/surface-status.ts";

const AT = "2026-10-08T09:00:00.000Z";
const AT_MS = Date.parse(AT);

function status(phase: SurfacePhase, attempt: number, observedAt?: string): SurfaceStatus {
  return surfaceStatusSchema.parse({
    phase,
    attempt,
    freshness: observedAt === undefined ? { kind: "snapshot" } : { kind: "live", observedAt, staleAfterMs: 60_000 },
  });
}

/** The values a zod enum accepts, read from the schema so a table is checked against the real machine. */
function optionsOf(schema: { options: readonly string[] }): readonly string[] {
  return schema.options;
}

describe("phases", () => {
  it("draws every phase with a tone and a distinct mark, so none is told by colour alone", () => {
    for (const phase of SURFACE_PHASES) {
      expect(SURFACE_PHASE_TONE[phase]).toBeDefined();
      expect(SURFACE_PHASE_MARK[phase].length).toBeGreaterThan(0);
    }
    expect(new Set(SURFACE_PHASES.map((phase) => SURFACE_PHASE_MARK[phase])).size).toBe(SURFACE_PHASES.length);
  });

  it("never draws a failure, a partial result or a cancellation in the success tone", () => {
    const success = SURFACE_PHASES.filter((phase) => SURFACE_PHASE_TONE[phase] === "success");
    expect(success).toEqual(["success"]);
    expect(SURFACE_PHASE_TONE.error).toBe("danger");
    expect(SURFACE_PHASE_TONE.partial).toBe("warning");
  });

  it("names exactly the phases that end an attempt", () => {
    expect([...OUTCOME_PHASES].sort()).toEqual(["cancelled", "error", "partial", "success"]);
  });
});

describe("domain machines read through the contract", () => {
  // Walked from each schema's own enum, so a state added to a machine without a reading fails here as well as in tsc.
  const tables: [string, Readonly<Record<string, SurfacePhase>>, readonly string[]][] = [
    ["system card", SYSTEM_CARD_PHASE, optionsOf(systemCardBlockSchema.shape.status)],
    ["connection", CONNECTION_PHASE, optionsOf(connectionCardBlockSchema.shape.status)],
    ["reconnect", RECONNECT_PHASE, optionsOf(reconnectCardSchema.shape.status)],
    ["approval", APPROVAL_PHASE, optionsOf(approvalCardBlockSchema.shape.decision)],
    ["task overview", TASK_OVERVIEW_PHASE, optionsOf(taskOverviewCardSchema.shape.tasks.element.shape.status)],
  ];

  for (const [name, table, states] of tables) {
    it(`reads every ${name} state, and no state it does not have`, () => {
      expect(Object.keys(table).sort()).toEqual([...states].sort());
      for (const state of states) expect(SURFACE_PHASES).toContain(table[state]);
    });
  }

  it("never reads a failed, denied, revoked or expired state as a success", () => {
    expect(CONNECTION_PHASE.failed).toBe("error");
    expect(CONNECTION_PHASE.degraded).toBe("partial");
    expect(CONNECTION_PHASE.needs_reauth).toBe("needs-action");
    expect(APPROVAL_PHASE.denied).toBe("cancelled");
    expect(APPROVAL_PHASE.expired).toBe("cancelled");
    expect(SYSTEM_CARD_PHASE.failed).toBe("error");
    expect(RECONNECT_PHASE.failed).toBe("error");
  });

  it("reads a revoked or denied connection as standing in the way, with reconnecting as the next step", () => {
    for (const state of ["revoked", "denied"] as const) {
      expect(CONNECTION_PHASE[state]).toBe("unavailable");
      expect(CONNECTION_NEXT_ACTION[state]).toBe("reconnect");
    }
    expect(CONNECTION_NEXT_ACTION.needs_reauth).toBe("sign-in");
    expect(CONNECTION_NEXT_ACTION.expired).toBe("sign-in");
    // Only states the card has a step for are named; the rest are left out, never guessed.
    const states = optionsOf(connectionCardBlockSchema.shape.status);
    for (const state of Object.keys(CONNECTION_NEXT_ACTION)) expect(states).toContain(state);
  });

  it("reads a report GitHub did not answer as partial, not as filed and not as failed", () => {
    expect(FEEDBACK_PUBLICATION_PHASE.unknown).toBe("partial");
    expect(FEEDBACK_PUBLICATION_PHASE.failed).toBe("error");
    expect(FEEDBACK_PUBLICATION_PHASE.published).toBe("success");
  });

  it("reads a finished task from its outcome and its evidence together", () => {
    const outcomes = optionsOf(taskSummaryCardSchema.shape.outcome) as readonly ("succeeded" | "failed" | "cancelled" | "not-verified")[];
    const verdicts = optionsOf(taskSummaryCardSchema.shape.evidence) as readonly ("verified" | "not-verified" | "contradicted")[];
    for (const outcome of outcomes) {
      for (const evidence of verdicts) {
        const phase = taskSummaryPhase(outcome, evidence);
        // Success needs both: the run said it succeeded, and the evidence agrees.
        expect(phase === "success").toBe(outcome === "succeeded" && evidence === "verified");
      }
    }
    expect(taskSummaryPhase("succeeded", "contradicted")).toBe("error");
    expect(taskSummaryPhase("succeeded", "not-verified")).toBe("partial");
    expect(taskSummaryPhase("failed", "verified")).toBe("error");
    expect(taskSummaryPhase("cancelled", "contradicted")).toBe("cancelled");
  });

  it("tells a directory that could not be asked from one that found nothing", () => {
    expect(marketplacePhase({ results: 0, unansweredSources: 0 })).toBe("empty");
    expect(marketplacePhase({ results: 0, unavailableReason: "offline", unansweredSources: 1 })).toBe("unavailable");
    expect(marketplacePhase({ results: 3, unansweredSources: 1 })).toBe("partial");
    expect(marketplacePhase({ results: 3, unansweredSources: 0 })).toBe("success");
  });
});

describe("snapshot or live", () => {
  it("never calls a snapshot stale, however old", () => {
    expect(freshnessState({ kind: "snapshot", statedAt: "2020-01-01T00:00:00.000Z" }, AT_MS)).toBe("snapshot");
  });

  it("calls a live view stale once it goes unconfirmed past its window", () => {
    const live = { kind: "live", observedAt: AT, staleAfterMs: 60_000 } as const;
    expect(freshnessState(live, AT_MS + 60_000)).toBe("live");
    expect(freshnessState(live, AT_MS + 60_001)).toBe("stale");
  });

  it("calls an observation time nobody can read stale, not fresh", () => {
    expect(freshnessState({ kind: "live", observedAt: "not a time", staleAfterMs: 60_000 }, AT_MS)).toBe("stale");
  });
});

describe("late answers", () => {
  it("drops an answer for an earlier attempt that arrives after a retry", () => {
    const retrying = status("pending", 2);
    expect(settleSurfaceStatus(retrying, status("error", 1))).toBe(retrying);
  });

  it("lets a new attempt replace an outcome", () => {
    const next = status("pending", 2);
    expect(settleSurfaceStatus(status("error", 1), next)).toBe(next);
  });

  it("does not reopen an outcome with a late 'still working' for the same attempt", () => {
    const done = status("success", 1);
    expect(settleSurfaceStatus(done, status("pending", 1))).toBe(done);
    expect(settleSurfaceStatus(done, status("loading", 1))).toBe(done);
  });

  it("keeps the first outcome of an attempt: a later, different outcome for the same attempt does not replace it", () => {
    for (const first of OUTCOME_PHASES) {
      for (const later of OUTCOME_PHASES) {
        const shown = status(first, 1);
        expect(settleSurfaceStatus(shown, status(later, 1))).toBe(shown);
      }
    }
    // Not even a fresher live observation: a success that lands after a cancel is a late answer, not a correction.
    const cancelled = status("cancelled", 1, AT);
    expect(settleSurfaceStatus(cancelled, status("success", 1, "2026-10-08T09:00:20.000Z"))).toBe(cancelled);
  });

  it("drops a live observation older than the one shown", () => {
    const shown = status("pending", 1, "2026-10-08T09:00:10.000Z");
    expect(settleSurfaceStatus(shown, status("pending", 1, AT))).toBe(shown);
    const newer = status("success", 1, "2026-10-08T09:00:20.000Z");
    expect(settleSurfaceStatus(shown, newer)).toBe(newer);
  });

  it("shows the first answer when nothing was shown yet", () => {
    const first = status("loading", 0);
    expect(settleSurfaceStatus(undefined, first)).toBe(first);
  });
});

describe("retry", () => {
  it("offers a retry only after a failure or half-failure, and only when the domain says it can be repeated", () => {
    expect(canRetry({ phase: "error", next: "retry" })).toBe(true);
    expect(canRetry({ phase: "partial", next: "check-again" })).toBe(true);
    expect(canRetry({ phase: "error", next: "sign-in" })).toBe(false);
    expect(canRetry({ phase: "error" })).toBe(false);
    expect(canRetry({ phase: "success", next: "retry" })).toBe(false);
    expect(canRetry({ phase: "pending", next: "retry" })).toBe(false);
  });
});

describe("what is said aloud", () => {
  it("says nothing for what was restored from history", () => {
    for (const phase of SURFACE_PHASES) expect(surfaceAnnouncement(undefined, phase, { restored: true })).toBe("off");
  });

  it("says nothing for the same phase again or for loading", () => {
    expect(surfaceAnnouncement("pending", "pending", { restored: false })).toBe("off");
    expect(surfaceAnnouncement("empty", "loading", { restored: false })).toBe("off");
  });

  it("interrupts for an error and waits its turn for everything else", () => {
    expect(surfaceAnnouncement("pending", "error", { restored: false })).toBe("assertive");
    expect(surfaceAnnouncement("pending", "success", { restored: false })).toBe("polite");
    expect(surfaceAnnouncement("pending", "cancelled", { restored: false })).toBe("polite");
  });
});

describe("reported values", () => {
  const source = { label: "OpenAI usage API", authority: "official" } as const;

  it("names a missing value as missing, never as zero", () => {
    for (const missing of [
      { state: "unknown" },
      { state: "unavailable", reason: "signed out" },
      { state: "unsupported" },
    ] as const) {
      const value = reportedValueSchema.parse(missing);
      const read = readReportedValue(value, AT_MS);
      expect(read.kind).toBe("missing");
      const text = reportedValueText(value, AT_MS);
      expect(text).not.toMatch(/\b0\b/u);
      expect(text.startsWith(missing.state)).toBe(true);
    }
    expect(reportedValueText({ state: "unavailable", reason: "signed out" }, AT_MS)).toBe("unavailable: signed out");
  });

  it("requires a reason for an unavailable value", () => {
    expect(reportedValueSchema.safeParse({ state: "unavailable" }).success).toBe(false);
  });

  it("keeps a reported zero, with its source and as-of time", () => {
    const zero = reportedValueSchema.parse({ state: "reported", value: 0, unit: "%", source, asOf: AT });
    expect(reportedValueText(zero, AT_MS)).toBe(`0 % (OpenAI usage API, as of ${AT})`);
  });

  it("refuses a reported value with no source or no as-of time", () => {
    expect(reportedValueSchema.safeParse({ state: "reported", value: 1, asOf: AT }).success).toBe(false);
    expect(reportedValueSchema.safeParse({ state: "reported", value: 1, source }).success).toBe(false);
  });

  it("says an inferred figure is an estimate, and an old live figure is stale", () => {
    const inferred = reportedValueSchema.parse({
      state: "reported",
      value: 42,
      source: { label: "Clark", authority: "inferred" },
      asOf: AT,
      staleAfterMs: 60_000,
    });
    expect(readReportedValue(inferred, AT_MS + 1_000)).toMatchObject({ kind: "value", stale: false });
    const late = readReportedValue(inferred, AT_MS + 120_000);
    expect(late).toMatchObject({ kind: "value", value: 42, stale: true, asOf: AT });
    expect(reportedValueText(inferred, AT_MS + 120_000)).toBe(`42 (estimated by Clark, as of ${AT}, stale)`);
  });
});
