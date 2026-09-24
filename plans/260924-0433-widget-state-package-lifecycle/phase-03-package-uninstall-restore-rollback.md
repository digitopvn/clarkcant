# Gỡ, khôi phục, quay về

Trạng thái: xong.

## Yêu cầu

1. Core `uninstallPackage(deps, {packageId, widgetIds})`: supersede generation đang chạy; instance của các widget thuộc package chuyển `offline`; `widget_state`, snapshot và dòng generation giữ nguyên.
2. Core `restorePackage(deps, {packageId, widgetIds, available})`: chỉ khi không có generation đang chạy; hồi sinh generation vừa gỡ (mới nhất bị supersede), đưa instance `offline` về `ready`. Từ chối khi directory không còn liệt kê đúng version + digest.
3. Core `rollbackPackage(deps, {packageId, available})`: quay về generation gần nhất có version khác. Không có migration xuống: state do bản mới ghi làm widget mở chỉ đọc.
4. `listInstalledPackages` thêm `previousVersion`; thêm `listRestorablePackages`, `activePackageVersions`.
5. Route `POST /packages/:id/{uninstall,restore,rollback}`; `GET /packages` trả thêm `restorable`. Id được URL-decode.
6. Live route: instance `offline` trả `frame: null`, `textFallback`, state, không binding, `readOnly: true`. Live route ưu tiên bản đang chạy khi directory liệt kê nhiều version, để rollback thực sự đổi code frame nạp.
7. Settings › Extensions & Widgets: nút Gỡ / Quay về {version} / Khôi phục trên đúng dòng, trạng thái inline nhận focus, không save button. Nút Quay về chỉ có khi thật sự có bản trước.
8. Chat và voice: tool model `manage_package` (list / uninstall / restore / rollback) gọi cùng `changePackage` với route, nên một câu nói và một cú bấm là một hành động, một bản ghi audit.

## Quyết định

- Không thêm AppIntent kind mới: tool `manage_package` đã cho chat/voice cùng đường với Settings mà không phải mở rộng matcher, bảng mô tả và executor phía client.
- Policy: `decideExecution` với category `local-write`. `deny` ⇒ 403 `POLICY_REFUSED`. `ask` từ agent/voice ⇒ 409 `CONFIRMATION_REQUIRED`, hướng người dùng tới nút trong Settings; cú bấm trên nút host-owned của chính package đó là câu trả lời xác nhận.
- Gói có facet native: kết quả báo `restartNeeded`, không tuyên bố đã có hiệu lực.

## Files

`packages/core/src/{package-lifecycle,installed-packages,index}.ts`, `apps/runtime/src/application/package-lifecycle.ts`, `apps/runtime/src/manage-package-tool.ts`, `apps/runtime/src/{node-tools,bootstrap/model-bootstrap}.ts`, `apps/runtime/src/routes/{packages,conversations}.ts`, `packages/conversation-client/src/{api.ts,DesktopSurfaces.tsx,settings/ExtensionsSettings.tsx,i18n/messages-settings.ts,styles/panels.ts}`.

## Kiểm chứng

- `packages/core/test/package-uninstall.spec.ts`
- `apps/runtime/test/package-lifecycle-route.spec.ts`
- `apps/web/e2e/package-lifecycle.spec.ts`

## Còn thiếu

- Frame widget detach ra cửa sổ riêng vẫn chưa hỗ trợ; không đổi trong phase này.
