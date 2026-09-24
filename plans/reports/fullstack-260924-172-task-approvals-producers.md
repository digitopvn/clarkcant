# Báo cáo triển khai — issue #172: duyệt approval của task và các notice hết hạn

## Phạm vi đã làm

### Task 1 — route duyệt cho approval do task raise, và mục chờ trong inbox

- Sửa lỗi kiến trúc trong máy trạng thái task: cổng chính sách thực thi
  (`apps/runtime/src/task-dispatch.ts`) trước đây ép task vào trạng thái
  cuối `failed` khi hỏi duyệt giữa chừng một lần chạy, mà `failed` không có
  lối ra hợp lệ nào — một lần cấp duyệt sau đó không bao giờ resume được
  task. Thêm hai sự kiện mới `run.needs_approval` (running → waiting_approval)
  và `run.approval_granted` (waiting_approval → dispatched) vào
  `packages/contracts/src/tasks.ts`, phản chiếu đúng cặp park/resume đã có
  sẵn ở thời điểm resolve (`resolve.need_approval` / `approval.granted`).
- Cổng chính sách giờ park task đúng nghĩa (`waiting_approval`) thay vì đánh
  fail nó, và trả lời trong hội thoại rằng đang chờ duyệt.
- Thêm route `POST /tasks/:taskId/approvals/:approvalId/decide`
  (`apps/runtime/src/routes/control.ts`, hàm
  `decideTaskApprovalForNode` trong `task-dispatch.ts`): kiểm tra approval
  thuộc đúng task, giữ đúng ràng buộc digest như `decideApproval` giữ cho
  approval có card. Khi cấp, replay `run.approval_granted` rồi
  `dispatch.acknowledged` để resume đúng lần chạy đã có lease, sau đó
  dispatch lại trên cùng execution node. Khi từ chối, task giữ nguyên bị
  từ chối, không có gì chạy.
- Thêm loại mục chờ mới `task-approval` vào `packages/contracts/src/inbox.ts`
  (approvalId, taskId, conversationId tuỳ chọn, description, operationDigest,
  effectCategory, requestedAt, expiresAt), suy ra trong
  `apps/runtime/src/inbox.ts` (`pendingTaskApprovals`, đọc thẳng từ bảng
  `approvals` vì loại approval này không có card), mô tả trong tool
  `read_inbox` với cùng cách redact bí mật như các mục khác, và hiển thị
  trong `InboxPanel` (`packages/conversation-client`) với nút Duyệt/Từ chối
  gọi route mới, đầy đủ chuỗi vi + en, không có control giả.
- Cập nhật `apps/runtime/test/inbox.spec.ts`: test cũ khẳng định approval
  của task KHÔNG được hiển thị nay đã thay bằng hai test khẳng định nó
  ĐƯỢC hiển thị và quyết định được qua route riêng.

### Task 2 — notice khi approval/câu hỏi hết hạn không ai trả lời

- File mới `apps/runtime/src/expiry-notices.ts`: quét định kỳ (interval
  unref, khởi động từ `wireRuntime`, dừng khi node đóng) ghi đúng một
  notice cho mỗi approval (lệnh hoặc task) hoặc câu hỏi hết hạn mà không ai
  quyết định, trỏ về hội thoại của nó.
  - Approval: đọc theo vị từ thời gian (`decision = 'pending' AND
    expires_at <= now`) trực tiếp trên bảng `approvals`, không phát minh
    đường ghi trạng thái "expired" mới — approval chỉ được ghi
    `decision='expired'` một cách lazy khi có ai đó thử quyết định nó, nên
    quét theo thời gian là cách đúng để phát hiện mà không cần chờ ai chạm
    vào nó.
  - Câu hỏi: tái dùng `expireQuestions` (đã có sẵn trong
    `apps/runtime/src/interactions.ts`, idempotent, chưa có caller sản xuất
    nào trước đây) — sweep là caller sản xuất đầu tiên của hàm này, đúng
    như gợi ý trong đề bài.
  - Approval năng lực (cài gói) bị loại khỏi sweep vì không có hội thoại để
    trỏ tới, nhất quán với cách `pendingCommandApprovals` đã xử lý.
  - `dedupKey` là `expired:<approvalId|questionId>`, dùng `tryRecordNodeNotice`
    nên sweep không bao giờ làm hỏng công việc gốc.
- Test mới `apps/runtime/test/expiry-notices.spec.ts` (5 case): ghi đúng một
  notice cho approval lệnh, một cho approval task, một cho câu hỏi (và đóng
  câu hỏi luôn — mục chờ biến mất khỏi inbox); gọi sweep hai lần không tạo
  notice thứ hai; không báo gì khi còn trong hạn; không báo approval năng
  lực vì không có hội thoại.
