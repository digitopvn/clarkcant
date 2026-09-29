---
phase: 2
title: Kiểm chứng và đóng issue đã xong
status: done
issues: [93, 129, 169, 171, 173, 174]
---

# Phase 02 — Kiểm chứng và đóng issue đã xong

## Bối cảnh

Scout (`plans/reports/scout-260929-0002-open-issues.md` §2) cho thấy các issue này đã được triển khai trên
`main` nhưng vẫn mở.

## Yêu cầu

Với mỗi issue: đối chiếu từng acceptance criterion với code và test trên `main`. Chạy test tương ứng. Chỉ đóng
khi mọi mục đạt. Nếu còn thiếu, làm phần thiếu theo vòng lặp chuẩn trước khi đóng. Không bịa kết quả.

| Issue | Việc cần kiểm | Ghi chú |
|---|---|---|
| #173 | `use-block-actions.ts` và assertion E2E trong `approval.spec.ts` | — |
| #174 | `packages/core/test/app-intents.spec.ts` (câu "mở hộp thư email của tôi") | — |
| #169 | `apps/runtime/src/update-checks.ts` và test | Ghi hạn chế: package git không bump version; nút Update chuyển sang #196 phase 3 |
| #171 | Thông báo OS, tuỳ chọn và giờ yên lặng | Thử test click bằng Playwright Electron. Nếu không test được thì tách sub-issue gated (thay thế 1), không tuyên bố đã pass |
| #93 | P0/P1 đã land; spec isolated-frame nằm trong job `e2e (browser suite)` bắt buộc; P2 docs land qua #207 | Cần phase 01 xong |
| #129 | Audit acceptance: không replay sau reload, `model.select` theo alias, phân biệt origin trong audit, xác nhận khi quit | Thay thế 1: tách "speech half trên audio thật" thành sub-issue `blocked,external-gate` liên kết #4 |

## Các bước

1. Chạy test hẹp cho từng issue (`pnpm --filter <pkg> test -- <spec>`, và Playwright spec liên quan).
2. Viết comment đóng: từng acceptance → bằng chứng (commit, test, file:line).
3. Với #129: tạo sub-issue gated trước, rồi mới đóng #129.
4. Nếu docs chính thức thiếu hành vi đã ship, mở PR docs trên `clarkcant-web` (EN và VI).

## Kiểm chứng

Sáu issue đã đóng, mỗi issue có comment đối chiếu. Sub-issue của #129 tồn tại với nhãn `blocked,external-gate`.

## Rủi ro và rollback

Một acceptance có thể thực ra chưa đạt. Khi đó giữ issue mở và làm phần thiếu. Rollback: mở lại issue kèm lý do.
