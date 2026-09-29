---
phase: 5
title: "Signal từ peer và nguồn thứ hai"
status: pending
issues: [197]
---

# Phase 05 — Signal từ peer và nguồn thứ hai

## Thiết kế

- Signal từ peer: NodeLink có thêm loại envelope `signal`. Nó là một sự thật, không mang quyền hạn. Envelope này đi
  qua `receiveEnvelope` (dedupe và danh tính peer có sẵn), rồi vào `ingestSignal` với
  `source.kind = "peer"`.
- Chuyển intent sang node khác:
  - `do.executor` là tuỳ chọn và do router chọn; người dùng chỉ nói "trên máy Linux";
  - task được tạo với origin `delegated` và đi qua đường delegation NodeLink hiện có;
  - grant và provenance được giữ nguyên.
- Nguồn thứ hai: webhook chung có HMAC (`POST /signals/webhook/<sourceId>`), secret lưu trong Secret Broker. Cùng
  với timer ở phase 02, nó cho thấy lõi thật sự không phụ thuộc GitHub.

## Kiểm chứng

- Signal từ peer được dedupe, và peer lạ bị từ chối.
- Task delegated mang đúng origin và grant.
- Webhook chung có chữ ký hợp lệ thì match, chữ ký sai thì 401.

## Phụ thuộc cần kiểm tra khi bắt đầu

Transport NodeLink còn là stub ở một số chỗ (`docs/distributed-runtime.md`). Nếu delegation thật không khả thi thì
tách phần đó thành sub-issue, nêu rõ lý do.
