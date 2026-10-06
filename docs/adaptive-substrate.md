# Adaptive agent substrate — target architecture

> English (default) · [Tiếng Việt](adaptive-substrate.vi.md)

**Date:** 06/10/2026 · **Status:** target architecture, **not shipped**. Owner: epic [#507](https://github.com/digitopvn/clarkcant/issues/507). What exists today is only the typed contracts listed in §9; no runtime reads them yet, and no user-visible behaviour described here is available. [system-architecture.md](system-architecture.md) and its [diagram](system-architecture.png) describe what runs now; when this document and either of them disagree about the present, they win.

## 1. Why

Models, agent runtimes and tools improve faster than ClarkCant can rebuild them. Clark should get better by **finding, connecting, orchestrating and replacing** the best available capabilities, not by growing every capability itself. The product philosophy says this in `AGENTS.md` ("Built for stronger models and better tools"); this document turns it into architecture.

The user-facing model does not change: **one Clark, one conversation.** Runtimes, sessions, providers, discovery sources, signals, schedules and package generations stay implementation details, summonable as progressive detail when someone asks.

## 2. Minimal core, replaceable intelligence

Specialized host code is justified where it owns something a model must not be trusted to guarantee: authority, security, deterministic state, durability, idempotency, isolation, recovery, protocol interoperability, observability, evidence, or critical UX and performance.

| Clark core stays authoritative for | Replaceable behind a contract |
|---|---|
| Principal and node identity | Model and provider |
| User intent, Task and Run identity | Planner and reasoner |
| Grants and resource ownership | Jev / decision provider |
| Secrets and credentials | Context and ranking strategy |
| Execution policy and reach-expansion consent | Model router |
| Effect ledger and reconciliation | Agent runtime |
| Durable state, Signals and persistent intents | Evaluator |
| Package generations and rollback | Capability and discovery providers |
| Artifacts | MCP / API / CLI implementations |
| Stop and cancellation | Browser and computer drivers |
| Audit, provenance and evidence; recovery | Skill implementations |
| The user-facing conversation model | Marketplace and search providers |

A model may decide; the host verifies. A runtime may execute; Clark owns authority and outcome semantics. A Marketplace may recommend; the local runtime verifies artifacts and grants. An agent may claim success; evidence decides whether the Clark Task succeeded.

## 3. Shape

```text
User ─▶ Clark (one conversation) ─▶ intent ─▶ planner (replaceable)
                                                │
                                      capability resolver
                                                │
                              resource & capability graph
                 (granted · local · runtime · peer · package · directory · endpoint · Internet)
                                                │
                                   available within grants?
                                    yes │            │ no
                                        │   discovery → reach-expansion plan → one consent
                                        └──────┬─────┘
                                     Clark Task / Run (one execution owner)
                                               │
                                    agent runtime fabric
                                               │
                                     effects + evidence
                                 ┌─────────────┴─────────────┐
                        conversation / delivery        improvement observer
                                                               │
                                                  hypothesis → skill evolution

Timer · webhook · signal source · channel · peer ─▶ persistent intent ─▶ the same Clark Task / Run
```

There is exactly one scheduler, one effect system and one task lifecycle. Background and standing work enter the same Task/Run path as a person's request.

### Where it sits in the current diagram

Nothing here adds a layer to [system-architecture.png](system-architecture.png). The runtime fabric generalizes "Pi Session" and "Worker Management" in the Core Runtime layer; the capability graph extends the "Capability Registry"; discovery providers feed from the Ecosystem layer (Package Manager, Marketplace); the reach-expansion gate is part of Jev/policy; delivery and the improvement observer sit beside the conversation timeline. When the runtime fabric ships, the diagram's "Pi Session" box should be renamed to a runtime-neutral label.

## 4. Agent runtime fabric

Clark runs work through more than one agent runtime — the bundled one today, other installed coding agents later — without assuming parity.

- Each runtime is described by a `RuntimeDescriptor`: an opaque Clark id, a display name that is only data, the node it is on, how Clark integrates with it, and a `RuntimeFeatures` record. Every trait (spawn, attach, observe, resume, fork, steer, stop, event stream, session history, model catalogue, model switching, usage, provider quota, extension/skill/MCP inventory, host approval bridge) is answered independently as `supported`, `unsupported` or `unknown`. `unknown` is never treated as support.
- Integration preference, most structured first: native SDK, native protocol (RPC / app server), structured CLI, stored-session observer, terminal reading only as a last resort.
- Session authority is explicit: `managed` (Clark started it), `attached` (joined through the runtime's control protocol), `observed` (bounded reading, no control). A recently written session file is history, not evidence the session is alive.
- **One execution backend owns each Clark Run.** The fabric generalizes the backend seam of [#402](https://github.com/digitopvn/clarkcant/issues/402); it does not add a process manager or recovery stack per runtime. Any lifecycle work waits for #402's backend ownership semantics.

## 5. Capabilities: graph, gaps and reach

**Resource & capability graph.** One host-owned model over everything Clark could use: installed capabilities and packages, projects and host resources, runtime-provided plugins, skills and MCP servers, peer capability summaries ([#264](https://github.com/digitopvn/clarkcant/issues/264)), directory and Marketplace listings ([#194](https://github.com/digitopvn/clarkcant/issues/194)), known endpoints and Internet results. "Graph" is a domain model; SQLite plus typed providers is enough. The Main agent asks one question — "what could help with X?" — instead of calling one search tool per provider.

**Candidates never grant.** A `CapabilityCandidate` carries provenance (provider, origin, trust: `verified`, `publisher-claimed` or `unverified`) and facts for ranking, but no field that grants, enables or installs. It may be acquired only in a verifiable form: an exact package (local path, pinned git revision, exact registry version), a digested artifact, an exact CLI package version, a known MCP/WebMCP endpoint or an OpenAPI document. There is no form for "run this command", so a web page's `curl … | sudo bash` cannot become an acquisition.

**Capability gaps, bounded curiosity.** A missing capability is a gap to resolve, not a dead end. Resolution walks from least to most new reach — already granted, local, installed runtimes, paired nodes, installed packages, directories, known endpoints, the Internet — and prefers, after fit: already available, no new credential, no install, smaller filesystem/network/data reach, stronger provenance, compatibility, cost, latency. Discovery starts only for a reason (missing capability, failed approach, low confidence, unavailable runtime, insufficient result, user request, recurring gap, standing intent) and is bounded by a budget (time, providers, candidates, tokens, cost, furthest source). Ambient exploration is a standing intent the person set up, never an invisible crawler.

**Reach-expansion gate.** *Autonomous within granted reach; explicit consent before expanding it.* When closing a gap needs new reach — a new host folder, installing or enabling code, connecting a server or account, a new network origin or data recipient, new access for another runtime or node — every step is gathered into one `ReachExpansionPlan`: the goal, the recommended option and real alternatives, each option's steps, filesystem scope, network origins, data recipients, credentials (by name, never value), runtime/node grants and trust lane, and the consent scopes on offer (`once`, `task`, `standing`). Consent binds to that reach item by item: a later request reaching further is a new question, one reaching less is covered. Whether to ask at all stays with Jev/policy. After consent, the host acquires through its existing install/connection paths, verifies the capability, and resumes the original task without the person restating it.

## 6. Standing work, signals and delivery

- **Standing intents v2** reuse the Signal → Intent → Effect core of [#197](https://github.com/digitopvn/clarkcant/issues/197). Schedules move to a deterministic calendar form (RRULE plus timezone, bounds, explicit misfire handling); natural language compiles to it once.
- **Execution envelope.** A standing intent's work is bounded by an `ExecutionEnvelope`: folders where there are folders, capabilities, account connections, allowed effects, data classes, executor constraints (nodes and required runtime traits, never a runtime name), budget and delivery targets. "Summarise important email every morning" needs no fake folder. A run, retry or delegation started from an envelope may narrow it, never widen it.
- **Signal sources** become a package facet that only receives, verifies and normalizes into Signals; dedupe, matching, retries, Task creation and recovery stay in the core.
- **Delivery router.** One canonical notice or result routes to the conversation, Inbox, OS notification, web push or an external channel ([#199](https://github.com/digitopvn/clarkcant/issues/199)). Sending to a channel is a `communication` effect, and a connected channel is usable by a standing intent only when its envelope names it.

## 7. Context and orchestration UX

Main Clark carries a bounded `RuntimeSessionSynopsis` per runtime session (authority, state and where it was read from, goal, task, usage, quota, recent outcome, artifacts, data class), never transcripts by default. The context planner of [#433](https://github.com/digitopvn/clarkcant/issues/433) decides when a session matters and loads redacted detail lazily. Parallel work appears as a transient Work Plan mini app that describes work, not runtimes; runtime, model and session identifiers are progressive detail.

## 8. Improvement

- **Improvement observer** reads observable evidence (outcomes, corrections, failures, fallbacks, retries, repeated approvals, unknown effects, context misses, cost/latency outliers), never hidden reasoning, and proposes an `ImprovementHypothesis` only with enough evidence.
- **Skill evolution** goes through immutable candidate revisions: hypothesis, candidate, eval suite against a control, canary, promotion, monitoring, rollback. A candidate that widens permissions, network or data reach takes the normal package/reach approval path.
- **Core self-improvement** only through branch/worktree, tests, review, PR, CI and the normal release path. Trusted core is never hot-patched.

## 9. Contracts that exist today

These are pure, runtime-validated contracts in `packages/contracts`, with unit tests. They are versioned (`version: 1`) and carry no runtime, vendor or model names.

| Contract | File | Purpose |
|---|---|---|
| `RuntimeDescriptor`, `RuntimeFeatures`, `RuntimeStatus`, `AgentRuntimeAdapter`, `SessionAuthority`, `RuntimeSessionSynopsis` | [`runtime-fabric.ts`](../packages/contracts/src/runtime-fabric.ts) | Describe runtimes and sessions without faked parity |
| `CapabilityCandidate`, `AcquisitionSource`, `DiscoveryBudget`, `CapabilityQuery`, `CapabilityProvider` | [`capability-discovery.ts`](../packages/contracts/src/capability-discovery.ts) | Provenance-bearing candidates that grant nothing |
| `ReachExpansionPlan`, `AcquisitionPlan`, `ReachConsent`, `reachWidening`, `consentDoesNotCover` | [`reach-expansion.ts`](../packages/contracts/src/reach-expansion.ts) | One coherent question; consent bound to reach |
| `ExecutionEnvelope`, `DeliveryTarget`, `envelopeWidening` | [`execution-envelope.ts`](../packages/contracts/src/execution-envelope.ts) | Standing work's authority boundary (sketch) |

None of these is on a public surface yet; [open-interfaces.md](open-interfaces.md) is unchanged until one is.

## 10. Order of work

Contracts and read-only inventory may proceed beside #402. Anything that would create a second execution owner, scheduler, checkpoint/recovery mechanism or a direct conversation-to-runtime lifecycle waits for #402. Cross-project side work ([#495](https://github.com/digitopvn/clarkcant/issues/495)) dispatches through the fabric rather than a runtime-specific path. Multi-node continuity ([#209](https://github.com/digitopvn/clarkcant/issues/209)) stays compatible but does not block local phases. The phases and their dependencies are tracked as child issues of #507.
