import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FILE_REFUSALS,
  createFileHandles,
  dialogFiltersForAccept,
  fileRefusal,
  mimeForFileName,
  replaceKeepsType,
  reviewPickFileRequest,
  reviewSaveFileRequest,
  saveNameForType,
  suggestedSaveName,
  writeFileWhole,
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
    expect(mimeForFileName("so-lieu.tsv")).toBe("text/tab-separated-values");
    expect(saveNameForType("so-lieu", "text/tab-separated-values")).toBe("so-lieu.tsv");
    // No type rather than a generic binary one: the node reads the bytes, and refuses a file it cannot hold with its reason.
    expect(mimeForFileName("setup.exe")).toBe("");
    expect(mimeForFileName("README")).toBe("");
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

  it("writes back only to a handle the picker minted, in the handle's own shape", () => {
    expect(reviewSaveFileRequest({ suggestedName: "a.txt", mimeType: "text/plain", contentBase64: "aGk=", replaceHandle: "C:/secrets.txt" }).allowed).toBe(false);
    // Something that only starts like a handle is not one: the whole shape is the check.
    expect(reviewSaveFileRequest({ suggestedName: "a.txt", mimeType: "text/plain", contentBase64: "aGk=", replaceHandle: "fh_../../secrets.txt" }).allowed).toBe(false);
    expect(reviewSaveFileRequest({ suggestedName: "a.txt", mimeType: "text/plain", contentBase64: "aGk=", replaceHandle: `fh_${"A".repeat(32)}` }).allowed).toBe(false);
    expect(reviewSaveFileRequest({ suggestedName: "a.txt", mimeType: "text/plain", contentBase64: "aGk=", replaceHandle: `fh_${"a".repeat(32)}` }).allowed).toBe(true);
    expect(reviewSaveFileRequest({ suggestedName: "a.txt", mimeType: "text/plain", contentBase64: "not base64!" }).allowed).toBe(false);
    expect(reviewSaveFileRequest({ suggestedName: "a.txt", mimeType: "text/plain", contentBase64: "aGk=" })).toMatchObject({ allowed: true, suggestedName: "a.txt" });
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

describe("what a failed pick or save tells the page", () => {
  it("answers with a fixed code and the error's own code, never the message that names the path", () => {
    const cause = Object.assign(new Error("EBUSY: resource busy or locked, open 'C:\\Users\\x\\f.csv'"), { code: "EBUSY" });

    const refusal = fileRefusal("READ_FAILED", cause);

    expect(refusal).toEqual({ ok: false, refused: "READ_FAILED", errorCode: "EBUSY" });
    expect(JSON.stringify(refusal)).not.toContain("Users");
    expect(JSON.stringify(refusal)).not.toContain("f.csv");
  });

  it("drops an error code that is not one, and a refusal code it does not know", () => {
    // A code is where a path could hide too, when something other than the file system threw.
    expect(fileRefusal("WRITE_FAILED", { code: "C:\\Users\\x\\f.csv" })).toEqual({ ok: false, refused: "WRITE_FAILED" });
    expect(fileRefusal("WRITE_FAILED", "C:\\Users\\x\\f.csv")).toEqual({ ok: false, refused: "WRITE_FAILED" });
    expect(fileRefusal("the file C:\\Users\\x\\f.csv is gone")).toEqual({ ok: false, refused: "INVALID_REQUEST" });
    expect(FILE_REFUSALS).toContain("REPLACE_TYPE_MISMATCH");
  });
});

describe("what Save As offers for a type", () => {
  it("names the file with its type's extension, so a text file is never offered as something the OS runs", () => {
    expect(saveNameForType("invoice.bat", "text/plain")).toBe("invoice.txt");
    expect(saveNameForType("Kế hoạch", "text/markdown")).toBe("Kế hoạch.md");
    expect(saveNameForType("bao-cao.CSV", "text/csv")).toBe("bao-cao.CSV");
    expect(saveNameForType("ảnh.jpeg", "image/jpeg")).toBe("ảnh.jpeg");
    expect(saveNameForType("../../evil.exe", "application/pdf")).toBe("evil.pdf");
    expect(saveNameForType("ghi chú. ", "text/plain")).toBe("ghi chú.txt");
    expect(saveNameForType("..", "text/plain")).toBe("file.txt");
  });

  it("offers only the type's extensions in the dialog, under the person's own words", () => {
    const review = reviewSaveFileRequest({
      suggestedName: "bao-cao.exe",
      mimeType: "text/csv",
      contentBase64: "aGk=",
      labels: { filterName: "Tệp", replaceTitle: "Thay tệp", replaceMessage: "Thay {name} bằng bản này?", replace: "Thay", cancel: "Hủy" },
    });

    expect(review).toMatchObject({
      allowed: true,
      suggestedName: "bao-cao.csv",
      filters: [{ name: "Tệp", extensions: ["csv"] }],
      dialog: { replaceTitle: "Thay tệp", replaceMessage: "Thay {name} bằng bản này?", replace: "Thay", cancel: "Hủy" },
    });
  });

  it("falls back to English words when the page passes none, and refuses a save that names no type the node holds", () => {
    expect(reviewSaveFileRequest({ suggestedName: "a", mimeType: "text/plain", contentBase64: "aGk=" })).toMatchObject({
      dialog: { replaceTitle: "Replace file", replace: "Replace", cancel: "Cancel" },
      filters: [{ name: "Files", extensions: expect.arrayContaining(["txt"]) }],
    });
    expect(reviewSaveFileRequest({ suggestedName: "a.txt", contentBase64: "aGk=" }).allowed).toBe(false);
    expect(reviewSaveFileRequest({ suggestedName: "a.exe", mimeType: "application/x-msdownload", contentBase64: "aGk=" }).allowed).toBe(false);
  });

  it("replaces a picked file only with bytes of the same type", () => {
    expect(replaceKeepsType("notes.md", "text/markdown")).toBe(true);
    expect(replaceKeepsType("Báo cáo.CSV", "text/csv")).toBe(true);
    expect(replaceKeepsType("notes.md", "application/pdf")).toBe(false);
    expect(replaceKeepsType("setup.exe", "application/octet-stream")).toBe(false);
  });

  it("names the picker's filter in the person's words", () => {
    expect(reviewPickFileRequest({ accept: ["text/csv"], filterName: "Tệp" })).toMatchObject({ filters: [{ name: "Tệp", extensions: ["csv"] }] });
  });
});

describe("writing a file whole", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });
  const folder = () => {
    const made = mkdtempSync(join(tmpdir(), "cc-file-bridge-"));
    folders.push(made);
    return made;
  };

  it("replaces the file's contents and leaves nothing else beside it", async () => {
    const dir = folder();
    const target = join(dir, "Kế hoạch.md");
    writeFileSync(target, "cũ");

    await writeFileWhole(target, Buffer.from("mới"));

    expect(readFileSync(target, "utf8")).toBe("mới");
    expect(readdirSync(dir)).toEqual(["Kế hoạch.md"]);
  });

  it("leaves the original as it was and removes its temporary file when the write cannot finish", async () => {
    const dir = folder();
    const target = join(dir, "a-folder.md");
    // A folder where the file should be: the rename over it fails, as a locked file would.
    const blocker = join(target, "inside.txt");
    writeFileSync(join(dir, "keep.md"), "giữ");
    rmSync(target, { force: true });
    await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(target).then(() => writeFile(blocker, "x")));

    await expect(writeFileWhole(target, Buffer.from("mới"))).rejects.toBeDefined();

    expect(readdirSync(dir).sort()).toEqual(["a-folder.md", "keep.md"]);
    expect(readFileSync(blocker, "utf8")).toBe("x");
  });

  it("writes through a short temporary name, whatever the file is called", async () => {
    const dir = folder();
    // 243 bytes in UTF-8: inside every system's 255-byte name limit, but past it once a name is built around it.
    const target = join(dir, `${"tên-rất-dài-".repeat(15)}.md`);
    expect(Buffer.byteLength(basename(target))).toBe(243);
    writeFileSync(target, "cũ");
    const temporaries: string[] = [];
    await writeFileWhole(target, Buffer.from("mới"), {
      rename: async (from: string, to: string) => {
        temporaries.push(from);
        await rename(from, to);
      },
    });
    expect(readFileSync(target, "utf8")).toBe("mới");
    expect(temporaries).toHaveLength(1);
    // The target's own name is not repeated in it, so a long name never makes the temporary one too long to create.
    expect(basename(temporaries[0] ?? "")).toMatch(/^\.cc-[0-9a-f]{12}\.tmp$/u);
    // Beside the original, in its real folder (macOS keeps its temporary folder behind a link).
    expect(dirname(temporaries[0] ?? "")).toBe(realpathSync(dir));
  });

  it("tries the rename again on Windows while another program briefly holds the file, and gives up cleanly", async () => {
    const dir = folder();
    const target = join(dir, "bang.csv");
    writeFileSync(target, "cu");
    let attempts = 0;
    const busyTwice = async (from: string, to: string) => {
      attempts += 1;
      if (attempts <= 2) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: "EBUSY" });
      await rename(from, to);
    };
    await writeFileWhole(target, Buffer.from("moi"), { platform: "win32", rename: busyTwice, retryDelayMs: 1 });
    expect(attempts).toBe(3);
    expect(readFileSync(target, "utf8")).toBe("moi");
    expect(readdirSync(dir)).toEqual(["bang.csv"]);

    // Held for good: the write fails, the original is untouched and the temporary file is gone.
    let tries = 0;
    const alwaysLocked = async () => {
      tries += 1;
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    };
    await expect(writeFileWhole(target, Buffer.from("khac"), { platform: "win32", rename: alwaysLocked, retryDelayMs: 1 })).rejects.toMatchObject({ code: "EPERM" });
    expect(tries).toBeGreaterThan(1);
    expect(readFileSync(target, "utf8")).toBe("moi");
    expect(readdirSync(dir)).toEqual(["bang.csv"]);

    // Elsewhere a locked rename is not a passing condition, and is not retried.
    let once = 0;
    const lockedElsewhere = async () => {
      once += 1;
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    };
    await expect(writeFileWhole(target, Buffer.from("khac"), { platform: "linux", rename: lockedElsewhere, retryDelayMs: 1 })).rejects.toBeDefined();
    expect(once).toBe(1);
  });

  it.skipIf(process.platform === "win32")("keeps the original file's permissions", async () => {
    const dir = folder();
    const target = join(dir, "rieng.md");
    writeFileSync(target, "cu");
    chmodSync(target, 0o640);
    await writeFileWhole(target, Buffer.from("moi"));
    expect(statSync(target).mode & 0o777).toBe(0o640);
    expect(readFileSync(target, "utf8")).toBe("moi");
  });

  it.skipIf(process.platform === "win32")("writes to the file a link points at, and leaves the link a link", async () => {
    const dir = folder();
    const real = join(dir, "that.md");
    const link = join(dir, "link.md");
    writeFileSync(real, "cu");
    symlinkSync(real, link);
    await writeFileWhole(link, Buffer.from("moi"));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("moi");
    expect(readdirSync(dir).sort()).toEqual(["link.md", "that.md"]);
  });
});
