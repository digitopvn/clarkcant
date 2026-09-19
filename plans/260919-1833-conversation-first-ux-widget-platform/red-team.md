# Red-team answers

Plan `260919-1833-conversation-first-ux-widget-platform`, mục "Red-team questions bắt buộc trước khi
bắt đầu mỗi Stage". Mỗi stage trả lời những câu thuộc stage đó **trước khi** bắt đầu, và câu trả lời
phải dựa trên code đã ship chứ không dựa trên ý định.

Quy ước: mỗi câu trả lời nêu kết luận trước, rồi tới bằng chứng, rồi tới những chỗ **không** đạt kèm
việc đã sửa. Một câu trả lời chỉ nói "không sao" mà không chỉ ra chỗ đã kiểm thì không tính là trả lời.

---

## Stage D — Phase 9 (JIT onboarding) và Phase 10 (P0 agentic widget catalog)

### Câu 1 — Feature này có đang leak Pi/Jev/node concept lên default UI không?

**Kết luận: có, ba chỗ. Cả ba đã sửa trong cùng change này.** Đây là câu hỏi có kết quả thật, không
phải câu hỏi để tick.

Ba chỗ leak:

1. **Thẻ phiên browser/desktop in ra "Lease epoch"** — một con số giao thức. Tệ hơn, nó do chính
   Phase 10 này thêm vào, kèm một lý lẽ nghe hợp lý ("không thấy epoch thì không biết takeover có hiệu
   lực không"). Lý lẽ đó sai chỗ: thứ người đọc cần biết là **kết quả** — hành động agent đã lên kế
   hoạch đã bị từ chối — và câu đó đã có sẵn trong thông báo. Con số vẫn còn, nhưng là
   `data-control-epoch` cho test đọc, không phải chữ cho người đọc.
2. **Thẻ artifact in `từ <originNodeId>`** — node id thô. Nay là "từ một node khác": cùng thông tin
   hữu ích, không lộ tên nội bộ.
3. **Thẻ task fallback về node id thô** khi node không có label. Nay cũng là "một node khác".

Những chỗ đã đúng và được xác nhận lại:

- Settings theo 6 tab do người dùng đặt tên; Pi internals chỉ còn trong tab Developer (Phase 4).
- Onboarding mới không hỏi node: setup card nói provider/model/key, là ba thứ người dùng sở hữu.
- Thẻ hội thoại hiển thị nội dung, không hiển thị id trừ khi id **là** nội dung (ví dụ task id trong
  thông báo dừng task, nơi người dùng cần nó để đối chiếu).

Điều còn lại chưa làm, nói rõ: các thẻ vẫn hiện **digest** trong khối artifact khi mở lại. Digest là
dữ kiện của node, nhưng nó cũng là thứ duy nhất trả lời được "có đúng file này không", nên nó ở lại;
đây là chỗ một reviewer có thể phản đối và nên phản đối nếu thấy chưa đủ lý do.

### Câu 10 — Một design target chưa implement có bị UI/docs quảng cáo như shipped không?

**Kết luận: UI thì không; có ba khoảng trống được ghi lại thay vì quảng cáo.**

UI không nói dối ở những chỗ đã ship:

- Wake word: không có detector local nào ship, nên toggle **không dùng được và nói rõ lý do** (Phase 8).
- Voice preview: adapter trả `supportsPreview: false` kèm lý do, không có nút giả (Phase 6).
- Phiên desktop: mặc định `needs-permission`, thẻ nói quyền thuộc hệ điều hành và node không tự cấp
  được; không vẽ preview giả (Phase 10).
- `WIDGET_RUNTIME_STATUS` vẫn là `bridge-codec-implemented-runtime-pending` — tức là nó vẫn nói thật
  là chưa có runtime (Phase 11 sẽ đổi).

Ba khoảng trống, ghi lại chứ không quảng cáo:

1. **Artifact chưa có producer thật.** Bảng, route, control đều thật; không có gì trong sản phẩm tạo
   ra artifact, nên đường này chỉ tới được bằng fixture. Đã nêu trong PR #37 và trong commit.
2. **Phiên browser/desktop chưa có launcher thật.** Mô hình quyền (lease, takeover, stop) là thật và
   có test; không có chỗ nào trong sản phẩm **mở** một phiên, nên hiện chỉ fixture tạo được. Đã nêu
   trong PR #39 và #40.
3. **DESIGN.md mô tả target, không mô tả shipped.** AGENTS.md cho phép điều đó, và chưa có câu nào
   trong DESIGN.md được viết như thể Phase 11–13 đã xong.

Hệ quả cho Stage D: stage này đóng được, nhưng hai khoảng trống (1) và (2) là **nợ kỹ thuật có tên**,
không phải chi tiết bỏ qua. Nếu Phase 11–13 ship runtime mà không có producer nào chạm tới ba widget
đó, thì catalog P0 sẽ mãi là thứ chỉ fixture chạm tới.

---

## Stage E — Phase 11 (Widget SDK runtime) và Phase 12 (Widget CLI)

*Chưa trả lời — sẽ trả lời trước khi bắt đầu Stage E (câu 9).*
