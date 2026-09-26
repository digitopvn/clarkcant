import { describe, expect, it } from "vitest";

import { readFlag } from "../src/launch-flags.mjs";

describe("desktop launch flags", () => {
  it("reads the space-separated form", () => {
    expect(readFlag(["--data-dir", "D:\\data"], "data-dir")).toBe("D:\\data");
  });

  it("reads the = form, which is the only one Electron lets through after a URL", () => {
    const argv = ["--renderer-url=http://127.0.0.1:4173/", "--node-url=http://127.0.0.1:8765", "--data-dir=D:\\data"];
    expect(readFlag(argv, "renderer-url")).toBe("http://127.0.0.1:4173/");
    expect(readFlag(argv, "node-url")).toBe("http://127.0.0.1:8765");
    expect(readFlag(argv, "data-dir")).toBe("D:\\data");
  });

  it("answers nothing for an absent flag, an empty value or a flag followed by another flag", () => {
    expect(readFlag([], "node-url")).toBeUndefined();
    expect(readFlag(["--node-url="], "node-url")).toBeUndefined();
    expect(readFlag(["--node-url", "--smoke-test"], "node-url")).toBeUndefined();
    expect(readFlag(["--node-url"], "node-url")).toBeUndefined();
  });

  it("does not match a flag that only shares a prefix", () => {
    expect(readFlag(["--renderer-url-extra=x"], "renderer-url")).toBeUndefined();
  });
});
