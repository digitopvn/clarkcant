---
phase: E
title: "Layout primitive và cây composition có giới hạn"
status: done
issues: [198, 224]
---

# Phase E — layout primitive và cây composition có giới hạn

## Bối cảnh

- Bề mặt ghép chỉ dựng được từ ba template cố định (`overview`, `focused`, `agenda`) trong `compose-mini-app.ts`.
  Muốn một bố cục khác thì phải thêm template vào code.
- Spec composition (`packages/contracts/src/surface-composition.ts`) chỉ có danh sách section phẳng, mỗi slot tối đa một
  lần.
- Lịch sử đọc spec và section từ presentation bundle bất biến; bundle đã nhúng spec.

## Thiết kế

Model đề xuất cây qua `show_view` với `canvas.overview@1` và `props.layout`:

- Container: `stack`, `row`, `grid` (`columns` 1–4), `card`, `tabs` (mỗi tab cần `label`), `split` (đúng hai con),
  `collapsible` (cần `label`, có `open`), `divider`.
- Lá: `{ kind: "widget", widget, props, label? }`, với `widget` là id trong catalog của node.
- Không có `props.layout` thì các template cũ vẫn chạy như công thức.

Host biên dịch (`apps/runtime/src/compose-layout.ts`):

- Đo kích thước trước khi đọc: tối đa 5 tầng, 40 nút, 12 con mỗi container, 8 tab, 12 widget.
- Trường lạ trên một nút bị từ chối, không bị bỏ qua.
- Lá phải là widget lá của catalog: container, `canvas.action@1` (có `show_view` riêng) và media chưa có nguồn đều bị từ
  chối kèm lý do.
- Props được kiểm theo JSON Schema đầy đủ của định nghĩa; dữ liệu do host gắn (ghi đè `datasetRef` của model); digest
  của định nghĩa được ghim; mỗi lá thành một section có id riêng (`metrics-1`, `metrics-2`, …).
- Cây lưu trữ (`LayoutNode`) chỉ gọi section theo id, không mang id widget, props hay mã.
- Spec có cây là `schemaVersion` 2, được lưu cùng bundle qua cùng đường `persistComposition` với template, nên replay,
  hủy lượt và binding (`period.change`, `date.select`, `view.save`, mỗi section một binding) giống hệt.
- Mọi nút có text alternative (`describeLayout`).

Client (`mini-app-surface.tsx`) vẽ cây:

- Grid dùng `auto-fit`: không quá số cột cây yêu cầu, không cột nào hẹp hơn 220px.
- Split xếp chồng khi bề mặt hẹp hơn 560px (container query).
- Tabs theo mẫu WAI-ARIA (roving tabindex, mũi tên, Home, End); panel giữ mounted và dùng `hidden`.
- Collapsible là `<details>` với dấu mở/đóng nhìn thấy được.

## File

- `packages/contracts/src/composition-layout.ts` (mới), `surface-composition.ts`.
- `packages/core/src/widget-service.ts`: `CompositeCaptureInput.layout`.
- `apps/runtime/src/compose-layout.ts` (mới), `compose-mini-app.ts` (tách `persistComposition`), `view-catalog.ts`.
- `apps/runtime/src/test-support/fixture-model.ts`: câu "bố cục …".
- `packages/conversation-client/src/mini-app-surface.tsx`, `api.ts`, `use-surface-renderer.tsx`,
  `DesktopSurfaces.tsx`, `styles/panels.ts`.
- Docs `docs/widgets-and-extensions*.md`, conformance ledger (V12).

## Kiểm chứng

- `packages/contracts/test/composition-layout.spec.ts`, `apps/runtime/test/compose-layout.spec.ts`.
- E2E `apps/web/e2e/layout-tree.spec.ts`: grid và card, lịch sử sau reload, tabs bằng bàn phím, collapsible, split,
  375px không tràn ngang, lời từ chối kèm lý do.
- `pnpm verify` và full E2E.

## Còn lại

- Catalog chưa có widget search: "Card(Search, Table)" tạm dùng `canvas.filter@1` cạnh `canvas.table@1` có
  `searchable`. Khi #225 thêm lá search, phần đóng #225 phải kiểm đúng cây "Grid(Metrics, Metrics, Card(Search, Table))".