import { describe, expect, it } from "vitest";

import { createControlSessionRegistry } from "../src/control-sessions.ts";

/**
 * Who is driving a surface.
 *
 * The claim worth testing is not that a flag flips. It is that a takeover takes effect on a process this node is
 * not synchronously controlling: the agent's next action is refused because its lease is stale, rather than the
 * host reaching into a running automation to interrupt it. That is why most assertions here are about what an
 * *action* is told afterwards, not only about the session record.
 *
 * Browser and desktop share this model, so the tests run both surfaces through the same boundary — the one place
 * a single implementation is supposed to serve two capabilities.
 */

const AT = "2026-09-19T17:00:00.000Z";
const LATER = "2026-09-19T17:05:00.000Z";

function registry() {
  const sessions = createControlSessionRegistry();
  const browser = sessions.create({ sessionId: "cs_browser", surface: "browser", label: "đang mở form thanh toán" });
  const computer = sessions.create({ sessionId: "cs_computer", surface: "computer", label: "đang sửa bảng tính" });
  return { sessions, browser, computer };
}

describe("control sessions", () => {
  it("starts with the agent driving, at the epoch its plan was made under", () => {
    const { sessions, browser } = registry();

    expect(browser.owner).toBe("agent");
    expect(browser.status).toBe("running");
    expect(browser.leaseEpoch).toBe(0);
    expect(browser.preview).toBe("available");
    expect(sessions.admitAction("cs_browser", 0).ok).toBe(true);
  });

  it("does not assume a desktop is observable", () => {
    const { computer } = registry();

    /*
     * The operating system owns screen observation, not this node. Defaulting a desktop session to `available`
     * would claim a view of the screen that nobody has been granted — and the permission is the one boundary this
     * project does not get to route around.
     */
    expect(computer.preview).toBe("needs-permission");
  });

  it("hands the wheel to the user, and refuses the action the agent had already planned", () => {
    const { sessions } = registry();

    const taken = sessions.takeover("cs_browser", AT);
    expect(taken?.owner).toBe("user");
    expect(taken?.takenOverAt).toBe(AT);
    // The epoch moves, which is the whole mechanism.
    expect(taken?.leaseEpoch).toBe(1);

    /*
     * The assertion this module exists for. The agent planned this action before the user took over; it arrives
     * after. If it were admitted, the user would be driving a browser that is still being driven.
     */
    const stale = sessions.admitAction("cs_browser", 0);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("STALE_LEASE");

    // A freshly planned action is refused for the other reason, which is the distinction worth keeping.
    const fresh = sessions.admitAction("cs_browser", 1);
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.code).toBe("USER_HAS_CONTROL");
  });

  it("keeps the surface when the wheel changes hands", () => {
    const { sessions } = registry();
    const taken = sessions.takeover("cs_browser", AT);

    // Takeover is not a restart: same session, still running, still on the same page — which is the point, since
    // the user took the wheel to finish something that was half done.
    expect(taken?.sessionId).toBe("cs_browser");
    expect(taken?.label).toBe("đang mở form thanh toán");
    expect(taken?.status).toBe("running");
  });

  it("ends the session on stop, and refuses an action already in flight", () => {
    const { sessions } = registry();

    const stopped = sessions.stop("cs_browser", LATER);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.stoppedAt).toBe(LATER);
    expect(stopped?.leaseEpoch).toBe(1);

    // An action planned a moment ago would otherwise land on a session that has ended.
    const inflight = sessions.admitAction("cs_browser", 0);
    expect(inflight.ok).toBe(false);
    if (!inflight.ok) expect(inflight.code).toBe("SESSION_STOPPED");
  });

  it("has nothing to take over once stopped", () => {
    const { sessions } = registry();
    sessions.stop("cs_browser", LATER);

    expect(sessions.takeover("cs_browser", LATER)).toBeUndefined();
    expect(sessions.stop("cs_browser", LATER)).toBeUndefined();
    expect(sessions.get("cs_browser")?.owner).toBe("agent");
  });

  it("refuses to act on a surface it cannot observe, and says why", () => {
    const { sessions } = registry();

    const blind = sessions.admitAction("cs_computer", 0);

    expect(blind.ok).toBe(false);
    /*
     * A fourth reason, and the one that is about safety rather than about authority: acting on a surface nobody
     * can see is how an unsupervised effect lands where no one is looking. The message carries the reason so the
     * card can show it rather than a generic refusal.
     */
    if (!blind.ok) {
      expect(blind.code).toBe("PREVIEW_UNAVAILABLE");
      expect(blind.message.length).toBeGreaterThan(0);
    }
  });

  it("admits an action once the preview is granted, without changing who drives", () => {
    const sessions = createControlSessionRegistry();
    sessions.create({
      sessionId: "cs_granted",
      surface: "computer",
      label: "đang sửa bảng tính",
      preview: "available",
    });

    expect(sessions.admitAction("cs_granted", 0).ok).toBe(true);
    expect(sessions.get("cs_granted")?.owner).toBe("agent");
  });

  it("tells an unknown session apart from a stopped one", () => {
    const { sessions } = registry();
    const missing = sessions.admitAction("cs_missing", 0);

    expect(missing.ok).toBe(false);
    // Named, because "refused" without the reason sends a caller looking for a fault in the wrong place.
    if (!missing.ok) expect(missing.code).toBe("NO_SUCH_SESSION");
    expect(sessions.takeover("cs_missing", AT)).toBeUndefined();
  });

  it("lets the user take over twice without letting the agent back in", () => {
    const { sessions } = registry();
    sessions.takeover("cs_browser", AT);
    const again = sessions.takeover("cs_browser", LATER);

    expect(again?.owner).toBe("user");
    expect(again?.leaseEpoch).toBe(2);
    // Still refused after a second takeover: handing the wheel back is not something a repeat can cause.
    const action = sessions.admitAction("cs_browser", 2);
    expect(action.ok).toBe(false);
    if (!action.ok) expect(action.code).toBe("USER_HAS_CONTROL");
  });

  it("reports both surfaces from one registry", () => {
    const { sessions } = registry();
    expect(sessions.list().map((session) => session.surface).sort()).toEqual(["browser", "computer"]);
  });
});
