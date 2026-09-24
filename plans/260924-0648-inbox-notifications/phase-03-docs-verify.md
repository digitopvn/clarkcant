---
phase: 3
title: Tài liệu, kiểm chứng, PR và follow-up
status: pending
---

# Phase 3 — Tài liệu, kiểm chứng, PR

1. `DESIGN.md`: §6.1 header thêm dấu hộp thư (chỉ khi > 0); mục mới về Hộp thư; ghi rõ "mở hội thoại"
   từ một mục là con trỏ, không phải trình chọn phiên.
2. `docs/system-architecture.md`: §7.5 thêm Hộp thư như view đọc của Interaction Manager; §10 thêm bảng
   `notifications`.
3. `node tools/check-invariants.mjs --fix-manifest` nếu file trong manifest thay đổi.
4. `pnpm verify`, rồi `pnpm test:e2e` cho spec hộp thư, rồi `pnpm verify:full` nếu môi trường cho phép.
5. Commit, push, PR nháp, theo dõi PR.
6. Follow-up issue: cập nhật gói/Pi; NodeLink `notice` + việc chờ xuyên node; thông báo OS + tuỳ chọn;
   producer bổ sung (effect `unknown`, OAuth, automation, ghép cặp, hết hạn, approval task dispatch).
