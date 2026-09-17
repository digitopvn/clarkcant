import { afterEach, describe, expect, it } from "vitest";

import { directoryPicker } from "../src/Conversation.tsx";

/**
 * Which ambient value counts as a usable directory dialog.
 *
 * The detection is the whole difference between the two builds: the desktop shell installs a named
 * bridge before the page script runs and the browser installs nothing, and the component must render
 * the picker in exactly the first case. It is a plain function rather than a render assertion
 * because vitest here has no DOM, and "is there a dialog" is not a question that needs one.
 */

function install(value: unknown): void {
  (globalThis as { clarkcant?: unknown }).clarkcant = value;
}

afterEach(() => {
  delete (globalThis as { clarkcant?: unknown }).clarkcant;
});

describe("the desktop directory picker", () => {
  it("is absent on the web, where nothing installs a bridge", () => {
    expect(directoryPicker()).toBeUndefined();
  });

  it("is absent when the bridge exposes no picker", () => {
    install({ notify: () => undefined, status: () => undefined });
    expect(directoryPicker()).toBeUndefined();
  });

  it("is absent when the picker is not callable", () => {
    // A hostile or half-initialised page can put anything on the global; only a function is a dialog.
    for (const value of [null, "pickDirectory", 42, { pickDirectory: null }, { pickDirectory: "yes" }]) {
      install(value);
      expect(directoryPicker(), `expected ${JSON.stringify(value)} not to be a dialog`).toBeUndefined();
    }
  });

  it("returns a callable that answers with the chosen path, bound to the bridge", async () => {
    const seen: { title?: string }[] = [];
    const bridge = {
      title: "desktop shell",
      pickDirectory(input?: { title?: string }) {
        seen.push(input ?? {});
        return Promise.resolve({ ok: true, path: `/chosen/from/${this.title}`, canceled: false });
      },
    };
    install(bridge);

    const pick = directoryPicker();
    expect(pick).toBeDefined();
    const chosen = await pick?.({ title: "Chọn thư mục" });
    expect(chosen?.path).toBe("/chosen/from/desktop shell");
    // Bound to the bridge rather than detached from it: a method that reads its own object is the
    // shape the preload actually exposes.
    expect(seen).toEqual([{ title: "Chọn thư mục" }]);
  });
});
