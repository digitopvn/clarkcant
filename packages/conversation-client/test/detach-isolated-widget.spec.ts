import { describe, expect, it } from "vitest";

import { canShowDetached } from "../src/DesktopSurfaces.tsx";
import type { IsolatedFrameLiveResponse, LiveWidgetResponse } from "../src/api.ts";

/**
 * Which widgets the conversation offers to detach.
 *
 * A detached window holds no credential, but the desktop host relays a frame's reads, state writes, publishes and
 * presses for it with its own, so a widget in its own frame can run there. One with no frame (its package is gone) has
 * nothing to run, so it stays in the conversation, where its text alternative is shown.
 */
describe("detaching an isolated widget", () => {
  it("is offered for a widget that runs in its own frame", () => {
    const isolated = { kind: "isolated-frame", instanceId: "widget_frame", frame: { url: "/widgets/frame" } } as unknown as IsolatedFrameLiveResponse;
    expect(canShowDetached(isolated)).toBe(true);
  });

  it("is not offered for a widget whose frame is gone (frame: null)", () => {
    const gone = { kind: "isolated-frame", instanceId: "widget_frame", frame: null } as unknown as IsolatedFrameLiveResponse;
    expect(canShowDetached(gone)).toBe(false);
  });

  it("is offered for a composition, which the detached window draws", () => {
    const composition = { kind: "composition", compositionId: "comp_1" } as unknown as LiveWidgetResponse;
    expect(canShowDetached(composition)).toBe(true);
  });

  it("is not offered before the surface has been read", () => {
    expect(canShowDetached(undefined)).toBe(false);
  });

  it("is not offered for a kind the detached window does not know how to draw", () => {
    const unknown = { kind: "something-new" } as unknown as LiveWidgetResponse;
    expect(canShowDetached(unknown)).toBe(false);
  });
});
