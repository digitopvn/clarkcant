import { describe, expect, it } from "vitest";
import {
  type Grant,
  assertBlockProvenance,
  claimInvite,
  instantSchema,
  principalIdSchema,
  checkArtifactAcceptance,
  checkGrant,
  compileActionBinding,
  consentStillValid,
  decideInboxAction,
  degradeUnrenderableBlocks,
  dispositionOf,
  intersectGrants,
  isTerminal,
  isUsable,
  legalEvents,
  mayRetrySubmit,
  negotiateVersions,
  reduceTask,
  requiredRefreshScope,
  retryabilityOf,
  routeVoiceIntent,
  taskIdSchema,
  runIdSchema,
  taskStateSchema,
  taskEventSchema,
  validatePeerEnvelope,
  allStatesReachable,
  attachmentRefSchema,
  isHostOwnedBlock,
  messageBlockSchema,
} from "../src/index.ts";

// Branded values are produced through their own schema so the fixtures cannot drift
// from the contract they are testing.
const AT = instantSchema.parse("2026-09-16T04:00:00.000Z");
const LATER = instantSchema.parse("2026-09-16T05:00:00.000Z");
const SOON = instantSchema.parse("2026-09-16T04:30:00.000Z");
const OWNER = principalIdSchema.parse("prin_owner");

describe("identifier contracts", () => {
  it("rejects a run id used where a task id belongs", () => {
    const taskId = taskIdSchema.parse("task_1");
    const runId = runIdSchema.parse("run_1");
    expect(taskIdSchema.safeParse(runId).success).toBe(false);
    expect(runIdSchema.safeParse(taskId).success).toBe(false);
  });
});

describe("version negotiation (T11)", () => {
  const local = {
    protocol: { name: "agent.nodelink" as const, min: 1, max: 2 },
    appVersion: "0.2.0",
    hostApi: { name: "agent.apphost" as const, min: 1, max: 1 },
    capabilityGenerations: { calendar: { name: "agent.apphost" as const, min: 1, max: 3 } },
  };

  it("agrees on the highest shared version", () => {
    const result = negotiateVersions(local, {
      ...local,
      protocol: { name: "agent.nodelink", min: 1, max: 1 },
      capabilityGenerations: { calendar: { name: "agent.apphost", min: 1, max: 2 } },
    });
    expect(result.mode).toBe("full");
    expect(result.agreed?.nodeLinkVersion).toBe(1);
    expect(result.agreed?.capabilityGenerations?.calendar).toBe(2);
  });

  it("falls back to read-only rather than silently downgrading an unsupported family", () => {
    const result = negotiateVersions(local, {
      ...local,
      capabilityGenerations: {},
    });
    expect(result.mode).toBe("read-only");
    expect(result.reasons.join(" ")).toContain("calendar");
  });

  it("reports incompatibility when the protocol windows do not overlap", () => {
    const result = negotiateVersions(local, {
      ...local,
      protocol: { name: "agent.nodelink", min: 7, max: 9 },
    });
    expect(result.mode).toBe("incompatible");
  });
});

describe("task state machine (T17, T18)", () => {
  it("declares every state and every event", () => {
    expect(taskStateSchema.options.length).toBe(16);
    expect(taskEventSchema.options.length).toBeGreaterThan(20);
  });

  it("is total: every state has defined behaviour for every event", () => {
    for (const state of taskStateSchema.options) {
      for (const event of taskEventSchema.options) {
        const outcome = reduceTask(state, event);
        if (outcome.ok) expect(outcome.state).toBeTruthy();
        else expect(outcome.code).toBe("ILLEGAL_TRANSITION");
      }
      // Every state must be reachable from `queued`, or it is dead code.
    }
    expect(allStatesReachable()).toBe(true);
  });

  it("accepts cancellation from every non-terminal state", () => {
    for (const state of taskStateSchema.options) {
      const outcome = reduceTask(state, "cancel.requested");
      if (isTerminal(state) || state === "cancel_requested") {
        expect(outcome.ok).toBe(false);
      } else {
        expect(outcome.ok).toBe(true);
        expect(outcome.ok && outcome.state).toBe("cancel_requested");
      }
    }
  });

  it("has no path from idle-looking states to success without verification", () => {
    for (const state of taskStateSchema.options) {
      for (const event of legalEvents(state)) {
        const outcome = reduceTask(state, event);
        if (outcome.ok && outcome.state === "succeeded") {
          // Success is only ever reachable from verification or reconciliation.
          expect(["verifying", "reconciling"]).toContain(state);
        }
      }
    }
  });

  it("does not let a resolution failure leave the task hanging", () => {
    const outcome = reduceTask("resolving", "resolve.failed");
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.state).toBe("failed");
  });

  it("maps every state to a disposition", () => {
    for (const state of taskStateSchema.options) {
      expect(dispositionOf(state)).toBeTruthy();
    }
    expect(dispositionOf("uncertain")).toBe("uncertain");
    expect(dispositionOf("succeeded")).toBe("succeeded");
  });

  it("keeps uncertain distinct from failed", () => {
    expect(dispositionOf("uncertain")).not.toBe(dispositionOf("failed"));
  });
});

