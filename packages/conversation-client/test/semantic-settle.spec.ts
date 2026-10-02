import { describe, expect, it } from "vitest";

import {
  SEMANTIC_FLUSH_TIMEOUT_MS,
  SEMANTIC_SEND_TIMEOUT_MS,
  SemanticFlushTimeout,
  createSemanticSettler,
  gatePress,
  pressMustWait,
} from "../src/semantic-settle.ts";

const SETTLE_MS = 250;

/**
 * A clock the test moves by hand, so a period passes only when the test says it does. Timers are fired by the period
 * they were set for: the settle period, a send's bound or a flush's bound.
 */
function manualTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    setTimer: (run: () => void, ms: number) => {
      next += 1;
      pending.set(next, { run, ms });
      return next;
    },
    clearTimer: (timer: unknown) => {
      pending.delete(timer as number);
    },
    fire: (ms = SETTLE_MS) => {
      const due = [...pending.entries()].filter(([, timer]) => timer.ms === ms);
      for (const [id] of due) pending.delete(id);
      for (const [, timer] of due) timer.run();
    },
    count: (ms = SETTLE_MS) => [...pending.values()].filter((timer) => timer.ms === ms).length,
  };
}

/** A send the test answers by hand, recording what was sent, with the signal it was given. */
function controlledSend() {
  const calls: { proposal: string; signal: AbortSignal; resolve: () => void; reject: (cause: Error) => void }[] = [];
  const send = (proposal: string, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ proposal, signal, resolve, reject });
    });
  return { calls, send };
}

