# Phase 2 — Approval của task điều phối và producer mới (#172)

## Bối cảnh

`apps/runtime/src/task-dispatch.ts` gọi `requestApproval` với `taskId` khi policy trả `ask`, rồi settle task với
lời từ chối "can be retried once it is granted". Chưa có route quyết định, nên hộp thư cố ý bỏ approval có `task_id`.

## Việc làm

1. Route quyết định cho approval của task (giữ ràng buộc digest như route thẻ): grant cho phép lần dispatch lại của
   đúng task đó chạy capability đó; deny để task ở trạng thái đã từ chối. Kind waiting mới trong contract hộp thư,
   hộp thư và `read_inbox` đưa nó ra, UI hộp thư vẽ nút chỉ vì route đã có.
2. Producer "hết hạn mà chưa ai trả lời" cho approval và câu hỏi: một observer định kỳ trong runtime bootstrap,
   khoá `expired:<id>`.
3. Producer effect `unknown` cần đối soát (nơi effect được ghi `unknown`).
4. Producer kết nối OAuth hết hạn/bị thu hồi (nơi trạng thái kết nối đổi).

## Kiểm chứng

Mỗi producer: đúng một thông báo, gọi lặp không thêm dòng, trỏ về hội thoại/đối tượng. Route: digest sai → từ chối,
không quyết định; grant → dispatch lại chạy được.
