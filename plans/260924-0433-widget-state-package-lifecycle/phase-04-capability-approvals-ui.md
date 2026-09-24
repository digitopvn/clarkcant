# UI duyệt capability đang chờ, grant ∩ preflight

Trạng thái: xong.

## Yêu cầu

1. `GET /packages/approvals`: approval install-capability đang chờ (`task_id IS NULL`, digest dạng `${digest}:${ref}`, chưa hết hạn), kèm package/version. Chỉ liệt kê approval có generation đang chạy khớp digest: cấp quyền cho gói đã gỡ không có chỗ để ghi (`NO_GENERATION_FOR_APPROVAL`), nên đó không phải một nút thật.
2. Settings › Extensions & Widgets hiển thị từng approval với Cho phép / Từ chối, gọi `POST /packages/approvals/:id/decision` với đúng `operationDigest` đã hiển thị; kết quả inline, nhận focus. Không có gì để duyệt ⇒ không hiện mục. Đây là chrome của host — không bao giờ nằm trong frame.
3. Live route chạy `invocationPreflight` trên từng capability đã cấp (`readyCapabilities` trong core); frame chỉ nhận capability đã cấp **và** sẵn sàng; `unavailableCapabilities` nêu ref, mã và lý do. Conversation hiện một dòng trạng thái khi có capability bị giữ lại.

## Quyết định

- Model không duyệt quyền. Tool `manage_package` action `list` chỉ nêu các quyền đang chờ và chỉ người dùng tới Settings: bên xin quyền (widget) và bên hành động thay người dùng (model) không được là bên trả lời.
- Capability bị giữ lại vì chưa sẵn sàng được broker lại ở lần mount sau mà không cần duyệt lại: grant là sự cho phép, preflight là tình trạng hiện tại.

## Files

`apps/runtime/src/application/package-install.ts`, `apps/runtime/src/routes/{packages,conversations}.ts`, `apps/runtime/src/manage-package-tool.ts`, `packages/core/src/widget-frame.ts`, `packages/conversation-client/src/{api.ts,DesktopSurfaces.tsx,settings/ExtensionsSettings.tsx,i18n/messages-settings.ts,i18n/messages-shell.ts,styles/panels.ts}`.

## Kiểm chứng

- `apps/runtime/test/package-install-capability-approval.spec.ts` (liệt kê, trả lời, gói đã gỡ)
- `apps/runtime/test/package-lifecycle-route.spec.ts` (grant ∩ preflight trên live route)
- `packages/core/test/widget-frame.spec.ts` (`readyCapabilities`)
- `apps/web/e2e/capability-approvals.spec.ts` (câu trả lời của node được stub; route thật đã có spec runtime)
