import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DELEGATED_ARTIFACT_MAX_BYTES, DELEGATED_ARTIFACTS_MAX, DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES } from "@clarkcant/contracts";

import { blobPathForDigest } from "../src/blobs.ts";
import { prepareDelegatedArtifacts } from "../src/delegated-artifacts.ts";
import type { TaskOutputFile } from "../src/task-dispatch.ts";

/**
 * What a node that ran a handed-over task offers back: only the files its worker wrote, as the worker last wrote them,
 * within the bounds on count and bytes, each stored before it is offered. What is left out is said, never dropped.
 */

let work: string;
let dataDir: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "clarkcant-offered-"));
  dataDir = mkdtempSync(join(tmpdir(), "clarkcant-offered-data-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

function hex(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A file the worker wrote, as the worker reported it. */
function written(name: string, contents: string | Buffer): TaskOutputFile {
  const path = join(work, name);
  writeFileSync(path, contents);
  return { path, sha256: hex(contents), name };
}

describe("the files a node offers back for a task it ran", () => {
  it("offers each file as the worker wrote it, stored under its digest, typed by its extension", () => {
    const notes = written("notes.md", "viết từ máy bàn\n");
    const data = written("data.json", "{}\n");
    const plain = written("log.weird", "x\n");

    const { prepared, left } = prepareDelegatedArtifacts(dataDir, [notes, data, plain]);

    expect(left).toEqual([]);
    expect(prepared).toEqual([
      { name: "notes.md", digest: `sha256:${notes.sha256}`, sizeBytes: Buffer.byteLength("viết từ máy bàn\n"), mimeType: "text/markdown" },
      { name: "data.json", digest: `sha256:${data.sha256}`, sizeBytes: 3, mimeType: "application/json" },
      { name: "log.weird", digest: `sha256:${plain.sha256}`, sizeBytes: 2, mimeType: "text/plain" },
    ]);
    const stored = blobPathForDigest({ dataDir, digest: `sha256:${notes.sha256}` });
    expect(stored).toBeDefined();
    expect(readFileSync(String(stored), "utf8")).toBe("viết từ máy bàn\n");
  });

  it("leaves out, and says so, a file changed since the worker wrote it or no longer there", () => {
    const changed = written("changed.md", "as written\n");
    writeFileSync(changed.path, "changed after\n");
    const gone: TaskOutputFile = { path: join(work, "gone.md"), sha256: hex("never here\n"), name: "gone.md" };
    const kept = written("kept.md", "kept\n");

    const { prepared, left } = prepareDelegatedArtifacts(dataDir, [changed, gone, kept]);

    expect(prepared.map((file) => file.name)).toEqual(["kept.md"]);
    expect(left).toEqual(["changed.md (đã đổi sau khi việc ghi nó)", "gone.md (không còn đọc được)"]);
    expect(blobPathForDigest({ dataDir, digest: `sha256:${hex("changed after\n")}` })).toBeUndefined();
  });

  it("offers no more files than one task may, nor a file larger than one may be", () => {
    const many = Array.from({ length: DELEGATED_ARTIFACTS_MAX + 1 }, (_, index) => written(`n${String(index)}.md`, `${String(index)}\n`));
    const large = written("large.bin", Buffer.alloc(DELEGATED_ARTIFACT_MAX_BYTES + 1, 1));

    const counted = prepareDelegatedArtifacts(dataDir, many);
    expect(counted.prepared).toHaveLength(DELEGATED_ARTIFACTS_MAX);
    expect(counted.left).toEqual([`n${String(DELEGATED_ARTIFACTS_MAX)}.md (quá ${String(DELEGATED_ARTIFACTS_MAX)} tệp)`]);

    const sized = prepareDelegatedArtifacts(dataDir, [large]);
    expect(sized.prepared).toEqual([]);
    expect(sized.left).toEqual([`large.bin (lớn hơn ${String(DELEGATED_ARTIFACT_MAX_BYTES)} byte)`]);
  });

  it("offers up to the bytes one task may offer and leaves out the file past them", () => {
    const chunk = DELEGATED_ARTIFACT_MAX_BYTES;
    const full = Array.from({ length: DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES / chunk }, (_, index) =>
      written(`part${String(index)}.bin`, Buffer.alloc(chunk, index + 1)),
    );
    const over = written("over.bin", Buffer.alloc(1, 9));

    const { prepared, left } = prepareDelegatedArtifacts(dataDir, [...full, over]);

    expect(prepared.map((file) => file.name)).toEqual(full.map((file) => file.name));
    expect(prepared.reduce((sum, file) => sum + file.sizeBytes, 0)).toBe(DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES);
    expect(left).toEqual([`over.bin (vượt ${String(DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES)} byte cho cả việc)`]);
  });
});
