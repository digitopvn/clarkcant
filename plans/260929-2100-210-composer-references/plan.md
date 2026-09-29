---
title: "#210 A–D và #196 phase 1–2: một hợp đồng reference cho composer và inbox"
status: in-progress
created: 2026-09-29
issues: [210, 196]
related: [5, 209, 198, 200, 129, 137]
---

# #210 A–D và #196 phase 1–2

Nguồn: [#210](https://github.com/digitopvn/clarkcant/issues/210), [#196](https://github.com/digitopvn/clarkcant/issues/196),
phase 07 của [lộ trình](../260929-0002-open-issues-roadmap/plan.md).

## Kết quả cần đạt

Trong ô nhập duy nhất, người dùng gõ `/` để chọn skill và `@` để chỉ tới project, file, thư mục, MCP service, hội
thoại hoặc việc nền. Clark nhận reference có kiểu, được node kiểm lại lúc gửi. Từ Inbox, người dùng có thể đánh dấu
chưa đọc, hoàn tác dismiss, "Hỏi Clark" và "Thêm vào ngữ cảnh". Hai thao tác cuối dùng chính reference đó, không dán
chữ vào prompt. Mỗi notice mang subject có kiểu, và host tự suy ra action hợp lệ từ trạng thái hiện tại.

## Phase

| Phase | Nội dung | Phụ thuộc | Trạng thái |
| --- | --- | --- | --- |
| 01 | [Hợp đồng `ComposerReference`, provider registry, resolver lúc gửi](phase-01-reference-contract-and-resolver.md) | — | done |
| 02 | [Popover trong composer, token, chip, gửi kèm reference](phase-02-composer-popover.md) | 01 | done |
| 03 | [Inbox: đọc/chưa đọc, hoàn tác dismiss, Hỏi Clark, Thêm vào ngữ cảnh, `NoticeSubject`, action resolver](phase-03-actionable-inbox.md) | 01, 02 | pending |

Phase 01 và 02 nằm chung một PR vì phần UI là bằng chứng của hợp đồng. Phase 03 là PR thứ hai.

## Quyết định chung

- Một hợp đồng duy nhất `ComposerReference` (`packages/contracts/src/composer-references.ts`), version hoá bằng
  `COMPOSER_REFERENCES_VERSION = 1`. Body của tin nhắn mang `references: { version: 1, items: [...] }`. Notice
  reference (`kind: "notice"`) là một thành viên của union này, không phải một cơ chế riêng.
- Provider chạy ở node, do host sở hữu (`apps/runtime/src/composer-suggestions.ts`). Client chỉ gọi
  `GET /composer/suggestions?trigger=/|@&q=`. Provider trả reference, không trả callback. Xếp hạng tất định, không gọi LLM.
- Reference là con trỏ, không phải quyền. Chọn một project, file, MCP service hay hội thoại không cấp quyền filesystem,
  không mở rộng quyền MCP, không khởi động hay dừng session. Resolver chỉ kiểm tra rồi mô tả; mọi hành động vẫn đi qua
  tool và Jev/policy có sẵn.
- Resolver chạy lúc gửi: reference đã mất hoặc đã đổi (skill bị gỡ hay sửa nội dung, file bị xoá, project ra ngoài
  approved root, hội thoại không còn) thì bị từ chối bằng một câu tiếng Việt nói rõ reference nào. Bản nháp được giữ lại.
- Reference đã resolve được lưu thành block `reference` trên tin nhắn người dùng. Timeline hiển thị chip, và
  `model-turn` đọc lại chính block đó để dựng phần brief (cùng mẫu với `attachmentBrief`).
- File và thư mục chỉ nằm trong project đã index, tức là trong approved root. Path luôn tương đối với project, dùng `/`
  làm dấu phân cách, và được kiểm realpath để chặn thoát ra ngoài qua symlink (giữ confinement của #137).
- Skill lấy từ Pi resource loader qua `packages/pi-adapter` (chỉ package này được import Pi SDK). `revision` là hash
  nội dung `SKILL.md`, nên skill bị sửa sau khi chọn sẽ bị báo stale thay vì âm thầm chạy bản khác.
- Phase E của #210 (Clark instance và session từ xa) bị gate bởi #5 và #209. Nó được tách thành sub-issue
  `blocked,external-gate` (thay thế 1 của contract lộ trình).

## Ngoài phạm vi

Command palette toàn cục, duyệt marketplace từ `/`, provider từ xa (phase E), #196 phase 3–5 (retry, update, snooze,
deep link, App Intents đầy đủ; thuộc phase 08 của lộ trình).

## Nghiệm thu

Xem phần kiểm chứng của từng phase. Tổng thể: `pnpm verify`, `pnpm verify:full`, E2E Playwright cho `/` và `@`, và các
action của Inbox. Docs `clarkcant-web` (EN và VI).
