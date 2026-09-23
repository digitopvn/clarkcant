import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commandEnvelopeSchema, instantSchema, nodeIdSchema } from "@clarkcant/contracts";
import {
  acceptCommand,
  activeGrants,
  appendMessage,
  messagesSince,
  checkRestoreCompatibility,
  claimConversationAuthority,
  closeDatabase,
  createBackup,
  currentSchemaVersion,
  MIGRATIONS,
  migrate,
  type Migration,
  openDatabase,
  payloadDigest,
  peerCursor,
  putPreference,
  readPreference,
  recordInbox,
  revokeGrant,
  searchProjects,
  unsettledEffects,
  upsertEffect,
  upsertGrant,
  upsertProject,
  verifyBackup,
  type ProjectRecord,
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

/**
 * Failure injection around a backup (V18).
 *
 * A backup is written by a process that can be killed at any moment, so the interesting question is
 * not whether `createBackup` works when it finishes — the tests above cover that — but what the node
 * does with the directory an interruption leaves behind. The manifest is written last, so a kill
 * between `VACUUM INTO` and the manifest write leaves a database with no manifest, and a kill after
 * it leaves a manifest whose database was never finished. `verifyBackup` is what an operator consults
 * before restoring, so it has to answer for both rather than throw at them.
 */
describe("failure injection around a backup (V18)", () => {
  /** One finished backup, so each test can break exactly one thing about it. */
  function backupIn(): string {
    const db = openDatabase({ path: join(dir, "live.sqlite") });
    migrate(db);
    db.prepare(
      "INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)",
    ).run("conv_1", NODE_A, AT, AT);
    createBackup({ db, destination: join(dir, "snapshot"), now: () => AT });
    closeDatabase(db);
    return join(dir, "snapshot");
  }

  it("reports a backup that was interrupted before its manifest was written", () => {
    const snapshot = backupIn();
    rmSync(join(snapshot, "manifest.json"), { force: true });

    const verification = verifyBackup(snapshot);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(" ")).toMatch(/could not be read or parsed/);
  });

  it("reports a manifest whose database was never finished", () => {
    // The interruption the manifest-last ordering does not cover on its own: the write of the database
    // itself was cut short, and what is left is a manifest pointing at nothing.
    const snapshot = backupIn();
    rmSync(join(snapshot, "backup.sqlite"), { force: true });

    const verification = verifyBackup(snapshot);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(" ")).toMatch(/backup\.sqlite/);
  });

  it("reports a manifest that cannot be parsed", () => {
    const snapshot = backupIn();
    writeFileSync(join(snapshot, "manifest.json"), "{ this is not json");

    const verification = verifyBackup(snapshot);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(" ")).toMatch(/could not be read or parsed/);
  });

  it("reports a database truncated mid-write", () => {
    const snapshot = backupIn();
    const target = join(snapshot, "backup.sqlite");
    const bytes = readFileSync(target);
    writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const verification = verifyBackup(snapshot);
    expect(verification.ok).toBe(false);
    // A short file changes the digest first; if a truncation ever survived that, the integrity check
    // is the second line of defence and either answer is a refusal.
    expect(verification.problems.join(" ")).toMatch(/digest mismatch|integrity_check|could not be opened|could not be read/);
  });

  it("reports row counts that disagree with the manifest even when the bytes are intact", () => {
    const snapshot = backupIn();
    const manifestPath = join(snapshot, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { tableCounts: Record<string, number> };
    // The digest still matches the file, so only the counts disagree. A restore that trusted the
    // manifest over the database would report a row count the database does not have.
    manifest.tableCounts.conversations = 99;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const verification = verifyBackup(snapshot);
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(" ")).toMatch(/conversations restored 1 rows but the manifest recorded 99/);
  });

  it("keeps verifying over many rounds, so a leak or a drift fails here rather than later", () => {
    /*
     * Bounded on purpose. Twenty-five rounds is enough for a leaked handle to show up — each round
     * removes and rewrites the backup file, and on Windows removing a file something still holds open
     * fails — and enough for a count or a digest to drift, while staying short enough to be an
     * ordinary test rather than a soak run nobody keeps.
     */
    const snapshot = join(dir, "snapshot");
    const db = openDatabase({ path: join(dir, "live.sqlite") });
    migrate(db);
    try {
      for (let round = 0; round < 25; round += 1) {
        db.prepare(
          "INSERT INTO conversations (conversation_id, home_node_id, created_at, updated_at) VALUES (?,?,?,?)",
        ).run(`conv_${String(round)}`, NODE_A, AT, AT);

        const manifest = createBackup({ db, destination: snapshot, now: () => AT });
        expect(manifest.tableCounts.conversations).toBe(round + 1);

        const verification = verifyBackup(snapshot);
        // Every round has to stand on its own. A backup that verifies only the first time is not a
        // backup, it is a coincidence.
        expect(verification.problems).toEqual([]);
        expect(verification.tableCounts.conversations).toBe(round + 1);
      }
    } finally {
      closeDatabase(db);
    }
  });
});

