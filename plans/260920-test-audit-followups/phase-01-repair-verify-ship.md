# Sửa, kiểm chứng và ship

Trạng thái: đã sửa và kiểm chứng local; PR/merge là bước giao hàng tiếp theo được ghi trên GitHub.

## Ngữ cảnh và sở hữu

- `origin/main` đã được merge, gồm E2E và desktop smoke; giữ nguyên hai gate này.
- Tests: contracts, runtime live/calibration, Pi adapter fixture.
- Tools: scanner lịch sử và tests bằng Git repo thật; workflow gọi scanner thay grep chỉ hiện tại.
- Docs: README docs + manifest và journal trong plans.

## Thực hiện

1. Đối chiếu phát hiện audit với source hiện tại và sửa theo hợp đồng thật.
2. Chạy focused tests, mutation có khôi phục source để chứng minh khả năng bắt lỗi.
3. Chạy scanner thật và full verification; E2E dùng port riêng worktree 16483/26483 vì port mặc định thuộc session khác.
4. Review diff, sửa lỗi trong phạm vi, commit/push nhánh hiện tại, tạo PR main và attach.
5. Xác minh checks/review/head trước merge; theo dõi CI merge commit và báo kết quả.

## Rủi ro và rollback

- Secret lịch sử thật phải chặn ship; không tự rewrite lịch sử hoặc log giá trị.
- Provider thật không được gọi trong negative tests; giữ opt-in rõ ràng.
- Không dừng server của session khác. Playwright sở hữu vòng đời server test.
- Rollback bằng revert PR; không có migration hay thay đổi dữ liệu production.

## Kiểm chứng

Ghi kết quả cuối vào báo cáo ship và PR. Không dùng kết quả cũ trước khi merge main làm bằng chứng cho revision mới.

`pnpm verify:full` exit 0: invariants/typecheck/lint PASS, 1.635 Vitest pass/7 opt-in skip, build PASS, browser 99 pass/1 conditional skip có sẵn. Review Approve và scanner lịch sử sạch theo các mẫu hiện có. Xem [báo cáo](../reports/ship-260920-1037-test-audit-followups.md).
