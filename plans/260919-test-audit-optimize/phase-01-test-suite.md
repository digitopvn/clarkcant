# Audit, tối ưu và kiểm chứng

Trạng thái: hoàn tất.

## Ngữ cảnh

- [README](../../README.md), [tài liệu](../../docs/README.md), [conformance](../../docs/conformance-traceability.md).
- Cấu hình: `vitest.config.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`.

## Thay đổi dự kiến

- Thêm `tools/ci-test-scope.mjs` và `tools/test/ci-test-scope.spec.ts`; thêm tools vào discovery của Vitest.
- CI giữ hai tên job, trigger, matrix Node và secret gate. Classifier chỉ bỏ setup/test đắt tiền khi toàn diff thuộc whitelist văn xuôi hoặc manifest đã được invariants kiểm tra.
- `apps/runtime/test/selector-budget-wiring.spec.ts`: thay hai lần chờ 600 ms bằng clock kiểm soát được.
- `apps/runtime/test/bind-failure.spec.ts`: dùng TCP server thật giữ cổng, dọn process và thư mục temp.
- Ghi quy tắc CI vào tài liệu sở hữu nhỏ nhất và cập nhật manifest nếu cần.

## Kiểm chứng

1. Baseline một worker: 1.144 pass, 7 skip, 89 file; tổng đo 76,55 giây.
2. Chạy focused tests cho từng thay đổi; mutation budget phải fail rồi khôi phục source.
3. Chạy `pnpm verify` và so tập tên/trạng thái test với baseline.
4. Định lượng lợi ích CI bằng timing GitHub hiện có; ghi là ước lượng nếu chưa có run mới.

Kết quả: focused tests và `pnpm verify` PASS. Lượt JSON sau sửa cùng một worker có 1.162 pass, 7 skip, 70,25 giây; không mất test cũ hoặc đổi trạng thái. YAML parse, review fail-open, invariants và plan validation PASS. Xem [báo cáo](../reports/test-260919-1908-audit-optimize.md).

## Rủi ro và rollback

Classifier phân loại sai có thể bỏ kiểm tra cần thiết: whitelist hẹp, fallback full và test rename/deletion/missing-base. Không chọn riêng package vì dependency xuyên package. Rollback bằng hoàn nguyên các file tối ưu; không có migration hoặc thay đổi dữ liệu người dùng.
