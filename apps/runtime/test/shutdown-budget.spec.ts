import { describe, expect, it } from "vitest";

import { shutdownStepBudget } from "../src/shutdown-budget.ts";

/**
 * A shutdown step that waits gets what is left before the hard stop, less the time kept for the steps after it — never
 * the whole grace, which would let one slow step cost the node its clean close.
 */
describe("how long a shutdown step may wait", () => {
  it("gives what is left before the hard stop, less the reserve", () => {
    // Started 3.1 s into a 5 s grace: 1.9 s are left, 1 s of them kept for the close.
    expect(shutdownStepBudget({ deadline: 5_000, now: 3_100, reserveMs: 1_000 })).toBe(900);
  });

  it("gives nothing once the reserve is reached, rather than a negative wait", () => {
    expect(shutdownStepBudget({ deadline: 5_000, now: 4_000, reserveMs: 1_000 })).toBe(0);
    expect(shutdownStepBudget({ deadline: 5_000, now: 6_000, reserveMs: 1_000 })).toBe(0);
  });
});
