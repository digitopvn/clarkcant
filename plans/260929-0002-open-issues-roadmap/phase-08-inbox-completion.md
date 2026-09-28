---
phase: 8
title: "#196 phase 3–5, #170, #172 phần còn lại"
status: pending
issues: [196, 170, 172]
---

# Phase 08 — Hoàn thiện hộp thư

## Yêu cầu

- #196 phase 3:
  - retry;
  - update: cần route update đi qua lifecycle cài đặt/rollback thật, không vẽ nút khi route chưa có;
  - skip-version;
  - ask-again;
  - peer reply (dựa trên #170).
- #196 phase 4: snooze và suppression.
- #196 phase 5: deep link OS, AppIntent, agent và voice, CLI và MCP qua cùng capability.
- #170: kind `notice` trên NodeLink và waiting item từ node khác. Chứng minh bằng hai node trên một máy qua HTTP
  pairing (V04 PASS). Tách "cross-host proof thật" thành sub-issue gated liên kết #5 (thay thế 1). Trước khi làm,
  kiểm chứng rằng HTTP pairing đủ dùng mà không cần WebSocket transport. Nếu không đủ: không dừng hỏi; tạo issue riêng ghi rõ lý do, cách giải quyết và những gì cần từ user, rồi tiếp tục các phần còn lại (quyết định user 2026-09-29).
- #172 phần còn lại:
  - notice cho effect `unknown` (cần một writer production cho effect ledger);
  - reminder và automation đến hạn (dùng scheduler của phase 06).
  - Hai producer phụ thuộc issue ngoài phạm vi (OAuth hết hạn → #2; yêu cầu pairing node → #5) được tách
    thành sub-issue `blocked,external-gate` (thay thế 1).

## Kiểm chứng

- Test producer với `dedupKey` ổn định.
- E2E hai node (hai port, hai database).
- Playwright cho action và snooze.
- `pnpm verify:full`. Docs trên `clarkcant-web`.

## Rủi ro và rollback

Notice spam hoặc lặp: dedup và giờ yên lặng của #171. Rollback: revert.
