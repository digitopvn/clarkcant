---
phase: 2
title: Giao diện — dấu header, popover, lệnh mở, mở hội thoại khác
status: pending
---

# Phase 2 — Giao diện

## Việc cần làm

1. `GatewayClient`: `inbox()`, `inboxSummary()`, `markInboxRead(ids?)`, `dismissNotice(id)` — parse bằng schema.
2. `packages/conversation-client/src/inbox/InboxMark.tsx`: nút trên header, chỉ render khi `waiting + unread > 0`,
   poll 5 s, `refreshKey` để đọc lại ngay.
3. `InboxPanel.tsx`: popover host-owned; phần "Đang chờ bạn" trước (Duyệt/Từ chối cho lệnh và quyền gói,
   "Mở hội thoại" cho câu hỏi), rồi "Thông báo" mới nhất trước (chưa đọc: chấm + chữ), ghi thời điểm đọc.
   Mở panel đánh dấu đã đọc những thông báo nó hiện. Lỗi nói rõ cái gì hỏng, cái gì còn nguyên.
4. Logic thuần trong `inbox-model.ts` (nhãn nguồn, thời gian tương đối, sắp xếp) để test node-only.
5. `inbox.open` trong `AppIntentHost` + `use-app-intent-surfaces.ts`; `showConversation` đóng cả hộp thư.
6. `Conversation` nhận `onOpenConversation`; `App.tsx` đổi `cc_conversation` và re-key `Conversation`.
7. Quyết định trong hộp thư cho hội thoại đang mở → `applyTimeline` để thẻ trong transcript cập nhật ngay.
8. i18n vi/en.

## Kiểm chứng

- `packages/conversation-client/test/inbox-model.spec.ts`.
- `apps/web/e2e/inbox.spec.ts`: dấu vắng khi rỗng; việc nền xong → dấu hiện, mở bằng click và bằng
  "mở hộp thư", Escape trả focus, màn hình hẹp, reduced-motion.
