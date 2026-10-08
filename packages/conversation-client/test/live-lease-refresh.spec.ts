import { afterEach, describe, expect, it, vi } from "vitest";

import { refreshLiveLease } from "../src/live-lease-refresh.ts";

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
