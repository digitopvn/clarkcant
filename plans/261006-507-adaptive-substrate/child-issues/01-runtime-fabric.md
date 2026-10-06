# feat(runtime): canonical agent runtime fabric behind the execution-backend seam

Labels: `enhancement`, `blocked` · Parent: #507 (Phase 1)

## Summary

Generalize the current Pi-specific runtime/session seam into one runtime fabric that can run Clark work through more
than one agent runtime, using the Phase 0 contracts in `packages/contracts/src/runtime-fabric.ts`
(`RuntimeDescriptor`, `RuntimeFeatures`, `AgentRuntimeAdapter`, `SessionAuthority`, `RuntimeSessionSynopsis`).

## Dependencies

- **Blocked by #402** — the fabric must sit behind #402's execution-backend contract (Track B1: one persisted backend
  owner per run, backend choice survives restart). Do not start lifecycle work before it lands; re-read its final
  backend API first.
- Phase 0 contracts (#507).
- Unblocks: #495 (side work dispatches through the fabric), Phase 2 runtime inventories, Phase 8.
- Coordinates with #209 (placement stays host-owned) and #125 (runtime simplification).

## Scope

- Adapt the existing Pi path to `AgentRuntimeAdapter` without duplicating lifecycle semantics; `packages/pi-adapter`
  remains the only Pi SDK importer.
- Map runtime choice onto the backend seam: exactly one backend owns a Clark Run; no per-runtime process manager,
  scheduler or recovery stack.
- List / observe / stop runtime work through the canonical Work/Task surfaces and the existing Stop and Stop-all paths.
- Add at least one non-Pi runtime adapter through a native structured protocol (SDK or RPC/app server), feature-detected
  trait by trait; `unknown` stays `unknown`.
- Session authority `managed | attached | observed` enforced through `maySessionAct`; observed sessions are read-only.
- Produce `RuntimeSessionSynopsis` records; never inject transcripts into Main Clark context by default.

## Acceptance criteria

- [ ] A Clark Run has exactly one execution owner, persisted before execution, for both the Pi and the non-Pi runtime.
- [ ] Stop, Stop-all, budgets, authority revocation, effects and evidence work the same regardless of runtime.
- [ ] Runtime traits are probed, not assumed; a trait the adapter could not establish reads `unknown`.
- [ ] An observed session cannot be steered, stopped or resumed through Clark.
- [ ] Replacing the runtime that runs a task class does not change Task/Run product semantics or user-facing wording.
- [ ] No runtime, session or model identifier is required in the normal user journey; they are progressive detail.
- [ ] Windows, macOS and Linux CI pass for portable paths; OS-specific runtime discovery sits behind an adapter.
- [ ] Architecture docs EN/VI updated; `system-architecture.png` "Pi Session" relabelled runtime-neutral.

## Non-goals

- A permanent agent/runtime dashboard or session picker.
- PTY/TUI scraping as a first adapter.
- Treating all runtimes as feature-equivalent.
- A second scheduler or recovery mechanism next to #402's backend.
