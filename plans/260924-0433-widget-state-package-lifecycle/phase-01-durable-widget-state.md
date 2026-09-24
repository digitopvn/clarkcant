# State bền qua bridge, tách revision

Trạng thái: xong.

## Ngữ cảnh

- `packages/widget-sdk/src/runtime.ts` dùng một biến `revision` cho cả revision instance (init, `action.invoke`) lẫn revision state (`state.update`, message `state`). `packages/widget-host/src/session.ts` giữ `revision = 0` riêng cho state. Hệ quả: frame init ở instance revision 3 ghi state với `expectedRevision: 3` và bị từ chối STALE; sau một lần ghi state, action kế tiếp mang revision sai.
- `state.update` chỉ gộp trong bộ nhớ của session: không có gì ghi xuống `widget_state`.

## Yêu cầu

1. Init mang thêm `stateRevision` (optional trong schema để runtime cũ vẫn bắt tay). Runtime giữ `stateRevision` riêng; `state.update` so với nó; message `state` cập nhật nó; action vẫn dùng revision instance.
2. `FrameSessionInput.persistState?(input) => Promise<{ok:true; stateRevision; state} | {ok:false; code; message; currentRevision?}>`. Có callback thì session **chờ** node xác nhận rồi mới gửi `state` mới; bị từ chối thì gửi lại state đã commit kèm revision hiện tại (widget biết mình cũ, bản nháp của widget không bị host xoá). Không có callback thì giữ hành vi cũ (dev host, conformance).
3. Core `applyWidgetStatePatch(deps, {instanceId, principalId, definition, expectedRevision, patch})`: bỏ key ephemeral, gộp, validate theo tập con JSON Schema của `stateSchema`, giới hạn 16 KiB, kiểm revision trong transaction, ghi `widget_state`. Không bump revision instance (state không đổi cái người dùng đã thấy như một action).
4. Route `POST /conversations/:id/widgets/:instanceId/state` cho instance isolated-app: 200 / 409 `STATE_REVISION_STALE` (kèm state hiện tại) / 422 `STATE_SCHEMA_INVALID` / 413 `STATE_TOO_LARGE` / 409 `STATE_READ_ONLY` / 410 `PACKAGE_NOT_INSTALLED`.
5. Live route trả `stateRevision` và `state` (đã bỏ ephemeral) cho frame; `WidgetFrame` truyền vào init.
6. Contract: `ephemeralStateKeys` trong `widgetDefinitionSchema`.

## Files

`packages/contracts/src/widgets.ts`, `packages/widget-sdk/src/{index,runtime}.ts`, `packages/widget-host/src/session.ts`, `packages/core/src/widget-state.ts` (mới), `packages/core/src/index.ts`, `packages/core/src/widget-frame.ts`, `apps/runtime/src/routes/conversations.ts`, `packages/conversation-client/src/{WidgetFrame,DesktopSurfaces}.tsx`, `packages/conversation-client/src/api.ts`, test tương ứng.

## Kiểm chứng

Focused vitest cho sdk/host/core/runtime; e2e `widget-frame.spec.ts` vẫn xanh.

## Rủi ro / rollback

Schema init thêm field optional — tương thích ngược. Không có migration DB.
