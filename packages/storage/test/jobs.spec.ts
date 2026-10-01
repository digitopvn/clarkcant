import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Instant } from "@clarkcant/contracts";

import { closeDatabase, migrate, openDatabase, type Database } from "../src/index.ts";
import { conversationHasUnsettledWork } from "../src/repositories/conversation-deletion.ts";
import { failInterruptedJobs, getJob, getOwnedJob, insertJob, listOpenJobs, transitionJob, updateJobProgress } from "../src/repositories/jobs.ts";

let db: Database;
const NOW = "2026-10-01T10:00:00.000Z" as Instant;

function addJob(overrides: Record<string, unknown> = {}): void {
  insertJob(db, {
    jobId: "job_1" as never,
    nodeId: "node_1",
    ownerPrincipalId: "prin_1" as never,
    instanceId: "winst_1",
    actionBindingId: "binding_1",
    packageId: "pkg_1" as never,
    packageGeneration: "generation_1",
    capabilityRef: "example.export@1" as never,
    effectCategory: "local-write",
    status: "queued",
    resultRefs: [],
    createdAt: NOW,
    nodeBootId: "boot_1",
    ...overrides,
  } as Parameters<typeof insertJob>[1]);
}

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  migrate(db);
});
afterEach(() => closeDatabase(db));

describe("durable package jobs", () => {
  it("scopes reads to the full origin owner tuple and advances progress monotonically", () => {
    addJob();
    expect(getOwnedJob(db, "job_1", {
      ownerPrincipalId: "prin_1", instanceId: "winst_1", actionBindingId: "binding_1", packageGeneration: "generation_1",
    })?.status).toBe("queued");
    expect(getOwnedJob(db, "job_1", {
      ownerPrincipalId: "prin_other", instanceId: "winst_1", actionBindingId: "binding_1", packageGeneration: "generation_1",
    })).toBeUndefined();
    expect(updateJobProgress(db, { jobId: "job_1", progress: { current: 2, total: 3, message: "working" }, at: NOW })).toBe(true);
    expect(updateJobProgress(db, { jobId: "job_1", progress: { current: 1, total: 3 }, at: NOW })).toBe(false);
    expect(updateJobProgress(db, { jobId: "job_1", progress: { current: 4 }, at: NOW })).toBe(false);
    expect(getJob(db, "job_1")).toMatchObject({ status: "running", progress: { current: 2, total: 3 } });
  });

  it("settles jobs once and never replays an open effect after a restart", () => {
    addJob();
    expect(transitionJob(db, { jobId: "job_1", status: "completed", at: NOW })).toBe(true);
    expect(transitionJob(db, { jobId: "job_1", status: "completed", at: NOW })).toBe(false);
    expect(transitionJob(db, { jobId: "job_1", status: "cancelled", at: NOW })).toBe(false);
    expect(failInterruptedJobs(db, { nodeId: "node_1", currentBootId: "boot_2", at: NOW })).toBe(0);

    addJob({ jobId: "job_2", nodeBootId: "boot_1", status: "running" });
    expect(failInterruptedJobs(db, { nodeId: "node_1", currentBootId: "boot_2", at: NOW })).toBe(1);
    expect(getJob(db, "job_2")?.error).toContain("may have completed its effect");
    expect(listOpenJobs(db, "node_1")).toEqual([]);
  });

  it("keeps a conversation with an open job from being deleted until the job ends", () => {
    addJob({ conversationId: "conv_1" });
    expect(conversationHasUnsettledWork(db, "conv_1")).toBe(true);
    expect(transitionJob(db, { jobId: "job_1", status: "cancelled", at: NOW })).toBe(true);
    expect(conversationHasUnsettledWork(db, "conv_1")).toBe(false);
  });
});
