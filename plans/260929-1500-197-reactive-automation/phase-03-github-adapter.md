---
phase: 3
title: "Adapter GitHub"
status: done
issues: [197]
---

# Phase 03 — Adapter GitHub

## Thiết kế

- Package `packages/signal-sources`, trong đó `github.ts` hiện thực `SignalSourceAdapter`:
  - `verify`: HMAC-SHA256 trên body thô, với webhook secret lấy từ Secret Broker; so sánh bằng `timingSafeEqual`;
  - `normalize`: chuyển thành các signal sau:
    - `github.issue.labeled`, `opened`, `edited`;
    - `github.pull_request.opened`, `synchronize`;
    - `github.issue_comment.created`;
    - `github.pull_request_review_comment.created`;
    - `github.workflow_run.completed`, `github.check_suite.completed`;
  - `dedupeKey` là header `X-GitHub-Delivery`;
  - `poll?(cursor)` là seam cho node không nhận được webhook; bản fake có test.

  Lõi automation không import gì từ GitHub.
- Route `POST /signals/github`:
  - không dùng token của node, nhưng bắt buộc có chữ ký hợp lệ;
  - ghi trước, trả `202` ngay, rồi xử lý bất đồng bộ;
  - body bị giới hạn kích thước.
- Chống tự kích hoạt: adapter ghi `provenance.actor`. Signal có actor trùng danh tính GitHub của node (setting
  `signals.github.selfLogins`) được đánh dấu `selfGenerated`.
- Gắn repository: intent có `match` theo `repository == owner/name` cộng resource `repository` (đường dẫn local).
  Trước khi dispatch, dispatcher kiểm tra rằng `git remote get-url origin` của đường dẫn đó trỏ đúng
  `owner/name`.
- Consent: thiếu secret webhook hoặc token thì hỏi qua `request_secret` hiện có, và chỉ hỏi đúng lúc cần.

## Kiểm chứng

- Chữ ký sai hoặc thiếu thì trả 401 và không ghi gì.
- Delivery trùng chỉ được ghi một lần.
- Mỗi loại sự kiện chuẩn hoá đúng topic và subject (fixture payload thật của GitHub).
- Signal tự gây ra không match.
- Remote không khớp thì task bị từ chối.

## Kết quả

- Package `packages/signal-sources` gồm `adapter.ts` (hợp đồng chung `SignalSourceAdapter`, `SignalPoller`) và `github.ts` (xác minh HMAC, chuẩn hoá, parse remote, poller Events API).
- Route `POST /signals/github` nằm trước bước kiểm tra bearer, trong `apps/runtime/src/routes/github-signals.ts`, với giới hạn body 2 MiB ở `server.ts`.
- Automation service kiểm tra `origin` của repository trước khi tạo task.
- Preference `signals.github.selfLogins` được ghi qua `create_automation` (tham số `githubSelfLogins`).
- Việc chạy poller theo lịch chưa được nối; phần này được theo dõi ở một issue riêng.
