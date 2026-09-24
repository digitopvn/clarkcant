# Publish áp quy tắc §20, docs, verify, PR

Trạng thái: xong.

## Yêu cầu

1. `clark widget publish` so definition sắp phát hành với lần chuẩn bị trước (`dist/published-definitions.json`) và từ chối, kèm tên từng vi phạm:
   - `stateSchema` đổi mà `stateVersion` không tăng, hoặc thiếu bước migration từ `stateVersion` đã phát hành;
   - `stateVersion` giảm;
   - bước migration đã phát hành bị sửa hoặc xoá;
   - `ephemeralStateKeys`, `effectCategories` đổi hoặc `requestedCapabilities` thêm mà definition không tăng major;
   - definition biến mất mà package không tăng major.
2. Cập nhật `docs/widget-development.md` §5, §15, §16, §20 và mục trạng thái triển khai; dòng V08 của `docs/conformance-traceability.md` (vẫn PARTIAL); `docs/manifest.json`.
3. `pnpm verify`, e2e các journey bị chạm, commit, push, cập nhật PR.

## Quyết định

Kế hoạch ban đầu coi mọi thay đổi `stateMigrations` là breaking. Đã nới lại: **thêm** bước migration là cách không-breaking để đổi `stateSchema` (đó chính là mục đích của migration); chỉ **sửa hoặc xoá** bước đã phát hành bị từ chối, vì một node có thể đã migrate bằng nó.

## Files

`packages/widget-cli/src/version-rules.ts`, `packages/widget-cli/src/cli.ts`, `packages/widget-cli/test/version-rules.spec.ts`, docs.

## Test

`packages/widget-cli/test/version-rules.spec.ts` — từng quy tắc trên một definition gốc, và `clark widget publish` chạy hai lần trên một scaffold thật (từ chối rồi chấp nhận khi có migration).
