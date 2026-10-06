# feat(automation): standing intents v2 with calendar schedules and a generic execution envelope

Labels: `enhancement` · Parent: #507 (Phase 5)

## Summary

Extend the #197 Signal → Intent → Effect core so standing work can be scheduled on a deterministic calendar and be
bounded by an `ExecutionEnvelope` (`packages/contracts/src/execution-envelope.ts`) instead of folder-only task actions.

## Dependencies

- #197 (done) — reuse its storage, dedupe, intent runs and recovery. No second scheduler.
- Phase 0 envelope sketch.
- Executor runtime constraints (`requiredFeatures`) need Phase 1; node constraints reuse existing peer executor grants.
- Delivery to external channels needs Phase 7; conversation/Inbox delivery can land here.
- Task dispatch must use the canonical backend; any run-lifecycle change waits for #402.

## Scope

- Schedule form: one-shot, interval, calendar recurrence (iCalendar RRULE + IANA timezone), start/end bounds, explicit
  misfire/catch-up policy, bounded jitter only where appropriate. Natural language compiles to it once; execution is
  deterministic. A new storage migration (never edit an applied one).
- Persist the envelope with the intent; enforce it at dispatch; `envelopeWidening` guards runs, retries and delegations.
- Capability/connection-scoped tasks without fake filesystem resources.

## Acceptance criteria

- [ ] "Every weekday at 8:00 Asia/Saigon" fires deterministically across DST/timezone changes and restarts.
- [ ] A routine runs with only capabilities/connections, no folder.
- [ ] Restart or delivery retry never duplicates Task creation or silently replays an unknown effect.
- [ ] A run never exceeds its envelope; widening is refused or asked about.
- [ ] Existing `{ at }` / `{ everyMinutes }` intents keep working (migration tested).
- [ ] Focused tests, `pnpm verify`, docs EN/VI, `open-interfaces` updated if the automation surface changes.

## Non-goals

- A new scheduler, worker pool or automation dashboard.
- Model re-interpretation of the schedule at run time.
