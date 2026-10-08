import { lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { devRootIdentityOf } from "../src/index.ts";
import { removeTestDirectory } from "../../../tools/test-cleanup.ts";

let dir: string;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "clarkcant-dev-root-identity-")));
});

afterEach(async () => {
  await removeTestDirectory(dir);
});

/** A link to a folder: a junction on Windows, which needs no privilege, and a symbolic link elsewhere. */
const linkFolder = (target: string, path: string): void => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

describe("devRootIdentityOf", () => {
  it("gives a folder's device and file id, as stat reads them", () => {
    const folder = join(dir, "timer");
    mkdirSync(folder);
    const stat = statSync(folder, { bigint: true });
    expect(devRootIdentityOf(folder)).toEqual({ dev: stat.dev, ino: stat.ino });
    expect(devRootIdentityOf(folder, { followLinks: false })).toEqual({ dev: stat.dev, ino: stat.ino });
  });

  it("gives no id for a file, or for a path where nothing is", () => {
    const file = join(dir, "notes.txt");
    writeFileSync(file, "x");
    for (const followLinks of [true, false]) {
      expect(devRootIdentityOf(file, { followLinks })).toBeUndefined();
      expect(devRootIdentityOf(join(dir, "missing"), { followLinks })).toBeUndefined();
    }
  });

  it("follows a link or junction by default, and gives no id through one when links are not followed", () => {
    const folder = join(dir, "timer");
    const linked = join(dir, "linked");
    mkdirSync(folder);
    linkFolder(folder, linked);
    const target = statSync(folder, { bigint: true });
    expect(devRootIdentityOf(linked)).toEqual({ dev: target.dev, ino: target.ino });
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(devRootIdentityOf(linked, { followLinks: false })).toBeUndefined();
  });

  it("gives a folder below a link the id of that folder either way: only the path's own last step is not followed", () => {
    const folder = join(dir, "projects", "timer");
    mkdirSync(folder, { recursive: true });
    linkFolder(join(dir, "projects"), join(dir, "linked"));
    const target = statSync(folder, { bigint: true });
    expect(devRootIdentityOf(join(dir, "linked", "timer"), { followLinks: false })).toEqual({ dev: target.dev, ino: target.ino });
  });
});
