# Phase 01 (H) — Thẻ status, progress và details

Trạng thái: done (#280 qua PR #286). Plan: [plan.md](plan.md).

## Thiết kế

- `canvas.status@1`: `label`, `tone` (neutral, info, success, warning, danger), `detail?`, `asOf?`, `title?`. Tone
  được nói bằng chữ và biểu tượng, không chỉ bằng màu.
- `canvas.progress@1`: hoặc `value`/`max` (+ `unit?`), hoặc `steps` (1–12, mỗi bước `label` và `status` ∈ done,
  current, pending, failed, skipped; tối đa một bước current). Không có indeterminate.
- `canvas.details@1`: `items` (1–24 cặp `label`/`value`) và `title?`.
- Hàm parse, kiểm tra và semantic dùng chung ở `packages/contracts/src/status-cards.ts`.
- Runtime: view riêng cho từng widget (text alternative từ props), leaf trong layout tree, nhánh semantic theo props.
- Client: renderer trong `renderers.tsx`, i18n, style theo token; `asOf` hiển thị "Tính đến …", không có badge live.
- Catalog: META và fixture; fixture model có câu "đặt thẻ trạng thái|tiến độ|chi tiết".

## File

`packs/data-canvas/src/index.ts`, `packages/contracts/src/status-cards.ts`, `apps/runtime/src/view-catalog.ts`,
`apps/runtime/src/compose-layout.ts`, `apps/runtime/src/widget-semantic.ts`,
`packages/conversation-client/src/renderers.tsx` (+ i18n, styles), `packages/widget-catalog/src/{registry,fixtures}.ts`,
`apps/runtime/src/test-support/fixture-model.ts`, test, `apps/web/e2e/status-cards.spec.ts`, docs EN/VI.

## Kiểm chứng

Unit (contracts, data-canvas, runtime, client, widget-catalog), `widget-library.spec.ts`, `status-cards.spec.ts`,
`pnpm verify`, `pnpm invariants`, ảnh 1280 tối/sáng và 390.

## Rủi ro

Thêm slot layout mới cần cập nhật enum `compositionSlotSchema` và `SLOT_ORDER`; test hợp đồng sẵn có bắt lệch.
