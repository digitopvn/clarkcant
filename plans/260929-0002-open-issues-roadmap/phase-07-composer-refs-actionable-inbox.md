---
phase: 7
title: "#210 A–D cùng #196 phase 1–2: hợp đồng reference chung"
status: pending
issues: [210, 196]
---

# Phase 07 — #210 A–D cùng #196 phase 1–2

## Bối cảnh

Comment trên #196 yêu cầu `notice-ref` hội tụ với `ComposerReference` của #210. Nếu làm riêng thì sẽ phải làm lại.

## Yêu cầu

- Một hợp đồng `ComposerReference` được version hoá, dùng chung cho `/` skill, `@` entity và notice subject.
- #210:
  - A: provider registry và popover có a11y (bàn phím, focus, screen reader, reduced motion);
  - B: skill;
  - C: entity cục bộ (MCP, file, project, conversation, session);
  - D: resolver chung với #196.
- #210 phase E (cross-node): tách thành sub-issue `blocked,external-gate` liên kết #5 (thay thế 1).
- #196 phase 1: đánh dấu đã đọc/chưa đọc, undo dismiss, "Ask Clark", "Add to context".
- #196 phase 2: `NoticeSubject` và host action resolver.
- Conversation vẫn là bề mặt chính. Không thêm sidebar hay dashboard mặc định.

## Kiểm chứng

- Unit test cho resolver.
- Playwright: gõ `/` và `@` → chọn bằng bàn phím → reference xuất hiện trong turn.
- Hành động notice hoạt động bằng pointer, bàn phím và voice (qua AppIntent).
- `pnpm verify:full`. Docs trên `clarkcant-web` (EN và VI).

## Rủi ro và rollback

Rò entity ngoài scope (ví dụ file ngoài project root): resolver phải tôn trọng confinement của phase 03.
Rollback: revert.
