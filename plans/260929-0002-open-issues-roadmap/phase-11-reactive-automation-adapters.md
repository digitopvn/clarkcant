---
phase: 11
title: "#197 phase 3–5 (fixture, tách live journey)"
status: pending
issues: [197]
---

# Phase 11 — #197 phase 3–5

## Yêu cầu

- Phase 3: GitHub adapter (polling, vì desktop node không nhận được public webhook). Credential đi qua Secret
  Broker. Test bằng fixture hoặc bản ghi HTTP, không gọi API thật trong CI.
- Phase 4: journey từ issue tới draft PR, chạy hết trên fixture hoặc repo giả cục bộ.
- Phase 5: peer signal qua NodeLink (hai node trên một máy) cùng một nguồn signal thứ hai.
- Tách live journey (token hoặc GitHub App thật, repo test thật, webhook công khai) thành sub-issue
  `blocked,external-gate` (thay thế 1). Chọn GitHub App hay token: ghi thành quyết định trong sub-issue, không tự chọn.
- Đóng #197 khi phase 1–5 in-repo xong và sub-issue gated đã tồn tại.

## Kiểm chứng

Test tích hợp với fixture, E2E hai node, `pnpm verify`. Docs trên `clarkcant-web`.

## Rủi ro và rollback

Automation tạo PR thật ngoài ý muốn: trong test chỉ dùng fixture; hành động bên ngoài đi qua Jev/policy.
Rollback: revert.
