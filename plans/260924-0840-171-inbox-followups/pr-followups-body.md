## Tóm tắt

Phần tiếp theo của hộp thư (#175). PR này thêm những producer và route mà backend lúc đó chưa có, và sửa một lỗi có từ trước. Issue liên quan: #169, #171, #172, #173. Không PR nào tự đóng issue: #172 mới xong một phần, còn #170 vẫn bị chặn.

### #173 — từ chối để lại bản ghi mà thẻ đọc được
- Từ chối một lệnh bây giờ ghi `decide_approval` giống như khi duyệt. Thẻ đọc bản ghi đó để hiện "đã từ chối" và bỏ nút, thay vì trông như vẫn còn chờ.

### #172 — approval của task được điều phối (mới xong một phần)
- Execution-policy gate không còn fail task khi nó cần hỏi. Thay vào đó gate đưa task vào `waiting_approval` bằng hai event `run.needs_approval` và `run.approval_granted`. Trước đây `failed` là trạng thái cuối nên task không thể chạy tiếp.
- Route mới `POST /tasks/:taskId/approvals/:approvalId/decide`:
  - vẫn kiểm tra digest như route của thẻ;
  - duyệt thì task chạy lại capability ngay, không hỏi lần hai;
  - từ chối thì chỉ ghi quyết định.
- Hộp thư hiện thêm loại việc chờ `task-approval`:
  - nội dung đã redact, không có thẻ đi kèm;
  - có nút Duyệt/Từ chối, dùng chung khoá in-flight và đường xử lý lỗi với các dòng khác;
  - `read_inbox` mô tả loại này với cùng mức redact.
- Producer mới: approval hoặc câu hỏi hết hạn mà không ai trả lời thì được báo đúng một lần (`expired:<id>`), trỏ về hội thoại của nó. Việc quét chạy theo chu kỳ trong `wireRuntime` và dừng khi node đóng.
- **Còn chặn**, đã ghi trong DESIGN §6.7 "Chưa ship":
  - thông báo effect ở trạng thái `unknown`: effect ledger chưa có nơi ghi ở production;
  - thông báo kết nối OAuth hết hạn: bảng `connections` chưa có nơi ghi.

### #171 — thông báo ngoài ứng dụng
- Trên desktop: OS notification qua Electron. Thông báo do host sở hữu, chỉ mang tiêu đề và nội dung đã redact, không bao giờ có dòng lệnh. Bấm vào thì focus cửa sổ và mở hộp thư qua `inbox.open`.
- Trên trình duyệt: Web Notification API. Chỉ bật sau khi người dùng bấm nút trong Settings → Control và trình duyệt cấp quyền.
- Tuỳ chọn:
  - bật/tắt theo nhóm: việc chờ duyệt, kết quả việc nền, cập nhật, thiết bị khác;
  - giờ yên lặng;
  - lưu ngay, không cần nút Save.
- Việc chờ còn ≤ 1 phút trước khi hết hạn được nhắc đúng một lần.

### #169 — kiểm tra cập nhật
- Một job định kỳ so sánh:
  - gói và widget đã cài với directory index, dùng cùng resolver với lúc cài;
  - Pi SDK với npm registry.
- Nội dung thông báo nêu version cũ → mới và risk lane.
- Lỗi mạng không tạo thông báo lỗi.
- Khoá dedup theo version nên mỗi version chỉ có một dòng.
- Giới hạn: gói nguồn `git` mà không bump version thì không phát hiện được.

### Hợp nhất với main
- Rebase lên main mới nhất, gồm work supervisor #167 và #168.
- Shutdown vẫn giữ khối bounded shutdown của main và dừng thêm hai timer: update check và expiry sweep.
- Dòng approval của task trong panel được viết dựa trên panel trước các review fix của #175. Khi hợp nhất, dòng này đã được sửa để dùng chung dạng `Busy` và `settleDecideFailure`.

### Không làm trong PR này
- #170 (việc chờ và thông báo từ node khác) phụ thuộc NodeLink pairing (#5).
- Chưa có nút "Cập nhật", vì route cập nhật thật chưa được nối vào lifecycle cài/rollback.

## Kiểm chứng
- `pnpm verify` (sau rebase lên main mới nhất): 243 file test pass, 2893 test pass, 7 skipped.
- `pnpm test:e2e` (bỏ env provider): 163 pass, 3 skipped. Hai lỗi của spec e2e mới (#171) lộ ra khi chạy cả bộ đã được sửa: bấm công tắc qua nhãn thay vì input bị che, và dùng nội dung việc nền riêng để spec hộp thư chạy sau không khớp hai thông báo.
- Chưa kiểm tra tay hành vi click OS notification trên Electron có GUI.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01GwDsQT1Tk2afRLcc8LagXi
