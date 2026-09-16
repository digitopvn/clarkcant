import { describe, expect, it, vi } from "vitest";

import { newId } from "../src/services.ts";

/**
 * Identifier uniqueness across restarts.
 *
 * The runtime crashed with `UNIQUE constraint failed: messages.message_id` on the first message
 * after a restart. The cause was an identifier built from a counter that starts at one in every
 * process, while the rows the previous process wrote are still in the database.
 *
 * This reproduces that condition directly: take identifiers, then load the module again as a
 * fresh process would and take more. Two runs of the same build against the same data directory
 * must not agree on an identifier.
 */

/** Identifiers from a freshly loaded module, which is what a restarted process has. */
async function identifiersFromAFreshProcess(count: number): Promise<string[]> {
  vi.resetModules();
  const module = await import("../src/services.ts");
  return Array.from({ length: count }, () => module.newId("msg"));
}

describe("an identifier is unique across restarts, not just within one process", () => {
  it("does not repeat an identifier when the process starts again", async () => {
    const first = await identifiersFromAFreshProcess(5);
    const second = await identifiersFromAFreshProcess(5);

    // This is the assertion the old counter failed: both runs started at one and produced
    // `msg_00000001`, so the second run collided with rows the first had already written.
    const overlap = first.filter((id) => second.includes(id));
    expect(overlap).toEqual([]);
  });

  it("is unique within a single process as well", () => {
    // The static import, so this also keeps the export visibly used rather than only reached
    // through a dynamic import that tooling cannot follow.
    const ids = Array.from({ length: 200 }, () => newId("msg"));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stays inside what a message id may contain", () => {
    const ids = Array.from({ length: 3 }, () => newId("msg"));
    for (const id of ids) {
      // The contract allows only these characters and bounds the length; an identifier that
      // violated it would fail validation at the point of storage rather than here.
      expect(id).toMatch(/^msg_[A-Za-z0-9_-]+$/);
      expect(id.length).toBeLessThanOrEqual(128);
    }
  });

  it("keeps the prefix, so identifiers stay readable in logs and fixtures", () => {
    const ids = Array.from({ length: 2 }, () => newId("msg"));
    for (const id of ids) expect(id.startsWith("msg_")).toBe(true);
  });
});
