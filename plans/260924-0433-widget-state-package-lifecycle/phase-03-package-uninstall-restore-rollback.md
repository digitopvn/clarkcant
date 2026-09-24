# Gỡ, khôi phục, quay về

Trạng thái: chờ.

## Yêu cầu

1. Core `uninstallPackage(deps, {packageId})`: supersede generation đang chạy; instance của các widget thuộc package chuyển `offline`; `widget_state`, snapshot, pin giữ nguyên; trả số instance offline và việc cần restart Pi khi package có facet native.
2. Core `reactivatePreviousGeneration(deps, {packageId})`: có generation đang chạy ⇒ quay về generation bị thay gần nhất; không có ⇒ khôi phục generation vừa gỡ. Instance offline của package quay lại `ready`.
3. `listInstalledPackages` thêm `previousVersion`; thêm `listRestorablePackages`.
4. Route `POST /packages/:id/uninstall`, `POST /packages/:id/restore`, `POST /packages/:id/rollback`; `GET /packages` trả thêm `restorable`.
5. Live route: widget của package không còn generation đang chạy ⇒ 410 kèm text fallback.
6. Settings › Extensions & Widgets: nút Gỡ / Quay về {version} / Khôi phục trên đúng dòng, trạng thái inline, không save button. App intent `package.uninstall` / `package.rollback` / `package.restore` cho chat và voice, cùng một đường.

## Files

`packages/core/src/{install-lifecycle,installed-packages}.ts`, `apps/runtime/src/routes/packages.ts`, `apps/runtime/src/app-intents.ts`, `packages/core/src/app-intents.ts`, `packages/conversation-client/src/settings/ExtensionsSettings.tsx`, `api.ts`, i18n, e2e.
