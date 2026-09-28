---
phase: 9
title: "#192 cá nhân hoá Orb"
status: pending
issues: [192]
---

# Phase 09 — #192 cá nhân hoá Orb

## Bối cảnh

`orb.profile` đã có (`clark|calm|jelly|glass|custom`). Orb động là bản sắc mặc định: không được gỡ, và
reduced motion luôn thắng.

## Yêu cầu

- Preset lấy cảm hứng từ ShaderCN. Chỉ chép shader code nếu giấy phép cho phép; nếu không thì tự viết lại.
- Preview trong Settings.
- Lưu preference ngay, không có nút Save.
- Fallback khi reduced motion và khi không có WebGL.
- Quyết định đã chốt: agent chọn 4–6 preset và giữ preference toàn cục `orb.profile`.

## Kiểm chứng

- Unit test cho preference.
- Playwright: đổi preset → orb đổi; bật reduced motion → orb tĩnh; mô phỏng thiếu WebGL → dùng fallback.
- Chụp ảnh màn hình để so sánh.
- `pnpm verify:full`. Docs trên `clarkcant-web`.

## Rủi ro và rollback

Vi phạm giấy phép: kiểm tra `LICENSE` của nguồn và ghi vào PR. Hiệu năng GPU: giới hạn số frame. Rollback: revert.
