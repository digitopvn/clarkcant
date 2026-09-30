import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import { openDatabase, type Database } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import {
  artifactUsageForInstance,
  artifactUsageForPrincipal,
  BLOB_IN_CONVERSATION_MESSAGES_SQL,
  blobStillReferenced,
  deleteArtifactsForConversation,
  extendArtifactGrant,
  getArtifact,
  getArtifactGrant,
  getBrokerArtifact,
  insertBrokerArtifact,
  instanceIsInConversation,
  listExpiredWorkingArtifacts,
  liveStagingRefs,
  putArtifactGrant,
  recordWorkingArtifactWrite,
  revokeArtifactGrant,
  sealWorkingArtifact,
  upsertArtifact,
} from "../src/repositories/index.ts";

/**
 * The artifact store a widget reaches by ref.
 *
 * Migration 38 extends the table peers already write to, so the tests hold both properties that follow: a peer's
 * artifact stays readable by the peer path and invisible to the broker, and a broker artifact's grants, expiry and
 * retention behave as the contract says.
 */
let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-artifact-refs-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const T0 = "2026-09-30T10:00:00.000Z" as Instant;
const T1 = "2026-09-30T11:00:00.000Z" as Instant;
const T2 = "2026-09-30T12:00:00.000Z" as Instant;

function working(overrides: Partial<Parameters<typeof insertBrokerArtifact>[1]> = {}): void {
  insertBrokerArtifact(db, {
    artifactId: "art_w1",
    ownerPrincipalId: "prn_me",
    kind: "working",
    state: "writable",
    conversationId: "conv_1",
    instanceId: "winst_1",
    name: "draft.md",
    mimeType: "text/markdown",
    sizeBytes: 0,
    digest: undefined,
    blobPath: undefined,
    stagingRef: "art_w1.part",
    createdAt: T0,
    expiresAt: T1,
    originNodeId: "node_1",
    ...overrides,
  });
}

describe("broker artifacts", () => {
  it("stores a working artifact without a digest or a blob, and seals it once", () => {
    working();
    expect(getBrokerArtifact(db, "art_w1")).toMatchObject({ kind: "working", state: "writable", digest: undefined, stagingRef: "art_w1.part" });

    recordWorkingArtifactWrite(db, { artifactId: "art_w1", sizeBytes: 12, expiresAt: T2 });
    expect(getBrokerArtifact(db, "art_w1")).toMatchObject({ sizeBytes: 12, expiresAt: T2 });

    const digest = `sha256:${"b".repeat(64)}`;
    expect(sealWorkingArtifact(db, { artifactId: "art_w1", digest, blobPath: "/data/blobs/x.md", sizeBytes: 12, mimeType: "text/markdown" })).toBe(true);
    expect(getBrokerArtifact(db, "art_w1")).toMatchObject({
      kind: "finalized",
      state: "sealed",
      digest,
      stagingRef: undefined,
      expiresAt: undefined,
    });
    // Sealed bytes are not sealed twice, and are not written.
    expect(sealWorkingArtifact(db, { artifactId: "art_w1", digest, blobPath: "/data/blobs/y.md", sizeBytes: 1, mimeType: "text/plain" })).toBe(false);
    recordWorkingArtifactWrite(db, { artifactId: "art_w1", sizeBytes: 99, expiresAt: T2 });
    expect(getBrokerArtifact(db, "art_w1")?.sizeBytes).toBe(12);
  });

  it("keeps a peer's artifact out of the broker's reach, and the peer path still reads it", () => {
    upsertArtifact(db, {
      artifactId: "art_peer",
      digest: `sha256:${"c".repeat(64)}`,
      sizeBytes: 3,
      mimeType: "text/plain",
      classification: "private",
      originNodeId: "node_2",
      createdAt: T0,
    });
    expect(getBrokerArtifact(db, "art_peer")).toBeUndefined();
    expect(getArtifact(db, "art_peer")?.sizeBytes).toBe(3);
    expect(artifactUsageForPrincipal(db, "prn_me")).toBe(0);
  });

  it("counts a principal's artifact bytes and nobody else's", () => {
    working({ sizeBytes: 40 });
    working({ artifactId: "art_w2", ownerPrincipalId: "prn_other", sizeBytes: 7, stagingRef: "art_w2.part" });
    expect(artifactUsageForPrincipal(db, "prn_me")).toBe(40);
  });

  it("counts one instance's artifact bytes, so one widget cannot fill the principal's quota", () => {
    working({ sizeBytes: 40 });
    working({ artifactId: "art_w2", sizeBytes: 2, stagingRef: "art_w2.part" });
    working({ artifactId: "art_w3", instanceId: "winst_2", sizeBytes: 7, stagingRef: "art_w3.part" });
    expect(artifactUsageForInstance(db, "winst_1")).toBe(42);
    expect(artifactUsageForInstance(db, "winst_2")).toBe(7);
    expect(artifactUsageForInstance(db, "winst_none")).toBe(0);
  });

  it("names the staging files a writable artifact still points at, and no sealed one", () => {
    working();
    working({ artifactId: "art_w2", stagingRef: "art_w2.part" });
    working({
      artifactId: "art_f1",
      kind: "finalized",
      state: "sealed",
      digest: `sha256:${"d".repeat(64)}`,
      blobPath: "/data/blobs/ddd.md",
      stagingRef: undefined,
      expiresAt: undefined,
    });
    expect([...liveStagingRefs(db)].sort()).toEqual(["art_w1.part", "art_w2.part"]);
  });

  it("lists working artifacts past their expiry, and not finalized ones", () => {
    working();
    working({ artifactId: "art_w2", expiresAt: T2, stagingRef: "art_w2.part" });
    expect(listExpiredWorkingArtifacts(db, T1).map((row) => row.artifactId)).toEqual(["art_w1"]);
  });
});

