# Phase 01 — Semantic state và ghi chú UI cho lượt kế tiếp

Trạng thái: xong. Plan: [plan.md](plan.md).

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

## Điều chỉnh khi triển khai

- Không touch ở route live-owner: nhận quyền xem bản live không đổi nghĩa của widget, nên không phải thay đổi
  semantic. Touch chỉ ở route actions, state và `/semantic`.
- `uiContextNote` trả `{ text, shown }`. Chỉ widget được nêu trong ghi chú mới được đánh dấu đã thấy, nên widget bị
  bỏ vì ngân sách vẫn là tin mới ở lượt sau.
- Binding loại `view` bị loại khỏi `availableActions` của model, vì giá trị đã nói state mà binding đó ghi. Voice
  vẫn giữ mọi binding của view.
- Giới hạn danh sách là 12 mục × 80 ký tự để một danh sách không vượt giới hạn byte của tài liệu.
- Văn bản trong tài liệu đi qua `redactSecrets`.
- SDK có thêm `values` trong `semantic.publish(summary, selectedIds, values?)`; schema bridge tự khai báo giới hạn
  để bundle của widget không phải kéo theo contracts.
- Summary của composition không lặp lại giá trị đồ thị: nếu lặp, mỗi thay đổi giá trị cũng thành thay đổi summary và
  delta nói hai lần.
- Chip ghim hiện tiêu đề hoặc nhãn của widget thay cho definition id (lỗi UX phát hiện khi chụp bằng chứng E2E).

## Ngoài phạm vi

- Lưu lịch sử semantic revision: không cần, vì bundle bất biến đã giữ lịch sử.
- Đo token với provider thật: không có provider nên không đưa ra số liệu.

## Kiểm chứng

- Test tập trung, rồi `pnpm verify`.
- E2E `apps/web/e2e/widget-semantic.spec.ts`, rồi chạy cả bộ E2E.
- Docs EN/VI và docs web.
