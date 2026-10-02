# Phase 03 (J) — Chart area và scatter

Trạng thái: done (#282 qua PR #331). Plan: [plan.md](plan.md).

## Thiết kế dự kiến

- `canvas.area@1` (stacked tuỳ chọn) và `canvas.scatter@1` với field x/y khai báo rõ, không suy từ "cột số đầu tiên".
- Dùng chung trục, legend, định dạng số và bảng dữ liệu thay thế của chart hiện có.
- Semantic: chuỗi đang bật, khoảng giá trị, điểm được chọn.

## Kiểm chứng

Unit, E2E gallery và hội thoại, ảnh 1280 tối/sáng và 390.

## Rủi ro

Nhiều điểm scatter: giới hạn số điểm trong schema và cảnh báo khi dataset bị cắt.
