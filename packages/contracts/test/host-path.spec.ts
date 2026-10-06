import { describe, expect, it } from "vitest";

import { absoluteHostPathProblem, absoluteHostPathSchema, hostPathSegments, hostPathWithin } from "../src/index.ts";

describe("an absolute host path", () => {
  it("accepts POSIX and Windows absolute forms", () => {
    for (const path of ["/", "/home/an/Forms", "C:\\", "C:\\Users\\an", "d:\\work\\repo"]) {
      expect(absoluteHostPathSchema.safeParse(path).success, path).toBe(true);
    }
  });

  it("refuses relative, home-relative, unnormalized and network paths with a reason", () => {
    expect(absoluteHostPathProblem("../../etc")).toMatch(/absolute/);
    expect(absoluteHostPathProblem("~/Documents")).toMatch(/absolute/);
    expect(absoluteHostPathProblem("Documents")).toMatch(/absolute/);
    expect(absoluteHostPathProblem("C:Users")).toMatch(/drive letter/);
    expect(absoluteHostPathProblem("/home/an/../../etc")).toMatch(/normalized/);
    expect(absoluteHostPathProblem("/home/./an")).toMatch(/normalized/);
    expect(absoluteHostPathProblem("C:\\Users\\..\\Windows")).toMatch(/normalized/);
    expect(absoluteHostPathProblem("/home//an")).toMatch(/empty segments/);
    expect(absoluteHostPathProblem("//server/share")).toMatch(/network share/);
    expect(absoluteHostPathProblem("\\\\server\\share")).toMatch(/absolute|network share/);
    expect(absoluteHostPathProblem("/home/an\0")).toMatch(/NUL/);
    expect(absoluteHostPathProblem(" /home")).toMatch(/whitespace/);
    expect(absoluteHostPathSchema.safeParse("../../etc").success).toBe(false);
  });

  it("keeps one separator per style, so a filename character is never read as a separator", () => {
    expect(absoluteHostPathProblem("/srv/data\\x")).toMatch(/only \//);
    expect(absoluteHostPathProblem("/srv\\..\\etc")).toMatch(/only \//);
    expect(absoluteHostPathProblem("c:/x")).toMatch(/drive letter, a colon and \\/);
    expect(absoluteHostPathProblem("C:\\Users/an")).toMatch(/only \\/);
    expect(absoluteHostPathProblem("C:x")).toMatch(/drive letter/);
  });
});

describe("host path containment", () => {
  it("splits a path into its root and segments", () => {
    expect(hostPathSegments("/home/an")).toEqual(["", "home", "an"]);
    expect(hostPathSegments("c:\\Users\\an")).toEqual(["C:", "Users", "an"]);
  });

  it("compares segment by segment, never by string prefix", () => {
    expect(hostPathWithin("/a/b", "/a/b")).toBe(true);
    expect(hostPathWithin("/a/b/c", "/a/b")).toBe(true);
    expect(hostPathWithin("/a/b/c", "/")).toBe(true);
    expect(hostPathWithin("/a/bc", "/a/b")).toBe(false);
    expect(hostPathWithin("/a", "/a/b")).toBe(false);
    expect(hostPathWithin("C:\\a\\b", "c:\\a")).toBe(true);
    expect(hostPathWithin("D:\\a", "C:\\")).toBe(false);
    expect(hostPathWithin("/a", "C:\\")).toBe(false);
  });

  it("never places a path inside another when either is not a valid absolute host path", () => {
    expect(hostPathWithin("/srv/data\\x", "/srv/data")).toBe(false);
    expect(hostPathWithin("c:/x/y", "c:/x")).toBe(false);
    expect(hostPathWithin("/a/../b", "/a")).toBe(false);
    expect(hostPathWithin("/a/b", "a")).toBe(false);
  });
});
