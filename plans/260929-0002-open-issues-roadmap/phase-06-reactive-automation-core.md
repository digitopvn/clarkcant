---
phase: 6
title: "#197 phase 1–2: provenance, resource theo task, Signal/Intent"
status: pending
issues: [197]
---

# Phase 06 — #197 phase 1–2

## Yêu cầu

- Phase 1:
  - intent provenance;
  - resource theo task, thay cho `projects.roots()` của cả node (hoàn tất hướng mà phase 03 đã chuẩn bị);
  - `run_command` đi qua broker cho worker.
- Phase 2:
  - hợp đồng Signal;
  - delivery inbox bền vững;
  - persistent intent;
  - matcher tất định;
  - scheduler cơ bản mà #172 cần cho reminder và automation đến hạn.
- Jev/policy vẫn là nơi quyết định escalation. Automation không tự duyệt hành động đặc quyền của chính nó.
- Tạo sub-issue cho phase 1–5 của epic #197, liên kết với epic.

## Các bước

Tạo plan con `plans/{date}-197-reactive-automation/`. Đọc `docs/open-interfaces.md` và
`docs/distributed-runtime.md`. Mỗi phase là một PR.

## Kiểm chứng

- Unit test cho matcher (tất định, idempotent với signal lặp).
- Test durability: khởi động lại thì không mất và không nhân đôi delivery.
- Test: worker không đọc được ngoài resource của task.
- `pnpm verify` và `pnpm invariants`.

## Rủi ro và rollback

Automation chạy lặp hoặc chạy ngoài ý muốn: cần dedup key, bounded retry và nút Stop hay tắt intent. Rollback:
revert PR; migration bù trừ.
