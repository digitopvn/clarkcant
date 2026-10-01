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
