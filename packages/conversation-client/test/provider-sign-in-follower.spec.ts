import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderSignInView } from "@clarkcant/contracts";

import { GatewayError } from "../src/api.ts";
import { refusalReason } from "../src/node-view-refusal.ts";
import { ProviderSignInFollower, type ProviderSignInPort } from "../src/use-provider-sign-ins.ts";

/**
 * How a surface follows a provider sign-in: the path the `/login` card and Settings → AI & Routing share.
 *
 * The repo has no DOM test environment, so the follower is driven here without React: what a surface shows is what
 * it publishes, and the node is a port whose answers the test hands out.
 */

const POLL_MS = 1500;

function view(patch: Partial<ProviderSignInView> = {}): ProviderSignInView {
  return { signInId: "signin-1", providerId: "acct", method: "oauth", state: "running", events: [], ...patch };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(port: Partial<ProviderSignInPort> = {}) {
  let shown: Record<string, ProviderSignInView> = {};
  const publish = vi.fn((update: (current: Record<string, ProviderSignInView>) => Record<string, ProviderSignInView>) => {
    shown = update(shown);
  });
  const errors: string[] = [];
  const full: ProviderSignInPort = {
    startProviderSignIn: vi.fn(async () => view()),
    providerSignIn: vi.fn(async () => view()),
    runningProviderSignIns: vi.fn(async () => ({ signIns: [] })),
    answerProviderSignIn: vi.fn(async () => view()),
    cancelProviderSignIn: vi.fn(async () => view({ state: "cancelled" })),
    notifyModelChange: vi.fn(),
    ...port,
  };
  const follower = new ProviderSignInFollower(full, publish, (message) => errors.push(message), POLL_MS);
  return { follower, port: full, publish, errors, shown: () => shown };
}

describe("following a provider sign-in", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops reading once the surface is gone, even with a read in flight when it went", async () => {
    const inFlight = deferred<ProviderSignInView>();
    const providerSignIn = vi.fn(() => inFlight.promise);
    const { follower, publish } = harness({ providerSignIn });

    follower.follow("acct", view());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(providerSignIn).toHaveBeenCalledTimes(1);

    // The Settings tab is left while that read is still on its way.
    follower.close();
    const published = publish.mock.calls.length;
    inFlight.resolve(view({ state: "waiting" }));
    await vi.advanceTimersByTimeAsync(POLL_MS * 20);

    expect(providerSignIn).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(published);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("draws nothing for a read that failed after the surface went", async () => {
    const inFlight = deferred<ProviderSignInView>();
    const { follower, publish } = harness({ providerSignIn: () => inFlight.promise });
    follower.follow("acct", view());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    follower.close();
    const published = publish.mock.calls.length;
    inFlight.reject(new GatewayError(404, "SIGN_IN_NOT_FOUND", "This sign-in has ended; start it again from /login."));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(publish).toHaveBeenCalledTimes(published);
  });

  it("keeps reading while the surface is there, and stops once the sign-in ends", async () => {
    const providerSignIn = vi.fn<ProviderSignInPort["providerSignIn"]>().mockResolvedValueOnce(view()).mockResolvedValueOnce(view({ state: "done" }));
    const { follower, port, shown } = harness({ providerSignIn });
    follower.follow("acct", view());
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(providerSignIn).toHaveBeenCalledTimes(2);
    expect(shown().acct?.state).toBe("done");
    expect(port.notifyModelChange).toHaveBeenCalledTimes(1);
  });

  it("shows again a sign-in the node still runs when the surface opens, under the key the surface gives it", async () => {
    const running = view({ state: "waiting", prompt: { type: "text", message: "Code" } });
    const { follower, shown } = harness({ runningProviderSignIns: async () => ({ signIns: [running] }) });
    await follower.reattach((candidate) => candidate.providerId);
    expect(shown()).toEqual({ acct: running });
  });

  it("reads the running sign-ins once for every row that asks together, and shows each in one row: the newest", async () => {
    const listing = deferred<{ signIns: ProviderSignInView[] }>();
    const runningProviderSignIns = vi.fn(() => listing.promise);
    const { follower, shown } = harness({ runningProviderSignIns });
    const older = follower.reattach((candidate) => (candidate.providerId === "acct" ? "card-1/acct" : undefined));
    const newer = follower.reattach((candidate) => (candidate.providerId === "acct" ? "card-2/acct" : undefined));
    listing.resolve({ signIns: [view()] });
    await Promise.all([older, newer]);
    expect(runningProviderSignIns).toHaveBeenCalledTimes(1);
    expect(Object.keys(shown())).toEqual(["card-2/acct"]);

    // A row drawn again later — scrolled back into view — does not show it a second time.
    runningProviderSignIns.mockResolvedValueOnce({ signIns: [view()] });
    await follower.reattach((candidate) => (candidate.providerId === "acct" ? "card-1/acct" : undefined));
    expect(Object.keys(shown())).toEqual(["card-2/acct"]);
  });

  it("leaves the surface as it was when the node cannot list its sign-ins", async () => {
    const { follower, shown, errors } = harness({
      runningProviderSignIns: async () => {
        throw new GatewayError(404, "RESOURCE_NOT_FOUND", "no such providers route");
      },
    });
    await follower.reattach((candidate) => candidate.providerId);
    expect(shown()).toEqual({});
    expect(errors).toEqual([]);
  });

  it("says why an answer was refused in the node's words, without its code", async () => {
    const { follower, errors } = harness({
      answerProviderSignIn: async () => {
        throw new GatewayError(409, "NOT_WAITING", "This sign-in is not asking for anything right now.");
      },
    });
    follower.answer({ key: "acct", signInId: "signin-1", value: "code" });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(["This sign-in is not asking for anything right now."]);
  });

  it("says why a sign-in could no longer be read in the node's words, without its code", async () => {
    const { follower, shown } = harness({
      providerSignIn: async () => {
        throw new GatewayError(404, "SIGN_IN_NOT_FOUND", "This sign-in has ended; start it again from /login.");
      },
    });
    follower.follow("acct", view());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(shown().acct).toMatchObject({ state: "failed", error: "This sign-in has ended; start it again from /login." });
  });

  it("reads a refusal as the node's sentence, and anything else as its message", () => {
    expect(refusalReason(new GatewayError(409, "SIGN_IN_METHOD_UNAVAILABLE", "Fake has no sign-in of its own; use an API key."))).toBe(
      "Fake has no sign-in of its own; use an API key.",
    );
    expect(refusalReason(new Error("offline"))).toBe("offline");
  });
});
