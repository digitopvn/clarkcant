---
phase: 1
title: Backend — contract, bảng, suy ra việc chờ, route, producer, tool
status: done
---

# Phase 1 — Backend

## Bối cảnh

- `requestApproval` (`packages/core/src/coordination.ts`) ghi hàng `approvals`; thẻ `approval-card` trong
  transcript mang payload. `decideApprovalForNode` đọc payload từ thẻ.
- `listPendingCapabilityApprovals` (`apps/runtime/src/application/package-install.ts`) đã có.
- `pendingForConversation` (`apps/runtime/src/interactions.ts`) suy ra câu hỏi đang chờ.
- `nodeBackgroundSessions` chỉ trong bộ nhớ, giữ 10 phút — không phải lịch sử.

## Việc cần làm

1. `packages/contracts/src/inbox.ts`: `noticeSchema`, `waitingItemSchema` (union `command-approval`,
   `capability-approval`, `question`), `inboxResponseSchema`, `inboxSummarySchema`, `inboxReadRequestSchema`.
2. Migration 26 `notifications` + index unique `(principal_id, dedup_key)` + index `(principal_id, created_at)`.
3. `packages/storage/src/repositories/notifications.ts`: `recordNotification` (dedup, cắt độ dài, cắt tỉa),
   `listNotifications`, `markNotificationsRead`, `dismissNotification`, `countUnreadNotifications`.
4. `apps/runtime/src/inbox.ts`: `waitingItems(services, now)` và `recordNodeNotification` (redact).
5. `apps/runtime/src/routes/inbox.ts` + đăng ký trong `gateway.ts`.
6. Producer: `startBackgroundWork` và `onSettled` của task dispatch.
7. App intent `inbox.open` (contracts, core phrases + nouns, `control_app` kinds).
8. Tool `read_inbox` chỉ đọc.

## Kiểm chứng

- `packages/storage/test/notifications.spec.ts`: dedup, cắt tỉa, đọc/ẩn, principal tách biệt.
- `apps/runtime/test/inbox.spec.ts`: approval lệnh ở hội thoại khác được suy ra; đã quyết định/hết hạn thì
  biến mất; producer việc nền ghi đúng một thông báo; route trả schema hợp lệ.
- `packages/core/test/app-intents.spec.ts`: cụm mới khớp, câu công việc không bị bắt.

## Rủi ro / rollback

Migration chỉ thêm bảng; rollback là bỏ route và bảng không được đọc. Không sửa migration cũ.
