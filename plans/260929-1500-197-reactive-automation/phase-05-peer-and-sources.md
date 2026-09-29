---
phase: 5
title: "Signal từ peer và nguồn thứ hai"
status: completed
issues: [197, 244]
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

## Tiến độ

- Xong (PR đầu của #244): envelope `signal` trong NodeLink, `POST /peers/<nodeId>/signals` xếp signal vào outbox,
  lượt chuyển outbox chạy thật trên node (`startPeerDelivery`, ngay khi có hàng và mỗi 30 giây), bên nhận ghi
  `peer.<topic>` theo danh tính của kênh; webhook chung `POST /signals/webhook/<source>` với secret riêng cho từng
  nguồn qua Secret Broker, giới hạn 256 KiB, đặt nguồn trong hội thoại. Bằng chứng: `webhook.spec.ts` (7),
  `webhook-signals.spec.ts` (7), `peer-signals.spec.ts` (6, hai node thật qua HTTP thật).
- Xong (PR thứ hai của #244): chạy task trên node kia — `executor` trên automation, `allow_peer_tasks`/`list_peers`
  ở bên nhận, grant đi bằng `pair.confirm`, `delegate` tạo task origin `delegated` ở bên nhận trong phần giao của grant
  và allowance, effect ngoài phần đó chờ chủ node nhận ở mọi chế độ, `result` quay về hội thoại của bên gửi (kể cả từ
  chối và "chưa rõ" sau khi bên nhận khởi động lại), `cancel.request` dừng ở cả hai bên. Bằng chứng:
  `peer-delegation.spec.ts` (7, hai node thật qua HTTP thật, worker thật).
- Tách ra #253: trạng thái khi task chờ ở bên nhận, thu hồi grant khi gỡ automation, budget giữa các node, trả
  artifact, capability discovery. Hai máy thật vẫn là phạm vi của #5.