describe("grants", () => {
  it("is per instance, expires, extends and revokes", () => {
    working();
    putArtifactGrant(db, { artifactId: "art_w1", instanceId: "winst_1", principalId: "prn_me", access: "write", createdAt: T0, expiresAt: T1 });
    expect(getArtifactGrant(db, "art_w1", "winst_1")).toEqual({ instanceId: "winst_1", principalId: "prn_me", access: "write", expiresAt: T1 });
    expect(getArtifactGrant(db, "art_w1", "winst_2")).toBeUndefined();

    extendArtifactGrant(db, { artifactId: "art_w1", instanceId: "winst_1", expiresAt: T2 });
    expect(getArtifactGrant(db, "art_w1", "winst_1")?.expiresAt).toBe(T2);

    expect(revokeArtifactGrant(db, { artifactId: "art_w1", instanceId: "winst_1", at: T1 })).toBe(true);
    expect(getArtifactGrant(db, "art_w1", "winst_1")?.revokedAt).toBe(T1);
    // Revoked stays revoked: extending does not revive it, and a second revoke has nothing to do.
    extendArtifactGrant(db, { artifactId: "art_w1", instanceId: "winst_1", expiresAt: T2 });
    expect(getArtifactGrant(db, "art_w1", "winst_1")?.revokedAt).toBe(T1);
    expect(revokeArtifactGrant(db, { artifactId: "art_w1", instanceId: "winst_1", at: T2 })).toBe(false);
  });
});

