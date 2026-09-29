# Phase 01 — Primitive nền tảng và mini app (#200)

Trạng thái: chờ. Plan: [plan.md](plan.md).

## Phạm vi

Sub-issue của #200 theo thứ tự: #313 ∥ #314 → #315 (∥ #317, #318) → #316 → #319 ∥ #320 ∥ #332 → #321, #333 (gate
ngoài). #334 và #335 (mô phỏng dev-host) không bị chặn, làm sớm, tuần tự hoặc rebase nhẹ với phần dev-host của #313/#315/#316.
Chi tiết phạm vi, non-goal và tiêu chí nằm trong body từng issue.

## Kiểm chứng

- Mỗi PR: unit test cho contract/runtime/SDK, E2E cho luồng người dùng, `pnpm verify`, `pnpm verify:full`,
  `pnpm invariants`, CI xanh cả Windows.
- Docs EN/VI trong repo và docs chính thức ở `clarkcant-web` sau merge (hoặc issue `ai-handle`).
- #321 chỉ xong khi có bằng chứng chạy thật và key không lộ ra widget, service, log.

## Rủi ro

- #316 lớn cho một PR: nếu review khó, tách resource profile khỏi token broker nhưng giữ một issue theo dõi.
- #313, #315, #316 cùng thêm migration: đánh số tuần tự khi rebase, không sửa migration đã áp dụng.
- Mini app lộ lỗ hổng trong primitive: sửa ở primitive (issue gốc), không vá riêng trong app.

## Rollback

Mỗi PR độc lập; revert PR. Migration mới chỉ thêm bảng/cột, rollback bằng migration tiếp theo nếu cần.
