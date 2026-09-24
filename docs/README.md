# Agent — Conversation Platform Blueprint v2

> English (default) · [Tiếng Việt](README.vi.md)

**Date:** 16/09/2026 · **Status:** design blueprint. This repo already has a bootstrap implementation: real behavior is owned by the code in `apps/` and `packages/`, and verification status lives in [conformance-traceability.md](conformance-traceability.md) and the `README.md` at the repo root.

## Product decision

**The conversation is the only interface the user needs to learn.** Desktop and web are clients of a runtime installed independently on a personal machine or a VPS. Paired runtimes can hand off work, exchange data they have been granted access to, and return results into the same conversation. Widgets are interactive areas inside the conversation and can be pinned; extensions extend capabilities through the conversation itself.

The name “Agent” is only a working name; it does not lock in a brand, domain or npm scope.

## Reading order

Before changing UI/UX, read [DESIGN.md](../DESIGN.md) to stay true to the interaction direction. The working process for agents lives in [AGENTS.md](../AGENTS.md); evidence and implementation limits live in [conformance-traceability.md](conformance-traceability.md).

1. [Scope lock](scope-lock.md): goals, IN/OUT and the decisions that replace v1.
2. [System architecture](system-architecture.md): stack, process, domain, contracts, security and data.
3. [Distributed runtime](distributed-runtime.md): VPS install, pairing, remote delegation, disconnect/recovery.
4. [Widgets & extensions](widgets-and-extensions.md): rich catalog, agent-defined actions, custom mini-apps, pin and lifecycle.
5. [Widget developer standard](widget-development.md): authoring contract, SDK UX, conformance, package/publish flow and directory metadata.
6. [Installation](installation.md): cross-platform installer, interactive onboarding, Docker and VPS with HTTPS. [Integration & onboarding](integration-onboarding.md): research/install/auth/reload, Google Calendar, quick play and needs-based setup.
7. [Browser & Computer Use](browser-computer-use.md): core/pack boundary, driver, node targeting and takeover.
8. [Implementation plan](implementation-plan.md): dependencies, work packages, gates, acceptance scenarios.
9. [Research & decisions](research-and-decisions.md): upstream verification results, choices/rejected alternatives, sources.
10. [Jev selector](mini-app/jev-configuration.md): operation and privacy of the decision layer — configuration, what is sent out, telemetry, fallback.
11. [ADR-001 — Gemini Live for voice](research/adr-001-gemini-live-provider.md) and [P0.1 compatibility lock](research/compatibility-lock.md): the decision that replaces the blueprint, and the Pi SDK lifecycle as actually measured.
12. [Open interfaces](open-interfaces.md) ([Tiếng Việt](open-interfaces.vi.md)): API, MCP, WebSocket, CLI for third-party applications and AI tools.
13. [Changelog](CHANGELOG.md): old constraints that have been replaced.

The JSON files in [examples](examples/) only illustrate **the app's own contracts**; they are not the official wire protocol of Pi/MCP/A2A, nor runnable configuration before the app is implemented.

## Document precedence

Latest user request → scope-lock → system-architecture → topic documents → implementation-plan. The v2 set **replaces** the v1 scope rather than stacking on top of it. Old UI screenshots are visual reference; they do not lock topology, navigation or security promises.

[DESIGN.md](../DESIGN.md) owns the UI/UX direction; [system-architecture.png](system-architecture.png) is the current architecture diagram when it differs from the prose. These are design sources, not evidence that a feature has shipped. In particular, Autonomous is the target policy; the current command execution path still uses approval, see [model-turn.ts](../apps/runtime/src/model-turn.ts) and [gateway.ts](../apps/runtime/src/gateway.ts).

## Release scope

- First desktop client: macOS Apple Silicon; shared web client for server nodes.
- Headless runtime: Linux VPS; OCI image first, bundled Node runtime package + service installer later within the same release gate.
- Nodes of the same owner pair and exchange task/message/artifact/status; no multi-master DB sync is needed.
- Built-in rich widgets + custom sandboxed mini-apps/MCP Apps; pinned within the conversation space.
- Install/setup/auth/reload through chat with consent and rollback, with clearly stated limits.
- Browser Use and Computer Use are key capabilities, with drivers packaged as extensions; permissions and lifecycle live in core.
- Voice shares the task/action model; native mobile and a commercial marketplace are not part of this release.

## Change-scoped CI checks

The [CI](../.github/workflows/ci.yml) workflow keeps the verify, secret scan, browser E2E and desktop smoke gates. The [classifier](../tools/ci-test-scope.mjs) only trims the steps of the verify job when the entire diff belongs to the allowed prose list or `docs/manifest.json`; invariants still run. The remaining gates are not skipped by this classifier. A diff with code, an unknown path, a missing base or a classification error still runs in full.

Changes that include code still run the full Vitest suite on both Node versions; tests are not selected per package because many safety constraints cut across packages. The journey check commands and the completion requirements for UI changes are in [AGENTS.md](../AGENTS.md); CI already has browser E2E and desktop smoke, but fixtures do not prove that a real provider works. A BLOCKED result must be read together with the missing condition.

Live suites only run when opted in. Once enabled, if a credential/model is missing or no evidence is received from the provider, the smoke/calibration fails with reason `BLOCKED`; it does not turn into PASS through a fallback. [Live smoke](../apps/runtime/test/jev-live.spec.ts) and [calibration](../apps/runtime/test/jev-calibration-live.spec.ts) own the execution conditions; a generic HTTP error does not prove a correct model rejection.

Run `node tools/scan-secret-history.mjs` to check a fully fetched Git history; the [scan script](../tools/scan-secret-history.mjs) owns the detection patterns and output limits. The scope covers file versions still reachable in history, including documents and deleted files; this is a pattern-based check and does not prove that every kind of secret is detected. A shallow clone or an unreadable Git repository makes the check fail. Results only state the object ID and pattern type, never the secret value.

## Four statements that must not be advertised falsely

“Package installed” does not mean “integration usable”. “Local-first” does not mean “data never leaves the machine”. “UI closed” does not mean “work on the VPS stopped”. “Signed/iframe/container” does not mean “absolutely safe”.

Sources [R01–R30](research-and-decisions.md#nguồn-chính-thức) confirm the upstream primitives. The concrete architecture, limits, protocols and milestones are design decisions of this document set, not features already available in Pi.
