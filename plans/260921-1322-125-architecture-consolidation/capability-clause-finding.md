# The capability-effect clause: why it cannot be satisfied by wiring

The completion auditor requires "one canonical execution policy governs command, widget, install, and capability effects". Three surfaces are wired — command, install and widget all reach the canonical resolver. The fourth is not, and this file records the proof that the gap is a missing product path rather than a missing call.

## The claim, tested

A focused attempt was made to wire `preflightCapability` (`apps/runtime/src/preflight.ts:305`, whose only non-test hit is its own definition) into the one production admission point that appeared to exist: `packages/core/src/widget-service.ts:1180`, which branches on `binding.proposal.kind !== "view"` and answers `UNSUPPORTED_ACTION`.

That point cannot be the fix, for two independent reasons.

**1. Nothing in production ever produces the surface it guards.** The branch requires a non-view binding (`invoke`, `agent`, `workflow`) to exist. Verified mechanically across every non-test source tree:

```
$ grep -rn 'kind: "invoke"\|kind: "agent"\|kind: "workflow"' apps/*/src packages/*/src packs/*/src examples/*/src
0 hits
```

Every construction of such a binding anywhere in the repository is in a unit test. The only production compiler of action bindings, `apps/runtime/src/compose-mini-app.ts:730-775`, hard-codes `{ kind: "view", operation, args: {} }` at `:751`. The only writer of binding rows is `captureCompositeSurface` (`packages/core/src/widget-service.ts:669`), fed from that same view-only list, plus `saveActionBinding` (`:736`) whose only caller is `bindAgentAction` (`packages/core/src/consent.ts:101`) — which has no production caller. The frame protocol cannot propose one either: `packages/widget-sdk/src/index.ts:84` sends only `action.invoke`, and the host bridge at `packages/widget-host/src/session.ts:196` only invokes an id it was given.

**2. The branch refuses unconditionally, so a preflight there could only change which refusal wins — and would make it worse.** `widget-service.ts:1205-1221` returns `UNSUPPORTED_ACTION` regardless. A capability-existence preflight placed ahead of it would replace "this node has no executor for it yet" with "discover it first", which is misleading precisely because discovering the capability changes nothing: the node has no executor for any non-view action. That is the anti-pattern `packages/execution-supervisor/src/native-binding.ts:12-16` exists to prevent, and the ordering there is the reverse — a binding that cannot run is refused before permission is discussed.

## Every other candidate, checked and rejected

- `packages/core/src/consent.ts:72-79` already performs the same discovery check inline; with no production caller, replacing it would change nothing observable.
- `packages/core/src/capability-registry.ts:245` decides readiness, not existence, and has no non-test caller.
- `packages/core/src/conductor.ts:895` (`runDispatchedTask`) is post-hoc evidence verification, takes no capability ref, and has no non-test caller.
- `packages/core/src/conductor.ts:576-596` takes its ref from `listCapabilitySummaries(…, { usableOnly: true })`, so an existence preflight there is vacuous by construction; and the branch is unreachable today because `isUsable` (`packages/contracts/src/grants.ts:91-99`) requires `authenticated && authorized`, which nothing in production sets.
- `apps/runtime/src/pack-load.ts` is a load probe, not an effect admission, and was excluded as cosmetic.
- `packages/widget-host/src/session.ts:231` is a brokering permission, not a discovery check.

## What this means

The clause is unmet, and it cannot be met by wiring a call. Satisfying it requires a production capability-effect path — something that creates a non-view binding or invokes a capability — with the host preflight at its admission. That is new product scope, not part of the six phases this program was scoped to deliver.

## Two findings worth keeping

1. **A real grant-authority defect, live and unfixed.** `apps/runtime/src/routes/conversations.ts:160` forwards the widget manifest's `requestedCapabilities` as the brokered list, and `packages/conversation-client/src/DesktopSurfaces.tsx:511` passes that through as `brokeredCapabilities`. The manifest is request metadata (`packages/core/src/widget-package.ts:16`), so the host is treating a request as a grant. The correct behaviour is to intersect the request with what the node actually holds. This is also one of the reopened #93's P1 items and is recorded there. It was **not** fixed here because it changes widget capability grants and needs an explicit owner decision.
2. **A drifted comment.** `apps/runtime/src/preflight.ts:301-303` claims two paths share one message, but `consent.ts:77` is English and `preflight.ts:315` is Vietnamese, so they have already diverged.

## Honest status of the two clauses the audit named

| Clause | Status |
| --- | --- |
| Install closure consumed by a real path | Partially. The route now consumes its frozen closure through the locked-build path's own reader and admission and reports the refusal in the install result. "A build fails rather than re-resolving floating ranges" stays unproven: there is no production step of that kind, and no dependency metadata source able to answer what a range resolves to. |
| Capability effects governed | Not achievable within scope. Proven above: no production producer of the surface exists. |
