---
title: Hộp thư — thông báo và việc đang chờ người dùng
status: done
created: 2026-09-24
branch: claude/sleepy-mccarthy-ys493l
---

# Hộp thư — thông báo và việc đang chờ người dùng

## Kết quả mong muốn

Một nơi duy nhất, host-owned, trả lời hai câu hỏi mà hội thoại hiện tại không trả lời được khi người dùng
đang ở chỗ khác:

1. **Có gì đang chờ tôi?** Lệnh cần duyệt, quyền (capability) mà gói xin lúc cài, câu hỏi agent đang hỏi —
   kể cả khi chúng nằm trong một hội thoại khác với hội thoại đang mở.
2. **Có gì mới?** Việc nền xong/hỏng, task worker (phiên Pi nền) kết thúc, và — khi backend sẵn sàng —
   cập nhật Pi/extension/widget, tin từ node ClarkCant khác, cảnh báo hệ thống.

Người dùng thấy một dấu trên header **chỉ khi có gì đó** (đếm > 0), mở được bằng click, bàn phím, lệnh gõ
("mở hộp thư") hoặc giọng nói, và agent có thể trả lời "có gì mới không?" bằng tool chỉ đọc.

## Ràng buộc

- Mô hình tinh thần vẫn là **một hội thoại, một Clark**. Hộp thư là surface phụ (modal host-owned — là bề mặt quyết định, và modal không lồng nhau), không phải
  sidebar, dashboard hay trình chọn phiên. Mở hội thoại khác từ một mục là *con trỏ tới nơi việc xảy ra*,
  không phải danh sách hội thoại.
- **Việc đang chờ là dữ liệu suy ra, không lưu.** Approval nằm ở bảng `approvals` + thẻ trong transcript;
  câu hỏi nằm trong transcript. Hộp thư đọc lại từ đó mỗi lần, nên không bao giờ có một hàng trạng thái
  nói khác timeline. Không thể "bỏ qua" một việc đang chờ — chỉ trả lời hoặc để hết hạn.
- **Thông báo là bản ghi bền, có giới hạn.** Bảng mới `notifications` (migration 24; bảng `inbox` đã là
  bảng dedup của NodeLink nên không dùng tên đó). Mỗi producer gửi `dedupKey`; unique
  `(principal_id, dedup_key)` làm producer at-least-once (peer gửi lại, kiểm tra cập nhật lặp) trở nên
  idempotent. Giữ tối đa 200 thông báo, thông báo đã ẩn quá 30 ngày bị xoá — cắt tỉa khi ghi.
- Duyệt lệnh từ hộp thư đi **đúng route** thẻ trong hội thoại dùng (`/conversations/:id/approvals/:id/decide`,
  gửi kèm digest đã hiển thị). Duyệt quyền gói đi đúng route Settings dùng. Không có đường duyệt thứ hai.
  Digest được mang theo nhưng không hiển thị.
- Tiêu đề/nội dung thông báo được redact và cắt độ dài trước khi lưu; không bao giờ chứa secret.
- Không tuyên bố dữ liệu là live: hộp thư ghi rõ thời điểm đọc; poll 5 giây như dấu việc nền.
- Chưa đọc được đánh dấu bằng chấm **và** chữ, không chỉ bằng màu.
- Motion dùng token chung (chỉ transform), Escape đóng và trả focus, reduced-motion vẫn dùng được.

## Không làm (tạo follow-up issue)

