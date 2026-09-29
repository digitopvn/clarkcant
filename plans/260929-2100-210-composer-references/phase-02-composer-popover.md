---
phase: 2
title: "Popover trong composer, token, chip, gửi kèm reference"
status: pending
issues: [210]
---

# Phase 02 — Popover trong composer

## Thiết kế

- `packages/conversation-client/src/composer-trigger.ts`, gồm các hàm thuần:
  - `activeTrigger(draft, caret)`: `/` ở đầu tin hoặc sau khoảng trắng; `@` ở đầu tin hoặc sau khoảng trắng hay dấu câu.
    Không kích hoạt bên trong URL hay email.
  - `replaceToken(draft, trigger, label)` trả draft mới và caret mới.
  - `liveReferences(draft, refs)` bỏ reference mà token hiển thị của nó không còn trong draft.
- `use-composer-references.ts`:
  - gọi `GET /composer/suggestions`, debounce 80 ms;
  - bỏ kết quả cũ khi query đổi;
  - state gồm active index, danh sách reference đã chọn và trạng thái mở/đóng;
  - IME: không mở hay chọn khi `isComposing`.
- `composer-suggestions.tsx`:
  - listbox đặt ngay trên composer. Textarea mang `role="combobox"`, `aria-expanded`, `aria-controls`,
    `aria-activedescendant` và `aria-autocomplete="list"`;
  - mũi tên di chuyển, Enter/Tab chọn, Escape đóng mà không đổi draft, pointer và touch dùng được;
  - `prefers-reduced-motion` tắt transition.
- Reference đã chọn hiện thành chip cạnh chip tệp đính kèm, có nút bỏ. Token `@label ` hay `/label ` được chèn vào draft.
- `use-turn-send` và `api.ts` gửi `references` cùng `attachmentIds`. Gửi thất bại thì trả lại cả draft lẫn reference.
- Timeline hiển thị block `reference` của tin nhắn người dùng thành chip chỉ đọc.

## Kiểm chứng

- Unit test cho `composer-trigger`: đầu tin, giữa câu, URL, email, nhiều reference, thay đúng khoảng token.
- Playwright:
  - gõ `/` → chọn skill bằng bàn phím → gửi → timeline có chip skill và node nhận đúng reference;
  - gõ `@` → chọn project, rồi `@<project>/` → chọn file → gửi;
  - Escape giữ nguyên draft;
  - gõ `@` và chọn bằng pointer.
- `pnpm verify:full`.
