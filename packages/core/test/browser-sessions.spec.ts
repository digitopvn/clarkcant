import { describe, expect, it } from "vitest";

import { createBrowserSessionRegistry } from "../src/browser-sessions.ts";

/**
 * Who is driving the browser.
 *
 * The claim worth testing is not that a flag flips. It is that a takeover takes effect on a process this node is
 * not synchronously controlling: the agent's next action is refused because its lease is stale, rather than the
 * host reaching into a running automation to interrupt it. That is why the assertions are about what an *action*
 * is told afterwards, not only about the session record.
 */

const AT = "2026-09-19T17:00:00.000Z";
const LATER = "2026-09-19T17:05:00.000Z";

function withSession() {
  const registry = createBrowserSessionRegistry();
  const session = registry.create({ sessionId: "bs_1", label: "đang mở form thanh toán" });
  return { registry, session };
}

describe("browser sessions", () => {
  it("starts with the agent driving, at the epoch its plan was made under", () => {
    const { registry, session } = withSession();

    expect(session.owner).toBe("agent");
    expect(session.status).toBe("running");
    expect(session.leaseEpoch).toBe(0);
    expect(registry.admitAction("bs_1", 0).ok).toBe(true);
  });

  it("hands the wheel to the user, and refuses the action the agent had already planned", () => {
    const { registry } = withSession();

    const taken = registry.takeover("bs_1", AT);
    expect(taken?.owner).toBe("user");
    expect(taken?.takenOverAt).toBe(AT);
    // The epoch moves, which is the whole mechanism.
    expect(taken?.leaseEpoch).toBe(1);

    /*
     * The assertion this module exists for. The agent planned this action before the user took over; it arrives
     * after. If it were admitted, the user would be driving a browser that is still being driven.
     */
    const stale = registry.admitAction("bs_1", 0);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("STALE_LEASE");

    // And a freshly planned action is refused for the other reason, which is the distinction worth keeping.
    const fresh = registry.admitAction("bs_1", 1);
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.code).toBe("USER_HAS_CONTROL");
  });

  it("keeps the page when the wheel changes hands", () => {
    const { registry } = withSession();
    const taken = registry.takeover("bs_1", AT);

    // Takeover is not a restart: the session is still the same session, still running, still on the same page.
    expect(taken?.sessionId).toBe("bs_1");
    expect(taken?.label).toBe("đang mở form thanh toán");
    expect(taken?.status).toBe("running");
  });

  it("ends the session on stop, and refuses an action already in flight", () => {
    const { registry } = withSession();

    const stopped = registry.stop("bs_1", LATER);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.stoppedAt).toBe(LATER);
    expect(stopped?.leaseEpoch).toBe(1);

    // An action planned a moment ago would otherwise land on a session that has ended.
    const inflight = registry.admitAction("bs_1", 0);
    expect(inflight.ok).toBe(false);
    if (!inflight.ok) expect(inflight.code).toBe("SESSION_STOPPED");
  });

  it("has nothing to take over once stopped", () => {
    const { registry } = withSession();
    registry.stop("bs_1", LATER);

    // Flipping the owner of a stopped session would describe a state nobody can act on.
    expect(registry.takeover("bs_1", LATER)).toBeUndefined();
    expect(registry.stop("bs_1", LATER)).toBeUndefined();
    expect(registry.get("bs_1")?.owner).toBe("agent");
  });

  it("tells an unknown session apart from a stopped one", () => {
    const { registry } = withSession();
    const missing = registry.admitAction("bs_missing", 0);

    expect(missing.ok).toBe(false);
    // Named, because "refused" without the reason sends a caller looking for a fault in the wrong place.
    if (!missing.ok) expect(missing.code).toBe("NO_SUCH_SESSION");
    expect(registry.takeover("bs_missing", AT)).toBeUndefined();
  });

  it("lets the user take over twice without letting the agent back in", () => {
    const { registry } = withSession();
    registry.takeover("bs_1", AT);
    const again = registry.takeover("bs_1", LATER);

    expect(again?.owner).toBe("user");
    expect(again?.leaseEpoch).toBe(2);
    // Still refused after a second takeover: handing the wheel back is not something a repeat can cause.
    const action = registry.admitAction("bs_1", 2);
    expect(action.ok).toBe(false);
    if (!action.ok) expect(action.code).toBe("USER_HAS_CONTROL");
  });
});
