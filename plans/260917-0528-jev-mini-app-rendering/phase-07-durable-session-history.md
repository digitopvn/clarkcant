---
title: "Phase 7: durable-session-history"
status: done
---

# Phase 7: Durable session history

## Overview
- P2; effort ~2 agent-hours; lane L3 (song song Phase 2 và 3); **depends on Phase 1** (schema/migration discipline), độc lập với Phase 2-6 về code nhưng nên đợi Phase 6 release gate trước khi vào production để tránh trộn diff.
- Context: [report §5](../reports/analysis-260917-1211-jev-mini-app-rendering.md) — session persistence là tiền đề của retrieval; hiện `packages/pi-adapter/src/real.ts:239` dùng `SessionManager.inMemory`, worker trả `sessionFile: undefined`, nghĩa là **chưa có gì để search**.
- Mục tiêu: session/message của pi runtime được persist bền vững kèm timestamp + principal, làm corpus cho Phase 8.

## Requirements
- [x] Session file sống qua restart của runtime và của node.
- [x] Mỗi message có conversation_id, role, sequence, created_at, principal scope.
- [x] Không log/persist secret, token, API key vào session documents.

## Related code files
Root: `/Volumes/GOON/www/digitop/clarkcant/`.
- Modify `packages/pi-adapter/src/real.ts`: thay `SessionManager.inMemory` bằng persistent manager trỏ vào data-dir đã có.
- Modify `apps/worker/src/index.ts:335`: trả `sessionFile` thật thay vì `undefined`.
- Modify `apps/runtime/src/services.ts`: wire session store vào composition root.
- Modify `packages/storage/src/migrate.ts` (nếu cần bảng ánh xạ riêng; bảng `messages`/`conversations` đã có ở migrate.ts:156,440 — ưu tiên reuse).
- Create `packages/pi-adapter/test/session-persistence.spec.ts`.

## Implementation steps
1. Đọc API của pi SDK SessionManager để chọn persistent mode đúng (không đoán tên hàm); nếu SDK không hỗ trợ, persist transcript qua outbox/events tables hiện có. **Đã xác minh 2026-09-17:** FTS5 trong `node:sqlite` hoạt động (bm25, unicode61, trigram). pi SDK 0.85.1 `session-manager.d.ts:319–334` có `SessionManager.create(cwd, sessionDir?, options?)`, `open(path, sessionDir?)`, `continueRecent(cwd, sessionDir?)`, `inMemory(...)`. **Quyết định:** dùng `create(cwd, join(dataDir, "sessions"))` với `dataDir` từ `apps/runtime/src/main.ts:40`; resume qua `open(sessionFile)`.
2. Hai nguồn corpus theo `docs/system-architecture.png` (Knowledge & History Store = Pi JSONL + SQLite): bảng `messages` cho conversation history; JSONL session của worker cho tool calls/reasoning. Thêm bảng additive `session_files(session_id, task_id, principal_id, path, created_at, ingest_cursor)` để Phase 8 ingest theo offset. Không đồng bộ hai chiều.
3. Migration additive + backup/restore test như Phase 1 (nếu cần cột mới).
4. Redaction pass trước persist: strip pattern key/token đã có trong repo (voice-session tokenMatches là tham chiếu).
5. E2E nhỏ: gửi message → restart node → message và session vẫn đọc được.

## Kết quả (2026-09-17)

- Migration 12: `session_files(session_id, node_id, principal_id, task_id, conversation_id, path, byte_size, ingest_cursor, last_ingested_at, created_at, updated_at)` + index theo principal/task. `upsertSessionFile` không ghi đè `created_at`/`ingest_cursor`; `advanceSessionIngestCursor` chỉ tiến (batch retry không rewind).
- `packages/contracts/src/redaction.ts`: một danh sách pattern dùng chung (`redactSecrets`, `findSecretShapes`, `containsSecretShape`); `mini-app-candidates` dùng lại thay vì tự định nghĩa danh sách thứ ba.
- `packages/pi-adapter/src/session-file.ts`: `redactSessionFile` (rewrite từng dòng, **từ chối ghi** nếu JSON hỏng trước hoặc sau khi redact), `readTranscriptFrom(path, offset, limit)` (bỏ partial tail, throw khi gặp dòng hỏng thay vì bỏ qua), `transcriptSize`.
- `RealPiAdapterOptions`: `sessionDir` (có → `SessionManager.create(cwd, sessionDir)`, không → `inMemory` như cũ) và `onSessionFile` callback; adapter gọi callback khi transcript đã nằm trên disk.
- `apps/worker`: trả `handle.sessionFile` thật (trước là `undefined`), `main.ts` nhận `--data-dir` và truyền `sessionDir`.
- `apps/runtime/src/session-store.ts`: `registerSessionFile` (kiểm tra path nằm trong `dataDir/sessions`, từ chối `PATH_OUTSIDE_SESSION_DIR`), `redactRegisteredSession`, `checkResumable` (`SESSION_UNKNOWN`/`SESSION_FILE_MISSING`), `summariseSessions` (không chứa nội dung transcript), `sessionsDirectory`. Service `NodeServices.sessions`, thư mục tạo lúc boot.
- `model-turn.ts` + `main.ts`: model turn nhận `sessionDir` và `onSessionFile`, runtime đăng ký vào index; báo đường dẫn sessions lúc khởi động.
- Tests: `packages/pi-adapter/test/session-persistence.spec.ts` (9) và `apps/runtime/test/session-store.spec.ts` (8) — gồm redaction không phá JSON, offset/limit/partial tail, đọc lại sau restart, path ngoài thư mục sessions bị từ chối, cursor chỉ tiến. `pnpm verify` pass (705).

## Ghi chú cho phase sau

- Phase 8 ingest theo `ingest_cursor` bằng `readTranscriptFrom`; `source: "session_entry"` cho các dòng JSONL, `ref` là `sessionId:offset`.
- Redaction chạy ở boundary per-turn do adapter chọn; nếu một ngày SDK tự ghi thêm, pass này vẫn chạy lại được (idempotent).

## Success criteria
- Restart runtime: `sessionFile` tồn tại trên disk và `open()` resume được; `session_files` có row tương ứng; `messages` đã bền vững từ trước.
- Session Manager là control extension của Main Pi theo sơ đồ: expose `list/resume` qua service trong `apps/runtime`, không trong worker process (service phải sống qua Pi swap).
- `pnpm exec vitest run packages/pi-adapter/test/session-persistence.spec.ts` + `pnpm typecheck` pass.

**Bằng chứng (2026-09-17, kiểm lại):**

- Sống qua restart: `apps/runtime/test/session-store.spec.ts` describe "durability across a restart" — file transcript còn trên đĩa, row `session_files` còn trong database sau khi mở lại.
- Metadata của message: `packages/storage/test/storage.spec.ts` "keeps the identity a history reader depends on" — `conversation_id`, `role`, `sequence`, `created_at`, `delivery` round-trip, và một conversation khác không đọc được message đó.
- Không persist secret: `packages/pi-adapter/test/session-persistence.spec.ts` (redact trước khi ghi, JSON hỏng thì từ chối) và nhánh redaction trong `session-store.spec.ts`.
