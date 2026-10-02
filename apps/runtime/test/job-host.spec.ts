import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, insertJob, listAuditEvents, migrate, openDatabase, type Database } from "@clarkcant/storage";
import { performEmergencyStop } from "../src/application/emergency-stop.ts";
import { createWorkSupervisor } from "../src/work-supervisor.ts";
import { createPackageJobHost, jobEndNotice } from "../src/job-host.ts";

let db: Database;
beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
  migrate(db);
});
afterEach(() => closeDatabase(db));

const job = (jobId: string) => ({
  jobId: jobId as never,
  nodeId: "node_1" as never,
  ownerPrincipalId: "prin_1" as never,
  conversationId: "conv_1" as never,
  instanceId: "winst_1",
  actionBindingId: "binding_1",
  packageId: "pkg_1" as never,
  packageGeneration: "generation_1",
  capabilityRef: "example.export@1" as never,
  effectCategory: "local-write" as const,
});

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("durable package job host", () => {
  it("lists jobs in the supervisor, enforces active capacity, and routes Stop to the service signal", async () => {
    const supervisor = createWorkSupervisor();
    const host = createPackageJobHost({ db, nodeId: "node_1", nodeBootId: "boot_1", newId: () => "job_unused", supervisor, maxActiveJobs: 1 });
    let signal: AbortSignal | undefined;
    let settled = 0;
    const started = host.start({
      job: job("job_active"),
      run: (nextSignal) => new Promise((_resolve, reject) => {
        signal = nextSignal;
        nextSignal.addEventListener("abort", () => reject(nextSignal.reason), { once: true });
      }),
      onSettled: () => { settled += 1; },
    });

    expect(started.status).toBe("running");
    await flush();
    expect(host.canAdmit()).toBe(false);
    expect(supervisor.list()).toContainEqual(expect.objectContaining({ workId: "job_active", kind: "job", state: "running" }));
    expect(() => host.start({ job: job("job_second"), run: async () => ({ content: "must not run" }) })).toThrow(/limit/);

    expect(supervisor.cancel("job_active")).toBe("stopped");
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(host.get("job_active", { ownerPrincipalId: "prin_1", instanceId: "winst_1", actionBindingId: "binding_1", packageGeneration: "generation_1" })?.status).toBe("cancelled");
    expect(settled).toBe(1);
    expect(supervisor.list()).toEqual([]);
    expect(settled).toBe(1);
  });

  it("holds a package to its profile's own job limit inside the node's, and counts only that package's jobs", async () => {
    const supervisor = createWorkSupervisor();
    const host = createPackageJobHost({ db, nodeId: "node_1", nodeBootId: "boot_1", newId: () => "job_unused", supervisor, maxActiveJobs: 4 });
    const scope = { packageId: "pkg_1", maxActive: 1 };
    const pending = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    host.start({ job: job("job_first"), scope, run: pending });
    await flush();
    expect(host.canAdmit()).toBe(true);
    expect(host.canAdmit(scope)).toBe(false);
    expect(() => host.start({ job: job("job_second"), scope, run: async () => ({ content: "must not run" }) })).toThrow(/package is at its active job limit/);
    // Another package has its own count.
    expect(host.canAdmit({ packageId: "pkg_2", maxActive: 1 })).toBe(true);
    host.start({ job: { ...job("job_other"), packageId: "pkg_2" as never }, scope: { packageId: "pkg_2", maxActive: 1 }, run: pending });
    await flush();
    expect(host.canAdmit({ packageId: "pkg_2", maxActive: 1 })).toBe(false);
    expect(supervisor.cancel("job_first")).toBe("stopped");
    await flush();
    expect(host.canAdmit(scope)).toBe(true);
  });

  it("reports a restart interruption and never calls the old service again", () => {
    const supervisor = createWorkSupervisor();
    const reports: string[] = [];
    const host = createPackageJobHost({
      db, nodeId: "node_1", nodeBootId: "boot_2", newId: () => "job_unused", supervisor,
      report: (_conversationId, text) => reports.push(text),
    });
    insertJob(db, { ...job("job_crashed"), status: "running", resultRefs: [], createdAt: "2026-10-01T10:00:00.000Z", startedAt: "2026-10-01T10:00:00.000Z", nodeBootId: "boot_1" } as never);

    expect(host.recover()).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("may have completed its effect");
    expect(reports[0]).toContain("example.export@1");
    expect(host.canAdmit()).toBe(true);
    expect(host.recover()).toBe(0);
    expect(reports).toHaveLength(1);
  });

  it("fails every interrupted job even when the note for one of them cannot be written", () => {
    const supervisor = createWorkSupervisor();
    const reported: string[] = [];
    const host = createPackageJobHost({
      db, nodeId: "node_1", nodeBootId: "boot_2", newId: () => "job_unused", supervisor,
      report: (_conversationId, _text, ended) => {
        reported.push(ended.jobId);
        if (reported.length === 1) throw new Error("the conversation could not be written");
      },
    });
    for (const jobId of ["job_crashed_a", "job_crashed_b"]) {
      insertJob(db, { ...job(jobId), status: "running", resultRefs: [], createdAt: "2026-10-01T10:00:00.000Z", startedAt: "2026-10-01T10:00:00.000Z", nodeBootId: "boot_1" } as never);
    }

    expect(host.recover()).toBe(2);
    expect(reported).toHaveLength(2);
    const owner = { ownerPrincipalId: "prin_1", instanceId: "winst_1", actionBindingId: "binding_1", packageGeneration: "generation_1" };
    expect(host.get("job_crashed_a", owner)?.status).toBe("failed");
    expect(host.get("job_crashed_b", owner)?.status).toBe("failed");
  });

  it("keeps a chatty service's progress to a few writes a second, and always its last step", async () => {
    const supervisor = createWorkSupervisor();
    const host = createPackageJobHost({ db, nodeId: "node_1", nodeBootId: "boot_1", newId: () => "job_unused", supervisor });
    const owner = { ownerPrincipalId: "prin_1", instanceId: "winst_1", actionBindingId: "binding_1", packageGeneration: "generation_1" };
    const seen: (number | undefined)[] = [];
    let finish: (() => void) | undefined;
    host.start({
      job: job("job_chatty"),
      run: (_signal, onProgress) => new Promise((resolve) => {
        for (let step = 1; step <= 500; step += 1) onProgress({ current: step, total: 500 });
        finish = () => resolve({ content: "done" });
      }),
    });
    host.subscribe("job_chatty", owner, (snapshot) => seen.push(snapshot.progress?.current));
    await flush();

    // The first report and the last step are kept; the hundreds in between, sent within one instant, are not written.
    expect(host.get("job_chatty", owner)?.progress).toMatchObject({ current: 500, total: 500 });
    expect(seen.filter((current) => current !== undefined).length).toBeLessThanOrEqual(2);
    finish?.();
    await flush();
    expect(host.get("job_chatty", owner)?.status).toBe("completed");
  });

  it("stops a job before dispatch without sending a service request or claiming an uncertain effect", async () => {
    const supervisor = createWorkSupervisor();
    const reports: string[] = [];
    const outcomes: unknown[] = [];
    const host = createPackageJobHost({
      db, nodeId: "node_1", nodeBootId: "boot_1", newId: () => "job_unused", supervisor,
      report: (_conversationId, text) => reports.push(text),
    });
    let calls = 0;
    host.start({
      job: job("job_not_sent"),
      run: async () => { calls += 1; return { content: "must not run" }; },
      onSettled: (outcome) => outcomes.push(outcome),
    });
    expect(supervisor.cancelKind("job")).toBe(1);
    await flush();
    expect(calls).toBe(0);
    expect(outcomes).toMatchObject([{ status: "cancelled", sent: false }]);
    expect(reports[0]).toContain("Nothing ran");
  });

  it("ends a running job on an emergency Stop, counts it once, and writes the stop down", async () => {
    const supervisor = createWorkSupervisor();
    const reports: string[] = [];
    const host = createPackageJobHost({
      db, nodeId: "node_1", nodeBootId: "boot_1", newId: () => "job_unused", supervisor,
      report: (_conversationId, text) => reports.push(text),
    });
    let signal: AbortSignal | undefined;
    host.start({
      job: job("job_stopped"),
      run: (nextSignal) => new Promise((_resolve, reject) => {
        signal = nextSignal;
        nextSignal.addEventListener("abort", () => reject(nextSignal.reason), { once: true });
      }),
    });
    await flush();

    const report = await performEmergencyStop({ db, ownerPrincipalId: "prin_1", nodeId: "node_1", newId: () => "audit_stop", work: supervisor });
    await flush();

    expect(report).toMatchObject({ jobs: 1, background: 0 });
    expect(signal?.aborted).toBe(true);
    expect(host.get("job_stopped", { ownerPrincipalId: "prin_1", instanceId: "winst_1", actionBindingId: "binding_1", packageGeneration: "generation_1" })?.status).toBe("cancelled");
    expect(reports[0]).toContain("may have finished its effect");
    expect(supervisor.list()).toEqual([]);
    expect(listAuditEvents(db, "prin_1")[0]?.summary).toContain("1 package job");
  });

  it("names what a finished job produced and what to do next", () => {
    const ref = (name: string) => ({ v: 1, artifactId: `art_${name}`, kind: "fixed", mimeType: "image/png", sizeBytes: 1, name }) as never;
    expect(jobEndNotice({ capabilityRef: "example.export@1" as never, status: "completed", resultRefs: [ref("a.png")] }, { status: "completed" }))
      .toBe("The package job for example.export@1 completed and produced “a.png”. Open its widget to use it.");
    expect(jobEndNotice({
      capabilityRef: "example.export@1" as never, status: "completed",
      resultRefs: [ref("1.png"), ref("2.png"), ref("3.png"), ref("4.png")],
    }, { status: "completed" })).toContain("“1.png”, “2.png”, “3.png” and 1 more");
    expect(jobEndNotice({ capabilityRef: "example.export@1" as never, status: "cancelled", resultRefs: [] }, { status: "cancelled", sent: true }))
      .toContain("may have finished its effect");
    expect(jobEndNotice({ capabilityRef: "example.export@1" as never, status: "cancelled", resultRefs: [] }, { status: "cancelled", sent: false }))
      .toContain("Nothing ran");
  });

  it("leaves the job for boot recovery, without an unhandled rejection, when its ending cannot be recorded", async () => {
    const local = openDatabase({ path: ":memory:" });
    migrate(local);
    const host = createPackageJobHost({ db: local, nodeId: "node_1", nodeBootId: "boot_1", newId: () => "job_unused", supervisor: createWorkSupervisor() });
    let answer: (() => void) | undefined;
    host.start({ job: job("job_unrecorded"), run: () => new Promise((resolve) => { answer = () => resolve({ content: "done" }); }) });
    await flush();
    closeDatabase(local);
    answer?.();
    await flush();
    expect(host.canAdmit()).toBe(true);
  });
});
