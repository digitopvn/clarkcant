import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { instantSchema } from "@clarkcant/contracts";
import { decideExecution, recordEffectExecution } from "@clarkcant/core";

import { handleRequest, type GatewayDeps, type GatewayRequest, type GatewayResponse } from "../src/gateway.ts";
import { bootNodeServices, type NodeServices } from "../src/services.ts";

/**
 * The activity route.
 *
 * This is what makes autonomy checkable rather than merely trusted. An approval card is its own evidence; an
 * effect that ran without one leaves a record here instead, and the Control tab reads it. The route is
 * therefore not a convenience — without it, "Autonomous" would be a mode whose effects nobody could review
 * afterwards.
 *
 * The negative case matters as much as the positive one: the document is written by `recordEffectExecution`,
 * and what reaches the client is a fixed set of named fields rather than whatever happens to be in the log.
 */

const AT = "2026-09-16T04:00:00.000Z";

let dir: string;
let services: NodeServices;
let deps: GatewayDeps;
/** Monotonic across the whole file, so two records cannot collide on the event id. */
let nextId = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-activity-"));
  services = bootNodeServices({ dataDir: dir, label: "activity test node" });
  deps = { services, now: () => AT as never };
});

afterEach(() => {
  services.runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

async function request(method: string, path: string, options: { authed?: boolean } = {}): Promise<GatewayResponse> {
  const outgoing: GatewayRequest = {
    method,
    path,
    query: {},
    headers: options.authed === false ? {} : { authorization: `Bearer ${services.runtime.identity.localToken}` },
    body: "",
  };
  return handleRequest(deps, outgoing);
}

interface EffectEntry {
  at: string;
  kind: string;
  mode: string;
  category: string;
  description: string;
  operationDigest: string;
  because: string;
}

async function effects(): Promise<EffectEntry[]> {
  const response = await request("GET", "/activity");
  expect(response.status).toBe(200);
  return (response.body as { effects: EffectEntry[] }).effects;
}

/** Write one audit record the way the command tool does, so the route is read from real data. */
function record(command: string, category: "local-write" | "external-write" = "local-write"): void {
  const digest = `sha256:${"a".repeat(40)}`;
  const decision = decideExecution({
    mode: "autonomous",
    rules: [],
    action: { kind: "effect", category, operationDigest: digest },
    explicitUserIntent: true,
  });
  if (decision.kind !== "execute") throw new Error("expected an execution");
  recordEffectExecution(
    {
      db: services.runtime.db,
      nodeId: services.runtime.identity.nodeId,
      // Monotonic across calls, not per call: the event id is a primary key, and a counter that restarted
      // would collide on the second record.
      newId: (prefix) => `${prefix}_${(nextId += 1)}`,
      now: () => instantSchema.parse(AT),
    },
    {
      principalId: services.runtime.identity.ownerPrincipalId,
      mode: "autonomous",
      decision,
      category,
      operationDigest: digest,
      description: command,
    },
  );
}

describe("the activity route reports what ran without asking", () => {
  it("is behind the same token as every other route", async () => {
    expect((await request("GET", "/activity", { authed: false })).status).toBe(401);
  });

  it("answers an empty list rather than nothing when no effect has run", async () => {
    // Empty is a fact — nothing has run without a card yet — and it is a different state from an unreadable
    // log, which is why the surface can say so in words.
    expect(await effects()).toEqual([]);
  });

  it("reports the mode, category, digest and description of a recorded effect", async () => {
    record("git status --short");
    const listed = await effects();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      kind: "effect.executed",
      mode: "autonomous",
      category: "local-write",
      description: "git status --short",
      at: AT,
    });
    // The digest travels so an entry can be matched against the operation it describes.
    expect(listed[0]?.operationDigest).toMatch(/^sha256:/);
    // Why it was allowed to run, which is the part a person reviewing autonomy actually wants.
    expect(listed[0]?.because).not.toBe("");
  });

  it("returns the newest first, so a reader sees the latest thing", async () => {
    record("first");
    record("second");
    const listed = await effects();
    expect(listed.map((entry) => entry.description)).toEqual(["second", "first"]);
  });

  it("reports a category it did not expect as unknown rather than inventing one", async () => {
    /*
     * A document written by an older build, or by hand, must not become a category the surface renders as if
     * the resolver had produced it. The route reads named fields and falls back for anything missing.
     */
    services.runtime.db
      .prepare(
        `INSERT INTO events (event_id, source_node_id, stream, source_sequence, kind, document, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("evt_odd", services.runtime.identity.nodeId, "activity", 99, "effect.executed", "{}", AT);

    const listed = await effects();
    const odd = listed.find((entry) => entry.at === AT && entry.mode === "unknown");
    expect(odd).toBeDefined();
    expect(odd?.category).toBe("unknown");
    expect(odd?.description).toBe("");
  });

  it("never carries a value the writer did not put there", async () => {
    // The document is passed through as named fields rather than serialised whole, which is what keeps a
    // future writer from leaking something into the settings surface by accident.
    services.runtime.db
      .prepare(
        `INSERT INTO events (event_id, source_node_id, stream, source_sequence, kind, document, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "evt_secret",
        services.runtime.identity.nodeId,
        "activity",
        98,
        "effect.executed",
        JSON.stringify({ description: "ok", apiKey: "sk-live-should-not-travel" }),
        AT,
      );

    const serialised = JSON.stringify(await effects());
    expect(serialised).not.toContain("sk-live-should-not-travel");
    expect(serialised).not.toContain("apiKey");
  });
});