describe("retention", () => {
  it("removes a conversation's artifacts and their grants, and reports where the bytes were", () => {
    working();
    working({
      artifactId: "art_f1",
      kind: "finalized",
      state: "sealed",
      digest: `sha256:${"d".repeat(64)}`,
      blobPath: "/data/blobs/ddd.md",
      stagingRef: undefined,
      expiresAt: undefined,
    });
    working({ artifactId: "art_other", conversationId: "conv_2", stagingRef: "art_other.part" });
    putArtifactGrant(db, { artifactId: "art_f1", instanceId: "winst_1", principalId: "prn_me", access: "read", createdAt: T0, expiresAt: T1 });

    const released = deleteArtifactsForConversation(db, "conv_1");
    expect(released).toEqual({ removed: 2, blobPaths: ["/data/blobs/ddd.md"], stagingRefs: ["art_w1.part"] });
    expect(getBrokerArtifact(db, "art_f1")).toBeUndefined();
    expect(getArtifactGrant(db, "art_f1", "winst_1")).toBeUndefined();
    expect(getBrokerArtifact(db, "art_other")).toBeDefined();
  });

  it("knows when a content-addressed blob is still someone else's", () => {
    working({
      artifactId: "art_f1",
      kind: "finalized",
      state: "sealed",
      digest: `sha256:${"e".repeat(64)}`,
      blobPath: "C:\\data\\blobs\\eee.txt",
      stagingRef: undefined,
      expiresAt: undefined,
    });
    expect(blobStillReferenced(db, "C:\\data\\blobs\\eee.txt")).toBe(true);
    // The same content address written with other separators is the same file.
    expect(blobStillReferenced(db, "/elsewhere/blobs/eee.txt")).toBe(true);
    expect(blobStillReferenced(db, "/data/blobs/fff.txt")).toBe(false);
  });

  /*
   * Every writer of the content-addressed store, each on its own: one that is missed here is one whose file a release
   * elsewhere deletes from under it.
   */
  describe("asks every writer of the store, by digest as well as by path", () => {
    const hex = "0123456789abcdef".repeat(4);
    const blobPath = `/data/blobs/${hex.slice(0, 32)}.png`;

    beforeEach(() => {
      db.prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES ('conv_1', 't', 'node_1', ?, ?)").run(T0, T0);
    });

    it("finds nothing when no writer holds the bytes", () => {
      expect(blobStillReferenced(db, blobPath)).toBe(false);
    });

    it("an attachment, by its sha256 when its path is another build's", () => {
      db.prepare(
        `INSERT INTO attachments (attachment_id, principal_id, conversation_id, filename, mime, kind, size_bytes, sha256, blob_path, created_at)
         VALUES ('att_1', 'prn_me', 'conv_1', 'a.png', 'image/png', 'image', 3, ?, '/old/place/renamed.png', ?)`,
      ).run(`sha256:${hex}`, T0);
      expect(blobStillReferenced(db, blobPath)).toBe(true);
    });

    it("an image the person imported into a mini-app", () => {
      db.prepare(
        `INSERT INTO local_images (image_id, owner_principal_id, node_id, artifact_id, mime_type, byte_size, digest, alt_text, blob_path, created_at)
         VALUES ('img_1', 'prn_me', 'node_1', 'art_img', 'image/png', 3, ?, 'anh', '/elsewhere/x.png', ?)`,
      ).run(`sha256:${hex}`, T0);
      expect(blobStillReferenced(db, blobPath)).toBe(true);
    });

    it("an imported image by its path, when its file name carries no digest to match", () => {
      db.prepare(
        `INSERT INTO local_images (image_id, owner_principal_id, node_id, artifact_id, mime_type, byte_size, digest, alt_text, blob_path, created_at)
         VALUES ('img_2', 'prn_me', 'node_1', 'art_img2', 'image/png', 3, ?, 'anh', 'C:\\old\\blobs\\anh-cu.png', ?)`,
      ).run(`sha256:${"f".repeat(64)}`, T0);
      expect(blobStillReferenced(db, "/data/blobs/anh-cu.png")).toBe(true);
      expect(blobStillReferenced(db, "/data/blobs/anh-khac.png")).toBe(false);
    });

    it("a file a delegated task offered back, which has no path column at all", () => {
      db.prepare(
        `INSERT INTO task_artifacts (task_id, direction, peer_artifact_id, peer_node_id, name, digest, size_bytes, mime_type, state, created_at, updated_at)
         VALUES ('task_1', 'offered', 'art_p', 'node_2', 'out.png', ?, 3, 'image/png', 'offered', ?, ?)`,
      ).run(`sha256:${hex}`, T0, T0);
      expect(blobStillReferenced(db, blobPath)).toBe(true);
    });

    it("a peer's received artifact, recorded by digest only", () => {
      upsertArtifact(db, {
        artifactId: "art_peer",
        digest: `sha256:${hex}`,
        sizeBytes: 3,
        mimeType: "image/png",
        classification: "private",
        originNodeId: "node_2",
        createdAt: T0,
      });
      expect(blobStillReferenced(db, blobPath)).toBe(true);
    });

    it("evidence that recorded the bytes' digest", () => {
      db.prepare(
        `INSERT INTO evidence (evidence_id, run_id, kind, verdict, summary, ref, digest, observed_at)
         VALUES ('ev_1', NULL, 'screenshot', 'pass', 'frame', NULL, ?, ?)`,
      ).run(`sha256:${hex}`, T0);
      expect(blobStillReferenced(db, blobPath)).toBe(true);
    });

    it("a session card that kept a captured frame in its message", () => {
      db.prepare(
        `INSERT INTO messages (message_id, conversation_id, role, author_node_id, task_id, delivery, document, sequence, created_at)
         VALUES ('msg_1', 'conv_1', 'assistant', 'node_1', NULL, 'delivered', ?, 1, ?)`,
      ).run(JSON.stringify({ blocks: [{ type: "session", previewFrame: { digest: `sha256:${hex}` } }] }), T0);
      expect(blobStillReferenced(db, blobPath)).toBe(true);
    });

    it("reads messages only for a picture, the only kind of file a captured frame is stored as", () => {
      db.prepare(
        `INSERT INTO messages (message_id, conversation_id, role, author_node_id, task_id, delivery, document, sequence, created_at)
         VALUES ('msg_1', 'conv_1', 'assistant', 'node_1', NULL, 'delivered', ?, 1, ?)`,
      ).run(JSON.stringify({ blocks: [{ type: "session", previewFrame: { digest: `sha256:${hex}` } }] }), T0);
      expect(blobStillReferenced(db, `/data/blobs/${hex.slice(0, 32)}.jpg`)).toBe(true);
      // Text, a PDF: no frame is ever stored as one, so the transcript is not read for it.
      expect(blobStillReferenced(db, `/data/blobs/${hex.slice(0, 32)}.txt`)).toBe(false);
      expect(blobStillReferenced(db, `/data/blobs/${hex.slice(0, 32)}.pdf`)).toBe(false);
    });

    it("reads only the conversation it is told to, through its index, when a widget lets go of its own file", () => {
      db.prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES ('conv_2', 't', 'node_1', ?, ?)").run(T0, T0);
      db.prepare(
        `INSERT INTO messages (message_id, conversation_id, role, author_node_id, task_id, delivery, document, sequence, created_at)
         VALUES ('msg_1', 'conv_1', 'assistant', 'node_1', NULL, 'delivered', ?, 1, ?)`,
      ).run(JSON.stringify({ blocks: [{ type: "session", previewFrame: { digest: `sha256:${hex}` } }] }), T0);
      expect(blobStillReferenced(db, blobPath, { messagesOf: "conv_1" })).toBe(true);
      expect(blobStillReferenced(db, blobPath, { messagesOf: "conv_2" })).toBe(false);
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${BLOB_IN_CONVERSATION_MESSAGES_SQL}`)
        .all("conv_2", hex.slice(0, 32)) as { detail: string }[];
      expect(plan.map((row) => row.detail).join(" ")).toMatch(/SEARCH messages USING (COVERING )?INDEX idx_messages_conversation/u);
    });
  });
});

describe("which conversation holds an instance", () => {
  beforeEach(() => {
    for (const id of ["conv_1", "conv_2"]) {
      db.prepare("INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, 't', 'node_1', ?, ?)").run(id, T0, T0);
    }
    for (const id of ["winst_1", "winst_2", "winst_3"]) {
      db.prepare(
        `INSERT INTO widget_instances (instance_id, definition_id, definition_version, package_digest, owner_node_id, owner_principal_id,
           revision, presentation_revision, data_revision, action_binding_revision, lifecycle, document, updated_at)
         VALUES (?, 'def', '1.0.0', 'sha256:x', 'node_1', 'prn_me', 1, 1, 1, 1, 'active', '{}', ?)`,
      ).run(id, T0);
    }
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, role, author_node_id, task_id, delivery, document, sequence, created_at)
       VALUES ('msg_1', 'conv_1', 'assistant', 'node_1', NULL, 'delivered', '{}', 1, ?)`,
    ).run(T0);
    db.prepare(
      `INSERT INTO widget_snapshots (snapshot_id, instance_id, message_id, captured_revision, captured_at, stale, document)
       VALUES ('snap_1', 'winst_1', 'msg_1', 1, ?, 0, '{}')`,
    ).run(T0);
    db.prepare(
      `INSERT INTO pins (pin_id, conversation_id, instance_id, display_mode, position, refresh_policy, created_at)
       VALUES ('pin_1', 'conv_2', 'winst_2', 'compact', 0, 'manual', ?)`,
    ).run(T0);
  });

  it("through the message that placed it, or the pin that keeps it open, and nowhere else", () => {
    expect(instanceIsInConversation(db, { conversationId: "conv_1", instanceId: "winst_1" })).toBe(true);
    expect(instanceIsInConversation(db, { conversationId: "conv_2", instanceId: "winst_2" })).toBe(true);
    // A real instance and a real conversation that do not belong together.
    expect(instanceIsInConversation(db, { conversationId: "conv_2", instanceId: "winst_1" })).toBe(false);
    expect(instanceIsInConversation(db, { conversationId: "conv_1", instanceId: "winst_2" })).toBe(false);
    expect(instanceIsInConversation(db, { conversationId: "conv_1", instanceId: "winst_3" })).toBe(false);
  });
});
