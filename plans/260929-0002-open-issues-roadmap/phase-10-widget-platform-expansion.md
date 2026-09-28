---
phase: 10
title: "#198 P1/P2 và #200 (đã khử trùng lặp)"
status: pending
issues: [198, 200]
---

# Phase 10 — #198 P1/P2 và #200

## Yêu cầu

- #198 P1: widget status, artifact và diff; chart; calendar view.
- #198 P2: map, diagram, media. Đóng #198 khi mọi sub-issue xong.
- #200: trước hết cập nhật epic để M3, M5 và M6 trỏ về #198/#195 (đã sở hữu ở phase 04 và 05). Sau đó làm:
  - M1: ArtifactRef broker;
  - M2: executor cho invoke, agent và workflow;
  - M4: JobRef;
  - M7: resource profile và token broker (không đưa secret thô cho widget không tin cậy);
  - 4 mini app tham chiếu. Riêng phần chạy thật của app sinh ảnh (cần provider key) được tách thành sub-issue gated (thay thế 1); phần in-repo dùng fake provider trong test.
- Mỗi milestone là một sub-issue và một PR.

## Kiểm chứng

Unit test, E2E widget, `pnpm verify:full`, `pnpm invariants`. Docs widget trong repo và trên `clarkcant-web`.

## Rủi ro và rollback

Token broker là ranh giới bảo mật: widget chỉ nhận token có phạm vi hẹp và TTL ngắn; có test cho việc từ chối.
Rollback: revert từng PR.
