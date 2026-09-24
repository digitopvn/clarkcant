# Publish áp quy tắc §20, docs, verify, PR

Trạng thái: chờ.

## Yêu cầu

1. `clark widget publish` đọc `dist/directory-entry.json` đã chuẩn bị trước đó (nếu có) cùng `dist/published-definitions.json` và từ chối khi `stateSchema`, `ephemeralStateKeys`, `stateMigrations`, `effectCategories` hoặc `requestedCapabilities` của một definition đổi mà version không tăng major; từ chối `stateSchema` đổi mà `stateVersion` không tăng.
2. Cập nhật `docs/widget-development.md` §5, §15, §19 (trạng thái), §20; `docs/conformance-traceability.md`; `docs/manifest.json`.
3. `pnpm verify`, e2e các journey bị chạm, commit, push, draft PR.
