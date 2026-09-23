import { describe, expect, it } from "vitest";

import { instantSchema } from "@clarkcant/contracts";
import { NEVER_FORWARDED, BUILTIN_PROFILES, buildEnvironment, runUnderProfile } from "@clarkcant/execution-supervisor";
import { driverUsable, probePlatformCapabilities } from "@clarkcant/host-adapters";
import { connectionUsable, createPkcePair, s256, validateEndpoint, verifyScopes, verifyState } from "@clarkcant/integration-sdk";
import { canPerformAuth, normalizeMcpTool, toolSetDigest, verifyTokenAudience } from "@clarkcant/mcp-adapters";
import { assembleUtterance } from "@clarkcant/contracts";
import { applyIntent, beginListening, createVoiceSessionState, end, ingestTranscript, mute } from "@clarkcant/voice-adapters";
import { activeGenerationId, activateFacet, createFacetHost, decideRequirementAction, rankCandidates, validateManifest } from "@clarkcant/capability-host";
import { CatalogRegistry, buildSandboxPolicy, prepareBlocksForRender, validateProps } from "../src/index.ts";

import { normalizeTime, buildAgenda, classifyWriteOutcome, findConflicts, freshnessOf } from "../../../packs/google-calendar/src/index.ts";
import { captureAllowed, inputAllowed, validateForegroundTarget } from "../../../packs/computer-macos/src/index.ts";
import { platformSupports, validateProfile } from "../../../packs/computer-linux-desktop/src/index.ts";
import { managedProfileDescriptor, resolveLocator } from "../../../packs/browser-playwright/src/index.ts";

const AT = instantSchema.parse("2026-09-16T04:00:00.000Z");

describe("execution profiles (T22)", () => {
  it("never forwards a credential-bearing environment variable to a child", () => {
    const hostile: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      AWS_SECRET_ACCESS_KEY: "leak",
      GITHUB_TOKEN: "leak",
      OPENAI_API_KEY: "leak",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    };
    const env = buildEnvironment(BUILTIN_PROFILES.build!, hostile);
    for (const name of NEVER_FORWARDED) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
  });

  it("refuses to run untrusted code under process-only containment", async () => {
    const outcome = await runUnderProfile({
      command: "node",
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      profile: BUILTIN_PROFILES["read-only-inspect"]!,
      codeIsUntrusted: true,
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.status === "refused" && outcome.reason).toContain("not sufficient for untrusted code");
  });

  it("runs a trusted command and reports its exit status", async () => {
    const outcome = await runUnderProfile({
      command: "node",
      args: ["-e", "process.stdout.write('ok')"],
      cwd: process.cwd(),
      profile: BUILTIN_PROFILES["read-only-inspect"]!,
    });
    expect(outcome.status).toBe("exited");
    expect(outcome.status === "exited" && outcome.stdout).toBe("ok");
  });
});

