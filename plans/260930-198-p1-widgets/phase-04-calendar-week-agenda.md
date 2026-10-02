# Phase 04 (K) — Calendar dạng tuần và agenda

Trạng thái: done (#283 qua PR #339). Plan: [plan.md](plan.md).

## Thiết kế dự kiến

- Thêm view `week` và `agenda` cho `canvas.calendar@1` (state `view`), giữ `month` mặc định.
- Sự kiện cả ngày đúng, múi giờ đúng, chỉ báo "bây giờ", chọn sự kiện và xem chi tiết.
- Semantic: view hiện tại, ngày chọn, sự kiện chọn.

## Kiểm chứng

Unit, E2E calendar, ảnh 1280 tối/sáng và 390.

## Rủi ro

Đổi state calendar cần `stateVersion` mới và migrate state cũ; không phá snapshot đã lưu.
