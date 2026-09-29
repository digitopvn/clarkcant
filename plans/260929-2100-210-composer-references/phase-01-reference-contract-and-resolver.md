---
phase: 1
title: "Hợp đồng ComposerReference, provider registry, resolver lúc gửi"
status: pending
issues: [210]
---

# Phase 01 — Hợp đồng, provider, resolver

## Thiết kế

- `packages/contracts/src/composer-references.ts`:
  - `composerReferenceSchema`: discriminated union theo `kind`:
    - `skill { skillId, source, revision }`;
    - `project { projectId }`;
    - `file` và `folder` `{ projectId, path }`, với path tương đối với project;
    - `mcp-server { serviceKey }`;
    - `conversation { conversationId }`;
    - `background-work { workId }`;
    - `notice { noticeId }`.

    Mọi kind đều mang `label` (snapshot để hiển thị, tối đa 120 ký tự).
  - `composerReferencesSchema = { version: 1, items: [...] }`, tối đa 8 item.
  - `composerSuggestionSchema = { key, trigger, kind, label, note?, disabledReason?, ref }`.
  - Message block mới `reference`, mang reference đã resolve và `note` ngắn do node viết.
- `packages/pi-adapter`: `skills()` trả `{ name, description, source: "user"|"project"|"package", revision }`.
  `revision` là sha256 của `SKILL.md`. `skillBody(name, revision)` trả nội dung đã bỏ frontmatter, hoặc lý do stale.
  Fake adapter có danh sách skill cấu hình được để test.
- `apps/runtime/src/composer-suggestions.ts`: registry các provider.
  - `/`: skill.
  - `@`: project, mcp-server (service host), conversation, background-work.
  - `@<project>/<đường dẫn>`: một lần `readdir` không đệ quy trong project, lọc theo tiền tố của đoạn cuối.

  Xếp hạng: khớp chính xác, rồi tiền tố, rồi dùng gần đây, rồi chuỗi con, rồi thứ tự ổn định. Tối đa 8 kết quả.
- Route `GET /composer/suggestions?trigger=&q=`, sau bước kiểm token.
- `apps/runtime/src/composer-references.ts`, `resolveComposerReferences({ services, conversationId, references })`:
  - kiểm từng item lúc gửi;
  - kết quả `{ ok, blocks }`, hoặc `{ ok:false, message }` nêu đúng label bị stale.
  - File và thư mục phải qua `verifyProject`, sau đó realpath phải nằm trong project. Notice phải thuộc principal và
    chưa bị dismiss.
- Cả hai route tin nhắn (thường và stream) dùng chung resolver, trả lỗi 400 `REFERENCE_NOT_AVAILABLE`.
- `referenceBrief(blocks, skillBody)` dựng phần prompt:
  - skill được chèn nội dung trong khối `<skill>`, như Pi tự làm với `/skill:name`;
  - các kind khác là một dòng mô tả kèm id để tool có sẵn dùng tiếp;
  - có ghi rõ: "reference là con trỏ, không phải quyền".

## Kiểm chứng

- Unit test cho contract: version sai hoặc kind lạ thì bị từ chối.
- Unit test cho provider: xếp hạng, giới hạn, path không thoát khỏi project (`..`, tuyệt đối, symlink).
- Unit test cho resolver: skill bị sửa hoặc gỡ, file bị xoá, project ra ngoài root, notice đã dismiss, hội thoại không
  tồn tại. Mỗi trường hợp có một câu lỗi rõ ràng.
- Integration: gửi tin kèm reference thì tin nhắn lưu block `reference`, và brief của lượt đó chứa reference.
- `docs/open-interfaces.md`/`.vi.md` có route mới và field `references`.
