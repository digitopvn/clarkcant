---
title: "Phase 1: Composition và snapshot contracts"
status: done
---

# Phase 1: Composition và snapshot contracts

## Overview
- Priority P1; effort ~3 agent-hours; dependencies: không.
- Thiết lập schema/version/data boundary trước khi tích hợp model hoặc UI.
- Context: [đề xuất chi tiết](../reports/analysis-260917-1211-jev-mini-app-rendering.md), [plan](./plan.md).

## Architecture và requirements

Một `canvas.overview@1` host container giữ **một logical instance**; các sections chỉ là leaf catalog renderers, không có owner riêng. `SurfaceCompositionSpecV1` là output của pure host compiler, không phải response được tin tưởng trực tiếp từ Jev. Spec phải validate exact definition/version/digest, slots, props và authorized refs. Không cho nested arbitrary layout, HTML, JS, CSS hay host-owned card.

Snapshot cần đóng băng cả layout, props, filter và dữ liệu đã trình bày. `capturedRevision` cộng `presentationRef=catalog:id` hiện tại không đủ. Snapshot bundle chứa immutable presentation data hoặc immutable revision refs; không dereference current dataset khi render history. Live state tiếp tục dùng widget_state; không tạo hệ state song song.

## Related code files

Root cho mọi path bên dưới: `/Volumes/GOON/www/digitop/clarkcant/`.

| Action | Path | Thay đổi |
|---|---|---|
| Create | `packages/contracts/src/surface-composition.ts` | Spec, section, immutable bundle và selection-result schemas |
| Modify | `packages/contracts/src/widgets.ts` | Additive snapshot bundle reference/version; giữ old snapshot readable |
| Modify | `packages/contracts/src/index.ts` | Export schemas mới |
| Modify | `packages/storage/src/migrate.ts` | Additive composition/bundle/local-calendar storage, scoped ownership/indexes |
| Modify | `packages/storage/src/repositories.ts` | Authorized reads, immutable bundle writes, reference retention |
| Modify | `packages/core/src/widget-service.ts` | Extend captureSnapshot, atomic composition/binding/snapshot writes |
| Create | `packages/contracts/test/surface-composition.spec.ts` | Schema compatibility/limits tests |
| Create | `packages/core/test/surface-snapshot.spec.ts` | Persist/reload/immutability/transaction tests |

Không xóa file. Nếu repository layer quá lớn, tách theo convention hiện tại và ghi path thực vào phase trước khi thực hiện.

## Implementation steps
1. Chốt schemas từ report §3.2: version 1; tối đa 12 leaf sections; section IDs unique; slots enum; refs và strings bounded. Reuse existing WidgetDefinition/ActionBinding, không copy authorization schema.
2. Additive migration: composition documents có instance/principal ownership; snapshot bundle immutable có snapshot/message refs; local calendar events có timezone/range constraints. Columns thật (đã xác minh `migrate.ts:173`): `tasks(state, disposition, revision, created_at, updated_at)`, `runs(started_at, ended_at)`; **không có `completed_at`**. Định nghĩa chốt: completed = `state = succeeded`, thời điểm = `updated_at`; failed/cancelled đếm riêng.
3. Dùng backup utility hiện có trước chạy migration trên bất kỳ DB có dữ liệu. Chứng minh restore trong disposable DB. Không sửa/xóa migration cũ đã áp dụng.
4. Extend captureSnapshot để giữ immutable bundle + exact catalog digest. Snapshot legacy không bundle dùng text fallback, không tự lấy current props gắn revision cũ.
5. Compiler là pure function input validated candidates → validated spec; persistence là service riêng. Transaction cùng message/instance/bindings/bundle; lỗi cuối transaction không để orphan rows.
6. Giới hạn: composition spec ≤256 KiB (trần catalog spec, widgets §12), bundle 1 MiB, selection metadata 16 KiB; oversized fallback có reason. Xóa nguồn theo privacy policy không được resurrect data qua history; khi bundle bị xóa hiển thị tombstone.

## Tests và success criteria
- Contract rejects duplicate sections, unknown slots, recursive sections, >12 sections và invalid references.
- Legacy messages parse; new spec roundtrip không mất version/provenance.
- Snapshot ở revision N giữ values N sau live update N+1 và sau restart; source delete → tombstone/fallback theo policy.
- Unauthorized principal không đọc bundle/composition; malformed ownership relation rejected.
- Failure giữa transaction rollback toàn bộ instance/bindings/message artifacts mới.
- Migration upgrade/restore roundtrip với DB copy giữ dữ liệu cũ.
- Gate: `pnpm exec vitest run packages/contracts/test/surface-composition.spec.ts packages/core/test/surface-snapshot.spec.ts` rồi `pnpm typecheck`.

## Todo
- [x] Define bounded composition và snapshot contracts.
- [x] Implement migration/repositories cùng backup/restore evidence.
- [x] Implement atomic snapshot capture và legacy fallback.
- [x] Pass contract, persistence và ownership tests.

## Kết quả (2026-09-17)

- `packages/contracts/src/surface-composition.ts`: `SurfaceCompositionSpecV1`, `CompiledSection`, `PresentationBundle`, `MiniAppSelection`, các pure check (`checkSurfaceCompositionSpec`, `checkPresentationBundle`, `checkSelectionAgainstCandidates`) và policy (`selectionIsDecisive`, `noulVerdict`).
- `packages/contracts/src/widgets.ts`: snapshot có thêm `bundleRef`/`bundleSchemaVersion`/`catalogDigest` dạng optional; snapshot cũ vẫn parse.
- Migration 10: `surface_compositions`, `presentation_bundles` (immutable, có tombstone), `calendar_events`, `local_images`, và `widget_live_owners.lease_expires_at`.
- `repositories.ts`: upsert/read theo principal cho composition/bundle/calendar/image; bundle chỉ INSERT, không có đường update.
- `packages/core/src/widget-service.ts`: `captureCompositeSurface` ghi instance + bindings + snapshot + composition + bundle trong **một** transaction, validate trước khi mở transaction.
- Tests: `packages/contracts/test/surface-composition.spec.ts` (14), `packages/core/test/surface-snapshot.spec.ts` (10) — gồm restart, rollback giữa transaction, cross-principal, tombstone, upgrade từ schema 9 và backup/verify. `pnpm verify` pass (591 tests).

## Ghi chú cho phase sau

- `checkSurfaceCompositionSpec` là pure function dùng chung cho compiler (Phase 5) và persistence; Phase 5 phải gọi lại nó trước khi persist thay vì tin compiler.
- `definitionCatalogKey(id, version)` là key chuẩn của catalog (`id@version`), dùng cả ở `widget-host` registry.

## Risks / security / next
Bundle giữ dữ liệu nhạy cảm lâu hơn live source: retention/deletion phải enforce ở server. Không đưa raw rows vào timeline JSON. Phase 2 và 3 chỉ bắt đầu khi schema này ổn định; chưa cần gọi model ở phase này.
