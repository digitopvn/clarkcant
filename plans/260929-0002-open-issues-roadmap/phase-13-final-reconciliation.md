---
phase: 13
title: Đối soát cuối và bàn giao
status: pending
issues: [2, 3, 4, 5, 193, 194, 199, 209]
---

# Phase 13 — Đối soát cuối và bàn giao

## Yêu cầu

- Liệt kê lại toàn bộ issue mở. Mọi issue trong phạm vi phải đã đóng kèm comment đối chiếu acceptance.
- Mỗi issue gated (#2, #3, #4, #5, #193, #194, #199, #209 và các sub-issue gated vừa tạo) có một comment ngắn,
  cập nhật: phần in-repo nào đã có, và prerequisite bên ngoài nào còn thiếu. Không đóng các issue này. #2–#5 được
  pin bởi invariant registry, nên phải giữ mở.
- `docs/conformance-traceability.md` khớp với trạng thái thật (chỉ tiếng Anh).
- Mọi thay đổi người dùng nhìn thấy đã có docs merged trên `clarkcant-web`, hoặc có issue fallback `ai-handle`.
- Viết report `plans/reports/summary-{date}-open-issues-roadmap.md`: issue đã đóng, PR, docs, sub-issue gated,
  câu hỏi còn mở.

## Kiểm chứng

`gh issue list --state open` chỉ còn issue gated. `pnpm verify` trên `main` mới nhất. `pnpm invariants`.

## Rủi ro và rollback

Không áp dụng. Chỉ đối soát.
