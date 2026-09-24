---
title: Terminal tương tác trong hội thoại
status: done
created: 2026-09-24
branch: claude/interactive-terminal-widget-cr3k1i
---

# Terminal tương tác trong hội thoại

## Kết quả mong muốn

Một thẻ Terminal (host-owned) xuất hiện trong hội thoại, cho phép:

1. mở một shell thật (PTY) tại một thư mục làm việc;
2. điền sẵn lệnh (prefill) để người dùng xem rồi tự nhấn Enter;
3. chạy lệnh (agent chạy qua tool, theo execution policy);
4. gửi kết quả lệnh / vùng chọn / màn hình về phiên chính như tin nhắn của người dùng;
5. người dùng gõ và dùng TUI (vim, htop, pi…) thoải mái: resize, màu, phím đặc biệt;
6. xem tiến trình nền (terminal khác, lệnh `run_command` đang chạy, việc nền) và theo dõi
   real-time một phiên Pi khác (đọc transcript JSONL khi Pi ghi thêm, đã redact secret).

## Ràng buộc

- Terminal là **host-owned** (lane 1): shell có toàn quyền của người dùng, nên không bao giờ là widget
  isolated và không có trong marketplace. Thẻ chỉ do host tạo (`HOST_OWNED_BLOCK_TYPES`).
- Lệnh do **agent** chạy đi qua preflight (thư mục trong root được sở hữu) + `decideExecution` + guardrail,
  giống `run_command`. Khi policy nói `ask`, lệnh được **điền sẵn nhưng không chạy**: người dùng nhấn Enter
  chính là xác nhận, trên đúng dòng lệnh họ thấy.
- Người dùng gõ trực tiếp là hành động của chính họ: không qua policy.
- Một terminal chỉ có **một người điều khiển** (driver) tại một thời điểm; thẻ khác xem ở chế độ quan sát
  và có nút chuyển quyền điều khiển (lease chuyển, không nhân bản).
- Không dựng dữ liệu giả: node không có `node-pty` thì thẻ nói rõ terminal không dùng được và vì sao.
- Emergency stop giết cả các terminal.
- Phiên Pi: chỉ đọc, redact secret trước khi gửi ra trình duyệt; nói rõ là cập nhật theo từng entry Pi ghi.

## Không làm

- Không detach terminal ra cửa sổ riêng (cửa sổ detach không được giữ credential).
- Không cho agent gõ phím tuỳ ý vào TUI (chỉ chạy lệnh ở prompt).
- Không lưu scrollback qua lần khởi động lại node.

## Thiết kế

| Lớp | File |
|---|---|
| Contract | `packages/contracts/src/surfaces.ts` — `terminalSessionCardSchema` |
| PTY + registry | `apps/runtime/src/terminal-sessions.ts` (node-pty lazy, shell integration OSC 133, scrollback, run/read) |
| Pi transcript | `apps/runtime/src/pi-session-watch.ts` (liệt kê + tail + redact) |
| Kênh live | `apps/runtime/src/terminal-gateway.ts` — WebSocket `/terminal`, frame đầu là `auth` |
| HTTP | `apps/runtime/src/routes/terminals.ts` — tổng quan tiến trình, mở/đóng, lệnh cuối |
| Tool agent | `apps/runtime/src/terminal-tools.ts` — `terminal_open`, `terminal_run`, `terminal_read` |
| UI | `packages/conversation-client/src/terminal-card.tsx` (xterm.js) + `terminal-socket.ts` (logic thuần) |

## Phases

1. [Runtime: PTY, kênh live và tool agent](phase-01-runtime.md)
2. [Thẻ Terminal trong hội thoại](phase-02-card.md)

## Tiêu chí chấp nhận

- [x] Unit: registry chạy shell thật, bắt được exit code qua OSC 133, prefill không chạy, run trả output.
- [x] Unit: tool tôn trọng policy (deny → không mở/không chạy; ask → prefill; execute → chạy).
- [x] Unit: tail transcript Pi nhận entry mới và redact secret.
- [x] E2E: thẻ terminal hiện trong hội thoại, gõ lệnh và thấy output, gửi kết quả về phiên chính,
      bàn phím rời terminal bằng F6, danh sách tiến trình hiển thị terminal đang chạy.
- [x] `pnpm verify` xanh.
