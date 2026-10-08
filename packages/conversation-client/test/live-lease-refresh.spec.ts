import { afterEach, describe, expect, it, vi } from "vitest";

import { HANDOFF_WAIT_MS, refreshLiveLease } from "../src/live-lease-refresh.ts";

/**
 * The conversation's periodic re-claim of a live widget, driven with a fake clock and claims answered by hand.
 */
describe("the conversation's periodic re-claim", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function controlled() {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  }

  it("makes the surface the owner again when a re-claim succeeds", async () => {
    vi.useFakeTimers();
    const onOwner = vi.fn();
    const refresh = refreshLiveLease({ claim: async () => ({}), paused: () => false, onOwner, refreshMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onOwner).toHaveBeenCalledTimes(1);
    refresh.stop();
  });

  it("does not make the surface the owner when a re-claim is refused", async () => {
    vi.useFakeTimers();
    const onOwner = vi.fn();
    const refresh = refreshLiveLease({
      claim: async () => {
        throw new Error("ALREADY_OWNED");
      },
      paused: () => false,
      onOwner,
      refreshMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onOwner).not.toHaveBeenCalled();
    refresh.stop();
  });

  it("sends no re-claim while the widget is being handed to a detached window", async () => {
    vi.useFakeTimers();
    let handingOff = true;
    const claim = vi.fn(async () => ({}));
    const refresh = refreshLiveLease({ claim, paused: () => handingOff, onOwner: vi.fn(), refreshMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claim).not.toHaveBeenCalled();
    handingOff = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(1);
    refresh.stop();
  });

  it("lets a hand-off wait for a re-claim already on its way, and does not call it ownership", async () => {
    vi.useFakeTimers();
    let handingOff = false;
    const sent = controlled();
    const onOwner = vi.fn();
    const refresh = refreshLiveLease({
      claim: () => sent.promise,
      paused: () => handingOff,
      onOwner,
      refreshMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    // The hand-off starts while the re-claim is still out.
    handingOff = true;
    let settled = false;
    void refresh.settled().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    sent.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    // Paused since it was sent: the hand-off, not this answer, decides who owns the widget.
    expect(onOwner).not.toHaveBeenCalled();
    refresh.stop();
  });

  it("sends one re-claim at a time, so a hand-off waits for every one still on its way", async () => {
    vi.useFakeTimers();
    let handingOff = false;
    const slow = controlled();
    const claim = vi.fn(() => slow.promise);
    const refresh = refreshLiveLease({ claim, paused: () => handingOff, onOwner: vi.fn(), refreshMs: 1_000 });
    // A re-claim slower than the refresh interval: the next ticks do not send another behind it.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(claim).toHaveBeenCalledTimes(1);

    handingOff = true;
    let settled = false;
    void refresh.settled(60_000).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    slow.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);

    // Once it has landed, the next tick sends again.
    handingOff = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim).toHaveBeenCalledTimes(2);
    refresh.stop();
  });

  it("stops waiting for a re-claim that never lands once the hand-off's bound has passed", async () => {
    vi.useFakeTimers();
    const refresh = refreshLiveLease({
      claim: () => new Promise(() => undefined),
      paused: () => false,
      onOwner: vi.fn(),
      refreshMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    let settled = false;
    void refresh.settled().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(HANDOFF_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    refresh.stop();
  });

  it("stops re-claiming once stopped", async () => {
    vi.useFakeTimers();
    const claim = vi.fn(async () => ({}));
    const refresh = refreshLiveLease({ claim, paused: () => false, onOwner: vi.fn(), refreshMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    refresh.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claim).toHaveBeenCalledTimes(2);
  });
});