describe("effect ledger (T05)", () => {
  const base = {
    effectId: "eff_1",
    taskId: "task_1",
    executorNodeId: "node_a",
    category: "external-write" as const,
    capabilityRef: "calendar.events.create@1",
    externalSupportsDedup: false,
    state: "submitted" as const,
    intent: "create event",
    operationDigest: "sha256:abc",
    preparedAt: AT,
    submitAttempts: 1,
  };

  it("refuses to resubmit an effect whose outcome is unknown", () => {
    expect(mayRetrySubmit({ state: "unknown", externalSupportsDedup: false })).toBe(false);
    expect(mayRetrySubmit({ state: "unknown", externalSupportsDedup: true })).toBe(false);
  });

  it("refuses to resubmit after an unacknowledged submit", () => {
    expect(mayRetrySubmit({ state: "submitted", externalSupportsDedup: false })).toBe(false);
  });

  it("never resubmits a confirmed effect", () => {
    expect(mayRetrySubmit({ state: "confirmed", externalSupportsDedup: true })).toBe(false);
  });

  it("refuses to retry a submitted effect without acknowledgement", () => {
    expect(base.state).toBe("submitted");
    expect(mayRetrySubmit(base)).toBe(false);
  });
});

describe("grants (T07, T08)", () => {
  const grant: Grant = {
    grantId: "grant_1",
    ownerPrincipalId: "prin_owner",
    senderNodeId: "node_a",
    receiverNodeId: "node_b",
    capabilityRefs: ["calendar.events.list@1", "calendar.events.create@1"],
    resources: [
      { nodeId: "node_b", resourceId: "ws_1", kind: "workspace", access: "write" },
    ],
    allowedDataClasses: ["public", "internal"],
    expiresAt: LATER,
    maxDelegationDepth: 2,
  };

  it("intersects two grants without ever widening either side", () => {
    const other: Grant = {
      ...grant,
      grantId: "grant_2",
      capabilityRefs: ["calendar.events.list@1"],
      resources: [{ nodeId: "node_b", resourceId: "ws_1", kind: "workspace", access: "read" }],
      allowedDataClasses: ["public"],
      expiresAt: SOON,
      maxDelegationDepth: 1,
    };
    const merged = intersectGrants(grant, other);
    expect(merged.capabilityRefs).toEqual(["calendar.events.list@1"]);
    expect(merged.resources[0]?.access).toBe("read");
    expect(merged.allowedDataClasses).toEqual(["public"]);
    expect(merged.expiresAt).toBe(SOON);
    expect(merged.maxDelegationDepth).toBe(1);
  });

  it("refuses a capability the grant does not include", () => {
    const decision = checkGrant(grant, { capabilityRef: "shell.exec@1", at: AT });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.code).toBe("GRANT_SCOPE_VIOLATION");
  });

  it("refuses a data class the grant does not permit", () => {
    const decision = checkGrant(grant, { capabilityRef: "calendar.events.list@1", at: AT, dataClass: "secret" });
    expect(decision.allowed).toBe(false);
  });

  it("refuses a revoked grant even before its expiry", () => {
    const decision = checkGrant({ ...grant, revokedAt: AT }, { capabilityRef: "calendar.events.list@1", at: AT });
    expect(decision.allowed === false && decision.code).toBe("GRANT_REVOKED");
  });

  it("refuses re-delegation beyond the permitted depth (A to B to C)", () => {
    const decision = checkGrant(grant, {
      capabilityRef: "calendar.events.list@1",
      at: AT,
      delegationDepth: 3,
    });
    expect(decision.allowed).toBe(false);
  });

  it("reports retryability per error code, never retrying an unknown effect", () => {
    expect(retryabilityOf("EFFECT_UNKNOWN")).toBe("never");
    expect(retryabilityOf("EFFECT_ALREADY_CONFIRMED")).toBe("never");
    expect(retryabilityOf("OBSERVATION_EXPIRED")).toBe("immediate");
    expect(retryabilityOf("APPROVAL_REQUIRED")).toBe("after-user-action");
  });
});

