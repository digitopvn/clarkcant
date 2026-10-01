---
phase: 12
title: "#201 nền tảng theme"
status: in-progress
issues: [201]
---

# Phase 12 — #201 nền tảng theme

Ngày 2026-09-30: M1 #296/PR304, M2 #297/PR305 và M3 #298/PR347 đã land. M4 #299/PR367 và docs web PR60 đã land, CI/Deploy xanh; [đối chiếu nghiệm thu](../reports/closure-260930-1812-299.md). Đang triển khai M5 #300 tại D:/wt300; sau đó M7 #302. M6 #301 vẫn gated bởi #194.

## Yêu cầu

- M1: hợp đồng; tách `experience.theme` thành `themeRef` + `colorScheme` (migration mới, có backup).
- M2: runtime cho themes facet (cần manifest hợp nhất của phase 04).
- M3: tokenisation, recipe, effect, đồng bộ với desktop.
- M4: `AppearanceSnapshot` trong widget bridge.
- M5: Theme Lab và CLI.
- M7: theme Pixel Arcade và Neo Brutalism. Chỉ đóng gói font nếu giấy phép cho phép.
- Orb default lấy từ #192 (phase 09). Appearance intent đi qua AppIntent của #129.
- M6 (marketplace) phụ thuộc #194, vốn ngoài phạm vi: tách sub-issue gated (thay thế 1).
- Mỗi milestone là một sub-issue và một PR.

## Kiểm chứng

- Unit test cho hợp đồng và migration.
- Playwright: đổi theme → host, widget và Mini App cùng đổi; widget không tin cậy chỉ nhận snapshot đọc được.
- Chụp ảnh màn hình.
- `pnpm verify:full`. Docs trên `clarkcant-web`.

## Rủi ro và rollback

Migration preference làm mất lựa chọn theme cũ: có test chuyển đổi. Rollback: migration bù trừ và revert.
