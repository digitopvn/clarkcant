import { describe, expect, it } from "vitest";

import {
  RUNTIME_FEATURE_NAMES,
  maySessionAct,
  runtimeDescriptorSchema,
  runtimeFeatures,
  runtimeFeaturesSchema,
  runtimeSessionSynopsisSchema,
  supportsFeature,
} from "../src/index.ts";

const at = "2026-10-06T08:00:00.000Z";

describe("runtime features", () => {
  it("fills every trait an adapter could not establish with unknown", () => {
    const features = runtimeFeatures({ spawn: "supported", fork: "unsupported" });
    expect(Object.keys(features).sort()).toEqual([...RUNTIME_FEATURE_NAMES].sort());
    expect(features.spawn).toBe("supported");
    expect(features.fork).toBe("unsupported");
    expect(features.steer).toBe("unknown");
  });

  it("refuses a feature record that leaves a trait out, so silence is never read as an answer", () => {
    const { steer: _left, ...partial } = runtimeFeatures({ steer: "supported" });
    expect(runtimeFeaturesSchema.safeParse(partial).success).toBe(false);
  });

  it("counts only supported as support; unknown is not parity", () => {
    const features = runtimeFeatures({ stop: "supported" });
    expect(supportsFeature(features, "stop")).toBe(true);
    expect(supportsFeature(features, "resume")).toBe(false);
  });
});

describe("a runtime descriptor", () => {
  const descriptor = {
    version: 1,
    runtimeId: "rt_second",
    displayName: "Second runtime",
    nodeId: "node_home",
    integration: "native-protocol",
    features: runtimeFeatures({ spawn: "supported", observe: "supported" }),
  };

  it("parses with an opaque runtime id and a display name that is only data", () => {
    expect(runtimeDescriptorSchema.parse(descriptor).runtimeId).toBe("rt_second");
  });

  it("refuses an id that is not Clark's own runtime id", () => {
    expect(runtimeDescriptorSchema.safeParse({ ...descriptor, runtimeId: "second" }).success).toBe(false);
  });

  it("refuses an integration outside the known ladder", () => {
    expect(runtimeDescriptorSchema.safeParse({ ...descriptor, integration: "screen-reading" }).success).toBe(false);
  });
});

describe("what Clark may do with a session", () => {
  const all = runtimeFeatures(Object.fromEntries(RUNTIME_FEATURE_NAMES.map((name) => [name, "supported"])));

  it("only observes an observed session, whatever the runtime supports", () => {
    expect(maySessionAct({ authority: "observed", features: all, action: "observe" })).toBe(true);
    for (const action of ["steer", "stop", "resume", "fork"] as const) {
      expect(maySessionAct({ authority: "observed", features: all, action })).toBe(false);
    }
  });

  it("acts on a managed or attached session only where the runtime supports the action", () => {
    const partial = runtimeFeatures({ stop: "supported", steer: "unsupported" });
    expect(maySessionAct({ authority: "attached", features: partial, action: "stop" })).toBe(true);
    expect(maySessionAct({ authority: "managed", features: partial, action: "steer" })).toBe(false);
    expect(maySessionAct({ authority: "managed", features: partial, action: "resume" })).toBe(false);
  });
});

describe("a runtime session synopsis", () => {
  const synopsis = {
    version: 1,
    runtimeId: "rt_second",
    sessionId: "rsess_a1",
    authority: "observed",
    state: "running",
    stateSource: "live-protocol",
    goal: "Review the auth changes",
    taskId: "task_1",
    dataClass: "internal",
    observedAt: at,
  };

  it("parses a bounded synopsis that refers to a Clark task", () => {
    expect(runtimeSessionSynopsisSchema.parse(synopsis).taskId).toBe("task_1");
  });

  it("refuses to call a session read only from stored history alive", () => {
    const result = runtimeSessionSynopsisSchema.safeParse({ ...synopsis, stateSource: "stored-history" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/stored history/);
    expect(
      runtimeSessionSynopsisSchema.safeParse({ ...synopsis, stateSource: "stored-history", state: "completed" }).success,
    ).toBe(true);
  });

  it("refuses a field it does not define, such as a transcript", () => {
    expect(runtimeSessionSynopsisSchema.safeParse({ ...synopsis, transcript: "…" }).success).toBe(false);
  });
});
