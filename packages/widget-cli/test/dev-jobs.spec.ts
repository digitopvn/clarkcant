import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEV_JOB_LIMITS, createDevJobBroker } from "../src/dev-jobs.ts";
import { readServiceSimulator } from "../src/service-simulator.ts";

const RENDER = "com.example.notes.render@1";
const binding = {
  actionBindingId: "binding_render",
  capabilityRef: RENDER,
  job: { steps: [{ current: 1, total: 2, message: "first half" }, { current: 2, total: 2 }], output: "rendered.png", error: "the renderer ran out of memory" },
};

describe("simulated jobs@1 in the dev host", () => {
  it("moves a job from queued through the fixture's progress to a completion that says it was simulated", () => {
    const jobs = createDevJobBroker({ now: () => "2026-10-01T10:00:00.000Z" });
    const started = jobs.start(binding);
    expect(started).toMatchObject({ status: "queued", resultRefs: [] });
    const jobId = started?.jobId ?? "";
    expect(jobId).toMatch(/^job_dev_/);

    expect(jobs.control(jobId, "advance")).toMatchObject({ status: "ok", job: { status: "running", startedAt: "2026-10-01T10:00:00.000Z" } });
    expect(jobs.control(jobId, "advance")).toMatchObject({ job: { status: "running", progress: { current: 1, total: 2, message: "first half" } } });
    expect(jobs.handle({ op: "get", jobId })).toMatchObject({ status: "ok", job: { progress: { current: 1 } } });
    jobs.control(jobId, "advance");
    const done = jobs.control(jobId, "advance");
    expect(done).toMatchObject({ job: { status: "completed", progress: { current: 2 }, endedAt: "2026-10-01T10:00:00.000Z" } });
    expect(done.status === "ok" ? done.job.output : "").toBe("rendered.png (simulated by clark widget dev)");

    // An ended job stays readable and refuses a second ending, with the node's own code.
    expect(jobs.control(jobId, "fail")).toMatchObject({ status: "refused", code: "JOB_NOT_RUNNING" });
    expect(jobs.handle({ op: "cancel", jobId })).toMatchObject({ status: "refused", code: "JOB_NOT_RUNNING" });
    expect(jobs.events().map((event) => event.op)).toEqual(["start", "advance", "advance", "advance", "advance"]);
  });

  it("fails and cancels on purpose, and refuses what a node would refuse", () => {
    const jobs = createDevJobBroker();
    const failing = jobs.start(binding)?.jobId ?? "";
    expect(jobs.control(failing, "fail")).toMatchObject({ job: { status: "failed", error: "the renderer ran out of memory (simulated by clark widget dev)" } });

    const cancelled = jobs.start(binding)?.jobId ?? "";
    expect(jobs.handle({ op: "cancel", jobId: cancelled })).toMatchObject({
      status: "ok",
      job: { status: "cancelled", error: "the job was cancelled (simulated by clark widget dev)" },
    });

    expect(jobs.handle({ op: "get", jobId: "job_unknown" })).toMatchObject({ status: "refused", code: "JOB_NOT_FOUND" });
    expect(jobs.handle({ op: "get", jobId: "../etc/passwd" })).toMatchObject({ status: "refused", code: "SCHEMA_INVALID" });
    expect(jobs.handle({ op: "delete", jobId: cancelled })).toMatchObject({ status: "refused", code: "SCHEMA_INVALID" });
  });

  it("holds a bounded number of jobs, making room from ended ones and refusing when all are running", () => {
    const jobs = createDevJobBroker();
    const first = jobs.start(binding)?.jobId ?? "";
    for (let index = 1; index < DEV_JOB_LIMITS.maxJobs; index += 1) jobs.start(binding);
    expect(jobs.start(binding)).toBeUndefined();

    jobs.control(first, "complete");
    expect(jobs.start(binding)).toBeDefined();
    expect(jobs.list()).toHaveLength(DEV_JOB_LIMITS.maxJobs);
    expect(jobs.handle({ op: "get", jobId: first })).toMatchObject({ code: "JOB_NOT_FOUND" });
  });
});

describe("job fixtures in dev-host-services.json", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const write = (bindings: unknown[]): string => {
    const root = mkdtempSync(join(tmpdir(), "clark-dev-jobs-"));
    created.push(root);
    mkdirSync(join(root, "fixtures"));
    writeFileSync(join(root, "fixtures", "dev-host-services.json"), JSON.stringify({ bindings }));
    return root;
  };

  it("accepts a job fixture only for a capability declared to run as a job, and requires one for it", () => {
    expect(readServiceSimulator(write([binding]), [RENDER], [RENDER]).bindings[0]?.job?.steps).toHaveLength(2);
    expect(() => readServiceSimulator(write([binding]), [RENDER], [])).toThrow(/not declared with execution kind "job"/);
    expect(() => readServiceSimulator(write([{ ...binding, job: undefined, outcome: { status: "accepted", message: "ok" } }]), [RENDER], [RENDER]))
      .toThrow(/needs a "job" fixture/);
    expect(() => readServiceSimulator(write([{ ...binding, job: { steps: [{ current: -1 }] } }]), [RENDER], [RENDER])).toThrow(/invalid/);
  });
});
