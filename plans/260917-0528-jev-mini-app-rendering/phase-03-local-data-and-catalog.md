---
title: "Phase 3: Local data và composite catalog"
status: done
---

# Phase 3: Local data và composite catalog

## Overview
- P1; effort ~5 agent-hours; lane L2 (song song Phase 2 và 7). Depends on Phase 1.
- Context: [report](../reports/analysis-260917-1211-jev-mini-app-rendering.md), hai ảnh trong `docs/mini-app/`.
- Dựng đủ leaf UI và data services; tương tác qua validated event interface, full gateway wiring ở Phase 4.

## Requirements và architecture

Host container `canvas.overview@1` resolve spec rồi bố trí slots cố định: metrics, filter, trend, calendar, image, CTA. Reuse table/note/charts khi phù hợp. Leaf renderer không gọi model, không tự fetch tùy ý; host resolve authorized refs và cung cấp presentation data. Một layer composition; không mỗi leaf một live owner.

Dữ liệu task metrics/trend từ SQLite tasks/runs/events qua adapter chuẩn hóa. Không giả task có due date. Calendar là local events do user nhập; ảnh là file user import qua approved artifact store. Empty data hiển thị empty state và affordance nhập dữ liệu, không số liệu mẫu. Week/month dùng timezone user/node rõ ràng; lưu instants UTC và timezone cho display/range boundaries.

## Related files
Root: `/Volumes/GOON/www/digitop/clarkcant/`.

| Action | Path | Purpose |
|---|---|---|
| Modify | `packs/data-canvas/src/index.ts` | Composite entry và metrics/filter/calendar/image/action definitions |
| Modify | `packages/widget-host/src/index.ts` | Catalog validation/fallback và family coverage |
| Create | `packages/conversation-client/src/mini-app-surface.tsx` | Bounded layout container, leaf renderer dispatch |
| Modify | `packages/conversation-client/src/renderers.tsx` | Leaf renderers; donut thực sự, accessible data alternatives |
| Modify | `packages/conversation-client/src/styles.ts` | Reuse theme tokens, responsive surface rules |
| Create | `apps/runtime/src/mini-app-data.ts` | Task aggregates, date range, local events, image refs |
| Modify | `apps/runtime/src/gateway.ts` | Authorized local event CRUD và image import/read routes |
| Modify | `packages/storage/src/repositories.ts` | Calendar/data queries theo principal |
| Create | `apps/runtime/test/mini-app-data.spec.ts` | Real SQLite/API data checks |
| Create | `packages/conversation-client/test/mini-app-helpers.spec.ts` | Pure helpers: range math, props validation, empty/negative series behavior (không JSX) |

Không xóa file. **Đã xác minh:** `vitest.config.ts` là `environment: "node"`, không jsdom → không tạo `.spec.tsx`; rendering/accessibility assertions đi vào Playwright ở Phase 6.

## Implementation steps
1. Map `tasks` rows → canonical metrics theo định nghĩa chốt (plan.md): completed = `state = succeeded` tại `updated_at`; pending = nonterminal; failed/cancelled riêng; bucket "tạo" theo `created_at`. Ghi provenance (node id, query revision, timezone).
2. Local calendar CRUD có title/start/end/timezone validation, principal scope và range query. Import/create qua production API; calendar selection chỉ xem local event details, không ngụ ý Google sync.
3. Image import size/MIME/magic-byte/dimensions checks, opaque artifact id, safe serving content-type. Chặn traversal và arbitrary remote URL fetch; v1 chỉ raster approved formats, không executable SVG/HTML. UI dùng alt và missing-image fallback.
4. Register spec-compatible definitions, validate props trước persist; render metrics, range selector, calendar, image, CTA. Donut không alias BarChart; series empty/negative/zero denominator có explicit behavior.
5. Layout compact trong conversation, expanded tối đa available width, mobile một cột; preserve readable chart axes/calendar và touch targets. Reuse current typography/theme, không sửa global shell ngoài phạm vi.
6. Mỗi leaf có loading/empty/error/stale/permission-denied state và text/table alternative. Dropdown/calendar keyboard accessible; label/focus visible; reduced motion. Resolve latest request only khi user đổi range nhanh; không flash stale response như dữ liệu mới.
7. CTA và filter emit typed intent gồm section/action id + input, không execute effect trực tiếp. Integration commit ở Phase 4 mới được claim interactive milestone complete.

