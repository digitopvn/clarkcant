# Hoàn tất các phát hiện audit — 20/09/2026

## Phạm vi và kết quả triển khai

Đã sửa các phát hiện còn lại của [audit 19/09](test-260919-1908-audit-optimize.md) và giữ phần tối ưu trước đó. Nhánh đã merge `origin/main` tại `b6b3883`; main mới đã có browser E2E và desktop smoke, nên giữ nguyên hai gate này thay vì tạo bản sao.

| Phát hiện | Xử lý và bằng chứng |
|---|---|
| Test ID không kiểm schema ID | Parse ID đúng, từ chối prefix sai theo hai chiều. Mutation bỏ kiểm tra prefix làm test thất bại. |
| Tên test lost ACK sai hành vi | Đổi tên thành kiểm tra không retry submitted effect chưa có acknowledgement; core vẫn sở hữu kiểm tra chuyển trạng thái. |
| Live smoke/calibration xanh khi thiếu provider | Opt-in thiếu key/model hoặc transport unavailable làm test thất bại với BLOCKED. Calibration kiểm telemetry thực, không tính fallback im lặng như bằng chứng Jev. Negative checks offline/missing-key/missing-embedder đều thất bại đúng lý do; không gọi provider trả phí. |
| Timer fixture Pi còn sống sau abort | Hủy timer khi abort/dispose; probe tạm kiểm số timer còn lại bằng 0, sau đó khôi phục probe. |
| CI thiếu browser journeys | Đã được main giải quyết trước khi tích hợp; giữ E2E và desktop smoke. |
| Secret scan không quét lịch sử | Scanner đọc từng blob reachable qua Git batch, gồm file đã xóa, docs, nhánh khác và merge result. Log chỉ nêu hash/category; shallow clone và lỗi Git chặn gate. |

## Kiểm chứng

- Focused test sửa assertions: 76 pass, 6 skip opt-in mặc định.
- Scanner: 5 pass, gồm Git repo thật, dữ liệu binary, lịch sử xóa, merge result, shallow clone và mọi điểm chia chunk của credential/PEM.
- Scanner thực trên repository: 1.912 phiên bản file, không có đối tượng bị đánh dấu tại thời điểm đo. Scanner theo mẫu, không chứng minh phát hiện mọi loại bí mật.
- Lượt full đầu bắt hai lỗi type: telemetry ngoài scope và tuple pattern bị suy luận sai. Đã sửa nguyên nhân; lượt tiếp theo invariants/typecheck/lint PASS, Vitest 1.635 pass và 7 skip.
- Review độc lập bắt trường hợp PEM header dài bị cắt giữa delimiter; đã sửa carry và thêm regression theo từng chunk. Review lại kết luận Approve, không còn finding cần sửa.
- `pnpm verify:full` PASS, exit 0: 1.635 Vitest pass/7 skip opt-in, production build PASS, Chromium 99 pass/1 conditional skip trong 100 cases. Test Orb hiện có bỏ qua khi renderer không có canvas (`apps/web/e2e/orb.spec.ts:260`); không thêm skip mới. Tổng 194,75 giây, browser khoảng 2,5 phút.
- Các process Playwright/runtime/Vite do task tạo đã thoát, port 16483/26483 đã được trả lại. Không dừng process của session khác.
- CI sau push/merge sẽ được ghi trên PR; chưa có kết quả ở thời điểm ghi báo cáo này.

## Quyết định

Không đổi hành vi sản phẩm hoặc version phát hành cho thay đổi test/tooling. Không gọi provider thật để tạo bằng chứng giả về availability. Giữ full matrix cho mọi diff code/không rõ/lỗi classifier; không tăng song song browser. Port test worktree 16483/26483 không dùng server của session khác.

## Giao hàng

Đang chuẩn bị PR vào `main`; chưa tuyên bố merged hoặc CI cuối cùng xanh. Quyền tạo PR và merge đã được người dùng cấp trong task này.