/**
 * Failure injection around a migration (V18).
 *
 * The interruption this stands in for is a migration that dies partway: a killed process, a full
 * disk, or a statement that does not hold on this machine's data. The property that has to survive it
 * is the one `migrate` documents — the version number never describes a schema that is not there —
 * because the next boot reasoning from a version it never reached is worse than a stopped upgrade.
 * The list is injectable, which is what makes this testable at all.
 */
describe("failure injection around a migration (V18)", () => {
  it("leaves the schema at the last fully-applied version when a migration dies partway", () => {
    const db = openDatabase({ path: ":memory:" });
    const good: Migration = {
      version: 1,
      name: "one-table",
      reversible: true,
      up: (target) => target.exec("CREATE TABLE keeps_me (id TEXT PRIMARY KEY)"),
    };
    const broken: Migration = {
      version: 2,
      name: "half-a-table",
      reversible: false,
      up: (target) => {
        target.exec("CREATE TABLE half (id TEXT PRIMARY KEY)");
        throw new Error("the disk filled up here");
      },
    };

    expect(() => migrate(db, [good, broken])).toThrow(/the disk filled up here/);

    // The migration that finished stands...
    expect(currentSchemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'keeps_me'").get()).toBeDefined();
    // ...and the one that died left nothing behind, not even the table it managed to create first.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
    closeDatabase(db);
  });
});

describe("a stored message", () => {
  it("keeps the identity a history reader depends on", () => {
    const db = freshDb();
    const at = "2026-09-17T05:00:00.000Z";
    db.prepare(
      "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)",
    ).run("conv_meta", "node_local", at, at);
    db.prepare(
      "INSERT INTO conversations (conversation_id, title, home_node_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)",
    ).run("conv_other", "node_local", at, at);

    appendMessage(
      db,
      {
        messageId: "msg_meta",
        conversationId: "conv_meta",
        role: "assistant",
        blocks: [{ type: "text", format: "plain", content: "xin chào", streaming: false }],
        authorNodeId: "node_local",
        createdAt: at,
        delivery: "accepted",
      } as never,
      // The caller supplies the sequence, so a cursor is meaningful across a restart.
      7,
    );

    const [message] = messagesSince(db, "conv_meta" as never, 0);
    expect(message?.messageId).toBe("msg_meta");
    expect(message?.conversationId).toBe("conv_meta");
    expect(message?.role).toBe("assistant");
    expect(message?.createdAt).toBe(at);
    expect(message?.blocks).toHaveLength(1);

    const row = db.prepare("SELECT sequence, delivery FROM messages WHERE message_id = ?").get("msg_meta") as {
      sequence: number;
      delivery: string;
    };
    expect(row.sequence).toBe(7);
    expect(row.delivery).toBe("accepted");

    // Principal scope follows the conversation: another conversation never sees this message, which is
    // the property the search path relies on when it filters by principal rather than by text.
    expect(messagesSince(db, "conv_other" as never, 0)).toHaveLength(0);
    expect(messagesSince(db, "conv_meta" as never, 7)).toHaveLength(0);
  });
});

describe("a stored preference", () => {
  it("keeps what it replaced, counts the change, and scopes one choice away from another", () => {
    const db = freshDb();
    const owner = "principal-owner";
    const at = instantSchema.parse("2026-09-19T02:00:00.000Z");

    // Nobody has chosen yet, which is a different state from having chosen nothing.
    expect(readPreference(db, owner, "model", "node")).toBeUndefined();

    putPreference(db, {
      principalId: owner,
      key: "model",
      value: "deepseek/deepseek-v4-flash",
      scope: "node",
      source: "onboarding",
      at,
    });
    expect(readPreference(db, owner, "model", "node")).toBe("deepseek/deepseek-v4-flash");

    putPreference(db, {
      principalId: owner,
      key: "model",
      value: "google/gemini-3-pro",
      scope: "node",
      source: "settings",
      at,
    });
    expect(readPreference(db, owner, "model", "node")).toBe("google/gemini-3-pro");

    // What it replaced is the first question asked when a node starts behaving differently than expected.
    const row = db
      .prepare("SELECT revision, previous_value FROM preferences WHERE principal_id = ? AND key = ? AND scope = ?")
      .get(owner, "model", "node") as { revision: number; previous_value: string | null };
    expect(row.revision).toBe(2);
    expect(row.previous_value).toBe("deepseek/deepseek-v4-flash");

    // Scope is part of the key, so a conversation's choice cannot overwrite the node's.
    putPreference(db, {
      principalId: owner,
      key: "model",
      value: "google/gemini-3-flash",
      scope: "conversation-1",
      source: "settings",
      at,
    });
    expect(readPreference(db, owner, "model", "conversation-1")).toBe("google/gemini-3-flash");
    expect(readPreference(db, owner, "model", "node")).toBe("google/gemini-3-pro");
  });
});

describe("searchProjects", () => {
  function project(overrides: Partial<ProjectRecord>): ProjectRecord {
    return {
      projectId: overrides.projectId ?? "proj_default",
      nodeId: NODE_A,
      path: "/home/duy/projects/default",
      name: "default",
      aliases: [],
      gitRemote: undefined,
      markers: [],
      kind: "code",
      mtime: 0,
      lastUsedAt: undefined,
      indexedAt: AT,
      ...overrides,
    };
  }

  it("matches by name via the FTS index, joined in a single query rather than one lookup per hit", () => {
    const db = freshDb();
    upsertProject(
      db,
      project({ projectId: "proj_clarkcant", path: "/home/duy/www/clarkcant-voice", name: "clarkcant-voice" }),
    );
    upsertProject(db, project({ projectId: "proj_agentkit", path: "/home/duy/www/agentkit", name: "agentkit" }));
    // Different node: must never surface in another node's results.
    upsertProject(
      db,
      project({
        projectId: "proj_other_node",
        nodeId: NODE_B,
        path: "/home/other/clarkcant-voice",
        name: "clarkcant-voice",
      }),
    );

    const results = searchProjects(db, NODE_A, "clarkcant");
    expect(results).toHaveLength(1);
    expect(results[0]?.project.projectId).toBe("proj_clarkcant");
    expect(results[0]?.how).toBe("search");
    expect(results[0]?.score).toBeTypeOf("number");
  });

  it("prefers an exact alias match over a ranked search hit for the same project", () => {
    const db = freshDb();
    upsertProject(
      db,
      project({
        projectId: "proj_alias",
        path: "/home/duy/www/kit",
        name: "the-kit-repo",
        aliases: ["kit"],
      }),
    );

    const results = searchProjects(db, NODE_A, "kit");
    expect(results).toHaveLength(1);
    expect(results[0]?.how).toBe("alias");
    expect(results[0]?.score).toBeUndefined();
  });

  it("returns nothing for a node with no matching projects", () => {
    const db = freshDb();
    upsertProject(db, project({ projectId: "proj_clarkcant", path: "/home/duy/www/clarkcant", name: "clarkcant" }));
    expect(searchProjects(db, NODE_B, "clarkcant")).toEqual([]);
  });
});