describe("widget action compilation (T40)", () => {
  const instance = {
    instanceId: "winst_1",
    ownerNodeId: "node_a",
    definitionRef: { id: "example.notes.editor", version: "1.0.0", packageDigest: "sha256:aa" },
    actionBindingRevision: 1,
  };

  it("refuses to bind a capability the registry does not know", () => {
    const result = compileActionBinding({
      bindingId: "act_1",
      instance,
      packageGeneration: "g1",
      label: "Do the thing",
      proposal: { kind: "invoke", capabilityRef: "imaginary.tool@1", args: {} },
      inputSchema: {},
      allowedDataRefs: [],
      fixedConstraints: {},
      effectCategory: "read",
      requiresApproval: false,
      limits: {},
      bindingDigest: "sha256:bb",
      at: AT,
      knownCapabilities: new Set<string>(),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("ACTION_REFERENCE_UNKNOWN");
  });

  it("refuses a workflow that depends on a step that does not exist", () => {
    const result = compileActionBinding({
      bindingId: "act_2",
      instance,
      packageGeneration: "g1",
      label: "Chain",
      proposal: {
        kind: "workflow",
        steps: [{ stepId: "a", kind: "invoke", capabilityRef: "calendar.events.list@1", dependsOn: ["missing"] }],
      },
      inputSchema: {},
      allowedDataRefs: [],
      fixedConstraints: {},
      effectCategory: "read",
      requiresApproval: false,
      limits: {},
      bindingDigest: "sha256:cc",
      at: AT,
      knownCapabilities: new Set(["calendar.events.list@1"]),
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("ACTION_MALFORMED");
  });

  it("refuses a workflow with a dependency cycle", () => {
    const result = compileActionBinding({
      bindingId: "act_3",
      instance,
      packageGeneration: "g1",
      label: "Loop",
      proposal: {
        kind: "workflow",
        steps: [
          { stepId: "a", kind: "invoke", capabilityRef: "calendar.events.list@1", dependsOn: ["b"] },
          { stepId: "b", kind: "invoke", capabilityRef: "calendar.events.list@1", dependsOn: ["a"] },
        ],
      },
      inputSchema: {},
      allowedDataRefs: [],
      fixedConstraints: {},
      effectCategory: "read",
      requiresApproval: false,
      limits: {},
      bindingDigest: "sha256:dd",
      at: AT,
      knownCapabilities: new Set(["calendar.events.list@1"]),
    });
    expect(result.ok).toBe(false);
  });

  it("compiles a valid invocation against a known capability", () => {
    const result = compileActionBinding({
      bindingId: "act_4",
      instance,
      packageGeneration: "g1",
      label: "Refresh",
      proposal: { kind: "invoke", capabilityRef: "calendar.events.list@1", args: {} },
      inputSchema: {},
      allowedDataRefs: [],
      fixedConstraints: { nodeId: "node_a" },
      effectCategory: "read",
      requiresApproval: false,
      limits: { deadlineMs: 5000 },
      bindingDigest: "sha256:ee",
      at: AT,
      knownCapabilities: new Set(["calendar.events.list@1"]),
    });
    expect(result.ok).toBe(true);
  });
});

describe("install consent (T21)", () => {
  const plan = {
    planId: "plan_1",
    ownerPrincipalId: OWNER,
    requirementKey: "cap:calendar",
    requestedCapabilityRefs: ["calendar.events.list@1"],
    candidate: {
      id: "example.calendar-pack",
      version: "0.2.0",
      artifactUrl: "https://registry.example.invalid/pkg.tgz",
      digest: "sha256:aa",
      rationale: "first-party recipe",
      sourceTier: "first-party-recipe" as const,
    },
    resolvedDependencies: [],
    targetNodeId: "node_a",
    grantedCapabilities: ["calendar.events.list@1"],
    effectCategories: ["read" as const],
    dataRecipients: [],
    planDigest: "sha256:plan",
    isolationPlan: [{ facetKind: "tools" as const, isolation: "service" as const }],
    createdAt: AT,
    expiresAt: LATER,
  };

  it("accepts an unchanged plan", () => {
    expect(consentStillValid(plan, plan).valid).toBe(true);
  });

  it("invalidates consent when the artifact digest changes", () => {
    const moved = { ...plan, candidate: { ...plan.candidate, digest: "sha256:zz" } };
    const result = consentStillValid(plan, moved);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.changed).toContain("digest");
  });

  it("invalidates consent when the target node changes", () => {
    const result = consentStillValid(plan, { ...plan, targetNodeId: "node_b" });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.changed).toContain("targetNodeId");
  });

  it("invalidates consent when the granted capabilities widen", () => {
    const result = consentStillValid(plan, {
      ...plan,
      grantedCapabilities: ["calendar.events.list@1", "calendar.events.create@1"],
    });
    expect(result.valid).toBe(false);
  });

  it("invalidates consent when the frozen build input moved, and names the dependency", () => {
    const frozen = {
      ...plan,
      lockRef: "pkg.artifact-and-dependencies.sha256-aaaa.lock.json",
      lockDigest: "sha256:lock-one",
      lockCoverage: "artifact-and-dependencies" as const,
      resolvedDependencies: [
        { id: "left-pad", version: "1.2.5", digest: "sha512-leftpad1", resolvedFrom: "npm:left-pad@1.2.5" },
      ],
    };
    const moved = {
      ...frozen,
      lockRef: "pkg.artifact-and-dependencies.sha256-bbbb.lock.json",
      lockDigest: "sha256:lock-two",
      resolvedDependencies: [
        { id: "left-pad", version: "1.3.0", digest: "sha512-leftpad2", resolvedFrom: "npm:left-pad@1.3.0" },
      ],
    };

    const result = consentStillValid(frozen, moved);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.changed).toContain("lockDigest");
    expect(result.changed).toContain("resolvedDependencies");
    // The field name is for a log; the detail is what somebody reads before deciding what to do.
    expect(result.detail.join(" ")).toContain("left-pad");
    expect(result.detail.join(" ")).toContain("1.2.5");
    expect(result.detail.join(" ")).toContain("1.3.0");
  });

  it("reports drift when a plan frozen with a lock is compared with one that froze nothing", () => {
    const frozen = {
      ...plan,
      lockRef: "pkg.artifact-only.sha256-aaaa.lock.json",
      lockDigest: "sha256:lock-one",
      lockCoverage: "artifact-only" as const,
      resolvedDependencies: [
        { id: "com.example.calendar", version: "1.2.0", digest: "sha256:aa", resolvedFrom: "npm:com.example.calendar@1.2.0" },
      ],
    };

    const result = consentStillValid(frozen, plan);

    // "No lock" is a different build input from "a lock that pins this artifact", and it must not read as agreement.
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.changed).toContain("lockRef");
  });
});

