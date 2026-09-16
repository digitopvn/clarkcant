import { beforeEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "@clarkcant/storage";
import {
  getPreference,
  listPreferences,
  setPreference,
  undoOnboardingChanges,
  undoPreference,
} from "../src/preferences.ts";
import {
  needIsReady,
  onboardingProgress,
  planOnboarding,
  readStep,
  recordStep,
  SETUP_STEPS,
} from "../src/onboarding.ts";

/**
 * Guided setup and preference undo (V16).
 *
 * Two claims are under test. Setup is planned from what the user said they want to do, so a step
 * nobody's need requires never appears. And undo returns a preference to what was actually there
 * before, which is not the same as writing a default back.
 */

const AT = "2026-09-16T06:00:00.000Z" as never;
const PRINCIPAL = "prin_owner";

function makeDeps(now = () => AT) {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  return { db, now };
}

let deps: ReturnType<typeof makeDeps>;
beforeEach(() => {
  deps = makeDeps();
});

describe("a preference remembers what it replaced", () => {
  it("round-trips a value", () => {
    setPreference(deps, {
      principalId: PRINCIPAL,
      key: "theme",
      scope: "global",
      value: "dark",
      source: "user",
    });
    expect(getPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global" })?.value).toBe(
      "dark",
    );
  });

  it("keeps the value it overwrote rather than a default", () => {
    setPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global", value: "dark", source: "user" });
    setPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global", value: "light", source: "user" });

    const current = getPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global" });
    expect(current?.value).toBe("light");
    expect(current?.previousValue).toBe("dark");
    expect(current?.revision).toBe(2);
  });

  it("undoes to the value that was actually there", () => {
    setPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global", value: "dark", source: "user" });
    setPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global", value: "light", source: "user" });

    const undone = undoPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global" });
    expect(undone).toEqual({ undone: true, key: "theme", restoredTo: "dark", removed: false });
    expect(getPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global" })?.value).toBe("dark");
  });

  it("removes a preference that did not exist rather than inventing a value", () => {
    setPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global", value: "dark", source: "user" });

    const undone = undoPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global" });
    // Writing a plausible default back would leave a setting the user never chose.
    expect(undone).toEqual({ undone: true, key: "theme", restoredTo: undefined, removed: true });
    expect(getPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global" })).toBeUndefined();
  });

  it("says so when there is nothing to undo", () => {
    const undone = undoPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global" });
    expect(undone.undone).toBe(false);
    expect(undone.undone === false && undone.reason).toContain("never been set");
  });

  it("keeps preferences separate across scopes", () => {
    setPreference(deps, { principalId: PRINCIPAL, key: "density", scope: "global", value: "compact", source: "user" });
    setPreference(deps, {
      principalId: PRINCIPAL,
      key: "density",
      scope: "conversation",
      value: "comfortable",
      source: "user",
    });
    expect(listPreferences(deps, PRINCIPAL)).toHaveLength(2);
  });
});

describe("undoing a guided setup", () => {
  it("undoes what setup wrote and leaves the user's own changes alone", () => {
    // Set by setup.
    setPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global", value: "light", source: "onboarding" });
    setPreference(deps, { principalId: PRINCIPAL, key: "density", scope: "global", value: "compact", source: "onboarding" });
    // Then changed by the user afterwards.
    setPreference(deps, { principalId: PRINCIPAL, key: "density", scope: "global", value: "comfortable", source: "user" });

    const outcome = undoOnboardingChanges(deps, { principalId: PRINCIPAL });

    // Only the value whose last writer was setup is touched.
    expect(outcome.undone).toEqual(["theme"]);
    expect(getPreference(deps, { principalId: PRINCIPAL, key: "theme", scope: "global" })).toBeUndefined();
    expect(getPreference(deps, { principalId: PRINCIPAL, key: "density", scope: "global" })?.value).toBe(
      "comfortable",
    );
  });

  it("is safe to run when setup wrote nothing", () => {
    expect(undoOnboardingChanges(deps, { principalId: PRINCIPAL })).toEqual({ undone: [], skipped: [] });
  });
});

describe("setup is planned from the needs the user stated", () => {
  it("plans only the steps those needs require", () => {
    const plan = planOnboarding(deps, {
      principalId: PRINCIPAL,
      nodeId: "node_a",
      needs: ["read-calendar"],
    });

    expect(plan.steps.map((step) => step.stepId)).toEqual(["connect-google-calendar"]);
    // Nothing about browsing, files, voice or MCP servers appears, because none of it was asked for.
    expect(plan.steps.map((step) => step.stepId)).not.toContain("grant-browser-profile");
    expect(plan.nextStep?.stepId).toBe("connect-google-calendar");
  });

  it("does not ask again for a step that is already done", () => {
    recordStep(deps, {
      principalId: PRINCIPAL,
      nodeId: "node_a",
      stepId: "connect-google-calendar",
      status: "done",
    });

    const plan = planOnboarding(deps, {
      principalId: PRINCIPAL,
      nodeId: "node_a",
      needs: ["read-calendar"],
    });
    expect(plan.steps[0]?.status).toBe("done");
    expect(plan.nextStep).toBeUndefined();
  });

  it("reports a step as blocked and names what it waits on", () => {
    // Voice needs a browser profile first, and that has not been granted.
    const plan = planOnboarding(deps, {
      principalId: PRINCIPAL,
      nodeId: "node_a",
      needs: ["use-voice"],
    });

    expect(plan.steps[0]?.status).toBe("blocked");
    expect(plan.steps[0]?.note).toContain("grant-browser-profile");
    // Blocked rather than hidden: a step that disappears is one the user never learns about.
    expect(plan.nextStep).toBeUndefined();
  });

  it("unblocks the step once its prerequisite is done", () => {
    recordStep(deps, { principalId: PRINCIPAL, nodeId: "node_a", stepId: "grant-browser-profile", status: "done" });
    const plan = planOnboarding(deps, {
      principalId: PRINCIPAL,
      nodeId: "node_a",
      needs: ["use-voice"],
    });
    expect(plan.steps[0]?.status).toBe("pending");
    expect(plan.nextStep?.stepId).toBe("grant-microphone");
  });

  it("reports a need that nothing in the catalogue serves", () => {
    const plan = planOnboarding(deps, {
      principalId: PRINCIPAL,
      nodeId: "node_a",
      needs: ["read-calendar"],
    });
    expect(plan.unservedNeeds).toEqual([]);
  });

  it("covers every need the catalogue claims to serve", () => {
    const needs = [...new Set(SETUP_STEPS.map((step) => step.serves))];
    const plan = planOnboarding(deps, { principalId: PRINCIPAL, nodeId: "node_a", needs });
    expect(plan.unservedNeeds).toEqual([]);
    expect(plan.steps).toHaveLength(needs.length);
  });
});

describe("progress records what was agreed to, not just that a step finished", () => {
  it("stores the context alongside the status", () => {
    recordStep(deps, {
      principalId: PRINCIPAL,
      nodeId: "node_a",
      stepId: "connect-google-calendar",
      status: "done",
      context: { account: "primary", scopes: ["calendar.readonly"] },
    });

    const step = readStep(deps, { principalId: PRINCIPAL, nodeId: "node_a", stepId: "connect-google-calendar" });
    expect(step?.status).toBe("done");
    expect(step?.context).toEqual({ account: "primary", scopes: ["calendar.readonly"] });
  });

  it("counts against the whole catalogue, so progress cannot look complete early", () => {
    recordStep(deps, { principalId: PRINCIPAL, nodeId: "node_a", stepId: "grant-project-folder", status: "done" });
    const progress = onboardingProgress(deps, { principalId: PRINCIPAL, nodeId: "node_a" });
    expect(progress.done).toBe(1);
    expect(progress.total).toBe(SETUP_STEPS.length);
    expect(progress.complete).toBe(false);
  });

  it("refuses a step that is not in the catalogue, instead of recording it", () => {
    expect(() =>
      recordStep(deps, {
        principalId: PRINCIPAL,
        nodeId: "node_a",
        stepId: "do-something-else",
        status: "done",
      }),
    ).toThrow(/not in the catalogue/);
  });

  it("scopes checkpoints per node, so one machine's setup does not mark another's done", () => {
    recordStep(deps, { principalId: PRINCIPAL, nodeId: "node_a", stepId: "grant-project-folder", status: "done" });
    const other = needIsReady(deps, { principalId: PRINCIPAL, nodeId: "node_b", need: "write-files" });
    expect(other.ready).toBe(false);
    expect(other.missing).toEqual(["grant-project-folder"]);

    const same = needIsReady(deps, { principalId: PRINCIPAL, nodeId: "node_a", need: "write-files" });
    expect(same.ready).toBe(true);
  });
});
