---
phase: 3
title: "Inbox: đọc/chưa đọc, hoàn tác dismiss, Hỏi Clark, Thêm vào ngữ cảnh, NoticeSubject, action resolver"
status: done
issues: [196]
---

# Phase 03 — Inbox có hành động

## Thiết kế

- Migration mới thêm cột `subject TEXT` vào `notifications`. Migration là bất biến.
- `noticeSubjectSchema` là union có kiểu:
  - `conversation`;
  - `background-work { workId, conversationId }`;
  - `task { taskId, conversationId? }`;
  - `package { packageId, version? }`;
  - `pi-update { packageName, version }`;
  - `peer { nodeId }`.

  `Notice.subject` là tuỳ chọn. Notice cũ không có subject vẫn hiển thị như trước.
- Producer trong `notices.ts` và các nơi gọi `tryRecordNodeNotice` ghi subject đúng nguồn: việc nền, task/worker,
  package, Pi, peer, automation.
- `apps/runtime/src/notice-actions.ts`, `noticeActionsFor(services, notice)`:
  - action được suy ra từ trạng thái hiện tại;
  - chỉ gồm các id `open`, `ask-clark`, `add-to-context`, `mark-read`, `mark-unread`, `dismiss`, kèm `disabledReason`
    khi có;
  - tối đa một action chính và một action phụ, còn lại nằm trong menu `•••`.

  `GET /inbox` trả `actions` cho từng notice. Producer không thể tự gắn action.
- Route mới:
  - `POST /inbox/unread { noticeIds }`;
  - `POST /inbox/notices/:id/restore`, dùng để hoàn tác dismiss trong cửa sổ ngắn; kho lưu cũng chỉ chấp nhận khi
    dismiss đủ mới.
- UI:
  - Hỏi Clark: gửi một lượt với câu mặc định và reference `notice`, vào hội thoại hiện tại.
  - Thêm vào ngữ cảnh: đặt reference `notice` vào composer mà không gửi.
  - Đánh dấu chưa đọc hoặc đã đọc.
  - Sau khi dismiss có toast "Hoàn tác". Live region báo kết quả.
- Voice và lệnh gõ: thêm AppIntent `inbox.ask` với ngữ nghĩa "hỏi Clark về thông báo mới nhất". Nó dùng cùng
  implementation với nút bấm.

## Kiểm chứng

- Unit test:
  - resolver: action theo subject và trạng thái; subject đã mất thì action bị tắt kèm lý do;
  - storage: unread, restore trong cửa sổ, restore quá hạn bị từ chối.
- Route test: notice của principal khác không đổi được.
- Playwright:
  - dismiss rồi hoàn tác;
  - đánh dấu chưa đọc làm số đếm tăng lại;
  - Hỏi Clark tạo lượt có chip notice;
  - Thêm vào ngữ cảnh đặt chip vào composer;
  - thao tác bằng bàn phím.
- `pnpm verify:full`. Docs `clarkcant-web` (EN và VI).
