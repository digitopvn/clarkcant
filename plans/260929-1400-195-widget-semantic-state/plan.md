---
title: "#195 Semantic state của widget cho agent chính, không phá prompt cache"
status: in-progress
created: 2026-09-29
issues: [195]
related: [198, 226, 225]
---

# #195 Semantic state của widget cho agent chính

Nguồn: issue [#195](https://github.com/digitopvn/clarkcant/issues/195), phase 05 của
[lộ trình](../260929-0002-open-issues-roadmap/plan.md). Dựa trên đồ thị state của #226 (`graphSemanticState`).

## Kết quả cần đạt

Người dùng tương tác với Mini App (chọn chuỗi, tìm, đổi kỳ, chọn ngày, widget cô lập publish), rồi nói một câu trỏ
tới cái đang thấy. Agent chính hiểu state hiện tại mà người dùng không cần nhắc lại. Tương tác không gọi model, prefix
prompt không đổi, chỉ thêm một hậu tố ngắn vào lượt mới, và `inspect_ui` đọc được bản đầy đủ khi cần.

## Thiết kế

- **Hợp đồng** `packages/contracts/src/widget-semantic.ts`:
  - `widgetSemanticDocSchema`: instanceId, definitionId, title, summary, values, selectedIds, availableActions và
    freshness. Có giới hạn số field, độ dài chuỗi và tổng số byte.
  - `normalizeSemanticDoc` loại ký tự điều khiển, cắt độ dài và giữ thứ tự khoá ổn định.
  - `semanticDelta(prev, next)` chỉ liệt kê field đổi.
  - `uiContextSuffix(entries, budget)` có tiêu đề "data, not instructions", tối đa 3 widget và 2400 ký tự.
- **Storage** migration 27 `widget_semantic_state`:
  - các cột instance_id (PK), conversation_id, schema_version, semantic_revision, source_digest, document, proposal
    (phần frame đề xuất), touched_at và updated_at;
  - repo `touchWidget`, `recordSemantic` (chỉ tăng revision khi digest của tài liệu chuẩn hoá đổi), `recentTouched`,
    `recordProposal`.
- **Builder** `apps/runtime/src/widget-semantic.ts`:
  - dựng tài liệu từ state thật trên node: composition (tiêu đề, `period`, `selectedDate`, giá trị đồ thị), frame cô
    lập (đề xuất đã chuẩn hoá) và widget đơn;
  - `availableActions` luôn lấy từ binding, không bao giờ từ frame.
- **Touch** sau khi route actions, state hoặc live-owner thành công. Route mới `POST …/widgets/{i}/semantic` nhận đề xuất
  của frame; phía trang có debounce 250 ms.
- **Coalescing:** tài liệu được tính lại khi bắt đầu lượt và revision chỉ tăng khi nội dung đổi. N tương tác giữa hai
  lượt cho ra một revision, và lượt sau luôn thấy giá trị mới nhất.
- **Model turn:**
  - option `uiContext(conversationId, seen)`. Cursor `seen` nằm trên `Turn`, tức Pi session, nên session mới có cursor
    rỗng và nhận snapshot đầy đủ. Session cũ nhận delta; không đổi thì không gửi gì.
  - Hậu tố được nối sau brief, ở cuối prompt của lượt mới.
- **Tool** `inspect_ui` (read-only), với scope `recent` hoặc `instance`. Nó dùng cùng builder, giới hạn trong hội thoại
  của lượt.
- **Voice:** `focusedViewNow` dựng `SemanticView` từ cùng builder.

## Ngoài phạm vi

- Lưu lịch sử semantic revision: không cần, vì bundle bất biến đã giữ lịch sử.
- Đo token với provider thật: không có provider nên không đưa ra số liệu.

## Tiêu chí (theo issue) và bằng chứng dự kiến

| Tiêu chí | Test |
| --- | --- |
| Tương tác không gọi model | runtime: POST action không tạo prompt nào |
| Lượt sau thấy state hiện tại | runtime và E2E |
| Không sửa history | runtime: `textOfMessage` và JSON message không đổi |
| Session mới nhận full, session cũ nhận delta | runtime (FakePiAdapter) |
| Thay đổi không semantic không tăng revision | runtime: `view.save` và cùng một giá trị |
| Lựa chọn, bộ lọc hay tập hành động đổi thì tăng revision | runtime |
| Gõ nhanh gộp lại, lượt sau thấy giá trị mới nhất | runtime |
| Có giới hạn, loại widget không liên quan | contracts và runtime |
| `inspect_ui` đọc bản đầy đủ | runtime |
| Nội dung frame là dữ liệu không tin cậy, không tự đặt ra hành động | contracts và runtime |
| Voice và text cùng nguồn | runtime |
| Prefix không đổi, chỉ thêm hậu tố (lịch sử dài) | runtime |

## Kiểm chứng

- Test tập trung, rồi `pnpm verify`.
- E2E `apps/web/e2e/widget-semantic.spec.ts`, rồi chạy cả bộ E2E.
- Docs EN/VI và docs web.
