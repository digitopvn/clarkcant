---
title: "Phase 4: Snapshot, live ownership và actions"
status: done
---

# Phase 4: Snapshot, live ownership và actions

## Overview
- P1; effort ~4 agent-hours; lane L2 tiếp sau Phase 3, song song Phase 8. Depends on Phase 1 và 3.
- Context: [report §3](../reports/analysis-260917-1211-jev-mini-app-rendering.md).
- Hoàn thiện tương tác trước khi đưa Jev vào turn; không dùng model để che action no-op.

## Architecture / requirements

History render từ snapshot bundle, không từ instanceById/current props. Timestamp + captured revision luôn có; nút host-owned “Mở bản hiện tại” mở cùng instance. Snapshot không chạy mutation bindings cũ. Live UI được chuyển giữa inline/expanded/pinned theo một owner token; vị trí còn lại là snapshot/read-only reference. Khi mất owner hoặc conflict, UI báo và yêu cầu refresh, không tự takeover.

Timeline DTO tách snapshots và live instances. Snapshot IDs/message sequences immutable; client merge theo stable message id + sequence, không overwrite captured data từ live response. Response tới muộn chỉ cập nhật live state nếu revision không lùi. Poll/reconnect/restart không gọi Jev.

## Related files
Root: `/Volumes/GOON/www/digitop/clarkcant/`.
- Modify `apps/runtime/src/services.ts`: buildTimeline snapshot/live DTO, authorized bundle resolution.
- Modify `apps/runtime/src/gateway.ts`: scoped action/state/ownership/bundle routes.
- Modify `packages/core/src/widget-service.ts`: dispatch through existing authorization/binding/state primitives; atomic save-view behavior.
- Modify `packages/conversation-client/src/api.ts`: typed transport và error mapping.
- Modify `packages/conversation-client/src/Conversation.tsx`: snapshot renderer input, real action callback, live open/pin lifecycle.
- Modify `packages/conversation-client/src/blocks.tsx`: forward snapshot identity/ref thay vì chỉ instance + revision.
- Modify `packages/conversation-client/src/DesktopSurfaces.tsx`: expanded/pinned reuse, ownership cleanup.
- Create `apps/runtime/test/mini-app-actions.spec.ts` và `packages/core/test/mini-app-ownership.spec.ts`.

## API (theo convention đã có: REST tree `/conversations/:id/…` trong `apps/runtime/src/gateway.ts:182–304`, bearer auth, JSON)
- `POST /conversations/:conversationId/widgets/:instanceId/actions`: existing ActionInvocation schema; URL/body instance match; principal authorized trên conversation và instance.
- `GET /conversations/:conversationId/widgets/:instanceId/live`: current state/spec revision/bindings được phép.
- `GET /conversations/:conversationId/snapshots/:snapshotId/presentation`: immutable bundle đã authorization.
- `POST` / `DELETE /conversations/:conversationId/widgets/:instanceId/live-owner`: claim/release, token matching; không public owner takeover.
- Reuse pins POST/DELETE hiện có; save-view cần durable state update + pin acceptance trong transaction hoặc idempotent core command, không hai independent optimistic client writes.

## Implementation steps
1. Resolve snapshot refs từ storage và giữ exact data revisions. Unknown/deleted/legacy bundle → fallback, không current props substitution.
2. Nối ActionInvocation fields: invocationId, expectedRevision, expectedBindingDigest, instanceId, actionBindingId, input. Compile bindings server-side; mỗi call reauthorize data/capability/resource version.
3. Filter action chỉ update view range/state và query data. Calendar selection chỉ update selected day. Save-view persist current state và pin same identity; generic capability/agent actions giữ approval path hiện có, chưa nằm trong M1 CTA.
4. Idempotency key reuse với cùng payload trả prior result; cùng key khác payload reject. Double click chỉ một effect. Revision/digest mismatch → conflict và reload, không silently apply sang target mới.
5. Ownership transfer host-coordinated: release old token, claim new, render live khi confirmed. Tab crash/restart cần bounded lease/expiry hoặc explicit recovery kiểm tra principal; nếu existing API chưa có expiry thì bổ sung additive fields và migration có backup. Không để orphan owner khóa instance vĩnh viễn.
6. Gate mutating controls khi historical/read-only/not owner/offline; request in progress không cho repeated submit. Show success/error thật, không optimistic toast trước durable acceptance.
7. Out-of-order timeline/state responses dedupe bằng sequence/revision. Reload mở lại pin theo persisted identity, không tạo instance mới.