const tick = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("what a widget says it shows, before a press", () => {
  it("sends only the last of a burst once it settles", async () => {
    const timers = manualTimers();
    const sent: string[] = [];
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send: async (p) => void sent.push(p), ...timers });
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
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send, ...timers });
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
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send, ...timers });
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
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send, ...timers });
    settler.publish("older");
    timers.fire();
    settler.publish("newer");
    timers.fire();
    await tick();
    // The newer one is not sent until the older one was answered.
    expect(calls.map((call) => call.proposal)).toEqual(["older"]);
    calls[0]?.resolve();
    await tick();
    expect(calls.map((call) => call.proposal)).toEqual(["older", "newer"]);
  });

  it("tries a failed description once more before the press, and refuses the press when that fails too", async () => {
    const timers = manualTimers();
    const { calls, send } = controlledSend();
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send, ...timers });
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

  it("never re-sends an older description that failed slowly after a newer one was published", async () => {
    const timers = manualTimers();
    const { calls, send } = controlledSend();
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send, ...timers });
    settler.publish("B");
    timers.fire();
    await tick();
    expect(calls.map((call) => call.proposal)).toEqual(["B"]);

    // The press waits on B; meanwhile the widget publishes C, which settles while B is still on its way.
    const press = settler.flush();
    settler.publish("C");
    timers.fire();
    await tick();
    calls[0]?.reject(new Error("slow failure"));
    await tick();
    expect(calls.map((call) => call.proposal)).toEqual(["B", "C"]);
    calls[1]?.resolve();
    await expect(press).resolves.toBeUndefined();
    await tick();
    // C is what the node holds: B, which failed, is not tried again behind it.
    expect(calls.map((call) => call.proposal)).toEqual(["B", "C"]);
  });

  it("lets a press through once its own description is answered, while the widget keeps publishing over a slow link", async () => {
    const timers = manualTimers();
    const { calls, send } = controlledSend();
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send, ...timers });
    settler.publish("position 0");

    let outcome: string | undefined;
    void gatePress(settler, false, () => Promise.resolve("ran"), () => "refused").then((result) => {
      outcome = result;
    });
    await tick();
    expect(calls.map((call) => call.proposal)).toEqual(["position 0"]);

    // A publish every settle period, each settling while the previous send is still on its way.
    for (let i = 1; i <= 12; i += 1) {
      settler.publish(`position ${i}`);
      timers.fire();
      calls[i - 1]?.resolve();
      await tick();
    }
    expect(outcome).toBe("ran");
    // The publishes after the press were still sent; the press just did not wait for them.
    expect(calls.length).toBe(13);

    timers.fire(SEMANTIC_FLUSH_TIMEOUT_MS);
    await tick();
    expect(outcome).toBe("ran");
  });

  it("gives up on a send that never answers, and later sends still go through", async () => {
    const timers = manualTimers();
    const proposals: string[] = [];
    const signals: AbortSignal[] = [];
    // The first send ignores its signal and never settles, as a request a proxy holds would.
    const send = (proposal: string, signal: AbortSignal) => {
      proposals.push(proposal);
      signals.push(signal);
      return proposals.length === 1 ? new Promise<void>(() => undefined) : Promise.resolve();
    };
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send, ...timers });
    settler.publish("stuck");
    timers.fire();
    await tick();

    const press = settler.flush();
    const outcome = press.then(
      () => "ran",
      (cause: unknown) => cause,
    );
    timers.fire(SEMANTIC_FLUSH_TIMEOUT_MS);
    expect(await outcome).toBeInstanceOf(SemanticFlushTimeout);

    // The stalled send is aborted at its own bound, and the frame's sends carry on.
    timers.fire(SEMANTIC_SEND_TIMEOUT_MS);
    await tick();
    expect(signals[0]?.aborted).toBe(true);
    settler.publish("later");
    timers.fire();
    await tick();
    expect(proposals).toContain("later");
    await expect(settler.flush()).resolves.toBeUndefined();
  });

  it("says what a press would have to wait for", async () => {
    const timers = manualTimers();
    const { calls, send } = controlledSend();
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send, ...timers });
    expect([settler.owes(), settler.pending()]).toEqual([false, false]);

    settler.publish("one");
    // Settling: owed, and both kinds of press wait.
    expect([settler.owes(), settler.pending()]).toEqual([true, false]);
    expect(pressMustWait(settler, false)).toBe(true);

    timers.fire();
    await tick();
    // On its way: only a press that reads the description waits for it.
    expect([settler.owes(), settler.pending()]).toEqual([false, true]);
    expect(pressMustWait(settler, false)).toBe(false);
    expect(pressMustWait(settler, true)).toBe(true);

    calls[0]?.resolve();
    await tick();
    expect([settler.owes(), settler.pending()]).toEqual([false, false]);
    expect(pressMustWait(settler, true)).toBe(false);

    settler.publish("two");
    timers.fire();
    await tick();
    calls[1]?.reject(new Error("refused"));
    await tick();
    // The newest one failed: still owed until it is delivered.
    expect([settler.owes(), settler.pending()]).toEqual([true, false]);
  });

  it("resolves at once when there is nothing to send", async () => {
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send: () => Promise.reject(new Error("never called")), ...manualTimers() });
    await expect(settler.flush()).resolves.toBeUndefined();
  });

  it("drops what is still settling when the frame goes, and aborts what is on its way", async () => {
    const timers = manualTimers();
    const { calls, send } = controlledSend();
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send, ...timers });
    settler.publish("on its way");
    timers.fire();
    await tick();
    settler.publish("gone");
    settler.dispose();
    timers.fire();
    await tick();
    expect(calls.map((call) => call.proposal)).toEqual(["on its way"]);
    expect(calls[0]?.signal.aborted).toBe(true);
  });
});

describe("the press gate", () => {
  const refusal = () => "refused";
  const run = () => Promise.resolve("ran");

  it("refuses a press whose description could not be delivered, without running it", async () => {
    let ran = false;
    const settler = { owes: () => true, pending: () => false, flush: () => Promise.reject(new SemanticFlushTimeout()) };
    const outcome = await gatePress(settler, true, () => {
      ran = true;
      return run();
    }, refusal);
    expect(outcome).toBe("refused");
    expect(ran).toBe(false);
  });

  it("runs a press that reads nothing without waiting for a send on its way", async () => {
    let flushed = false;
    const settler = {
      owes: () => false,
      pending: () => true,
      flush: () => {
        flushed = true;
        return new Promise<void>(() => undefined);
      },
    };
    await expect(gatePress(settler, false, run, refusal)).resolves.toBe("ran");
    expect(flushed).toBe(false);
  });

  it("refuses a press that reads the description once a stalled send runs out of time", async () => {
    const timers = manualTimers();
    const settler = createSemanticSettler<string>({ settleMs: SETTLE_MS, send: () => new Promise<void>(() => undefined), ...timers });
    settler.publish("selection: this");
    const outcome = gatePress(settler, true, run, refusal);
    await tick();
    timers.fire(SEMANTIC_FLUSH_TIMEOUT_MS);
    await expect(outcome).resolves.toBe("refused");
  });
});
