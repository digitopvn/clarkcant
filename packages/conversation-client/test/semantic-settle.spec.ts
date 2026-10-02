import { describe, expect, it } from "vitest";

import { createSemanticSettler } from "../src/semantic-settle.ts";

/** A clock the test moves by hand, so a settle period passes only when the test says it does. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    setTimer: (run: () => void) => {
      next += 1;
      pending.set(next, run);
      return next;
    },
    clearTimer: (timer: unknown) => {
      pending.delete(timer as number);
    },
    fire: () => {
      const runs = [...pending.values()];
      pending.clear();
      for (const run of runs) run();
    },
    count: () => pending.size,
  };
}

/** A send the test answers by hand, recording what was sent and in which order it was answered. */
function controlledSend() {
  const calls: { proposal: string; resolve: () => void; reject: (cause: Error) => void }[] = [];
  const send = (proposal: string) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ proposal, resolve, reject });
    });
  return { calls, send };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("what a widget says it shows, before a press", () => {
  it("sends only the last of a burst once it settles", async () => {
    const timers = manualTimers();
    const sent: string[] = [];
    const settler = createSemanticSettler<string>({ settleMs: 250, send: async (p) => void sent.push(p), ...timers });
    settler.publish("a");
    settler.publish("b");
    settler.publish("c");
    expect(sent).toEqual([]);
    timers.fire();
    await tick();
    expect(sent).toEqual(["c"]);
  });

  it("sends a publish still settling before the press, and waits until the node took it", async () => {
    const timers = manualTimers();
    const { calls, send } = controlledSend();
    const settler = createSemanticSettler<string>({ settleMs: 250, send, ...timers });
    settler.publish("selection: change that");

    let flushed = false;
    const press = settler.flush().then(() => {
      flushed = true;
    });
    await tick();
    // Sent at once, not after the settle period, and the press is still waiting on the answer.
    expect(timers.count()).toBe(0);
    expect(calls.map((call) => call.proposal)).toEqual(["selection: change that"]);
    expect(flushed).toBe(false);

    calls[0]?.resolve();
    await press;
    expect(flushed).toBe(true);
  });

  it("waits for a send already on its way, so the press never overtakes it", async () => {
    const timers = manualTimers();
    const { calls, send } = controlledSend();
    const settler = createSemanticSettler<string>({ settleMs: 250, send, ...timers });
    settler.publish("first");
    timers.fire();
    await tick();
    expect(calls).toHaveLength(1);

    let flushed = false;
    const press = settler.flush().then(() => {
      flushed = true;
    });
    await tick();
    expect(flushed).toBe(false);
    calls[0]?.resolve();
    await press;
    expect(flushed).toBe(true);
  });

  it("sends one at a time, in order, so an older description cannot land after a newer one", async () => {
    const timers = manualTimers();
    const { calls, send } = controlledSend();
    const settler = createSemanticSettler<string>({ settleMs: 250, send, ...timers });
    settler.publish("older");
    timers.fire();
    settler.publish("newer");
    timers.fire();
    await tick();
    // The newer one is not sent until the older one was answered.
    expect(calls.map((call) => call.proposal)).toEqual(["older"]);
    calls[0]?.resolve();
    await tick();
    await tick();
    expect(calls.map((call) => call.proposal)).toEqual(["older", "newer"]);
  });

  it("tries a failed description once more before the press, and refuses the press when that fails too", async () => {
    const timers = manualTimers();
    const { calls, send } = controlledSend();
    const settler = createSemanticSettler<string>({ settleMs: 250, send, ...timers });
    settler.publish("selection");
    timers.fire();
    await tick();
    calls[0]?.reject(new Error("node unreachable"));
    await tick();

    const retried = settler.flush();
    await tick();
    expect(calls.map((call) => call.proposal)).toEqual(["selection", "selection"]);
    calls[1]?.resolve();
    await expect(retried).resolves.toBeUndefined();

    settler.publish("next");
    const refused = settler.flush();
    await tick();
    calls[2]?.reject(new Error("node unreachable"));
    await tick();
    calls[3]?.reject(new Error("still unreachable"));
    await expect(refused).rejects.toThrow("still unreachable");
  });

  it("resolves at once when there is nothing to send", async () => {
    const settler = createSemanticSettler<string>({ settleMs: 250, send: () => Promise.reject(new Error("never called")), ...manualTimers() });
    await expect(settler.flush()).resolves.toBeUndefined();
  });

  it("drops what is still settling when the frame goes", async () => {
    const timers = manualTimers();
    const sent: string[] = [];
    const settler = createSemanticSettler<string>({ settleMs: 250, send: async (p) => void sent.push(p), ...timers });
    settler.publish("gone");
    settler.dispose();
    timers.fire();
    await settler.flush();
    expect(sent).toEqual([]);
  });
});
