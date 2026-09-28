---
phase: 1
title: Gỡ kẹt merge gate và land PR mở
status: pending
issues: [190]
prs: [205, 206, 207, 188]
---

# Phase 01 — Gỡ kẹt merge gate và land PR mở

## Bối cảnh

Ruleset `main: required CI` (id 24128511) yêu cầu `verify (windows-latest, node 24)`, nhưng chỉ PR #207 định nghĩa
job này. Vì vậy #205, #206 và #188 đều `BLOCKED` dù CI khác xanh. #207 đang `CONFLICTING` và trùng thay đổi với
#206 (`tools/invariants/context.mjs`) và với #208 (skip win32 của terminal-gateway, đã land).

## Yêu cầu

- Không PR nào bị kẹt vì một required check không tồn tại trên branch của nó.
- Cách ưu tiên: rebase #207 và merge nó (không sửa ruleset). Chỉ sửa ruleset khi việc rebase không khả thi, và
  phải bật lại check ngay sau khi #207 land. Ghi lại mọi thay đổi ruleset trên issue hoặc PR.

## File

`.github/workflows/*`, `.gitattributes`, `REVIEW.md`, `tools/invariants/context.mjs` cùng test của nó (qua #207
và #206). #205 chạm window channels của `app-desktop`.

## Các bước

1. Checkout #207, rebase lên `main`, bỏ thay đổi terminal-gateway mà #208 đã land, giải conflict `context.mjs`.
   Gộp các test `path.win32` và helper `repoRelativePath` của #206 vào #207.
2. Chạy `pnpm verify`, force-push với lease, chờ CI (có Windows) xanh, rồi merge #207.
3. Đóng #206 với comment "superseded by #207" kèm link commit chứa test đã gộp. Đóng #190 kèm bằng chứng.
4. Rebase #205 lên `main`, chờ CI xanh, review nhanh, rồi merge.
5. #188 (report audit UX, draft): đã chốt: chuyển report sang
   `plans/reports/` qua PR, bỏ trạng thái draft và merge. P0 "Stop một turn đang chạy" được chuyển sang phase 03.

## Kiểm chứng

`gh pr view` cho thấy #205 và #207 `MERGED`. Một PR thử mới nhận đủ required check. #190 đã đóng kèm comment.

## Rủi ro và rollback

Rebase sai có thể làm mất test. Đối chiếu diff trước và sau rebase. Rollback: revert merge commit. Nếu đã sửa
ruleset, khôi phục cấu hình check trước đó (lưu JSON ruleset vào `plans/reports/` trước khi sửa, không chứa secret).
