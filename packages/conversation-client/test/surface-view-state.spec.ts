import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SurfaceViewScope,
  SurfaceViewStoreProvider,
  createSurfaceViewStore,
  surfaceViewKey,
  useSurfaceViewState,
} from "../src/surface-view-state.tsx";

function Draft({ slot }: { slot: string }): ReactElement {
  const [value] = useSurfaceViewState(slot, () => "fresh");
  return createElement("output", null, value);
}

describe("view state that outlives its surface's component", () => {
  it("draws a surface mounted again with the view it was left in, keyed by the surface and not only the widget", () => {
    const store = createSurfaceViewStore();
    store.set(surfaceViewKey("msg_1#2", "note.draft"), "half typed");
    const draw = (scope: string): string =>
      renderToStaticMarkup(
        createElement(SurfaceViewStoreProvider, {
          store,
          children: createElement(SurfaceViewScope, { id: scope, children: createElement(Draft, { slot: "note.draft" }) }),
        }),
      );
    expect(draw("msg_1#2")).toBe("<output>half typed</output>");
    // The same widget drawn by another message is another surface, with its own view.
    expect(draw("msg_9#0")).toBe("<output>fresh</output>");
  });

  it("tells a section of a composed surface apart from its sibling", () => {
    const store = createSurfaceViewStore();
    store.set(surfaceViewKey("msg_1#0/section_b", "search.text"), "invoices");
    const html = renderToStaticMarkup(
      createElement(SurfaceViewStoreProvider, {
        store,
        children: createElement(SurfaceViewScope, {
          id: "msg_1#0",
          children: [
            createElement(SurfaceViewScope, { key: "a", id: "section_a", children: createElement(Draft, { slot: "search.text" }) }),
            createElement(SurfaceViewScope, { key: "b", id: "section_b", children: createElement(Draft, { slot: "search.text" }) }),
          ],
        }),
      }),
    );
    expect(html).toBe("<output>fresh</output><output>invoices</output>");
  });

  it("is plain component state outside a transcript surface, such as a pinned view", () => {
    const store = createSurfaceViewStore();
    store.set(surfaceViewKey("msg_1#2", "note.draft"), "half typed");
    expect(renderToStaticMarkup(createElement(SurfaceViewStoreProvider, { store, children: createElement(Draft, { slot: "note.draft" }) }))).toBe(
      "<output>fresh</output>",
    );
    expect(renderToStaticMarkup(createElement(Draft, { slot: "note.draft" }))).toBe("<output>fresh</output>");
  });

  it("holds a bounded number of views, letting the least recently written go first", () => {
    const store = createSurfaceViewStore(3);
    for (const key of ["a", "b", "c"]) store.set(key, key);
    store.set("a", "a again");
    store.set("d", "d");
    expect(store.size).toBe(3);
    expect(store.has("b")).toBe(false);
    expect(store.get("a")).toBe("a again");
    expect(store.has("c") && store.has("d")).toBe(true);
  });
});
