---
title: "#298 Theme Platform M3: chiều sâu giao diện do host sở hữu"
status: completed
created: 2026-09-30
issues: [298]
related: [201, 192, 129, 299, 300, 302, 304, 305]
---

# Theme Platform M3: chiều sâu giao diện (#298)

Pull request: [#347](https://github.com/digitopvn/clarkcant/pull/347).

Nguồn: issue [#298](https://github.com/digitopvn/clarkcant/issues/298), epic #201. Nền M1/M2 đã có trên `main`
(PR #304 contract + compiler, PR #305 theme từ package, đổi giao diện tại chỗ).

## Kết quả cần đạt

- Theme chọn được bản sắc (identity) chứ không chỉ màu: kiểu chữ theo profile đóng, độ dày/kiểu viền, kiểu bóng,
  tốc độ và đường cong chuyển động, bán kính ô nhập, recipe cho button, card, input, modal, badge, composer, và hiệu ứng
  nền/bề mặt có giới hạn (grain, scanlines, dot grid, hard grid, soft glow, glass, paper).
- Theme chỉ là dữ liệu: không selector, không CSS, không shader, không `url()`. Giá trị ngoài biên bị từ chối ở ranh
  giới (node và trang dùng cùng một hàm).
- Clark Default giữ nguyên từng byte: `themeStylesheet()` không đổi, test golden giữ nguyên, fixture không sinh lại.
  Component CSS đọc biến identity với fallback đúng giá trị Clark; test đảm bảo fallback và giá trị Clark là một.
- Ngữ nghĩa bảo vệ do compiler kiểm: Stop, duyệt/từ chối, chrome tin cậy của host, danger/warning/success, focus,
  disabled và provenance vẫn phân biệt được; theme vi phạm bị từ chối như theme thiếu tương phản (mã fallback mới).
  Quy tắc CSS của focus, disabled, trạng thái và card do host sở hữu không đọc biến recipe/hiệu ứng.
- Orb: theme có thể đặt profile mặc định; lựa chọn Orb tường minh của người dùng thắng; reduced motion thắng tất cả.
- Intent `appearance.set-theme`, `appearance.set-color-scheme`, `appearance.reset`, `appearance.open-theme-gallery`
  trên đường AppIntent: chữ, giọng nói, click và `control_app` hội tụ về một bộ hành động; đổi theme dùng PUT
  /preferences và Jev/policy sẵn có, không thêm xác nhận riêng.
- Desktop dùng cùng token: `shell.css` đọc `--cc-*` từ tệp token sinh ra từ design-tokens (test giữ đồng bộ).
- Terminal dùng font mono và màu của theme, đổi theme thì đổi theo.

## Không làm

- Theme Lab/Gallery, dòng "Customize" trong Settings, CLI `clark theme`, conformance tổng quát (#300, M5).
  `appearance.open-theme-gallery` chỉ mở mục Theme hiện có trong Settings.
- Theme tham chiếu Pixel Arcade, Neo Brutalism và font đóng gói (#302, M7). Profile chữ chỉ dùng font hệ thống.
- Đồng bộ lựa chọn sáng/tối lên node: vẫn là lựa chọn của thiết bị như hiện tại (DESIGN.md §11.1).
- Không thêm migration (preference là hàng dữ liệu).

## Phase

| Phase | Trạng thái | Phụ thuộc | Chi tiết |
| --- | --- | --- | --- |
| 01 Contract, compiler, audit, CSS identity, intent, desktop, docs, kiểm chứng | chờ review | — | [phase-01-appearance-depth.md](phase-01-appearance-depth.md) |

## Tiêu chí hoàn tất

- Test tập trung cho mọi guard; mutation check các guard chính có bảng kết quả.
- E2E trong `apps/web/e2e`: theme recipe+hiệu ứng áp dụng; chrome bảo vệ nhìn thấy dưới theme thù địch; reduced motion
  tắt hiệu ứng và chuyển động Orb; chỉ bàn phím; 390 px và 1280 px không tràn ngang; intent gõ chữ đổi theme.
- Ảnh 1280/390 × sáng/tối cho Clark Default và theme thử, so pixel Clark trước/sau.
- `pnpm verify`, `pnpm invariants`, `pnpm verify:full` trên head cuối; PR vào `main`, không merge.
