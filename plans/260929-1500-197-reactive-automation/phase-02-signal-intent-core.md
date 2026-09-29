---
phase: 2
title: "Lõi Signal và persistent intent"
status: pending
issues: [197, 172]
---

# Phase 02 — Lõi Signal và persistent intent

## Thiết kế

- **Contracts.**
  - `signalSchema` theo đúng hình trong issue: `source`, `topic`, `subject`, `payload`, `occurredAt`, `receivedAt`,
    `dedupeKey`, `provenance`.
  - `persistentIntentSchema` gồm:
    - `when.topic`;
    - `match[]` với `{path, op, value}`, trong đó `op` là `equals`, `in`, `contains` hoặc `exists`;
    - `do.goal`, `do.resources`, `do.allowedCategories`;
    - `schedule?`, dạng `{everyMinutes}` hoặc `{at}`, cho `timer.fired`;
    - `state` là `active`, `paused` hoặc `removed`;
    - `allowSelfTriggered`;
    - `summary`: câu nói đời thường mà người dùng nhìn thấy.
  - Payload của provider không đi vào contract lõi.
- **Storage.** Migration mới gồm ba bảng:
  - `signal_deliveries`, với `UNIQUE(source_id, dedupe_key)`, trạng thái `pending`/`processed`/`dead`, `attempts`
    và `next_attempt_at`;
  - `persistent_intents`, có `revision` và `next_fire_at`;
  - `intent_runs`, với `UNIQUE(intent_id, signal_id)` và `task_id` nullable.
- **Core.**
  - `matchIntent` là hàm thuần.
  - `ingestSignal` ghi bền vững trước khi làm gì khác, và chuỗi trùng thì được báo là `duplicate`.
  - `processSignals` với mỗi delivery `pending`:
    - đối chiếu mọi intent đang `active`;
    - chèn `intent_run` (trùng thì bỏ qua);
    - tạo task với origin `persistent` và resource của intent, gán `task_id`, rồi dispatch;
    - đánh dấu delivery là `processed`.
  - Lỗi được retry có giới hạn với backoff. Hết lượt thì chuyển sang `dead` và gửi một notice vào inbox.
  - Signal do chính Clark gây ra (`provenance.selfGenerated`) bị bỏ qua, trừ khi intent đặt `allowSelfTriggered`.
- **Runtime.**
  - `automation-service`:
    - lúc boot, chạy lại delivery `pending` và các run chưa có task;
    - một ticker (`unref`) phát `timer.fired` cho intent đến hạn, với dedupe key `timer:<intentId>:<scheduledAt>`,
      rồi dời `next_fire_at`; đây là scheduler cơ bản mà #172 cần.
  - Khi một run bắt đầu hoặc kết thúc, hội thoại của intent nhận một câu nói bằng lời thường.
  - `POST /signals` nhận signal chung đã xác thực bằng token của node. Đây là ingress cho nguồn local và cho test.
- **Model tools.** Chỉ nói bằng lời, không lộ khái niệm:
  - `create_automation` (khi nào, điều kiện, việc cần làm, thư mục hoặc repository, phạm vi effect);
  - `list_automations`, gồm cả vài lần chạy gần nhất và lý do;
  - `update_automation`: tạm dừng, chạy lại, sửa, xoá.

  Câu trả lời "Vì sao Clark làm việc này?" đọc từ origin của task.

## Kiểm chứng

- Matcher: tất định; cùng một signal lặp lại chỉ cho ra một run.
- Durability:
  - crash sau khi ingest, trước khi tạo task: boot sau tạo đúng một task;
  - crash sau khi tạo run, trước khi tạo task: không tạo task trùng.
- Retry: lỗi có giới hạn, rồi `dead` kèm notice.
- Timer: đến hạn thì chạy một lần; restart thì không nhân đôi.
- Tool:
  - tạo, liệt kê, tạm dừng, xoá qua hội thoại (runtime spec với FakePiAdapter);
  - intent tạm dừng thì không match.
- E2E: nói "từ giờ khi có signal X thì làm Y"; `POST /signals` giả lập; hội thoại báo việc đã bắt đầu.
