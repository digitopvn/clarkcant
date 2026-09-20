---
title: Audit và tối ưu bộ kiểm thử
status: completed
---

# Audit và tối ưu bộ kiểm thử

Trạng thái: hoàn tất. Ngày: 19/09/2026.

## Kết quả cần đạt

Audit có bằng chứng về độ tin cậy và chi phí; giảm thực thi không cần thiết mà giữ nguyên assertions và toàn bộ nhóm an toàn cho diff có code.

## Phạm vi và giới hạn

- Tối ưu CI cho diff chỉ chứa văn xuôi; invariants và secret scan luôn chạy.
- Thay chờ đồng hồ thật và runtime giữ cổng bằng fixture xác định được.
- Không sửa hành vi sản phẩm, bỏ test, tăng song song browser hoặc tự tuyên bố provider thật đã được kiểm chứng.
- Các phát hiện cần sửa assertions hoặc mở rộng CI browser được báo cáo riêng, không trộn với tối ưu.

## Thực hiện

1. [Audit, tối ưu và kiểm chứng](phase-01-test-suite.md).

## Tiêu chí chấp nhận

- Classifier lỗi/thiếu base/diff hỗn hợp/đường dẫn lạ đều chạy đầy đủ; rename xét cả hai đường dẫn.
- Không mất test cũ; số skip live giữ nguyên; có kiểm thử classifier bằng Git thật.
- Fixture thời gian vẫn phát hiện budget bị giữ từ lúc boot bằng mutation.
- Chạy focused tests trước, sau đó `pnpm verify`; báo rõ kết quả và số liệu trước/sau.

Phụ thuộc: Node 24, pnpm 12, Chromium đã cài; không cần credential provider.

Kết quả: `pnpm verify` PASS. So sánh JSON trước/sau giữ đủ 1.151 test cũ và trạng thái; thêm 18 test classifier. Xem [báo cáo audit và tối ưu](../reports/test-260919-1908-audit-optimize.md).
