import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Grant,
  type Instant,
  type PeerEnvelope,
  type TaskResource,
  DELEGATED_ARTIFACT_MAX_BYTES,
  DELEGATED_ARTIFACTS_MAX,
  DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES,
} from "@clarkcant/contracts";
import {
  type Database,
  closeDatabase,
  createConversation,
  getTaskArtifact,
  migrate,
  openDatabase,
  putPeerAllowance,
  putPersistentIntent,
  revokeGrant,
  upsertGrant,
  upsertTask,
} from "@clarkcant/storage";

import { blobPathForDigest } from "../src/blobs.ts";
import { prepareDelegatedArtifacts, receiveArtifactOffer, returnableFileBytes } from "../src/delegated-artifacts.ts";
import { taskGrant } from "../src/delegation.ts";
import { type TaskOutputFile, grantedOutputs } from "../src/task-dispatch.ts";

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

    const { prepared, left } = prepareDelegatedArtifacts(dataDir, [notes, data, plain], DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES);

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

  it("types tab-separated files by either extension the file contracts accept", () => {
    const tsv = written("bang.tsv", "a\tb\n");
    const tab = written("bang.tab", "a\tb\n");

    const { prepared } = prepareDelegatedArtifacts(dataDir, [tsv, tab], DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES);

    expect(prepared.map((file) => [file.name, file.mimeType])).toEqual([
      ["bang.tsv", "text/tab-separated-values"],
      ["bang.tab", "text/tab-separated-values"],
    ]);
  });

  it("leaves out, and says so, a file changed since the worker wrote it or no longer there", () => {
    const changed = written("changed.md", "as written\n");
    writeFileSync(changed.path, "changed after\n");
    const gone: TaskOutputFile = { path: join(work, "gone.md"), sha256: hex("never here\n"), name: "gone.md" };
    const kept = written("kept.md", "kept\n");

    const { prepared, left } = prepareDelegatedArtifacts(dataDir, [changed, gone, kept], DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES);

    expect(prepared.map((file) => file.name)).toEqual(["kept.md"]);
    expect(left).toEqual(["changed.md (đã đổi sau khi việc ghi nó)", "gone.md (không còn đọc được)"]);
    expect(blobPathForDigest({ dataDir, digest: `sha256:${hex("changed after\n")}` })).toBeUndefined();
  });

  it("offers no more files than one task may, nor a file larger than one may be", () => {
    const many = Array.from({ length: DELEGATED_ARTIFACTS_MAX + 1 }, (_, index) => written(`n${String(index)}.md`, `${String(index)}\n`));
    const large = written("large.bin", Buffer.alloc(DELEGATED_ARTIFACT_MAX_BYTES + 1, 1));

    const counted = prepareDelegatedArtifacts(dataDir, many, DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES);
    expect(counted.prepared).toHaveLength(DELEGATED_ARTIFACTS_MAX);
    expect(counted.left).toEqual([`n${String(DELEGATED_ARTIFACTS_MAX)}.md (quá ${String(DELEGATED_ARTIFACTS_MAX)} tệp)`]);

    const sized = prepareDelegatedArtifacts(dataDir, [large], DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES);
    expect(sized.prepared).toEqual([]);
    expect(sized.left).toEqual([`large.bin (lớn hơn ${String(DELEGATED_ARTIFACT_MAX_BYTES)} byte)`]);
  });

  it("offers up to the bytes one task may offer and leaves out the file past them", () => {
    const chunk = DELEGATED_ARTIFACT_MAX_BYTES;
    const full = Array.from({ length: DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES / chunk }, (_, index) =>
      written(`part${String(index)}.bin`, Buffer.alloc(chunk, index + 1)),
    );
    const over = written("over.bin", Buffer.alloc(1, 9));

    const { prepared, left } = prepareDelegatedArtifacts(dataDir, [...full, over], DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES);

    expect(prepared.map((file) => file.name)).toEqual(full.map((file) => file.name));
    expect(prepared.reduce((sum, file) => sum + file.sizeBytes, 0)).toBe(DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES);
    expect(left).toEqual([`over.bin (vượt ${String(DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES)} byte cho cả việc)`]);
  });

  it("stores nothing past the bytes this run may send back, which the other node would refuse", () => {
    const first = written("first.md", "12345\n");
    const second = written("second.md", "67890\n");

    const { prepared, left } = prepareDelegatedArtifacts(dataDir, [first, second], 8);

    expect(prepared.map((file) => file.name)).toEqual(["first.md"]);
    expect(left).toEqual(["second.md (vượt 8 byte cho cả việc)"]);
    expect(blobPathForDigest({ dataDir, digest: `sha256:${second.sha256}` })).toBeUndefined();
  });

  it("never offers, nor stores, a markup or script file, which the other node would refuse", () => {
    const page = written("page.html", "<script>alert(1)</script>\n");
    const shortPage = written("old.HTM", "<p>x</p>\n");
    const xhtml = written("doc.xhtml", "<html/>\n");
    const drawing = written("logo.svg", "<svg/>\n");
    const script = written("run.js", "alert(1)\n");
    const module = written("run.mjs", "export {}\n");
    const kept = written("notes.md", "kept\n");

    const { prepared, left } = prepareDelegatedArtifacts(
      dataDir,
      [page, shortPage, xhtml, drawing, script, module, kept],
      DELEGATED_ARTIFACTS_MAX_TOTAL_BYTES,
    );

    expect(prepared.map((file) => file.name)).toEqual(["notes.md"]);
    expect(left).toEqual([
      "page.html (loại text/html không được gửi về)",
      "old.HTM (loại text/html không được gửi về)",
      "doc.xhtml (loại application/xhtml+xml không được gửi về)",
      "logo.svg (loại image/svg+xml không được gửi về)",
      "run.js (loại text/javascript không được gửi về)",
      "run.mjs (loại text/javascript không được gửi về)",
    ]);
    for (const refused of [page, shortPage, xhtml, drawing, script, module]) {
      expect(blobPathForDigest({ dataDir, digest: `sha256:${refused.sha256}` })).toBeUndefined();
    }
  });
});

