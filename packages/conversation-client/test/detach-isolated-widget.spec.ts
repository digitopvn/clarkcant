import { describe, expect, it } from "vitest";

import { canShowDetached } from "../src/DesktopSurfaces.tsx";
import type { IsolatedFrameLiveResponse, LiveWidgetResponse } from "../src/api.ts";

/**
 * Which widgets the conversation offers to detach.
 *
 * A detached window holds no credential, so it can draw a composition and relay its presses, but it cannot run a widget
 * in its own frame: that frame saves state and renews its URL with the conversation's credential. Offering Detach for
 * one opened a window that threw, so the control is not offered and the window says why if it is reached anyway.
 */
describe("detaching an isolated widget", () => {
  it("is not offered for a widget that runs in its own frame", () => {
    const isolated = { kind: "isolated-frame", instanceId: "widget_frame" } as unknown as IsolatedFrameLiveResponse;
    expect(canShowDetached(isolated)).toBe(false);
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
