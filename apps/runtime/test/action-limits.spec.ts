import { DETACHED_RELAY_LIMITS } from "@clarkcant/widget-host/session";
import { describe, expect, it } from "vitest";

import { ACTION_LIMITS } from "../src/application/action-limits.ts";

/** How much longer than the node's own deadline a relayed press waits: the node's answer still has to travel back. */
const RELAY_MARGIN_MS = 30_000;

describe("the node's action deadlines, against the detached window's press relay", () => {
  it("lets a relayed press wait longer than any action may run, so a press still running is never given up on", () => {
    const longest = Math.max(...Object.values(ACTION_LIMITS).map((limits) => limits.deadlineMs?.max ?? 0));
    expect(longest).toBeGreaterThan(0);
    // The desktop host's copy (`RELAY_LIMITS` in `apps/desktop`) is held equal to this one by its own spec.
    expect(DETACHED_RELAY_LIMITS.intent.timeoutMs).toBeGreaterThanOrEqual(longest + RELAY_MARGIN_MS);
  });
});
