# Phase 02 (I) — Trình xem artifact, file, code và diff

Trạng thái: done (#281 qua PR #288). Plan: [plan.md](plan.md).

## Thiết kế dự kiến

- Primitive trình bày: thẻ file/artifact (tên, loại, kích thước, nguồn), khối code (ngôn ngữ, dòng, cuộn có giới
  hạn, sao chép), diff (unified, cộng/trừ bằng ký hiệu và màu, số dòng).
- Nội dung inline có giới hạn kích thước; ref tới artifact thật chỉ qua broker của host (#200 M1), không URL tuỳ ý.
- Không highlight bằng thư viện chạy mã; escape toàn bộ văn bản.
- Semantic: tên file, ngôn ngữ, số dòng, số dòng thêm/bớt.

## Kiểm chứng

Unit, E2E gallery và hội thoại, ảnh 1280 tối/sáng và 390.

## Rủi ro

Nội dung lớn làm nặng hội thoại: giới hạn byte và số dòng trong schema, cắt có báo.
