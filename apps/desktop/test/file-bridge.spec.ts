import { describe, expect, it } from "vitest";

import {
  createFileHandles,
  dialogFiltersForAccept,
  mimeForFileName,
  reviewPickFileRequest,
  reviewSaveFileRequest,
  suggestedSaveName,
} from "../src/file-bridge.mjs";

/**
 * The desktop's file pick and Save As, checked without a window.
 *
 * The property under test is what crosses the bridge: a name, a type, bytes and an opaque handle — never a path — and
 * a save that can only pre-fill a bare name or write back to a file the person picked in this window.
 */

describe("what the picker offers", () => {
  it("offers only types the node takes, narrowed by what the widget accepts", () => {
    expect(dialogFiltersForAccept(["text/csv"])).toEqual([{ name: "Files", extensions: ["csv"] }]);
    expect(dialogFiltersForAccept(["image/*"])[0]?.extensions).toEqual(["png", "jpg", "jpeg", "webp", "gif"]);
    // Nothing named is everything the node holds, not every file on disk.
    expect(dialogFiltersForAccept([])[0]?.extensions).toContain("pdf");
    expect(dialogFiltersForAccept([])[0]?.extensions).not.toContain("exe");
  });

  it("refuses a request whose types the node could never hold, instead of opening a dialog that offers nothing", () => {
    expect(reviewPickFileRequest({ accept: ["application/x-msdownload"] }).allowed).toBe(false);
    expect(reviewPickFileRequest({ accept: ["../etc/passwd"] }).allowed).toBe(false);
    expect(reviewPickFileRequest({ accept: Array.from({ length: 17 }, () => "text/plain") }).allowed).toBe(false);
    expect(reviewPickFileRequest({ accept: ["text/plain"] })).toMatchObject({ allowed: true, title: "Choose a file" });
  });

  it("names a file's type from its extension, and anything else as a type the node will refuse", () => {
    expect(mimeForFileName("Báo cáo.CSV")).toBe("text/csv");
    expect(mimeForFileName("notes.md")).toBe("text/markdown");
    expect(mimeForFileName("setup.exe")).toBe("application/octet-stream");
  });
});

describe("what Save As may write", () => {
  it("pre-fills a bare name, never a path the widget chose", () => {
    expect(suggestedSaveName("../../etc/passwd")).toBe("passwd");
    expect(suggestedSaveName("C:\\Windows\\system32\\evil.dll")).toBe("evil.dll");
    expect(suggestedSaveName("bao-cao\u0000.csv")).toBe("bao-cao.csv");
    expect(suggestedSaveName("..")).toBe("file");
    expect(suggestedSaveName(undefined)).toBe("file");
  });

  it("writes back only to a handle this window was given, in the handle's own shape", () => {
    expect(reviewSaveFileRequest({ suggestedName: "a.txt", contentBase64: "aGk=", replaceHandle: "C:/secrets.txt" }).allowed).toBe(false);
    expect(reviewSaveFileRequest({ suggestedName: "a.txt", contentBase64: "not base64!" }).allowed).toBe(false);
    expect(reviewSaveFileRequest({ suggestedName: "a.txt", contentBase64: "aGk=" })).toMatchObject({ allowed: true, suggestedName: "a.txt" });
  });

  it("keeps the path behind a handle in this process, bounded", () => {
    const handles = createFileHandles(2);
    const first = handles.remember("/home/me/one.txt");
    const second = handles.remember("/home/me/two.txt");
    const third = handles.remember("/home/me/three.txt");

    expect(first).toMatch(/^fh_[a-f0-9]{32}$/);
    expect(first).not.toContain("one");
    // The oldest is forgotten, so a renderer that picks without end cannot grow the map.
    expect(handles.pathFor(first)).toBeUndefined();
    expect(handles.pathFor(second)).toBe("/home/me/two.txt");
    expect(handles.pathFor(third)).toBe("/home/me/three.txt");
    expect(handles.size()).toBe(2);
    expect(handles.pathFor("fh_" + "0".repeat(32))).toBeUndefined();
  });
});
