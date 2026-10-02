import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import {
  closeDatabase,
  deletePackageConnection,
  endPackageConnection,
  getPackageConnection,
  listPackageConnections,
  migrate,
  openDatabase,
  packageConnectionTokens,
  refreshPackageConnectionTokens,
  savePackageConnection,
  type Database,
} from "../src/index.ts";

let db: Database;
const NOW = "2026-10-02T10:00:00.000Z" as Instant;
const LATER = "2026-10-02T11:00:00.000Z" as Instant;

function connect(ref = "conn_1", overrides: Record<string, unknown> = {}): void {
  savePackageConnection(db, {
    connectionRef: ref,
    principalId: "prin_1",
    packageId: "com.example.tasks",
    provider: "example.tasks",
    state: "connected",
    grantedScopes: ["tasks.read", "tasks.write"],
    accessExpiresAt: LATER,
    connectedAt: NOW,
    accessToken: "access-value",
    refreshToken: "refresh-value",
    ...overrides,
  });
}

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  migrate(db);
});

afterEach(() => {
  closeDatabase(db);
});

describe("package connections", () => {
  it("keeps the status apart from the tokens", () => {
    connect();
    const stored = getPackageConnection(db, "prin_1", "com.example.tasks");
    expect(stored).toEqual({
      connectionRef: "conn_1",
      principalId: "prin_1",
      packageId: "com.example.tasks",
      provider: "example.tasks",
      state: "connected",
      grantedScopes: ["tasks.read", "tasks.write"],
      accessExpiresAt: LATER,
      connectedAt: NOW,
      updatedAt: NOW,
    });
    expect(JSON.stringify(stored)).not.toContain("access-value");
    expect(packageConnectionTokens(db, "conn_1")).toEqual({ accessToken: "access-value", refreshToken: "refresh-value" });
    // A connection's tokens are not the credential store a person sees in Settings.
    expect(db.prepare("SELECT COUNT(*) AS n FROM credentials").get()).toEqual({ n: 0 });
  });

  it("replaces the old connection and its tokens on reconnect: one account per package", () => {
    connect("conn_1");
    connect("conn_2", { accessToken: "second-access", refreshToken: undefined });
    expect(listPackageConnections(db, "prin_1").map((entry) => entry.connectionRef)).toEqual(["conn_2"]);
    expect(packageConnectionTokens(db, "conn_1")).toEqual({});
    expect(packageConnectionTokens(db, "conn_2")).toEqual({ accessToken: "second-access" });
  });

  it("stores a refreshed token and the scopes the refresh came back with", () => {
    connect();
    refreshPackageConnectionTokens(db, {
      connectionRef: "conn_1",
      accessToken: "fresh-access",
      grantedScopes: ["tasks.read"],
      state: "partial",
      at: LATER,
    });
    expect(packageConnectionTokens(db, "conn_1")).toEqual({ accessToken: "fresh-access", refreshToken: "refresh-value" });
    expect(getPackageConnection(db, "prin_1", "com.example.tasks")).toMatchObject({ state: "partial", grantedScopes: ["tasks.read"], updatedAt: LATER });
  });

  it("deletes the tokens in the same step that marks a connection revoked or expired", () => {
    connect();
    endPackageConnection(db, { connectionRef: "conn_1", state: "revoked", reason: "the provider revoked the grant", at: LATER });
    expect(packageConnectionTokens(db, "conn_1")).toEqual({});
    expect(getPackageConnection(db, "prin_1", "com.example.tasks")).toMatchObject({
      state: "revoked",
      reason: "the provider revoked the grant",
    });
  });

  it("forgets a connection and its tokens on disconnect", () => {
    connect();
    expect(deletePackageConnection(db, "prin_1", "com.example.tasks")).toBe(true);
    expect(getPackageConnection(db, "prin_1", "com.example.tasks")).toBeUndefined();
    expect(packageConnectionTokens(db, "conn_1")).toEqual({});
    expect(deletePackageConnection(db, "prin_1", "com.example.tasks")).toBe(false);
  });
});
