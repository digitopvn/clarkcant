---
title: "#315 JobRef for long-running package capabilities"
status: completed
created: 2026-10-01
issues: [315]
related: [200, 313, 314, 316]
---

# #315 JobRef for long-running package capabilities

Pull request: [#377](https://github.com/digitopvn/clarkcant/pull/377).

## Outcome

Package services can run bounded, durable jobs through the existing action and service lanes. Widgets receive an opaque `JobRef`, can read/cancel only jobs started by their own binding, and can resume observation after remount. Jobs appear in the WorkSupervisor and Stop flow, report only service-originated progress, and are never silently replayed after restart.

## Constraints and non-goals

- Reuse #313 ArtifactRefs, #314 `invokeCapability` and the existing MCP stdio transport; do not expose paths, service processes, secrets, IPC, or new network origins to a frame.
- Use a versioned, optional long-running capability declaration; absent declaration keeps request/response behavior.
- Preserve host policy and effect-ledger decisions. A possibly dispatched effect remains uncertain after cancellation, service loss, or restart.
- No paired-node jobs, scheduler/cron, automatic retry of effectful jobs, general-purpose job queue, or resource-profile policy (owned by #316).

## Dependencies

- #313 and #314 are merged on `main`.
- #316 consumes this job/concurrency contract and follows #315.

## Phases

1. [Job contract, durable store, supervisor and service execution](phase-01-job-contract-and-execution.md)
2. [Widget bridge, SDK and dev-host simulation](phase-02-widget-bridge-and-dev-host.md)
3. [Recovery, result artifacts, notices, docs and verification](phase-03-recovery-artifacts-and-docs.md)

## Acceptance

- Job state survives frame unmount/remount and node restart; authorization binds principal, widget instance, action binding, package generation and capability.
- Service-reported progress is bounded and never invented. Cancellation reaches the active MCP request; completed output bytes become ArtifactRefs, never paths.
- Work listing, individual Stop and emergency Stop include jobs. Another principal or widget binding cannot read/cancel a job.
- Restart recovery reports interrupted jobs as failed with an honest may-have-run explanation and never re-runs them.
- Completion/failure/cancellation produces a conversation note or inbox notice naming the result or next action.
- `clark widget dev` simulates progress, completion, failure and cancellation without running a provider.
- Focused tests, `pnpm verify`, `pnpm verify:full`, `pnpm invariants`, plan validation and required GitHub CI (including Windows) pass; internal and official documentation is bilingual and merged.
