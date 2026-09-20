import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConversation, createPin, migrate, openDatabase, upsertProject, type Database } from "@clarkcant/storage";

import { rememberMemory } from "../src/memory.ts";
import { buildSuggestions } from "../src/suggestions.ts";

/**
 * What the node offers when somebody opens the app.
 *
 * These are properties rather than a snapshot of the ranking. The two that matter most are negative: a node with
 * nothing in it suggests nothing rather than inventing something, and two offers never point at the same record,
 * because a first screen with the same thing twice is worse than a shorter one.
 */

const NODE = "node_test";
const PRINCIPAL = "prin_test";
const NOW = "2026-09-19T12:00:00.000Z";

let db: Database;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "cc-suggestions-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
});

afterEach(() => {
  db.close();
});

function suggest(): ReturnType<typeof buildSuggestions> {
  return buildSuggestions({ db, nodeId: NODE, now: () => NOW, principalId: PRINCIPAL });
}

/**
 * A widget instance row, so a pin has something to point at.
 *
 * Inserted directly because creating an instance properly goes through the widget service and a conversation,
 * which is a lot of machinery for a fixture whose only job is to satisfy a foreign key.
 */
function widgetInstance(instanceId: string): void {
  db.prepare(
    `INSERT INTO widget_instances
       (instance_id, definition_id, definition_version, package_digest, owner_node_id, owner_principal_id,
        revision, presentation_revision, data_revision, action_binding_revision, lifecycle, document, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    instanceId,
    "canvas.overview@1",
    "1.0.0",
    "sha256:fixture",
    NODE,
    "prin_test",
    1,
    1,
    1,
    1,
    "active",
    "{}",
    NOW,
  );
}

function conversation(conversationId: string, at = NOW): void {
  createConversation(db, { conversationId, homeNodeId: NODE, at: at as never });
}

/**
 * A project row, with the fields the insert actually binds.
 *
 * `aliases` and `markers` are JSON strings rather than arrays because that is what the column holds, and the cast
 * is confined to this one helper: writing these inline in each test hid the difference until SQLite refused the
 * bind, which is how the shape was learned rather than assumed.
 */
function project(projectId: string, name: string): Parameters<typeof upsertProject>[1] {
  return {
    projectId,
    nodeId: NODE,
    path: `/tmp/${name}`,
    name,
    aliases: [],
    gitRemote: null,
    markers: "[]",
    kind: "repo",
    mtime: 0,
    lastUsedAt: NOW,
    indexedAt: NOW,
  } as never;
}

describe("a node with nothing to remember", () => {
  it("suggests nothing rather than inventing something", () => {
    expect(suggest()).toEqual([]);
  });
});

describe("a node with records", () => {
  it("offers something it was asked to remember, and says that is where it came from", () => {
    conversation("conv_one");
    const remembered = rememberMemory(
      { db, now: () => NOW, newId: (prefix) => `${prefix}_one` },
      {
        principalId: PRINCIPAL,
        conversationId: "conv_one",
        kind: "preference",
        scope: "node",
        text: "người dùng thích câu trả lời ngắn",
      },
    );
    if (!("memoryId" in remembered)) throw new Error(`the write was refused: ${remembered.refused}`);

    const offered = suggest().filter((item) => item.source === "memory");
    expect(offered).toHaveLength(1);
    // The chip points at the record the Memory tab lists, so it can be opened there and deleted from there. An
    // offer nobody could open would be the hidden memory this feature exists to avoid.
    expect(offered[0]?.ref).toBe(remembered.memoryId);
    expect(offered[0]?.label).toContain("câu trả lời ngắn");
    expect(offered[0]?.sourceLabel).toContain("bạn đã ghi nhớ");
  });

  it("offers the latest session, and says that is what it is", () => {
    conversation("conv_one");

    const offered = suggest();
    const session = offered.find((item) => item.source === "conversation");
    expect(session).toBeDefined();
    expect(session?.ref).toBe("conv_one");
    // No time word on this one: the conversation list carries no instant, and a guessed one would be a lie the
    // person can check.
    expect(session?.sourceLabel).toBe("phiên gần nhất");
  });

  it("offers something that was pinned, in the words for having pinned it", () => {
    conversation("conv_one");
    // The widget instance the pin points at, because the pin's foreign key is real and a fixture that skipped it
    // would be testing a database this application never has.
    widgetInstance("winst_one");
    createPin(db, {
      pinId: "pin_one",
      conversationId: "conv_one",
      instanceId: "winst_one",
      displayMode: "expanded",
      position: 0,
      refreshPolicy: "manual",
      createdAt: NOW,
    } as never);

    const pin = suggest().find((item) => item.source === "pin");
    expect(pin).toBeDefined();
    expect(pin?.ref).toBe("pin_one");
    expect(pin?.sourceLabel).toContain("ghim");
  });

  it("offers a directory by name, and the text is the sentence pressing it sends", () => {
    upsertProject(db, project("proj_one", "clarkcant"));

    const found = suggest().find((item) => item.source === "project");
    expect(found).toBeDefined();
    expect(found?.label).toContain("clarkcant");
    expect(found?.text).toContain("clarkcant");
  });

  it("never offers the same record twice", () => {
    conversation("conv_one");
    upsertProject(db, project("proj_one", "a"));
    upsertProject(db, project("proj_two", "b"));

    const refs = suggest()
      .map((item) => item.ref)
      .filter((ref): ref is string => ref !== undefined);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it("offers a first screen rather than a menu", () => {
    conversation("conv_one");
    for (const name of ["a", "b", "c", "d", "e"]) {
      upsertProject(db, project(`proj_${name}`, name));
    }

    expect(suggest()).toHaveLength(4);
  });

  it("gives the same offer the same name, because it is derived from what it points at", () => {
    conversation("conv_one");

    const first = suggest();
    const second = suggest();
    expect(first.map((item) => item.suggestionId)).toEqual(second.map((item) => item.suggestionId));
  });
});