describe("the files a worker reports writing", () => {
  it("keeps only those inside a folder the task was given, named as they are there", () => {
    const granted = mkdtempSync(join(tmpdir(), "clarkcant-granted-"));
    try {
      const inside = { path: join(granted, "sub", "notes.md"), sha256: hex("a") };
      const outside = { path: join(work, "secret.md"), sha256: hex("b") };
      const beside = { path: `${granted}-sibling${join("/", "x.md")}`, sha256: hex("c") };
      const root = { path: granted, sha256: hex("d") };

      expect(grantedOutputs([inside, outside, beside, root], [granted])).toEqual([{ ...inside, name: "sub/notes.md" }]);
      expect(grantedOutputs([outside], [])).toEqual([]);
    } finally {
      rmSync(granted, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * Decided against both owners' grants
 * ------------------------------------------------------------------ */

const HOME = "node_home";
const PEER = "node_peer";
const OTHER = "node_other";
const OWNER = "prin_owner";
const AT = "2026-09-30T08:00:00.000Z" as Instant;
const LATER = "2026-10-30T08:00:00.000Z" as Instant;
const DIGEST = `sha256:${"a".repeat(64)}`;

function freshDb(): Database {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  createConversation(db, { conversationId: "conv_1", homeNodeId: HOME, at: AT });
  return db;
}

function grantFor(input: { grantId: string; sender: string; receiver: string; maxArtifactBytes?: number }): Grant {
  const resources: TaskResource[] = [{ kind: "folder", path: work, access: "write" }];
  const built = taskGrant({
    grantId: input.grantId,
    ownerPrincipalId: OWNER,
    senderNodeId: input.sender,
    receiverNodeId: input.receiver,
    resources,
    allowedCategories: ["read"],
    expiresAt: LATER,
    ...(input.maxArtifactBytes === undefined ? {} : { maxArtifactBytes: input.maxArtifactBytes }),
  });
  if (!built.ok) throw new Error(built.message);
  return built.grant;
}

describe("the files a node takes back for a task it handed over", () => {
  let db: Database;

  /** A task this node's automation handed to PEER, still running there, under a grant allowing `maxArtifactBytes`. */
  beforeEach(() => {
    db = freshDb();
    const resources: TaskResource[] = [{ kind: "folder", path: work, access: "write" }];
    upsertGrant(db, grantFor({ grantId: "grt_1", sender: HOME, receiver: PEER, maxArtifactBytes: 1024 }), AT);
    putPersistentIntent(db, {
      intentId: "int_1",
      principalId: OWNER,
      conversationId: "conv_1",
      summary: "ghi chú trên máy khác",
      when: { topic: "note.created" },
      match: [],
      do: { kind: "task", goal: "ghi chú", resources, allowedCategories: ["read"], executor: PEER, grantId: "grt_1" },
      state: "active",
      allowSelfTriggered: false,
      revision: 0,
      createdAt: AT,
      updatedAt: AT,
    });
    upsertTask(db, {
      taskId: "task_1",
      conversationId: "conv_1",
      homeNodeId: HOME,
      executionNodeId: PEER,
      state: "running",
      revision: 0,
      goal: "ghi chú",
      origin: { kind: "persistent", principalId: OWNER, intentId: "int_1", triggerSignalId: "sig_1", allowedCategories: ["read"] },
      resources,
      createdAt: AT,
      updatedAt: AT,
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  function deps(now: Instant = AT) {
    return { db, identity: { nodeId: HOME, ownerPrincipalId: OWNER }, now: () => now };
  }

  function offer(artifactId: string, overrides: { sender?: string; originNodeId?: string; mimeType?: string; sizeBytes?: number } = {}): PeerEnvelope {
    return {
      protocol: "agent.nodelink",
      version: 1,
      messageId: `msg_${artifactId}`,
      correlationId: "task_1",
      senderNodeId: overrides.sender ?? PEER,
      recipientNodeId: HOME,
      kind: "artifact.offer",
      taskId: "task_1",
      sourceSequence: 1,
      sentAt: AT,
      payload: {
        artifact: {
          artifactId,
          digest: DIGEST,
          sizeBytes: overrides.sizeBytes ?? 10,
          mimeType: overrides.mimeType ?? "text/markdown",
          classification: "internal",
          originNodeId: overrides.originNodeId ?? PEER,
        },
        name: `${artifactId}.md`,
      },
    } as PeerEnvelope;
  }

  it("takes a file the node it handed the task to offers, within its owner's grant", () => {
    expect(receiveArtifactOffer(deps(), offer("art_ok"))).toEqual({ accepted: true, artifactId: "art_ok" });
    expect(getTaskArtifact(db, "task_1", "received", "art_ok")?.state).toBe("accepted");
  });

  it("refuses a file from a node the task was not handed to", () => {
    const outcome = receiveArtifactOffer(deps(), offer("art_other", { sender: OTHER, originNodeId: OTHER }));

    expect(outcome).toEqual({ accepted: false, reason: "this node handed that peer no such task" });
    expect(getTaskArtifact(db, "task_1", "received", "art_other")).toBeUndefined();
  });

  it("refuses a file the offer says came from another node", () => {
    const outcome = receiveArtifactOffer(deps(), offer("art_relayed", { originNodeId: OTHER }));

    expect(outcome).toEqual({ accepted: false, reason: "the file does not come from the node that ran the task" });
    expect(getTaskArtifact(db, "task_1", "received", "art_relayed")?.state).toBe("refused");
  });

  it("refuses a file once the grant the task went under is withdrawn or has run out", () => {
    const expired = receiveArtifactOffer(deps(LATER), offer("art_late"));
    expect(expired).toEqual({ accepted: false, reason: "the grant that task went under is no longer live" });

    revokeGrant(db, "grt_1", AT);
    const revoked = receiveArtifactOffer(deps(), offer("art_revoked"));
    expect(revoked).toEqual({ accepted: false, reason: "the grant that task went under is no longer live" });
    expect(getTaskArtifact(db, "task_1", "received", "art_revoked")?.state).toBe("refused");
  });

  it("refuses a type outside the ones it takes, and markup however it is spelled", () => {
    for (const [artifactId, mimeType] of [
      ["art_audio", "audio/mpeg"],
      ["art_page", "Text/HTML; charset=utf-8"],
      ["art_xhtml", "application/xhtml+xml"],
      ["art_script", "text/javascript"],
    ] as const) {
      expect(receiveArtifactOffer(deps(), offer(artifactId, { mimeType }))).toEqual({
        accepted: false,
        reason: `mime type ${mimeType} is not permitted`,
      });
    }
  });

  it("refuses a file past the count one task may bring back", () => {
    for (let index = 0; index < DELEGATED_ARTIFACTS_MAX; index += 1) {
      expect(receiveArtifactOffer(deps(), offer(`art_${String(index)}`, { sizeBytes: 1 })).accepted).toBe(true);
    }

    expect(receiveArtifactOffer(deps(), offer("art_one_more", { sizeBytes: 1 }))).toEqual({
      accepted: false,
      reason: `the task already brought back ${String(DELEGATED_ARTIFACTS_MAX)} files`,
    });
  });
});

describe("the bytes a node sends back for a task a peer handed it", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  /** A task PEER handed to this node (HOME) under a grant that asks for `asked` bytes, with this owner's allowance. */
  function handedHere(asked: number | undefined, allowed: number | undefined | "none") {
    upsertGrant(db, grantFor({ grantId: "grt_in", sender: PEER, receiver: HOME, ...(asked === undefined ? {} : { maxArtifactBytes: asked }) }), AT);
    if (allowed !== "none") {
      putPeerAllowance(db, {
        peerNodeId: PEER,
        ownerPrincipalId: OWNER,
        conversationId: "conv_1",
        grant: grantFor({ grantId: "alw_1", sender: PEER, receiver: HOME, ...(allowed === undefined ? {} : { maxArtifactBytes: allowed }) }),
        at: AT,
      });
    }
    return {
      taskId: "task_in",
      conversationId: "conv_1",
      homeNodeId: PEER,
      executionNodeId: HOME,
      state: "succeeded" as const,
      revision: 0,
      goal: "ghi chú",
      origin: { kind: "delegated" as const, principalId: OWNER, peerNodeId: PEER, delegationId: "grt_in", allowedCategories: ["read" as const] },
      createdAt: AT,
      updatedAt: AT,
    };
  }

  it("sends back no more than both owners allowed, the smaller of the two", () => {
    expect(returnableFileBytes(db, handedHere(1024, 512), AT)).toEqual({ asked: true, bytes: 512 });
  });

  it("sends nothing when this node's owner let no files go back, and says the peer asked", () => {
    expect(returnableFileBytes(db, handedHere(1024, undefined), AT)).toEqual({ asked: true, bytes: 0 });
  });

  it("sends nothing without a live allowance from this node's owner", () => {
    expect(returnableFileBytes(db, handedHere(1024, "none"), AT)).toEqual({ asked: true, bytes: 0 });
  });

  it("sends nothing to a peer that asked for no files", () => {
    expect(returnableFileBytes(db, handedHere(undefined, 4096), AT)).toEqual({ asked: false, bytes: 0 });
  });

  it("sends nothing once the grant the task came under is withdrawn or has run out", () => {
    const task = handedHere(1024, 4096);
    expect(returnableFileBytes(db, task, LATER)).toEqual({ asked: false, bytes: 0 });
    revokeGrant(db, "grt_in", AT);
    expect(returnableFileBytes(db, task, AT)).toEqual({ asked: false, bytes: 0 });
  });
});