- Nối dây: `NodeServices.expirySweep` (services.ts), khởi động trong
  `wireRuntime` (runtime-bootstrap.ts, chạy cả trên node fixture vì chỉ đọc
  bảng approvals và transcript), dừng trong `shutdown` của `main.ts`.

## Không làm (BLOCKED) — theo đúng ràng buộc "không phát minh đường đi chưa
## tồn tại"

### Task 3 — notice khi effect ở trạng thái `unknown` cần đối soát

BLOCKED: không có đường ghi sản xuất nào tới bảng `effects` để mà đối soát.
Đã tìm bằng grep toàn repo:

- `prepareEffect` (packages/core/src/task-service.ts) là hàm DUY NHẤT tạo
  dòng mới trong bảng `effects`, và nó không có caller nào trong
  `apps/runtime/src` — chưa có gì tạo effect ledger row cả.
- `markEffectUnknown` (chuyển một effect sang trạng thái `unknown`) cũng
  không có caller nào trong sản xuất.
- `recordEffectExecution` (được gọi từ `task-dispatch.ts`) ghi vào một
  luồng hoàn toàn khác — bảng `events`/audit (`effect.executed`) — không
  phải bảng `effects`.

Toàn bộ effect ledger đang không hoạt động ở nhánh sản xuất. Viết một notice
"effect đang ở unknown cần xác minh" lúc này sẽ là phát minh một đường đi
không tồn tại, đúng loại việc đề bài yêu cầu không làm.

### Task 4 — notice khi kết nối OAuth hết hạn/bị thu hồi

BLOCKED: không có đường ghi sản xuất nào tới bảng `connections`. Đã tìm
bằng grep toàn repo:

- Không có câu lệnh INSERT/UPDATE nào tới bảng `connections` ở bất cứ đâu
  trong mã sản xuất.
- Các hàm đọc bảng này (`credentialState`, `mayUseConnection`,
  `connectionsNeedingAttention` trong packages/core/src/limits.ts và
  consent.ts) không có caller nào trong `apps/runtime/src`.
- Block `"connection-card"` (theo `connectionCardBlockSchema`) chưa từng
  thực sự được tạo ra ở đâu — chỉ được nhắc tới trong một switch chung của
  session-search.ts để đánh index tìm kiếm.

Cả hai mục này đã được ghi vào danh sách "Chưa ship" của DESIGN.md §6.7,
nêu rõ lý do thiếu (không có writer sản xuất) để người đọc sau không nhầm
là đã xong.

## Quyết định phạm vi: không thêm e2e mới

Không thêm spec e2e mới cho luồng duyệt approval của task trong
`apps/web/e2e`. Lý do:

- Các hành vi chung của `InboxPanel` (đánh dấu, mở/đóng panel, Escape, trả
  focus, chiều rộng hẹp, reduced motion) là theo bề mặt chứ không theo từng
  loại mục, và đã được phủ bởi các test e2e approval-lệnh hiện có, vốn chạy
  cùng cơ chế component mà block task-approval mới tái dùng.
- Để thực sự tạo ra được một kịch bản approval của task trong môi trường
  e2e cần task dispatcher thật, nhưng `runtime-bootstrap.ts` chủ động tắt
  nó trên node fixture e2e (khối `if (!sessionFixture) { ... }`) để tránh
  một kịch bản có script spawn worker process thật. Dựng thêm capability +
  policy + đường dispatch cho fixture để làm việc này khả thi sẽ là mở rộng
  phạm vi đáng kể ngoài việc được giao.

Không có spec e2e nào được thêm; controller không cần chạy gì thêm ở
`apps/web/e2e` cho thay đổi này.

## Kiểm chứng

- `pnpm exec vitest run apps/runtime/test/task-approval-decide.spec.ts` — 5/5 qua.
- `pnpm exec vitest run apps/runtime/test/inbox.spec.ts` — 23/23 qua.
- `pnpm exec vitest run apps/runtime/test/expiry-notices.spec.ts` — 5/5 qua.
- `pnpm run typecheck` — sạch, không lỗi.
- `pnpm run lint` — sạch, không lỗi.
- `pnpm verify` (invariants → typecheck → lint → test) — toàn bộ 2765 test
  qua, 7 skip, 230 file test, không có test nào fail.
- `node tools/check-invariants.mjs --fix-manifest` đã chạy lại sau khi sửa
  docs, đồng bộ `docs/manifest.json`.
