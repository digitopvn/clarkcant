import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commandEnvelopeSchema, instantSchema, nodeIdSchema } from "@clarkcant/contracts";
import {
  acceptCommand,
  activeGrants,
  checkRestoreCompatibility,
  claimConversationAuthority,
  closeDatabase,
  createBackup,
  currentSchemaVersion,
  MIGRATIONS,
  migrate,
  openDatabase,
  payloadDigest,
  peerCursor,
  recordInbox,
  revokeGrant,
  unsettledEffects,
  upsertEffect,
  upsertGrant,
  verifyBackup,
} from "../src/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-storage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function freshDb() {
  const db = openDatabase({ path: ":memory:" });
  migrate(db);
  return db;
}

const AT = instantSchema.parse("2026-09-16T04:00:00.000Z");
const LATER = instantSchema.parse("2026-09-16T05:00:00.000Z");
const NODE_A = nodeIdSchema.parse("node_a");
const NODE_B = nodeIdSchema.parse("node_b");

describe("migrations", () => {
  it("applies every migration and records the schema version", () => {
    const db = freshDb();
    expect(currentSchemaVersion(db)).toBe(MIGRATIONS.at(-1)?.version);
    closeDatabase(db);
  });

  it("is idempotent", () => {
    const db = freshDb();
    const second = migrate(db);
    expect(second.applied).toEqual([]);
    closeDatabase(db);
  });

  it("lists migrations in strictly increasing order", () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe("durable command acceptance (T01)", () => {
  const envelope = commandEnvelopeSchema.parse({
    schema: "agent.command",
    version: 1,
    commandId: "cmd_1",
    idempotencyKey: "idem-key-00000001",
    kind: "task.create",
    payload: { goal: "summarise the fixture file" },
    issuedAt: AT,
  });

  it("accepts a command and writes the acknowledgement in the same transaction", () => {
    const db = freshDb();
    const result = acceptCommand(db, envelope, { receivedAt: AT, nextSequence: 1 });
    expect(result.status).toBe("accepted");
    closeDatabase(db);
  });

  it("replays the original acknowledgement for a retry instead of creating a second task", () => {
    const db = freshDb();
    acceptCommand(db, envelope, { receivedAt: AT, nextSequence: 1 });
    const retry = acceptCommand(db, envelope, { receivedAt: LATER, nextSequence: 2 });
    expect(retry.status).toBe("replayed");
    if (retry.status === "replayed") {
      expect(retry.ack.acceptedSequence).toBe(1);
    }
    const rows = db.prepare("SELECT COUNT(*) AS n FROM commands").get() as { n: number };
    expect(Number(rows.n)).toBe(1);
    closeDatabase(db);
  });

  it("refuses to reuse an idempotency key for a different payload", () => {
    const db = freshDb();
    acceptCommand(db, envelope, { receivedAt: AT, nextSequence: 1 });
    const different = commandEnvelopeSchema.parse({
      ...envelope,
      commandId: "cmd_2",
      payload: { goal: "something else entirely" },
    });
    const result = acceptCommand(db, different, { receivedAt: LATER, nextSequence: 2 });
    expect(result.status).toBe("conflict");
    closeDatabase(db);
  });

  it("is independent of JSON key ordering", () => {
    expect(payloadDigest({ a: 1, b: 2 })).toBe(payloadDigest({ b: 2, a: 1 }));
    expect(payloadDigest({ a: 1 })).not.toBe(payloadDigest({ a: 2 }));
  });
});

describe("inbox deduplication (T02, T03)", () => {
  const base = {
    dedupKey: "node_b:5:msg_5",
    peerNodeId: NODE_B,
    sourceSequence: 5,
    messageId: "msg_5",
    kind: "delegate",
    responseJson: JSON.stringify({ outcome: "accepted" }),
    receivedAt: AT,
  };

  it("records a first delivery and reports a replay as a duplicate", () => {
    const db = freshDb();
    const document = { protocol: "agent.nodelink", version: 1, messageId: "msg_5" } as never;
    const first = recordInbox(db, { ...base, document });
    expect(first.status).toBe("recorded");

    const replay = recordInbox(db, {
      ...base,
      document,
      responseJson: JSON.stringify({ outcome: "would-be-different" }),
      receivedAt: LATER,
    });
    expect(replay.status).toBe("duplicate");
    if (replay.status === "duplicate") {
      // The original answer is returned, so a lost acknowledgement cannot become a
      // second execution.
      expect(replay.previousResponseJson).toBe(JSON.stringify({ outcome: "accepted" }));
    }
    closeDatabase(db);
  });

  it("advances the peer cursor so a gap can be detected", () => {
    const db = freshDb();
    recordInbox(db, { ...base, document: { protocol: "agent.nodelink" } as never });
    expect(peerCursor(db, NODE_B)).toBe(5);
    closeDatabase(db);
  });
});

describe("conversation authority (T04)", () => {
  it("refuses a second home authority for one conversation", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)",
    ).run("conv_1", NODE_A, AT, AT);

    const first = claimConversationAuthority(db, {
      conversationId: "conv_1" as never,
      homeNodeId: NODE_A,
      at: AT,
    });
    expect(first.ok).toBe(true);

    const second = claimConversationAuthority(db, {
      conversationId: "conv_1" as never,
      homeNodeId: NODE_B,
      at: LATER,
    });
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.homeNodeId).toBe(NODE_A);

    // Claiming again by the same node is a no-op rather than an error.
    expect(
      claimConversationAuthority(db, { conversationId: "conv_1" as never, homeNodeId: NODE_A, at: LATER }).ok,
    ).toBe(true);
    closeDatabase(db);
  });
});