describe("platform driver gating (T57, T60)", () => {
  it("reports a Linux host without a display as unable to run a virtual desktop", () => {
    const caps = probePlatformCapabilities({ platform: "linux", hasDisplayEnv: false, containerRuntimeAvailable: true });
    const usable = driverUsable(caps, "computer-linux-desktop");
    expect(usable.usable).toBe(false);
    expect(usable.usable === false && usable.reason).toContain("display server");
  });

  it("refuses the macOS driver on a non-macOS host", () => {
    const caps = probePlatformCapabilities({ platform: "linux", hasDisplayEnv: true, containerRuntimeAvailable: true });
    expect(driverUsable(caps, "computer-macos").usable).toBe(false);
  });

  it("keeps capture and input permissions separate on macOS (T57)", () => {
    expect(inputAllowed({ accessibility: "denied", screenCapture: "granted" }).allowed).toBe(false);
    expect(captureAllowed({ accessibility: "granted", screenCapture: "denied" }).allowed).toBe(false);
    expect(inputAllowed({ accessibility: "unknown", screenCapture: "unknown" }).allowed).toBe(false);
  });

  it("revalidates the foreground target before sending input (T58)", () => {
    const mismatch = validateForegroundTarget({
      observedWindowRef: "win_a",
      observedScale: 2,
      currentWindowRef: "win_b",
      currentScale: 2,
    });
    expect(mismatch.valid).toBe(false);
    const scaleChange = validateForegroundTarget({
      observedWindowRef: "win_a",
      observedScale: 2,
      currentWindowRef: "win_a",
      currentScale: 1,
    });
    expect(scaleChange.valid).toBe(false);
  });

  it("routes a macOS-application task to a Mac node instead of failing quietly", () => {
    const decision = platformSupports({ needsMacApplication: true, needsGui: true });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.suggestedTarget).toBe("macos-node");
  });

  it("refuses a runner profile that mounts the host home or opens egress", () => {
    const bad = validateProfile({
      width: 1280,
      height: 800,
      depth: 24,
      mounts: [{ containerPath: "/host", hostPath: process.env.HOME ?? "/root", readOnly: false }],
      egress: "open",
    });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe("browser driver locator staleness (T53)", () => {
  it("asks for re-observation rather than clicking a stale reference", () => {
    const resolution = resolveLocator(
      { observationId: "obs_1", elementRefs: ["el_1"] } as never,
      { elementRef: "el_9" },
    );
    expect(resolution.status).toBe("needs-reobservation");
    expect(resolution.status === "needs-reobservation" && resolution.reason).toContain("observe");
  });

  it("refuses a managed profile with no allowed origins", () => {
    const result = managedProfileDescriptor({ profileName: "p", nodeId: "node_a", allowedOrigins: [] });
    expect("refused" in result).toBe(true);
  });
});

describe("OAuth and scope machinery (T30, T35)", () => {
  it("derives a PKCE challenge from the verifier", () => {
    const pair = createPkcePair();
    expect(pair.method).toBe("S256");
    expect(s256(pair.verifier)).toBe(pair.challenge);
    expect(pair.verifier).not.toBe(pair.challenge);
  });

  it("compares state in constant time and rejects a mismatch", () => {
    const state = "abc123";
    expect(verifyState(state, state)).toBe(true);
    expect(verifyState(state, "abc124")).toBe(false);
    expect(verifyState(state, "abc1234")).toBe(false);
  });

  it("reports partial consent instead of implying full access", () => {
    const partial = verifyScopes({ requestedScopes: ["read", "write"], optionalScopes: ["write"] }, ["read"]);
    expect(partial.status).toBe("full");
    const missing = verifyScopes({ requestedScopes: ["read", "write"], optionalScopes: [] }, ["read"]);
    expect(missing.status).toBe("partial");
    expect(missing.missingRequired).toEqual(["write"]);
    expect(verifyScopes({ requestedScopes: ["read"], optionalScopes: [] }, []).status).toBe("denied");
  });

  it("does not report a connection as usable without a passed probe", () => {
    const notProbed = connectionUsable({
      status: "connected",
      grantedScopes: ["read"],
      requiredScopes: ["read"],
      lastProbeResult: "not-run",
    });
    expect(notProbed.usable).toBe(false);
    expect(
      connectionUsable({ status: "connected", grantedScopes: ["read"], requiredScopes: ["read"], lastProbeResult: "pass" }).usable,
    ).toBe(true);
  });

  it("refuses an endpoint outside the declared allowlist and any non-HTTPS origin", () => {
    expect(validateEndpoint({ url: "https://evil.example.invalid/token", allowedOrigins: ["https://good.example.invalid"] }).ok).toBe(false);
    expect(validateEndpoint({ url: "http://good.example.invalid/token", allowedOrigins: ["http://good.example.invalid"] }).ok).toBe(false);
    expect(validateEndpoint({ url: "https://good.example.invalid/token", allowedOrigins: ["https://good.example.invalid"] }).ok).toBe(true);
  });
});

describe("MCP normalization and audience checks (T35)", () => {
  it("classifies a tool as a write unless it claims to be read-only and idempotent", () => {
    const silent = normalizeMcpTool("srv", { name: "do", inputSchema: {} });
    expect(silent.effectCategory).toBe("external-write");
    expect(silent.safeWithoutApproval).toBe(false);

    const readOnly = normalizeMcpTool("srv", {
      name: "list",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    });
    expect(readOnly.effectCategory).toBe("read");
    expect(readOnly.safeWithoutApproval).toBe(true);
  });

  it("treats a destructive hint as destructive even when read-only is also claimed", () => {
    const tool = normalizeMcpTool("srv", {
      name: "purge",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: true },
    });
    expect(tool.effectCategory).toBe("destructive");
  });

  it("invalidates a tool set digest when a schema changes", () => {
    const a = toolSetDigest([{ name: "t", inputSchema: { type: "object" } }]);
    const b = toolSetDigest([{ name: "t", inputSchema: { type: "object", required: ["x"] } }]);
    expect(a).not.toBe(b);
  });

  it("refuses a server whose only registration method is pre-registered clients", () => {
    const decision = canPerformAuth({
      authorizationServers: ["https://auth.example.invalid"],
      registrationMethods: ["static"],
    });
    expect(decision.possible).toBe(false);
    expect(decision.possible === false && decision.reason).toContain("pre-registered");
  });

  it("refuses to forward a token issued for a different resource", () => {
    expect(verifyTokenAudience({ tokenAudience: "https://a.example.invalid", expectedResource: "https://b.example.invalid" }).ok).toBe(false);
    expect(verifyTokenAudience({ tokenAudience: ["https://b.example.invalid"], expectedResource: "https://b.example.invalid" }).ok).toBe(true);
  });
});

describe("voice media focus and transcript assembly (T64, T65, T67)", () => {
  it("refuses a second exclusive microphone owner and names the holder (T67)", () => {
    let state = createVoiceSessionState("voice_1");
    const begun = beginListening(state);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    state = begun.state;

    const again = beginListening({ ...state, mediaFocus: { ...state.mediaFocus, microphoneOwner: "call" } });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.heldBy).toBe("call");
  });

  it("actually releases the device on mute", () => {
    const begun = beginListening(createVoiceSessionState("voice_1"));
    if (!begun.ok) throw new Error("expected focus");
    const muted = mute(begun.state);
    expect(muted.mediaFocus.microphoneOwner).toBeUndefined();
    expect(muted.mediaFocus.assistantMuted).toBe(true);
    expect(muted.state).toBe("idle");
  });

  it("releases the microphone and speaker when the session ends", () => {
    const begun = beginListening(createVoiceSessionState("voice_1"));
    if (!begun.ok) throw new Error("expected focus");
    const ended = end(begun.state);
    expect(ended.state).toBe("ended");
    expect(ended.mediaFocus.microphoneOwner).toBeUndefined();
    expect(ended.mediaFocus.speakerOwners).toEqual([]);
  });

  it("does not duplicate text from a repeated fragment", () => {
    const fragment = {
      voiceSessionId: "voice_1",
      utteranceId: "utt_1",
      fragmentIndex: 0,
      isFinal: true,
      text: "hello ",
      role: "user" as const,
      at: AT,
      sequence: 1,
    };
    const assembly = assembleUtterance([fragment, fragment]);
    expect(assembly.text).toBe("hello ");
    expect(assembly.duplicateFragments).toBe(1);
  });

  it("emits one intent per completed utterance and never one for a partial", () => {
    const state = createVoiceSessionState("voice_1");
    const partial = ingestTranscript(
      state,
      {
        voiceSessionId: "voice_1",
        utteranceId: "utt_1",
        fragmentIndex: 0,
        isFinal: false,
        text: "wait, ",
        role: "user",
        at: AT,
        sequence: 1,
      },
      () => "barge-in",
    );
    expect(partial.intent).toBeUndefined();

    const complete = ingestTranscript(
      partial.state,
      {
        voiceSessionId: "voice_1",
        utteranceId: "utt_1",
        fragmentIndex: 1,
        isFinal: true,
        text: "actually move it to Friday",
        role: "user",
        at: AT,
        sequence: 2,
      },
      () => "correction",
    );
    expect(complete.intent?.kind).toBe("correction");
    expect(complete.text).toBe("wait, actually move it to Friday");
  });

  it("does not cancel work on a barge-in (T64)", () => {
    const applied = applyIntent(createVoiceSessionState("voice_1"), {
      intentId: "i1",
      voiceSessionId: "voice_1",
      utteranceId: "u1",
      kind: "barge-in",
      text: "hold on",
      at: AT,
    });
    expect(applied.routing.cancelsJob).toBe(false);
  });
});

describe("capability host (T24)", () => {
  it("refuses to replace a facet that needs a worker handoff", () => {
    const host = createFacetHost();
    const result = activateFacet(host, {
      facetKind: "tools",
      isolation: "trusted-native",
      generationId: "g1",
      at: AT,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("REFRESH_SCOPE_UNSUPPORTED");
  });

  it("activates a UI facet in place and keeps the previous generation addressable", () => {
    let host = createFacetHost();
    const first = activateFacet(host, { facetKind: "ui", isolation: "isolated-ui", generationId: "ui-1", at: AT });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    host = first.state;
    const second = activateFacet(host, { facetKind: "ui", isolation: "isolated-ui", generationId: "ui-2", at: AT });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(activeGenerationId(second.state, "ui")).toBe("ui-2");
    expect(second.state.facets.get("ui")?.previousGenerationId).toBe("ui-1");
  });

  it("ranks a first-party recipe above public research and prefers fewer permissions", () => {
    const ranked = rankCandidates([
      { tier: "public-research", id: "c", version: "1.0.0", sourceUrl: "u", digest: "d", notes: "", requestedCapabilityCount: 1 },
      { tier: "first-party-recipe", id: "b", version: "1.0.0", sourceUrl: "u", digest: "d", notes: "", requestedCapabilityCount: 5 },
      { tier: "first-party-recipe", id: "a", version: "1.0.0", sourceUrl: "u", digest: "d", notes: "", requestedCapabilityCount: 2 },
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects a manifest that asks for a wildcard origin or a remote facet entry", () => {
    const result = validateManifest({
      id: "p",
      version: "1.0.0",
      hostApi: { min: 1, max: 1 },
      facets: [{ kind: "ui", entry: "https://cdn.example.invalid/widget.js", isolation: "isolated-ui" }],
      requestedCapabilities: [],
      permissions: { networkOrigins: ["*"], filesystem: [], microphone: false, camera: false, lifecycleScripts: [] },
      platforms: ["darwin-arm64"],
    } as never);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.length).toBeGreaterThanOrEqual(2);
  });

  it("distinguishes repair from install from connect", () => {
    expect(decideRequirementAction({ installed: false, loaded: false, authenticated: false, healthy: false })).toBe("install");
    expect(decideRequirementAction({ installed: true, loaded: false, authenticated: false, healthy: false })).toBe("repair");
    expect(decideRequirementAction({ installed: true, loaded: true, authenticated: false, healthy: true })).toBe("connect");
    expect(decideRequirementAction({ installed: true, loaded: true, authenticated: true, healthy: true })).toBe("none");
  });
});

describe("google calendar integration logic (T36, T38)", () => {
  it("keeps an all-day date apart from a timed instant", () => {
    const allDay = normalizeTime({ date: "2026-09-16", fallbackTimeZone: "Asia/Ho_Chi_Minh" });
    expect(allDay.ok && allDay.time.kind).toBe("date");
    const timed = normalizeTime({ dateTime: "2026-09-16T09:00:00Z", fallbackTimeZone: "Asia/Ho_Chi_Minh" });
    expect(timed.ok && timed.time.kind).toBe("timed");
    expect(normalizeTime({ date: "16/09/2026", fallbackTimeZone: "UTC" }).ok).toBe(false);
    expect(normalizeTime({ date: "2026-09-16", dateTime: "2026-09-16T09:00:00Z", fallbackTimeZone: "UTC" }).ok).toBe(false);
  });

  it("drops cancelled instances from an agenda and orders by start", () => {
    const agenda = buildAgenda([
      { id: "b", summary: "later", start: { kind: "timed", dateTime: "2026-09-16T10:00:00Z", timeZone: "UTC" }, end: { kind: "timed", dateTime: "2026-09-16T11:00:00Z", timeZone: "UTC" }, status: "confirmed", etag: "1" },
      { id: "x", summary: "cancelled", start: { kind: "timed", dateTime: "2026-09-16T08:00:00Z", timeZone: "UTC" }, end: { kind: "timed", dateTime: "2026-09-16T09:00:00Z", timeZone: "UTC" }, status: "cancelled", etag: "1" },
      { id: "a", summary: "earlier", start: { kind: "timed", dateTime: "2026-09-16T09:00:00Z", timeZone: "UTC" }, end: { kind: "timed", dateTime: "2026-09-16T09:30:00Z", timeZone: "UTC" }, status: "confirmed", etag: "1" },
    ]);
    expect(agenda.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("detects an overlap before the user confirms a move", () => {
    const existing = [
      { id: "e1", summary: "standup", start: { kind: "timed" as const, dateTime: "2026-09-17T09:00:00Z", timeZone: "UTC" }, end: { kind: "timed" as const, dateTime: "2026-09-17T09:30:00Z", timeZone: "UTC" }, status: "confirmed" as const, etag: "1" },
    ];
    const conflicts = findConflicts(
      {
        start: { kind: "timed", dateTime: "2026-09-17T09:15:00Z", timeZone: "UTC" },
        end: { kind: "timed", dateTime: "2026-09-17T09:45:00Z", timeZone: "UTC" },
      },
      existing,
    );
    expect(conflicts).toHaveLength(1);
  });

  it("treats a submit timeout as unknown rather than repeating the create (T38)", () => {
    expect(classifyWriteOutcome({ timedOut: true, readBackFoundEvent: false })).toBe("unknown");
    expect(classifyWriteOutcome({ timedOut: true, readBackFoundEvent: true })).toBe("confirmed");
    expect(classifyWriteOutcome({ httpStatus: 412, timedOut: false, readBackFoundEvent: false })).toBe("conflict");
    expect(classifyWriteOutcome({ httpStatus: 200, timedOut: false, readBackFoundEvent: true })).toBe("confirmed");
  });

  it("labels cached data as cached rather than live (T36)", () => {
    expect(freshnessOf({ fetchedAt: "2026-09-16T03:00:00Z", now: "2026-09-16T04:00:00Z", maxAgeMs: 300_000, online: true })).toBe("cached");
    expect(freshnessOf({ fetchedAt: "2026-09-16T03:59:00Z", now: "2026-09-16T04:00:00Z", maxAgeMs: 300_000, online: true })).toBe("live");
    expect(freshnessOf({ fetchedAt: "2026-09-16T03:59:00Z", now: "2026-09-16T04:00:00Z", maxAgeMs: 300_000, online: false })).toBe("offline");
  });
});

describe("widget host (T41, T44, T45)", () => {
  it("refuses to register two definitions under the same id and version", () => {
    const registry = new CatalogRegistry();
    const definition = {
      id: "canvas.table@1",
      version: "1.0.0",
      renderer: "catalog" as const,
      propsSchema: { type: "object", additionalProperties: false, properties: { datasetRef: { type: "string" } }, required: ["datasetRef"] },
      eventSchemas: {},
      semanticDescription: "table",
      requestedCapabilities: [],
      sizing: { compact: false, expanded: true },
      textFallback: "A table",
      effectCategories: ["read" as const],
      datasetRefs: [],
    };
    registry.register({ definition, chunk: "table", family: "tables" });
    expect(() => registry.register({ definition, chunk: "table", family: "tables" })).toThrow(/already registered/);
    expect(registry.familiesWithoutFixtures(["tables", "charts"])).toEqual(["charts"]);
  });

  it("falls back to the text alternative for unknown props instead of rendering them", () => {
    const definition = {
      id: "canvas.table@1",
      version: "1.0.0",
      renderer: "catalog" as const,
      propsSchema: { type: "object", additionalProperties: false, properties: { datasetRef: { type: "string", maxLength: 10 } }, required: ["datasetRef"] },
      eventSchemas: {},
      semanticDescription: "table",
      requestedCapabilities: [],
      sizing: { compact: false, expanded: true },
      textFallback: "A table is shown as text.",
      effectCategories: ["read" as const],
      datasetRefs: [],
    };
    const bad = validateProps(definition, { datasetRef: "way-too-long-a-reference", injected: "x" });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.problems).toContain('unknown property "injected"');
    expect(bad.ok === false && bad.fallback.type).toBe("text");
    expect(validateProps(definition, { datasetRef: "ds_1" }).ok).toBe(true);
  });

  it("never grants a custom mini-app a same-origin luxury (T45)", () => {
    const policy = buildSandboxPolicy({
      networkOrigins: [],
      microphone: false,
      camera: false,
      needsPopups: false,
      isolation: "isolated-ui",
    });
    expect(policy.iframeSandbox).not.toContain("allow-same-origin");
    expect(policy.iframeSandbox).not.toContain("allow-top-navigation");
    expect(policy.csp).toContain("connect-src 'none'");
    expect(policy.hostChromeOutsideFrame).toBe(true);
  });

  it("dropped a host card supplied by a non-host origin (T41)", () => {
    const forged = {
      type: "system-card" as const,
      owner: "host" as const,
      cardId: "c1",
      subject: "install" as const,
      title: "Installed",
      status: "done" as const,
      detail: "pretend",
      fields: [],
      cancellable: false,
      updatedAt: AT,
    };
    const prepared = prepareBlocksForRender([forged], {
      builtByHost: false,
      definitionIds: new Set<string>(),
      maxSurfaceBytes: 1024,
    });
    expect(prepared.blocks).toHaveLength(0);
    expect(prepared.rejected).toHaveLength(1);
  });
});
