---
phase: 2
title: Giao diện — dấu header, popover, lệnh mở, mở hội thoại khác
status: done
---

# Phase 2 — Giao diện

## Việc cần làm

1. `GatewayClient`: `inbox()`, `inboxSummary()`, `markInboxRead(ids?)`, `dismissNotice(id)` — parse bằng schema.
2. `packages/conversation-client/src/inbox/inbox-mark.tsx`: nút trên header, chỉ render khi `waiting + unread > 0`,
   poll 5 s, `refreshKey` để đọc lại ngay.
3. `inbox-panel.tsx`: modal host-owned (là bề mặt quyết định, và DESIGN.md §12 không lồng modal); phần "Đang chờ bạn" trước (Duyệt/Từ chối cho lệnh và quyền gói,
   "Mở hội thoại" cho câu hỏi), rồi "Thông báo" mới nhất trước (chưa đọc: chấm + chữ), ghi thời điểm đọc.
   Mở panel đánh dấu đã đọc những thông báo nó hiện. Lỗi nói rõ cái gì hỏng, cái gì còn nguyên.
4. Logic thuần trong `inbox-model.ts` (nhãn nguồn, thời gian tương đối, sắp xếp) để test node-only.
5. `inbox.open` trong `AppIntentHost` + `use-app-intent-surfaces.ts`; `showConversation` đóng cả hộp thư.
6. `Conversation` nhận `onOpenConversation`; `App.tsx` đổi `cc_conversation` và re-key `Conversation`.
7. Quyết định trong hộp thư cho hội thoại đang mở → `applyTimeline` để thẻ trong transcript cập nhật ngay.
8. i18n vi/en.

## Kiểm chứng

- `packages/conversation-client/test/inbox-model.spec.ts`.
- `apps/web/e2e/inbox.spec.ts`: lệnh chờ duyệt → dấu hiện ở trạng thái `waiting`; từ chối/duyệt từ hộp thư đi qua
  đúng route của thẻ và kết quả nằm trong hội thoại; mở bằng click và bằng "mở hộp thư"; Escape trả focus về dấu;
  màn hình 390 px không tràn ngang; reduced-motion.
- Node e2e dùng chung giữa các spec, nên mỗi test tìm approval của chính nó theo id thay vì khẳng định hộp thư rỗng.
- Việc nền xong (turn control kịch bản của node fixture) → thông báo chưa đọc, "Mở hội thoại" chuyển sang hội thoại
  kia; đọc xong thì dấu biến mất và hộp thư vẫn mở được bằng "mở hộp thư"; mở lại thấy đã đọc; "Bỏ" xoá khỏi danh sách.

## Phát hiện khi chạy e2e

- Tin nhắn chứa thẻ duyệt được đóng dấu thời gian lúc lượt viết nó, *trước* `requested_at` của approval. Cửa sổ quét
  bắt đầu từ `requested_at` bỏ sót đúng thẻ cần tìm. Đã đổi sang quét 2000 tin mới nhất theo `rowid`, kèm test hồi quy.
- Thẻ duyệt trong transcript vẫn hiện nút sau khi *từ chối* (kể cả từ chối ngay trên thẻ): `decidedApprovals` chỉ đọc
  biên nhận `tool-activity`, mà từ chối không tạo biên nhận. Có từ trước, ngoài phạm vi — ghi thành follow-up.
