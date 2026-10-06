import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ARTIFACT_LIMITS } from "@clarkcant/contracts";
import { closeDatabase, migrate, openDatabase, type Database } from "@clarkcant/storage";
import { type ArtifactBrokerDeps, readArtifactRange, storedBytesForInstance } from "../src/artifact-broker.ts";
import { storeJobResultArtifacts } from "../src/job-result-artifacts.ts";
import { createPackageJobHost } from "../src/job-host.ts";
import { createWorkSupervisor } from "../src/work-supervisor.ts";

let db: Database;
let dir: string;
let broker: ArtifactBrokerDeps;
const owner = { ownerPrincipalId: "prin_owner", instanceId: "winst_origin", actionBindingId: "binding_origin", packageGeneration: "generation_origin" };
const origin = { ...owner, conversationId: "conv_origin" } as never;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-job-result-"));
  db = openDatabase({ path: ":memory:" });
  migrate(db);
  let counter = 0;
  broker = { db, dataDir: dir, nodeId: "node_origin", newId: (prefix) => prefix + "_" + String(++counter), now: () => new Date("2026-10-01T10:00:00.000Z") };
});
afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("package job result artifacts", () => {
  it("stores real bytes through the broker and refuses another instance or principal", () => {
    const bytes = new TextEncoder().encode("the service result");
    const saved = storeJobResultArtifacts(broker, origin, [{ mimeType: "text/plain", bytes }]);
    expect(saved.omitted).toBe(false);
    expect(saved.refs).toHaveLength(1);
    const ref = saved.refs[0]!;
    expect(ref).toMatchObject({ kind: "finalized", mimeType: "text/plain", sizeBytes: bytes.byteLength });
    expect(Object.keys(ref)).not.toContain("blobPath");
    const read = readArtifactRange(broker, { principalId: owner.ownerPrincipalId, instanceId: owner.instanceId, artifactId: ref.artifactId, offset: 0, length: 100 });
    expect(read.ok).toBe(true);
    if (read.ok) expect(new TextDecoder().decode(read.bytes)).toBe("the service result");
    expect(readArtifactRange(broker, { principalId: "prin_other", instanceId: owner.instanceId, artifactId: ref.artifactId, offset: 0, length: 100 }).ok).toBe(false);
    expect(readArtifactRange(broker, { principalId: owner.ownerPrincipalId, instanceId: "winst_other", artifactId: ref.artifactId, offset: 0, length: 100 }).ok).toBe(false);
  });

  it("keeps no file above the granted profile's ceiling, and no profile raises the attachable maximum", () => {
    const bytes = new TextEncoder().encode("twelve bytes");
    expect(storeJobResultArtifacts(broker, origin, [{ mimeType: "text/plain", bytes }], 8)).toEqual({ refs: [], omitted: true });
    expect(storedBytesForInstance(db, owner.instanceId)).toBe(0);
    const kept = storeJobResultArtifacts(broker, origin, [{ mimeType: "text/plain", bytes }], Number.MAX_SAFE_INTEGER);
    expect(kept.refs).toHaveLength(1);
    const tooLarge = new Uint8Array(ARTIFACT_LIMITS.maxBytes + 1);
    expect(storeJobResultArtifacts(broker, origin, [{ mimeType: "text/plain", bytes: tooLarge }], Number.MAX_SAFE_INTEGER).omitted).toBe(true);
  });

  it("cleans rejected files and keeps completion output and refs available to a remounted observer", async () => {
    const bytes = new TextEncoder().encode("a real result");
    const notices: string[] = [];
    const host = createPackageJobHost({
      db, nodeId: "node_origin", nodeBootId: "boot_origin", newId: broker.newId,
      supervisor: createWorkSupervisor(), artifactBroker: broker,
      report: (_conversationId, text) => notices.push(text),
    });
    const job = host.start({
      job: { ...owner, conversationId: "conv_origin", jobId: "job_result", nodeId: "node_origin", packageId: "com.example.export", capabilityRef: "com.example.export@1", effectCategory: "read" } as never,
      run: async (_signal, report) => {
        report({ current: 1, total: 1, message: "service finished" });
        return { content: "Result ready", files: [{ mimeType: "text/plain", bytes }, { mimeType: "image/png", bytes }] };
      },
    });
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    const seen: string[] = [];
    const unsubscribe = host.subscribe(job.jobId, owner, (snapshot) => seen.push(snapshot.status));
    const current = host.get(job.jobId, owner);
    expect(seen).toEqual(["completed"]);
    expect(current).toMatchObject({ status: "completed", progress: { current: 1, total: 1 }, output: expect.stringContaining("Result ready") });
    expect(current?.output).toContain("could not be retained");
    expect(current?.resultRefs).toHaveLength(1);
    expect(storedBytesForInstance(db, owner.instanceId)).toBe(bytes.byteLength);
    expect(notices).toHaveLength(1);
    // Worded in the owner's language, Vietnamese by default.
    expect(notices[0]).toContain("đã xong và tạo ra “untitled.txt”. Mở widget của nó để dùng tệp này.");
    expect(host.get(job.jobId, { ...owner, actionBindingId: "binding_other" })).toBeUndefined();
    unsubscribe();
  });
});