## Tests / success criteria
- Capture N → change filter/state N+1 → history giữ N; expanded/pin là N+1; restart vẫn đúng.
- Two tabs cạnh tranh owner: một writer; unauthorized release/takeover rejected; crash recovery có test clock.
- Wrong principal/conversation/instance/digest/revision/input đều không gây effect.
- Double submit/retry/reordered responses không duplicate pins, không rollback UI về revision cũ.
- Unpin chỉ thay presentation, không xóa instance/data; snapshot vẫn đọc được.
- Provider offline không ảnh hưởng stored snapshot và deterministic live actions.
- Commands: `pnpm exec vitest run apps/runtime/test/mini-app-actions.spec.ts packages/core/test/mini-app-ownership.spec.ts`; `pnpm typecheck`.

## Todo
- [x] Implement snapshot/live DTO và client rendering split.
- [x] Wire authorized action transport, idempotency và conflict UX.
- [x] Implement shared ownership transfer/crash recovery.
- [x] Pass persistence, permission và concurrency tests.

## Kết quả (2026-09-17)

- `packages/core/src/widget-service.ts`: `claimLiveOwner` có lease (`LIVE_OWNER_LEASE_MS`, `recovery` khi lease hết hạn hoặc row cũ không có expiry), `liveOwnerOf`, `sweepExpiredLiveOwners`, release phải khớp token; `invokeMiniAppAction` với thứ tự **idempotency → authorization → binding shape → revision/digest**, ghi state + revision + stale + pin + invocation trong **một** transaction; `M1_VIEW_OPERATIONS` chỉ gồm `period.change`, `date.select`, `view.save`; binding `agent`/`invoke` bị từ chối (`UNSUPPORTED_ACTION`).
- `packages/storage`: `listSnapshotsForMessage` (cột `stale` thắng document — bug thật: trước đó snapshot bị đánh dấu cũ vẫn đọc ra `stale:false`).
- `apps/runtime/src/services.ts`: timeline tách `snapshots` (immutable: snapshotId, bundleRef, catalogDigest, capturedAt, stale) khỏi `instances` (live: state, stateRevision, ownerSurface, compositionId, definitionDigest, dataRefs, actionBindingIds). **Không** đưa owner token vào DTO.
- `apps/runtime/src/gateway.ts`: `POST …/actions`, `GET …/live` (spec + sections có rows hiện tại + `bindings` kèm `bindingDigest` — client cần digest để gửi lại), `GET …/snapshots/:id/presentation` (`readOnly: true`, có `spec` của bundle), `POST/DELETE …/live-owner`.
- `apps/runtime/src/mini-app-data.ts`: `resolveLiveSections` trả rows theo slot + `availability` (metrics/trend/calendar/image).
- `packages/conversation-client`: `blocks.tsx` forward `snapshotId/bundleRef/catalogDigest/capturedAt/stale`; `Conversation.tsx` render inline từ bundle (read-only, không actions) + nút “Mở bản hiện tại” tạo pin `expanded`; `DesktopSurfaces.tsx` `PinnedLiveSurface` (claim + refresh 30 s + release khi unmount, read-only khi surface khác giữ, conflict 409 → tải lại và nói rõ thao tác chưa áp dụng).
- Tests: `packages/core/test/mini-app-ownership.spec.ts` (12) và `apps/runtime/test/mini-app-actions.spec.ts` (11). `pnpm verify` pass (672).

## Ghi chú cho phase sau

- `captureCompositeSurface` nhận `instanceId` do caller cấp, để compiler Phase 5 compile binding trước khi persist mà binding vẫn trỏ đúng instance.
- Client gửi `expectedBindingDigest` lấy từ `/live`; binding đổi digest → 409 `BINDING_STALE` và UI phải reload.
- Phase 6 e2e assert: `data-snapshot`, `data-snapshot-stale`, `data-open-live`, `data-live-instance`, `data-ownership`, `data-pin-live`.

## Risks / next
Không đưa owner tokens hoặc action auth material vào history bundle, logs hay screenshots. Verify approval invariants không bị bypass. Phase 5 chỉ tích hợp compose khi deterministic interactions đã hoạt động.
