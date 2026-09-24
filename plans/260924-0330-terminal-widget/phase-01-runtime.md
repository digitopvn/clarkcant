# Runtime: PTY, kênh live và tool agent

Trạng thái: **hoàn tất** (triển khai + kiểm chứng local).

## Sở hữu file

`apps/runtime/src/terminal-*.ts`, `apps/runtime/src/pi-session-watch.ts`, `apps/runtime/src/routes/terminals.ts`,
wiring trong `services.ts`, `gateway.ts`, `main.ts`, `node-tools.ts`, `bootstrap/model-bootstrap.ts`,
`application/emergency-stop.ts`, `routes/control.ts`; contract `packages/contracts/src/surfaces.ts`.

## Các bước

1. Registry PTY (`node-pty` nạp lười), shell integration OSC 133 cho bash/zsh, scrollback có giới hạn.
2. `pi-session-watch.ts`: liệt kê transcript Pi, tail JSONL, redact secret.
3. WebSocket `/terminal`: frame đầu `auth`, một driver mỗi terminal, `take` chuyển lease.
4. Tool `terminal_open` / `terminal_run` / `terminal_read` qua preflight + policy; `ask` ⇒ prefill.
5. Emergency stop giết terminal.

## Kiểm chứng

`terminal-output.spec`, `terminal-sessions.spec` (shell thật, gồm data dir tương đối), `terminal-tools.spec`,
`terminal-gateway.spec`, `pi-session-watch.spec`.

## Rủi ro / rollback

Node không nạp được `node-pty` báo terminal không dùng được; revert branch để gỡ toàn bộ.
