# Thẻ Terminal trong hội thoại

Trạng thái: **hoàn tất** (triển khai + kiểm chứng local).

## Sở hữu file

`packages/conversation-client/src/terminal-card.tsx`, `terminal-socket.ts`, `blocks.tsx`, `api.ts`,
`use-block-actions.ts`, `styles/cards.ts`, `i18n/messages-timeline.ts`; `apps/web/e2e/terminal.spec.ts`; `DESIGN.md`.

## Các bước

1. Logic thuần (URL socket, chọn nội dung gửi, định dạng tin nhắn, vẽ transcript Pi) trong `terminal-socket.ts`.
2. Thẻ xterm.js nạp động, theme từ token `--cc-*`, F6 rời terminal, driver/observer, bảng tiến trình.
3. Trạng thái: loading, connecting, attached, gone, disconnected, load-failed, snapshot.
4. DESIGN.md mô tả hành vi đã ship.

## Kiểm chứng

`terminal-socket.spec`, `card-state-matrix.spec`, E2E `terminal.spec.ts` (gõ lệnh + gửi kết quả, F6 + bảng
tiến trình + Escape, kill, viewport 390px + reduced motion).

## Rủi ro / rollback

CSP của shell desktop có thể chặn style inline của renderer DOM xterm; chưa kiểm chứng trên Electron.
