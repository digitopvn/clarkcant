import { describe, expect, it } from "vitest";

import { envelopeWidening, executionEnvelopeSchema, type ExecutionEnvelope } from "../src/index.ts";

function envelope(input: Record<string, unknown>): ExecutionEnvelope {
  return executionEnvelopeSchema.parse({ version: 1, allowedEffects: [], ...input });
}

const standing = envelope({
  version: 1,
  capabilities: ["mail.read@1"],
  connections: ["conn_mail", "conn_chat"],
  allowedEffects: ["read", "communication"],
  dataClasses: ["public", "internal"],
  executor: { nodeIds: ["node_home"], requiredFeatures: ["stop"] },
  budget: { maxWallClockMs: 600_000, maxCostUsd: 1 },
  deliveryTargets: [
    { kind: "inbox", on: ["succeeded", "failed"] },
    { kind: "channel", connectionId: "conn_chat", target: "ops", on: ["failed", "needs-input"] },
  ],
});

describe("an execution envelope", () => {
  it("describes work with no folder at all, such as a morning mail summary", () => {
    expect(standing.resources).toBeUndefined();
    expect(standing.capabilities).toEqual(["mail.read@1"]);
  });

  it("names no runtime: the executor is constraints only", () => {
    expect(executionEnvelopeSchema.safeParse({ ...standing, executor: { runtime: "some-agent" } }).success).toBe(false);
  });

  it("refuses a channel delivery the envelope does not allow as a communication effect", () => {
    const result = executionEnvelopeSchema.safeParse({ ...standing, allowedEffects: ["read"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/communication/);
  });

  it("refuses a channel on a connection the envelope does not name, since being connected is not enough", () => {
    const result = executionEnvelopeSchema.safeParse({ ...standing, connections: ["conn_mail"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/conn_chat/);
  });
});

describe("an envelope handed on", () => {
  it("may narrow", () => {
    const narrower = envelope({
      capabilities: ["mail.read@1"],
      connections: ["conn_mail"],
      allowedEffects: ["read"],
      dataClasses: ["internal"],
      executor: { nodeIds: ["node_home"], requiredFeatures: ["stop", "resume"] },
      budget: { maxWallClockMs: 60_000, maxCostUsd: 0.5 },
      deliveryTargets: [{ kind: "inbox", on: ["failed"] }],
    });
    expect(envelopeWidening(narrower, standing)).toEqual([]);
  });

  it("never widens, and says each way it would", () => {
    const wider = envelope({
      resources: [{ kind: "folder", path: "/srv/reports", access: "read" }],
      capabilities: ["mail.read@1", "mail.send@1"],
      connections: ["conn_mail", "conn_chat"],
      allowedEffects: ["read", "external-write", "communication"],
      dataClasses: ["confidential"],
      executor: { requiredFeatures: [] },
      budget: { maxWallClockMs: 900_000 },
      deliveryTargets: [
        { kind: "inbox", on: ["report"] },
        { kind: "channel", connectionId: "conn_chat", target: "general", on: ["failed"] },
      ],
    });
    expect(envelopeWidening(wider, standing)).toEqual([
      "the folder /srv/reports (read)",
      "the capability mail.send@1",
      "the external-write effect",
      "confidential data",
      "any node",
      "a runtime without stop",
      "maxWallClockMs above 600000",
      "maxCostUsd above 1",
      "delivery of report to inbox",
      "delivery to general on conn_chat",
    ]);
  });

  it("lets a folder written cover the same folder read, and not the other way round", () => {
    const write = envelope({ resources: [{ kind: "folder", path: "/repo", access: "write" }] });
    const read = envelope({ resources: [{ kind: "folder", path: "/repo", access: "read" }] });
    expect(envelopeWidening(read, write)).toEqual([]);
    expect(envelopeWidening(write, read)).toEqual(["the folder /repo (write)"]);
  });

  it("lets a folder cover the folders inside it, segment by segment, and nothing outside it", () => {
    const outer = envelope({ resources: [{ kind: "folder", path: "/srv/reports", access: "read" }] });
    const inside = (path: string, access: "read" | "write" = "read") => envelope({ resources: [{ kind: "folder", path, access }] });
    expect(envelopeWidening(inside("/srv/reports/2026/q3"), outer)).toEqual([]);
    expect(envelopeWidening(inside("/srv/reports/2026", "write"), outer)).toEqual(["the folder /srv/reports/2026 (write)"]);
    expect(envelopeWidening(inside("/srv/reportsOld"), outer)).toEqual(["the folder /srv/reportsOld (read)"]);
    expect(envelopeWidening(inside("/srv"), outer)).toEqual(["the folder /srv (read)"]);
    expect(envelopeWidening(inside("/srv/reports/../secrets"), outer)).toEqual(["the folder /srv/reports/../secrets (read)"]);
    expect(envelopeWidening(inside("/srv/reports\\x"), outer)).toEqual(["the folder /srv/reports\\x (read)"]);
    const windows = envelope({ resources: [{ kind: "folder", path: "C:\\Reports", access: "write" }] });
    expect(envelopeWidening(inside("c:\\Reports\\2026"), windows)).toEqual([]);
  });

  it("does not let a folder cover a repository inside it, or a repository cover a folder", () => {
    const folder = envelope({ resources: [{ kind: "folder", path: "/repo", access: "write" }] });
    const repository = envelope({ resources: [{ kind: "repository", path: "/repo" }] });
    expect(envelopeWidening(repository, folder)).toEqual(["the repository /repo"]);
    expect(envelopeWidening(folder, repository)).toEqual(["the folder /repo (write)"]);
  });

  it("allows what every entry for the same delivery target allows together", () => {
    const split = envelope({
      deliveryTargets: [
        { kind: "inbox", on: ["succeeded"] },
        { kind: "inbox", on: ["failed"] },
      ],
    });
    expect(envelopeWidening(envelope({ deliveryTargets: [{ kind: "inbox", on: ["succeeded", "failed"] }] }), split)).toEqual([]);
    expect(envelopeWidening(envelope({ deliveryTargets: [{ kind: "inbox", on: ["report"] }] }), split)).toEqual([
      "delivery of report to inbox",
    ]);
  });

  it("reads absent data classes as the default classes, which exclude secrets", () => {
    expect(envelopeWidening(envelope({ dataClasses: ["secret"] }), envelope({}))).toEqual(["secret data"]);
    expect(envelopeWidening(envelope({}), envelope({ dataClasses: ["public"] }))).toEqual(["internal data", "confidential data"]);
  });
});
