# Fix report: state-only view writes for host-held players (#380)

Date: 2026-10-03. Branch `codex/380-light-view-state-writes`. Related: #329, #324, #198.

## Problem

A playing local video or audio player writes its position at most every 3 s (#329), which is about 1,200 writes an
hour. Each write ran the full view-action path:

- it bumped the instance revision;
- it marked the widget's snapshots stale;
- it rebuilt and returned the whole timeline, which re-rendered the client;
- it appended an `action_invocations` row that was never pruned.

## Decision

The fix is a typed variant of the existing action call, `variant: "view-state"`, not a new route or protocol. An
unknown variant gets `400 INVALID_SCHEMA`, so later variants are versioned by name.

- **Gate.** `writeViewState` (`packages/core/src/widget-service.ts`) applies the same checks as a view action: owner,
  binding, operation, input, revision and digest, through the shared `ownedBinding` and `precheckInvocation` helpers.
- **Allowed bindings.** It is limited to `media.view` bindings on `MEDIA_PLAYER_DEFINITION_IDS`, which are
  `canvas.video@1` and `canvas.audio@1`. Any other binding gets `UNSUPPORTED_ACTION`.
- **Isolated frames.** Frames cannot reach the variant, because the bridge builds the ordinary call and does not forward
  a variant.
- **No revision bump.** The instance revision is not bumped, so snapshots stay current and the page's
  `expectedRevision` stays valid. No timeline is built. `touchWidget` still runs, so the next turn's semantic context is
  unchanged.
- **Bounded rows.** Each binding keeps a single upserted `action_invocations` row, keyed
  `view-state:<actionBindingId>`. That row stores the latest invocation id and digest, which is enough for retries and
  for detecting a reused key. No migration was needed. Ordinary and effectful action rows are untouched.
- **Client.** `useMediaPlayback` marks its writes `stateOnly`, and `useSurfaceRenderer` sends them with
  `GatewayClient.writeViewState`.
  - It keeps one write in flight per player and sends only the latest waiting write.
  - It sends a leaving write immediately with keepalive.
  - It keeps the answered state as an overlay.
  - It applies a timeline when an older node returns one.

## Evidence

- **`apps/runtime/test/view-state-writes.spec.ts`** (7 tests):
  - 100 light writes caused 0 timeline builds and 0 stale snapshots, while one ordinary write caused 1 of each;
  - 1,200 writes left 2 rows in total, one ordinary and one light;
  - retry and reuse, the gate, the gallery refusal, and the route's answer and its refusal of an unknown variant are all
    covered.
- **`packages/conversation-client/test/playback-coalescer.spec.ts`**: the client sends the variant to the actions route.
- **`apps/web/e2e/widget.spec.ts`** (local video): every write carries the variant, and no answer carries a timeline or
  a new revision.
- **Commands:**
  - `pnpm verify` passed: 449 test files, 5,765 tests.
  - The media-render and widget e2e passed twice, 12 of 12 each run.
  - `pnpm invariants` and `pnpm verify:full`: see the PR.

## Docs

The EN/VI files updated:

- `widget-development` §8.11
- `widgets-and-extensions`
- `open-interfaces`: the variant paragraph
- `conformance-traceability` T76
- the manifest

**Official docs.** In `clarkcant-web/docs/api.html` and `vi/docs/api.html`, the actions row (line 111) needs two
changes:

- append `variant?` to its body cell;
- append the sentence below to its description.

EN:

> With `variant: "view-state"`, a host-held video or audio player's playback state is written state-only: the same
> checks, then `200 { variant, duplicate, instanceId, revision, stateRevision, state }` with no timeline and an unchanged
> revision, keeping one invocation record per binding; any other binding gives `400 UNSUPPORTED_ACTION` and an unknown
> variant `400 INVALID_SCHEMA`.

VI:

> Với `variant: "view-state"`, trạng thái phát của trình phát video hoặc âm thanh do host giữ được ghi chỉ-state: cùng
> các bước kiểm tra, rồi trả `200 { variant, duplicate, instanceId, revision, stateRevision, state }`, không kèm
> timeline, không đổi revision, và chỉ giữ một bản ghi invocation cho mỗi binding; binding khác nhận
> `400 UNSUPPORTED_ACTION`, variant lạ nhận `400 INVALID_SCHEMA`.
