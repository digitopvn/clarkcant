import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConversationId, Instant, Principal } from "@clarkcant/contracts";
import { FakePiAdapter } from "@clarkcant/pi-adapter";
import {
  type Database,
  getSecretMetadata,
  migrate,
  nodeStoreSecretBackend,
  openDatabase,
  putSecretMetadata,
} from "@clarkcant/storage";

import { createModelTurn } from "../src/model-turn.ts";
import { createSecretBroker } from "../src/secret-broker.ts";
import { describeCommandOutcome, runCommand, stopRunningCommands } from "../src/run-command.ts";

/**
 * Stopping work, and writing down what happened.
 *
 * The two are one feature: a stop is only trustworthy if there is a record that it happened, and an audit trail is
 * only useful if the work it describes can actually be stopped. The stop kills rather than asks — nothing here
 * waits for a child process to be polite about it.
 */
const ENV = { CC_MODEL_PROVIDER: "test-provider", CC_MODEL_ID: "test-model" } satisfies NodeJS.ProcessEnv;
const AT = "2026-09-19T10:00:00.000Z" as Instant;
const SECRET_VALUE = "value-that-must-not-be-audited";

/** A turn that stays open until it is released, so "stop something running" has something running to stop. */
class HangingAdapter extends FakePiAdapter {
  readonly aborted: { sessionId: string; reason: string }[] = [];

  override async prompt(): Promise<void> {
    await new Promise<void>(() => {
      // Never resolves on its own: only an abort or a stop ends this.
    });
  }

  override async abort(sessionId: string, reason: string): Promise<void> {
    this.aborted.push({ sessionId, reason });
    await super.abort(sessionId, reason);
  }
}

afterEach(() => {
  // Nothing may leak between tests: a live command from one would be stopped by the next test's call.
  stopRunningCommands();
});

describe("stopping a command that is running", () => {
  it("kills it, settles the promise, and does not report success", async () => {
    const running = runCommand({ command: `node -e "setTimeout(() => {}, 60000)"`, cwd: process.cwd() }, { timeoutMs: 60_000 });
    // Long enough for the child to exist: this is the state a person hits the stop in.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(stopRunningCommands()).toBe(1);
    const outcome = await running;

    expect(outcome.stopped).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode === 0).toBe(false);
    // And the receipt says a person stopped it, rather than that it failed on its own.
    expect(describeCommandOutcome("node -e …", outcome)).toContain("bị dừng theo yêu cầu");
  });

  it("answers nothing to stop when nothing is running", () => {
    expect(stopRunningCommands()).toBe(0);
  });
});

describe("stopping a background worker", () => {
  it("aborts and disposes the session nobody was awaiting", async () => {
    const adapter = new HangingAdapter({ script: ["ok"] });
    const turn = await createModelTurn({ env: ENV, cwd: process.cwd(), adapter });
    if (turn === undefined) throw new Error("the model turn was not built");
    const stop = (turn as { stopBackgroundSessions?: () => Promise<number> }).stopBackgroundSessions;
    if (stop === undefined) throw new Error("the turn does not expose a background stop");

    const principal: Principal = {
      principalId: "p_owner" as Principal["principalId"],
      kind: "user",
      nodeId: "n1" as Principal["nodeId"],
    };
    // Started and deliberately not awaited: a background request returns as soon as it is accepted, which is why the
    // only reference to that session is the one the stop reaches through.
    void turn.runInBackground({ conversationId: "c1" as ConversationId, principal, text: "việc dài" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await stop.call(turn)).toBe(1);
    expect(adapter.aborted).toHaveLength(1);
    // A second stop finds nothing: the worker was removed as it was stopped.
    expect(await stop.call(turn)).toBe(0);
  });
});

describe("what a use writes down", () => {
  function seededBroker(): { db: Database; close: () => void; events: { summary: string; ref: string }[] } {
    const dir = mkdtempSync(join(tmpdir(), "clarkcant-audit-use-"));
    const db = openDatabase({ path: join(dir, "node.sqlite") });
    migrate(db);
    putSecretMetadata(db, {
      secretId: "secret_github_token",
      principalId: "owner_1",
      name: "github_token",
      description: "GitHub PAT",
      kind: "token",
      backend: "node-store",
      backendRef: "github_token",
      allowedConsumers: ["command:git"],
      injectionPolicy: "process-env",
      at: AT,
    });
    nodeStoreSecretBackend(db, "owner_1").write("github_token", SECRET_VALUE, AT);
    return {
      db,
      close: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
      events: [],
    };
  }

  it("records the name and the consumer, and never the value", () => {
    const seeded = seededBroker();
    try {
      const broker = createSecretBroker({
        db: seeded.db,
        principalId: "owner_1",
        now: () => AT,
        audit: (event) => seeded.events.push(event),
      });
      broker.environmentFor({ name: "github_token", consumer: "command:git" }, "GITHUB_TOKEN");

      expect(seeded.events).toHaveLength(1);
      expect(seeded.events[0]?.ref).toBe("github_token");
      expect(seeded.events[0]?.summary).toContain("command:git");
      // The trail is not a second copy of the secret: nothing in it could carry the value.
      expect(JSON.stringify(seeded.events)).not.toContain(SECRET_VALUE);
      expect(getSecretMetadata(seeded.db, "owner_1", "github_token")?.lastUsedAt).toBe(AT);
    } finally {
      seeded.close();
    }
  });

  it("writes nothing when the use was refused", () => {
    const seeded = seededBroker();
    try {
      const broker = createSecretBroker({
        db: seeded.db,
        principalId: "owner_1",
        now: () => AT,
        audit: (event) => seeded.events.push(event),
      });
      // A consumer the allowlist does not name: refused before the value is read, so there is nothing to record.
      expect(broker.environmentFor({ name: "github_token", consumer: "command:curl" }, "GITHUB_TOKEN").ok).toBe(false);
      expect(seeded.events).toEqual([]);
    } finally {
      seeded.close();
    }
  });
});