- Kiểm tra cập nhật Pi SDK / gói npm-git / widget (chưa có nguồn phiên bản upstream) → thông báo `update`.
- Kind `notice` trên NodeLink và approval/câu hỏi xuyên node trong hộp thư (phụ thuộc #5).
- Gửi ra OS (Electron `Notification`, Web Notification API), tuỳ chọn theo loại, giờ yên lặng.
- Producer khác: effect `unknown` cần đối soát, OAuth hết hạn, automation/nhắc việc, yêu cầu ghép cặp,
  approval/câu hỏi đã hết hạn mà chưa trả lời, approval của task dispatch (chưa có route quyết định).

## Thiết kế

```
producer (việc nền, task worker, …, sau này: update-check, NodeLink)
   └─ recordNotification(db, {dedupKey, sourceKind, category, severity, title, body, conversationId?, originNodeId?})
        └─ notifications (migration 24, dedup + cắt tỉa)

GET /inbox ──► { waiting: suy ra từ approvals + transcript,  notices: notifications,  counts }
GET /inbox/summary ──► { waiting, unread }         (poll 5 s bởi dấu trên header)
POST /inbox/read  { ids? }                          (đánh dấu đã đọc; không ids = tất cả)
POST /inbox/notices/:id/dismiss                     (ẩn một thông báo)
```

| Lớp | File |
|---|---|
| Contract | `packages/contracts/src/inbox.ts` — notice, waiting item, response schemas |
| Storage | `packages/storage/src/migrate.ts` (v24) + `packages/storage/src/repositories/notifications.ts` |
| Suy ra việc chờ | `apps/runtime/src/inbox.ts` — gom approval lệnh, quyền gói, câu hỏi |
| HTTP | `apps/runtime/src/routes/inbox.ts` |
| Producer | `routes/conversations.ts` (`startBackgroundWork`), `bootstrap/runtime-bootstrap.ts` (`onSettled`) |
| Tool agent | `read_inbox` trong `apps/runtime/src/read-inbox-tool.ts` (đăng ký ở `node-tools.ts`); `inbox.open` trong `control_app` |
| App intent | `inbox.open` ở contracts/core/client, cụm "mở hộp thư", "open inbox" |
| UI | `packages/conversation-client/src/inbox/*` — dấu header + modal; `apps/web/src/App.tsx` mở hội thoại khác |

### Việc đang chờ được suy ra thế nào

- **Quyền gói**: `listPendingCapabilityApprovals` (đã lọc gói còn active và chưa hết hạn).
- **Lệnh**: hàng `approvals` `pending`, chưa hết hạn, không có `task_id`, không phải digest quyền gói.
  Hội thoại của nó tìm bằng thẻ `approval-card` mang `approvalId` đó trong 2000 tin nhắn mới nhất (theo `rowid`;
  tin chứa thẻ được đóng dấu *trước* `requested_at`, nên không thể quét từ mốc đó) — thẻ là nơi payload sống,
  nên approval không có thẻ thì không duyệt được và bị bỏ.
- **Câu hỏi**: `pendingForConversation` cho các hội thoại có `question-card` trong cửa sổ `QUESTION_TTL_MS`.

## Phases

1. [Backend: contract, bảng, suy ra việc chờ, route, producer, tool](phase-01-backend.md)
2. [Giao diện: dấu header, modal, lệnh mở, mở hội thoại khác](phase-02-surface.md)
3. [Tài liệu, kiểm chứng, PR và follow-up](phase-03-docs-verify.md)

## Tiêu chí chấp nhận

- Việc nền kết thúc → một thông báo (thành công/thất bại) có link về hội thoại; gọi lại producer với cùng
  `dedupKey` không tạo bản ghi thứ hai.
- Lệnh chờ duyệt ở hội thoại A hiện trong hộp thư khi đang mở hội thoại B; Duyệt/Từ chối từ hộp thư cho kết
  quả giống bấm thẻ; mục biến mất khi đã quyết định ở bất cứ đâu.
- Dấu header vắng mặt khi không có gì; xuất hiện với số đếm khi có.
- "mở hộp thư" / "open inbox" mở hộp thư; "mở thư viện ảnh", "tắt thông báo lỗi" không bị coi là lệnh sai.
- Escape đóng hộp thư và trả focus về nút; bàn phím đi hết được; màn hình hẹp không tràn.
- `pnpm verify` và e2e hộp thư qua.
