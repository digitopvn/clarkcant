import { describe, expect, it } from "vitest";

import type { IsolatedFrameLiveResponse } from "../src/api.ts";
import { keepMountedFrame } from "../src/DesktopSurfaces.tsx";

/**
 * Re-reading a live frame without reloading it.
 *
 * Each read mints a new grant, so each read has a new address. Re-reading to learn whether a service came back must
 * not reload the running widget — it would lose what the person typed — so the address is kept while the document is
 * the same one, and only then.
 */

function isolated(url: string, document: string | undefined): IsolatedFrameLiveResponse {
  return {
    kind: "isolated-frame",
    frame: { url, ...(document === undefined ? {} : { document }) },
    bindings: [],
  } as unknown as IsolatedFrameLiveResponse;
}

describe("keeping a live frame mounted across a re-read", () => {
  it("keeps the address while the document is the same, and takes everything else from the new read", () => {
    const previous = isolated("https://node.test/frame?grant=one", "com.example.notes@1.0.0/widgets/board/index.html");
    const next = {
      ...isolated("https://node.test/frame?grant=two", "com.example.notes@1.0.0/widgets/board/index.html"),
      bindings: [{ actionBindingId: "binding_notes_add", available: false }],
    } as unknown as IsolatedFrameLiveResponse;

    const kept = keepMountedFrame(previous, next) as IsolatedFrameLiveResponse;
    expect(kept.frame?.url).toBe("https://node.test/frame?grant=one");
    expect(kept.bindings).toEqual(next.bindings);
  });

  it("loads the new address when the document changed", () => {
    const previous = isolated("https://node.test/frame?grant=one", "com.example.notes@1.0.0/widgets/board/index.html");
    const next = isolated("https://node.test/frame?grant=two", "com.example.notes@1.1.0/widgets/board/index.html");
    expect(keepMountedFrame(previous, next)).toBe(next);
  });

  it("loads the new address when a node did not say which document it serves", () => {
    const previous = isolated("https://node.test/frame?grant=one", undefined);
    const next = isolated("https://node.test/frame?grant=two", undefined);
    expect(keepMountedFrame(previous, next)).toBe(next);
    expect(keepMountedFrame(undefined, next)).toBe(next);
  });
});
