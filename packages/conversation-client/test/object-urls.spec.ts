import { describe, expect, it } from "vitest";

import { createObjectUrlSet } from "../src/use-object-urls.ts";

/**
 * Which bytes a page fetches and releases as the pictures it shows change.
 *
 * A composed surface can list a whole gallery, and the conversation's set grows as each surface arrives: a change
 * that cancelled and fetched everything again would ask the node for the same pictures each time.
 */

function harness() {
  const fetched: string[] = [];
  const revoked: string[] = [];
  const answers = new Map<string, (url: string) => void>();
  const set = createObjectUrlSet({
    fetchUrl: (reference) => {
      fetched.push(reference);
      return new Promise<string>((resolve) => answers.set(reference, resolve));
    },
    revoke: (url) => revoked.push(url),
    onChange: () => undefined,
  });
  const answer = async (reference: string) => {
    answers.get(reference)?.(`blob:${reference}`);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { set, fetched, revoked, answer };
}

/** A harness whose fetches can also be refused, for the player sources read on request. */
function failingHarness() {
  const fetched: string[] = [];
  const revoked: string[] = [];
  const settle = new Map<string, { resolve: (url: string) => void; reject: (cause: Error) => void }>();
  let changes = 0;
  const set = createObjectUrlSet({
    fetchUrl: (reference) => {
      fetched.push(reference);
      return new Promise<string>((resolve, reject) => settle.set(reference, { resolve, reject }));
    },
    revoke: (url) => revoked.push(url),
    onChange: () => {
      changes += 1;
    },
  });
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    set,
    fetched,
    revoked,
    changes: () => changes,
    answer: async (reference: string) => {
      settle.get(reference)?.resolve(`blob:${reference}`);
      await flush();
    },
    fail: async (reference: string) => {
      settle.get(reference)?.reject(new Error("refused"));
      await flush();
    },
  };
}

describe("object URLs for a changing set of pictures", () => {
  it("fetches only new references, keeping those in flight and those already drawn", async () => {
    const run = harness();
    run.set.want(["a", "b"]);
    await run.answer("a");
    // "b" is still in flight and "a" is drawn: neither is asked for again.
    run.set.want(["a", "b", "c", ""]);
    await run.answer("b");
    await run.answer("c");
    expect(run.fetched).toEqual(["a", "b", "c"]);
    expect(run.set.get("a")).toBe("blob:a");
    expect(run.set.get("b")).toBe("blob:b");
    expect(run.set.get("c")).toBe("blob:c");
    expect(run.revoked).toEqual([]);
  });

  it("releases only what left the set, including a request that lands after it left", async () => {
    const run = harness();
    run.set.want(["a", "b"]);
    await run.answer("a");
    run.set.want(["b"]);
    expect(run.revoked).toEqual(["blob:a"]);
    expect(run.set.get("a")).toBeUndefined();
    run.set.want([]);
    await run.answer("b");
    expect(run.revoked).toEqual(["blob:a", "blob:b"]);
    expect(run.set.get("b")).toBeUndefined();
  });

  it("keeps a request that left and came back before it landed, and releases everything when its owner goes", async () => {
    const run = harness();
    run.set.want(["a"]);
    run.set.want([]);
    run.set.want(["a"]);
    await run.answer("a");
    expect(run.fetched).toEqual(["a"]);
    expect(run.set.get("a")).toBe("blob:a");
    run.set.release();
    expect(run.revoked).toEqual(["blob:a"]);
    expect(run.set.get("a")).toBeUndefined();
  });
});

describe("object URLs read on request, for a player's source", () => {
  it("reads nothing listed on request until it is asked for, then reads it once", async () => {
    const run = failingHarness();
    run.set.want(["poster"], ["clip", "song"]);
    expect(run.fetched).toEqual(["poster"]);
    expect(run.set.status("clip")).toBe("idle");
    expect(run.set.status("song")).toBe("idle");
    expect(run.set.status("elsewhere")).toBe("unlisted");

    run.set.request("clip");
    run.set.request("clip");
    expect(run.fetched).toEqual(["poster", "clip"]);
    expect(run.set.status("clip")).toBe("loading");
    // A change of list keeps a request in flight, and still reads nothing nobody asked for.
    run.set.want(["poster"], ["clip", "song"]);
    await run.answer("clip");
    expect(run.fetched).toEqual(["poster", "clip"]);
    expect(run.set.status("clip")).toBe("ready");
    expect(run.set.get("clip")).toBe("blob:clip");
    expect(run.set.status("song")).toBe("idle");
    expect(run.set.get("song")).toBeUndefined();
  });

  it("keeps a request made before the list names the reference, and reads it once it does", async () => {
    const run = failingHarness();
    run.set.request("clip");
    expect(run.fetched).toEqual([]);
    run.set.want([], ["clip"]);
    expect(run.fetched).toEqual(["clip"]);
    await run.answer("clip");
    expect(run.set.get("clip")).toBe("blob:clip");
  });

  it("reads a reference listed both ways now, as a picture", () => {
    const run = failingHarness();
    run.set.want(["shared"], ["shared"]);
    expect(run.fetched).toEqual(["shared"]);
  });

  it("releases a requested URL when it leaves the list, and needs a new request when it comes back", async () => {
    const run = failingHarness();
    run.set.want([], ["clip"]);
    run.set.request("clip");
    await run.answer("clip");
    run.set.want([], []);
    expect(run.revoked).toEqual(["blob:clip"]);
    expect(run.set.get("clip")).toBeUndefined();

    run.set.want([], ["clip"]);
    expect(run.set.status("clip")).toBe("idle");
    expect(run.fetched).toEqual(["clip"]);
    run.set.request("clip");
    expect(run.fetched).toEqual(["clip", "clip"]);
  });

  it("releases a requested URL that lands after its reference left the list, and never stores it", async () => {
    const run = failingHarness();
    run.set.want([], ["clip"]);
    run.set.request("clip");
    run.set.want([], []);
    await run.answer("clip");
    expect(run.revoked).toEqual(["blob:clip"]);
    expect(run.set.get("clip")).toBeUndefined();
    expect(run.set.status("clip")).toBe("unlisted");
  });

  it("says a refused source failed, and does not ask the node again for it", async () => {
    const run = failingHarness();
    run.set.want([], ["clip"]);
    run.set.request("clip");
    const before = run.changes();
    await run.fail("clip");
    expect(run.set.status("clip")).toBe("failed");
    expect(run.changes()).toBeGreaterThan(before);
    run.set.want([], ["clip"]);
    run.set.request("clip");
    expect(run.fetched).toEqual(["clip"]);
  });

  it("reads only the reference asked for, and does not retry a picture that failed", async () => {
    const run = failingHarness();
    run.set.want(["poster"], ["clip"]);
    await run.fail("poster");
    expect(run.set.status("poster")).toBe("failed");
    run.set.request("clip");
    expect(run.fetched).toEqual(["poster", "clip"]);
    // A change of list is still what tries a failed picture again.
    run.set.want(["poster"], ["clip"]);
    expect(run.fetched).toEqual(["poster", "clip", "poster"]);
  });

  it("releases every URL and forgets every request when its owner goes", async () => {
    const run = failingHarness();
    run.set.want(["poster"], ["clip"]);
    run.set.request("clip");
    await run.answer("poster");
    await run.answer("clip");
    run.set.release();
    expect(run.revoked.sort()).toEqual(["blob:clip", "blob:poster"]);
    run.set.want(["poster"], ["clip"]);
    expect(run.set.status("clip")).toBe("idle");
    expect(run.fetched).toEqual(["poster", "clip", "poster"]);
  });
});