## Acceptance / tests
- Real SQLite records tạo qua production paths cho ra đúng metrics/trend; compare API values với records, không hardcode UI values.
- Range week/month tại month boundary, leap day, DST và Asia/Saigon; event end trước start bị reject.
- Another principal không đọc event/image/dataset; deleted artifact có fallback, không broken blank panel.
- Empty DB không chứa KPI giả, sample events hoặc sample image.
- All required component families có test/render coverage; invalid schema downgraded rõ ràng.
- Narrow gate: `pnpm exec vitest run apps/runtime/test/mini-app-data.spec.ts`, rồi `pnpm typecheck` và `pnpm build`; browser renderer checks ở Phase 6.

## Todo
- [x] Implement scoped data services và local import/create affordances.
- [x] Register composition và leaf catalog definitions.
- [x] Build đủ UI regions/states bằng theme hiện có.
- [x] Pass data/security tests và renderer checks.

## Kết quả (2026-09-17)

- `packages/contracts/src/period.ts` (mới, pure): `periodRange` (tuần bắt đầu thứ Hai, tháng theo **local calendar**), `localTimeToUtc`/`timezoneOffsetMs` (hai bước, xử lý ngày DST 23 giờ), `countsByBucket`, `summariseSeries`, `donutSlices` (từ chối giá trị âm, nói rõ total = 0), `monthGrid` (6×7, cờ `inMonth`), `orderSections`.
- Migration 11: `datasets.owner_principal_id` + index; `getDatasetForPrincipal`/`listDatasetsForPrincipal` để dataset dẫn xuất chỉ đọc được bởi chủ.
- `packs/data-canvas`: thêm `canvas.overview@1` (container), `canvas.metrics@1`, `canvas.filter@1`, `canvas.calendar@1`, `canvas.image@1`, `canvas.cta@1`; `FAMILY_BY_DEFINITION` + `familyOf`. Bỏ marker stub renderer (renderer nằm ở conversation-client).
- `packages/widget-host`: `definitionDigest`, `registerCatalog`, `CatalogRegistry.entries()`, `COMPOSITION_FAMILIES`, `missingCompositionFamilies`, `checkCompositionCoverage` (dùng chung `checkSurfaceCompositionSpec`).
- `apps/runtime/src/mini-app-data.ts`: metrics/trend/outcome từ bảng `tasks` (completed = succeeded theo `updated_at`; pending = nonterminal; failed/cancelled riêng; provenance gồm `queryRevision`), calendar CRUD có validate, `sniffImage` (magic bytes PNG/JPEG/GIF/WebP + kích thước), `importLocalImage` (trần 5 MiB, alt bắt buộc, blob 0600 trong `dataDir/blobs`), `publishMiniAppData` (dataset id theo principal).
- `apps/runtime/src/gateway.ts`: `/calendar/events[...]`, `/images[...]` (serve bytes với content-type đã kiểm), `/datasets/:id` scoped theo principal, `GET /conversations/:id/widgets/:instanceId/composition`. `GatewayResponse.binary` + main.ts ghi bytes.
- `packages/conversation-client`: `mini-app-surface.tsx` (container theo slot order, 6 trạng thái vùng, tombstone, text alternative), renderer mới Metrics/Filter/Calendar/Image/Cta và Donut thật; `Conversation.tsx` resolve composition + image bytes; `api.ts` thêm transport composition/calendar/image; styles cho grid responsive.
- Tests: `apps/runtime/test/mini-app-data.spec.ts` (21), `packages/conversation-client/test/mini-app-helpers.spec.ts` (13). `pnpm verify` pass (649), `pnpm build` pass.

## Ghi chú cho phase sau

- `services.ts` expose `catalog` + `missingFamilies`; Phase 5 dùng `checkCompositionCoverage` trước khi persist.
- `sniffImage` là pure và đã test; dùng lại ở route nhập ảnh khác nếu có.
- Phase 6 kiểm tra UI thật: data attribute để assert gồm `data-surface-instance`, `data-slot`, `data-availability`, `data-period-select`, `data-calendar-month`, `data-last-intent`.

## Risks / next
Actual user data/image chưa được cung cấp cho final visual acceptance. Đó là evidence gate, không lý do thêm fake defaults. Phase 4 nối cùng component tree vào inline/expanded/pinned live behavior.
