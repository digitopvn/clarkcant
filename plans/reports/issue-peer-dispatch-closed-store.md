During #300 verification, a delayed peer delegation callback dispatched a task after the node's SQLite connection closed. All assertions passed, but Vitest correctly failed on the unhandled rejection.

Reproduced on #368 head 2042b8ae with both `pnpm verify:full` and the isolated `pnpm exec vitest run apps/runtime/test/peer-delegation.spec.ts` (27 assertions passed, one unhandled error). Stack: `delegation.ts` deferred `startTask` → `delegation-handlers.ts` → dispatcher `pump/runOne` → `getTask`, `ERR_INVALID_STATE: database is not open`.

The dispatcher assumes storage remains open when a delayed caller arrives. The lifecycle boundary must refuse dispatch after storage closes, without starting a worker or attempting a refusal write on the closed connection. Already persisted work remains for normal boot recovery.

Acceptance:
- A deterministic real-SQLite regression closes storage before a deferred dispatch, then proves dispatch returns false with no worker/settlement callback or unhandled rejection.
- Normal live dispatch, shutdown admission refusal and peer delegation/recovery behavior remain unchanged.
- The peer-delegation suite and full verification pass without suppressing unhandled errors or weakening assertions.
- Linux Node 22.19/24, macOS and Windows CI remain green. `DatabaseSync.isOpen` exists from Node 22.15 (verified against the official v22.19.0 source docs).

This blocks final local verification for #300; keep the repair as a focused commit in #368 so its final tree and all CI cover the fix.
