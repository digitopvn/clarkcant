---
title: Hoàn tất audit kiểm thử và merge vào main
status: completed
---

# Hoàn tất audit kiểm thử và merge vào main

Ngày: 20/09/2026. Trạng thái triển khai và kiểm chứng local: hoàn tất. Bước PR/merge được theo dõi trên GitHub sau khi push.

## Kết quả cần đạt

Đóng các phát hiện còn lại trong [audit](../reports/test-260919-1908-audit-optimize.md), kiểm chứng lại trên main mới nhất, tạo PR vào `main` và merge khi review cùng CI đạt.

## Phạm vi

- Sửa bằng chứng ID, lost ACK, live provider/calibration và dọn timer fixture Pi.
- Quét secret trong toàn bộ lịch sử file Git, kể cả file đã xóa và docs; không in credential.
- Giữ E2E và desktop smoke đã có trên main; không tạo job trùng.
- Giữ tối ưu trước, cập nhật tài liệu đúng hiện trạng, không đổi hành vi sản phẩm hay tự gọi provider trả phí.

## Các bước

1. [Sửa, kiểm chứng và ship](phase-01-repair-verify-ship.md).

## Tiêu chí chấp nhận

- Test ID thất bại khi bỏ kiểm tra prefix. Test live đã opt-in không pass khi thiếu điều kiện hoặc transport hỏng.
- Scanner bắt secret lịch sử và merge, fail khi shallow/Git lỗi, không lộ giá trị trong log.
- Focused tests, `pnpm verify:full`, review và các check PR đạt trên revision cuối.
- PR merged vào main; kiểm tra CI trên merge commit đến kết quả cuối.

Phụ thuộc: GitHub CLI có quyền push/merge, Node/pnpm/Chromium, runner CI. Credential live không cần cho default suite; không tuyên bố đã chứng minh provider thật.

Kết quả local: `pnpm verify:full` PASS, Vitest 1.635 pass/7 skip và browser 99 pass/1 skip có điều kiện từ main. Review Approve. [Báo cáo](../reports/ship-260920-1037-test-audit-followups.md).
