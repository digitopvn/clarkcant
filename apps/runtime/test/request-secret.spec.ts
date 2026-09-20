import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";
import {
  type Database,
  nodeStoreSecretBackend,
  openDatabase,
  migrate,
  putSecretMetadata,
} from "@clarkcant/storage";

import { createRequestSecretTool } from "../src/request-secret.ts";

/**
 * Asking for a secret.
 *
 * The assertions that matter are negative ones. A model that can read a value can put it in a tool call, a
 * summary or a message, and every one of those goes to the provider — so what this tool returns must have no room
 * for a value at all, not merely a promise not to include one.
 */
const AT = "2026-09-19T10:00:00.000Z" as Instant;
const SECRET_VALUE = "fixture-value-that-must-not-appear";

let dir: string;
let db: Database;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarkcant-request-secret-"));
  db = openDatabase({ path: join(dir, "node.sqlite") });
  migrate(db);
  counter = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function tool(): ReturnType<typeof createRequestSecretTool> {
  return createRequestSecretTool({
    db,
    principalId: "owner_1",
    newId: (prefix) => {
      counter += 1;
      return `${prefix}_${counter}`;
    },
    now: () => AT,
    nodeId: "node_local",
  });
}

function seedMetadata(): void {
  putSecretMetadata(db, {
    secretId: "secret_github_token",
    principalId: "owner_1",
    name: "github_token",
    description: "GitHub PAT dùng cho git push và GitHub API",
    kind: "token",
    backend: "node-store",
    backendRef: "github_token",
    allowedConsumers: ["command:git"],
    injectionPolicy: "tool-only",
    at: AT,
  });
}

describe("when the node does not have it", () => {
  it("opens a host-owned form and says the value will not be in the conversation", async () => {
    const answer = await tool().execute({
      name: "github_token",
      label: "GitHub token",
      description: "Cần để push code lên GitHub.",
      secretKind: "token",
      consumer: "command:git",
    });

    expect(answer.hostCard?.type).toBe("credential-card");
    expect(answer.hostCard).toMatchObject({
      destination: "vault-node",
      consumer: "command:git",
      scope: "node:node_local",
      purpose: "Cần để push code lên GitHub.",
    });
    // The field is masked and host-owned, which is what keeps the typed value out of the timeline.
    expect(answer.hostCard?.fields).toEqual([
      { name: "github_token", label: "GitHub token", masked: true, hostOwned: true },
    ]);
    expect(answer.text).toContain("không đi vào hội thoại");
  });

  it("asks for a name before it asks a person for anything", async () => {
    const answer = await tool().execute({ label: "Không tên", description: "x" });
    expect(answer.hostCard).toBeUndefined();
    expect(answer.text).toContain("tên cho secret");
  });
});

describe("when the node already has it", () => {
  it("says available, describes it, and returns no value", async () => {
    seedMetadata();
    nodeStoreSecretBackend(db, "owner_1").write("github_token", SECRET_VALUE, AT);

    const answer = await tool().execute({ name: "github_token", label: "GitHub token", description: "x" });

    expect(answer.text).toContain("github_token: available.");
    expect(answer.text).toContain("GitHub PAT dùng cho git push và GitHub API");
    expect(answer.text).toContain("command:git");
    // The negative assertion, and the reason this tool exists: nothing in the answer could carry a value.
    expect(answer.text).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(answer)).not.toContain(SECRET_VALUE);
    expect(answer.hostCard).toBeUndefined();
  });

  it("does not claim available when the metadata outlived the value", async () => {
    // A deleted credential whose row was left behind. Answering `available` here would send a caller off to use
    // something that is not there, and the failure would surface far from its cause.
    seedMetadata();
    const answer = await tool().execute({ name: "github_token", label: "GitHub token", description: "x" });
    expect(answer.text).not.toContain("available");
    expect(answer.hostCard?.type).toBe("credential-card");
  });

  it("tells the model to pass the name rather than the value", async () => {
    seedMetadata();
    nodeStoreSecretBackend(db, "owner_1").write("github_token", SECRET_VALUE, AT);
    const answer = await tool().execute({ name: "github_token", label: "GitHub token", description: "x" });
    expect(answer.text).toContain('secretRef "github_token"');
  });
});