describe("refresh scoping (T24)", () => {
  it("does not require a worker restart for a UI-only change", () => {
    expect(
      requiredRefreshScope({ facetKinds: ["ui"], nativeExtensionChanged: false, skillOrPromptChanged: false }),
    ).toBe("ui");
  });

  it("requires a new worker only for a native extension change", () => {
    expect(
      requiredRefreshScope({ facetKinds: ["ui"], nativeExtensionChanged: true, skillOrPromptChanged: false }),
    ).toBe("pi-worker");
  });

  it("reloads resources for a skill change without touching the worker", () => {
    expect(
      requiredRefreshScope({ facetKinds: ["skills"], nativeExtensionChanged: false, skillOrPromptChanged: true }),
    ).toBe("pi-resources");
  });

  it("restarts only the tool service for a connector change", () => {
    expect(
      requiredRefreshScope({ facetKinds: ["tools"], nativeExtensionChanged: false, skillOrPromptChanged: false }),
    ).toBe("tool-service");
  });
});

describe("capability readiness", () => {
  it("does not treat an installed package as usable", () => {
    expect(
      isUsable({ installed: true, loaded: true, authenticated: false, authorized: true, healthy: true }),
    ).toBe(false);
  });

  it("requires a healthy probe as well as a credential", () => {
    expect(
      isUsable({ installed: true, loaded: true, authenticated: true, authorized: true, healthy: false }),
    ).toBe(false);
    expect(
      isUsable({ installed: true, loaded: true, authenticated: true, authorized: true, healthy: true }),
    ).toBe(true);
  });
});

