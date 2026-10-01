import { describe, expect, it } from "vitest";

import { jobRecordSchema, jobStatusSchema, serviceCapabilityDeclarationSchema } from "../src/index.ts";

const base = {
  jobId: "job_1",
  nodeId: "node_1",
  ownerPrincipalId: "prin_1",
  instanceId: "winst_1",
  actionBindingId: "binding_1",
  packageId: "pkg_1",
  packageGeneration: "generation_1",
  capabilityRef: "example.export@1",
  effectCategory: "local-write",
  status: "queued",
  resultRefs: [],
  createdAt: "2026-10-01T10:00:00.000Z",
};

describe("package job contracts", () => {
  it("keeps jobs opaque and validates lifecycle snapshots", () => {
    expect(jobRecordSchema.parse(base).jobId).toBe("job_1");
    expect(jobStatusSchema.safeParse("replaying").success).toBe(false);
    expect(jobRecordSchema.safeParse({ ...base, progress: { current: 4, total: 3 } }).success).toBe(false);
  });

  it("opts into only versioned job execution while leaving old declarations synchronous", () => {
    const declaration = {
      tool: "export",
      ref: "example.export@1",
      summary: "Export a report",
      effectCategory: "local-write",
    };
    expect(serviceCapabilityDeclarationSchema.parse(declaration).execution).toBeUndefined();
    expect(serviceCapabilityDeclarationSchema.parse({ ...declaration, execution: { kind: "job", version: 1 } }).execution)
      .toEqual({ kind: "job", version: 1 });
    expect(serviceCapabilityDeclarationSchema.safeParse({ ...declaration, execution: { kind: "job", version: 2 } }).success)
      .toBe(false);
  });
});