describe("resource leases (T14)", () => {
  it("allows only one live lease per resource", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO leases (lease_id, resource_node_id, resource_id, resource_kind, epoch, acquired_at, expires_at) VALUES (?,?,?,?,?,?,?)",
    ).run("lease_1", NODE_A, "ws_main", "workspace", 1, AT, LATER);

    expect(() =>
      db
        .prepare(
          "INSERT INTO leases (lease_id, resource_node_id, resource_id, resource_kind, epoch, acquired_at, expires_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run("lease_2", NODE_A, "ws_main", "workspace", 2, AT, LATER),
    ).toThrow();

    // Releasing the first frees the slot, so a crash cannot wedge a resource forever.
    db.prepare("UPDATE leases SET released_at = ? WHERE lease_id = ?").run(AT, "lease_1");
    expect(() =>
      db
        .prepare(
          "INSERT INTO leases (lease_id, resource_node_id, resource_id, resource_kind, epoch, acquired_at, expires_at) VALUES (?,?,?,?,?,?,?)",
        )
        .run("lease_3", NODE_A, "ws_main", "workspace", 3, AT, LATER),
    ).not.toThrow();
    closeDatabase(db);
  });
});

describe("grant storage (T06)", () => {
  const grant = {
    grantId: "grant_1",
    ownerPrincipalId: "prin_owner",
    senderNodeId: NODE_A,
    receiverNodeId: NODE_B,
    capabilityRefs: ["calendar.events.list@1"],
    resources: [],
    allowedDataClasses: ["internal"],
    expiresAt: LATER,
    maxDelegationDepth: 1,
  } as never;

  it("returns a live grant and stops returning it after revocation", () => {
    const db = freshDb();
    upsertGrant(db, grant, AT);
    expect(activeGrants(db, NODE_A, AT)).toHaveLength(1);
    expect(revokeGrant(db, "grant_1", AT)).toBe(true);
    expect(activeGrants(db, NODE_A, AT)).toHaveLength(0);
    closeDatabase(db);
  });

  it("excludes a grant whose expiry has passed", () => {
    const db = freshDb();
    upsertGrant(db, grant, AT);
    expect(activeGrants(db, NODE_A, LATER)).toHaveLength(0);
    closeDatabase(db);
  });
});

describe("effect ledger persistence (T05)", () => {
  it("lists effects whose outcome is still undetermined", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)",
    ).run("conv_1", NODE_A, AT, AT);
    db.prepare(
      `INSERT INTO tasks (task_id, conversation_id, home_node_id, state, disposition, revision, goal, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("task_1", "conv_1", NODE_A, "running", "in-progress", 1, "goal", AT, AT);

    upsertEffect(db, {
      effectId: "eff_1",
      taskId: "task_1",
      executorNodeId: NODE_A,
      category: "external-write",
      capabilityRef: "calendar.events.create@1",
      externalSupportsDedup: false,
      state: "unknown",
      intent: "create the event",
      operationDigest: "sha256:aa",
      preparedAt: AT,
      submitAttempts: 1,
    } as never);

    const unsettled = unsettledEffects(db, NODE_A);
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]?.state).toBe("unknown");
    closeDatabase(db);
  });
});

describe("consistent backup and restore (T69)", () => {
  it("produces a verifiable backup with matching row counts", () => {
    const db = openDatabase({ path: join(dir, "live.sqlite") });
    migrate(db);
    db.prepare(
      "INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)",
    ).run("conv_1", NODE_A, AT, AT);

    const manifest = createBackup({
      db,
      destination: join(dir, "snapshot"),
      now: () => "2026-09-16T04:00:00.000Z",
    });
    expect(manifest.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.tableCounts.conversations).toBe(1);
    expect(manifest.vaultKeyBackedUpSeparately).toBe(true);

    const verification = verifyBackup(join(dir, "snapshot"));
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
    closeDatabase(db);
  });

  it("detects a tampered backup file", () => {
    const db = openDatabase({ path: join(dir, "live.sqlite") });
    migrate(db);
    createBackup({ db, destination: join(dir, "snapshot"), now: () => "2026-09-16T04:00:00.000Z" });
    closeDatabase(db);

    // Corrupt the copy, not the manifest.
    const target = join(dir, "snapshot", "backup.sqlite");
    const bytes = readFileSync(target);
    bytes[Math.floor(bytes.length / 2)] = 0xff;
    writeFileSync(target, bytes);

    const verification = verifyBackup(join(dir, "snapshot"));
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(" ")).toMatch(/digest mismatch|integrity_check/);
  });

  it("refuses to restore a backup taken by a newer schema", () => {
    const manifest = {
      createdAt: AT,
      schemaVersion: 99,
      digest: "sha256:aa",
      bytes: 1,
      tableCounts: {},
      migrations: [],
      vaultKeyBackedUpSeparately: true as const,
    };
    const result = checkRestoreCompatibility(manifest, 7);
    expect(result.ok).toBe(false);
  });

  it("migrates forward when the backup is older than the binary", () => {
    const manifest = {
      createdAt: AT,
      schemaVersion: 3,
      digest: "sha256:aa",
      bytes: 1,
      tableCounts: {},
      migrations: [],
      vaultKeyBackedUpSeparately: true as const,
    };
    expect(checkRestoreCompatibility(manifest, 7)).toEqual({ ok: true, action: "migrate-forward" });
  });
});