describe("peer envelope validation (T08, T11)", () => {
  const envelope = {
    protocol: "agent.nodelink" as const,
    version: 1,
    messageId: "msg_1",
    correlationId: "corr_1",
    senderNodeId: "node_a",
    recipientNodeId: "node_b",
    kind: "heartbeat" as const,
    sourceSequence: 1,
    sentAt: AT,
    payload: {},
  };

  const context = {
    authenticatedSenderNodeId: "node_a",
    supportedVersions: { min: 1, max: 2 },
    lastSeenSequence: undefined,
    knownDelegationIds: new Set<string>(),
  };

  it("accepts a well-formed envelope over an authenticated channel", () => {
    expect(validatePeerEnvelope(envelope, context).valid).toBe(true);
  });

  it("rejects a claimed sender that does not match the authenticated channel", () => {
    const result = validatePeerEnvelope(envelope, { ...context, authenticatedSenderNodeId: "node_z" });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.issues[0]?.code).toBe("SENDER_MISMATCH");
  });

  it("rejects an envelope outside the supported version window", () => {
    const result = validatePeerEnvelope({ ...envelope, version: 9 }, context);
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.issues.some((i) => i.code === "VERSION_UNSUPPORTED")).toBe(true);
  });

  it("rejects a delegate that references an unknown delegation", () => {
    const result = validatePeerEnvelope(
      { ...envelope, kind: "delegate", delegationId: "dlg_missing", payload: { grant: {}, taskBrief: {}, dataClass: "internal" } },
      context,
    );
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.issues.some((i) => i.code === "DELEGATION_UNKNOWN")).toBe(true);
  });
});

describe("inbox dedup decisions (T02, T03)", () => {
  const envelope = {
    protocol: "agent.nodelink" as const,
    version: 1,
    messageId: "msg_7",
    correlationId: "corr_7",
    senderNodeId: "node_a",
    recipientNodeId: "node_b",
    kind: "heartbeat" as const,
    sourceSequence: 7,
    sentAt: AT,
    payload: {},
  };

  it("processes a new in-sequence envelope", () => {
    const decision = decideInboxAction(envelope, { keys: new Map(), lastSequence: 6 });
    expect(decision.action).toBe("process");
  });

  it("recognises a replay by dedup key instead of starting a second task", () => {
    const decision = decideInboxAction(envelope, {
      keys: new Map([["node_a:7:msg_7", "msg_7"]]),
      lastSequence: 7,
    });
    expect(decision.action).toBe("duplicate");
  });

  it("reports a sequence gap rather than silently filling it", () => {
    const decision = decideInboxAction(envelope, { keys: new Map(), lastSequence: 3 });
    expect(decision.action).toBe("gap-detected");
    expect(decision.action === "gap-detected" && decision.expected).toBe(4);
  });
});

describe("pairing invites (T31)", () => {
  const invite = {
    inviteId: "inv_1",
    issuerNodeId: "node_a",
    endpoint: "https://node-a.example.invalid:8443",
    fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz",
    createdAt: AT,
    expiresAt: SOON,
  };

  it("accepts a fresh invite once", () => {
    const claimed = claimInvite(invite, AT);
    expect(claimed.ok).toBe(true);
    if (claimed.ok) {
      expect(claimInvite(claimed.invite, AT).ok).toBe(false);
    }
  });

  it("refuses an expired invite", () => {
    const result = claimInvite(invite, LATER);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("INVITE_EXPIRED");
  });
});

describe("artifact acceptance (T10)", () => {
  const offer = {
    artifactId: "art_1",
    digest: "sha256:aa",
    sizeBytes: 1024,
    mimeType: "text/csv",
    classification: "internal" as const,
    originNodeId: "node_b",
  };

  it("accepts a permitted artifact", () => {
    expect(
      checkArtifactAcceptance(offer, {
        allowedClassifications: ["internal"],
        maxBytes: 4096,
        allowedMimePrefixes: ["text/"],
      }).accepted,
    ).toBe(true);
  });

  it("refuses a data class outside the grant", () => {
    expect(
      checkArtifactAcceptance(offer, {
        allowedClassifications: ["public"],
        maxBytes: 4096,
        allowedMimePrefixes: ["text/"],
      }).accepted,
    ).toBe(false);
  });

  it("refuses an artifact that exceeds the byte budget", () => {
    expect(
      checkArtifactAcceptance({ ...offer, sizeBytes: 1_000_000 }, {
        allowedClassifications: ["internal"],
        maxBytes: 4096,
        allowedMimePrefixes: ["text/"],
      }).accepted,
    ).toBe(false);
  });

  it("refuses an executable content type regardless of declared size", () => {
    expect(
      checkArtifactAcceptance({ ...offer, mimeType: "application/x-executable", sizeBytes: 12 }, {
        allowedClassifications: ["internal"],
        maxBytes: 4096,
        allowedMimePrefixes: ["application/"],
      }).accepted,
    ).toBe(false);
  });
});

