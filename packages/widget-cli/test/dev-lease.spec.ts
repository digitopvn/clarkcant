import { describe, expect, it } from "vitest";

import { openDevLeaseStore } from "../src/dev-lease.ts";

/**
 * The dev host's lease store, checked against the real service it wraps.
 *
 * Nothing about "one owner at a time" or "an expired lease recovers" is decided here: this file only checks that
 * the store is actually calling `@clarkcant/core`'s `claimLiveOwner` / `releaseLiveOwner`, by asserting the exact
 * behaviour that service is known (by `packages/core/test/core.spec.ts`) to have — a second claim refused with
 * `ALREADY_OWNED` and the holder named, and a release that only the holder's own token can perform.
 */

describe("the dev host's lease store", () => {
  it("grants the first claim on an instance nobody holds", () => {
    const store = openDevLeaseStore();
    try {
      const result = store.claim({ ownerToken: "tok_inline", surface: "inline" });
      expect(result.ok).toBe(true);
      expect(store.current()?.ownerToken).toBe("tok_inline");
      expect(store.current()?.surface).toBe("inline");
    } finally {
      store.close();
    }
  });

  it("refuses a second live owner while the first is still held, and names the holder", () => {
    const store = openDevLeaseStore();
    try {
      store.claim({ ownerToken: "tok_inline", surface: "inline" });
      const second = store.claim({ ownerToken: "tok_detached", surface: "detached" });

      expect(second.ok).toBe(false);
      expect(second.ok === false && second.code).toBe("ALREADY_OWNED");
      expect(second.ok === false && second.heldBy.ownerToken).toBe("tok_inline");
      expect(second.ok === false && second.heldBy.surface).toBe("inline");
      // The refusal is not a side effect: the original claim is exactly as it was.
      expect(store.current()?.ownerToken).toBe("tok_inline");
    } finally {
      store.close();
    }
  });

  it("moves the lease once the holder releases it, never leaving two owners", () => {
    const store = openDevLeaseStore();
    try {
      store.claim({ ownerToken: "tok_inline", surface: "inline" });
      const released = store.release("tok_inline");
      expect(released).toBe(true);
      expect(store.current()).toBeUndefined();

      const claimedByDetached = store.claim({ ownerToken: "tok_detached", surface: "detached" });
      expect(claimedByDetached.ok).toBe(true);
      expect(store.current()?.surface).toBe("detached");
    } finally {
      store.close();
    }
  });

  it("refuses to release a claim with the wrong token", () => {
    const store = openDevLeaseStore();
    try {
      store.claim({ ownerToken: "tok_inline", surface: "inline" });
      expect(store.release("not-the-holder")).toBe(false);
      expect(store.current()?.ownerToken).toBe("tok_inline");
    } finally {
      store.close();
    }
  });
});
