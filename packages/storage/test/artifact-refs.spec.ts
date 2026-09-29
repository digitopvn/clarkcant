import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import { openDatabase, type Database } from "../src/db.ts";
import { migrate } from "../src/migrate.ts";
import {
  artifactUsageForPrincipal,
  blobStillReferenced,
  deleteArtifactsForConversation,
  extendArtifactGrant,
  getArtifact,
  getArtifactGrant,
  getBrokerArtifact,
  insertBrokerArtifact,
  listExpiredWorkingArtifacts,
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
});