describe("surface provenance (T41, T44)", () => {
  it("drops a host-owned card that a non-host origin supplied", () => {
    const block = {
      type: "approval-card" as const,
      owner: "host" as const,
      approvalId: "appr_1",
      operationDescription: "delete everything",
      operationDigest: "sha256:aa",
      effectCategory: "destructive" as const,
      expiresAt: LATER,
      decider: "user" as const,
      decision: "granted" as const,
    };
    const verdict = assertBlockProvenance(block, { builtByHost: false });
    expect(verdict.ok).toBe(false);
    expect(assertBlockProvenance(block, { builtByHost: true }).ok).toBe(true);
  });

  it("degrades an unknown widget to its text alternative instead of breaking the timeline", () => {
    const blocks = [
      {
        type: "widget-ref" as const,
        instanceId: "winst_missing",
        displayMode: "inline" as const,
        textAlternative: "A note widget is available when the pack is installed.",
      },
    ];
    const degraded = degradeUnrenderableBlocks(blocks, {
      definitionIds: new Set<string>(),
      maxSurfaceBytes: 256 * 1024,
    });
    expect(degraded[0]?.type).toBe("text");
  });
});

describe("attachment blocks", () => {
  // Built by parsing rather than as an object literal, so the test cannot drift from the schema: an
  // id here is the branded id the contract defines, not any string that looks like one.
  const ref = attachmentRefSchema.parse({
    attachmentId: "att_1",
    blobRef: `${"a".repeat(32)}.png`,
    kind: "image",
    filename: "anh.png",
    mime: "image/png",
    sizeBytes: 2048,
    sha256: `sha256:${"b".repeat(64)}`,
  });

  it("an attachment block round-trips through the message schema", () => {
    const block = { type: "attachment" as const, attachment: ref };
    const parsed = messageBlockSchema.parse(block);
    expect(parsed).toEqual(block);
    expect(messageBlockSchema.safeParse({ type: "attachment" }).success).toBe(false);
  });

  it("a block that carries a disk path instead of a ref is refused", () => {
    // The shape is strict for this reason: an attachment block is the one place a path could arrive
    // in the timeline, and a path in a stored message is a path the client would then be able to ask
    // the node to read.
    const withPath = { type: "attachment" as const, attachment: ref, blobPath: "/var/lib/blobs/a.png" };
    expect(messageBlockSchema.safeParse(withPath).success).toBe(false);
    expect(attachmentRefSchema.safeParse({ ...ref, blobRef: "/var/lib/blobs/a.png" }).success).toBe(false);
  });

  it("an attachment is not a host-owned block", () => {
    // A person put the file there. Treating it as host-owned would mean a widget could mint one, and
    // a model could then describe a file that was never uploaded.
    expect(isHostOwnedBlock({ type: "attachment", attachment: ref })).toBe(false);
  });
});

describe("voice intent routing (T64, T65)", () => {
  const base = {
    intentId: "intent_1",
    voiceSessionId: "voice_1",
    utteranceId: "utt_1",
    text: "wait, actually move it to Friday",
    at: AT,
  };

  it("treats a spoken interruption as audio-only and never cancels the job", () => {
    const routing = routeVoiceIntent({ ...base, kind: "barge-in" });
    expect(routing.cancelsJob).toBe(false);
    expect(routing.effect).toBe("audio-only");
  });

  it("treats a correction as a new task revision, not a second task", () => {
    const routing = routeVoiceIntent({ ...base, kind: "correction" });
    expect(routing.createsTaskRevision).toBe(true);
    expect(routing.cancelsJob).toBe(false);
  });

  it("cancels only on an explicit cancel", () => {
    expect(routeVoiceIntent({ ...base, kind: "cancel" }).cancelsJob).toBe(true);
    for (const kind of ["barge-in", "new-task", "correction", "status-question", "acknowledgement"] as const) {
      expect(routeVoiceIntent({ ...base, kind }).cancelsJob).toBe(false);
    }
  });
});
