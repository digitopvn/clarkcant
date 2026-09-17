---
title: "Phase 8: fts5-retrieval"
status: done
---

# Phase 8: FTS5 retrieval, temporal parser và baseline đo

## Overview
- P2; effort ~3 agent-hours; lane L3, song song với Phase 4. Depends on Phase 7.
- Context: [report §5](../reports/analysis-260917-1211-jev-mini-app-rendering.md) — retrieval pipeline là gap đã ghi; hiện **không có FTS/BM25/vector index** trong `packages/storage` (kiểm tra rg 2026-09-17: không có MATCH/bm25/fts ở storage/runtime/core).
- Mục tiêu: lớp **Lexical retrieval** + **Structured filters** của Memory & Search (`docs/system-architecture.png`): SQLite FTS5 bm25, filter theo principal/conversation/task/thời gian. Semantic retrieval là Phase 10; phase này phải trả output shape ghép được vào RRF.

## Requirements
- [ ] Truy vấn keyword trả kết quả theo BM25 rank, lọc được theo conversation/principal/khoảng thời gian.
- [ ] Truy cập scoped theo principal; không trả kết quả từ conversation của principal khác.
- [ ] Không index nội dung đã bị redact ở Phase 7.

## Related code files
Root: `/Volumes/GOON/www/digitop/clarkcant/`.
- Modify `packages/storage/src/migrate.ts`: bảng FTS5 (`session_fts`) + triggers đồng bộ từ `messages`, tokenizers phù hợp tiếng Việt (kiểm tra hỗ trợ unicode61/trigram trên build hiện có).
- Modify `packages/storage/src/repositories.ts`: query helper `searchSessionHistory` (FTS5 MATCH + bm25 rank + date range + scope).
- Create `apps/runtime/src/session-search.ts`: service layer — nhận structured query, trả `{source, ref, score, snippet, provenance}`; đồng thời đăng ký làm tool cho Main Pi (Session Manager: search/resume) qua `pi-adapter` custom tools, vì sơ đồ đặt Session Manager trong control extensions.
- Modify `apps/runtime/src/gateway.ts`: route `GET/POST /search/sessions` (xác minh convention route hiện có trước khi thêm).
- Create `apps/runtime/test/session-search.spec.ts`.

## Implementation steps
1. Migration additive với backup/restore test như Phase 1; FTS5 là virtual table — kiểm chứng `sqlite3` build của Node đã bật FTS5 trước khi cam kết (probe 1 lệnh).
2. Bảng `history_fts(source, ref, conversation_id, task_id, principal_id, created_at, text)`. Nguồn `message`: extract text từ `messages.document` (JSON, `migrate.ts:440`) ở write path. Nguồn `session_entry`: ingest JSONL theo `session_files.ingest_cursor` (batch, idempotent theo offset). Không index raw JSON. Trigger DELETE cho messages; JSONL xóa → xóa theo `session_id`.
3. Date range filter dùng `created_at` ISO; hỗ trợ cả instant và khoảng mở (từ/trước).
4. Trả snippet có highlighting; giới hạn kết quả + pagination bằng offset có bận.
5. Tìm "runtime đang chạy": query trạng thái live (leases/voice_sessions/widget_live_owners) **không qua FTS** — là lookup trạng thái, tách code path riêng.
6. Temporal parser deterministic `apps/runtime/src/temporal-parse.ts` ("hôm qua", "tuần trước", "3 ngày trước", ISO, Việt/Anh) — chuyển từ Phase 9 sang đây vì search cần nó dù có Jev hay không.
7. **Baseline đo:** ≥30 truy vấn thật Việt/Anh, human-label; ghi tỷ lệ acceptable của FTS + parser vào report. Số này là mốc so sánh cho Phase 9 (Jev decider) để chọn default config `search.decider`; Phase 9 vẫn được xây vì Jev còn phục vụ đường điều phối runtime.
8. Test: seed messages thật qua production API, query nhiều từ khóa Việt/Anh, boundary thời gian, scope khác principal → rỗng, từ khóa trùng redacted content không trả kết quả.

## Kết quả (2026-09-17)

- Migration 13: virtual table `history_fts(text, source, ref, conversation_id, task_id, principal_id, created_at)` với `tokenize='unicode61 remove_diacritics 2'` (truy vấn không dấu khớp nội dung có dấu và ngược lại) + trigger `messages_history_delete` để message bị xoá không còn tìm thấy. Probe xác nhận FTS5, bm25, snippet chạy trên `node:sqlite` của Node hiện tại.
- `repositories.ts`: `indexHistory` (idempotent theo `source+ref` — batch retry không nhân bản), `searchHistory` (principal scope trong SQL, from/to, conversation/task/source, limit/offset, snippet highlight), `recentHistory` (cửa sổ thời gian, mới nhất trước), `historyIndexSize`, `toMatchExpression` (mọi term được quote → `NEAR( OR "` không làm throw).
- `apps/runtime/src/temporal-parse.ts` (pure): `parseTemporal` cho tiếng Việt có/không dấu, tiếng Anh, ISO date, "N ngày/tuần trước", "N ngày qua"; ranh giới local day/week/month qua helper của contracts; cụm thời gian bị **loại khỏi** text tìm kiếm; không nhận ra → `none`.
- `apps/runtime/src/session-search.ts`: `searchSessions` (lexical rank 1; nhánh chỉ có mốc thời gian trả nội dung trong cửa sổ), `indexMessage`/`indexMessages` (text của `surface`/`evidence`/`artifact` lấy từ text alternative, không index JSON thô), `textOfSessionEntry` (chỉ lấy field văn bản/lệnh, bỏ id/digest), `ingestSessionEntries` (batch theo `ingest_cursor`, cursor chỉ tiến sau khi batch được index, từ chối session của principal khác), `createSearchHistoryTool` (`search_history` cho Main Pi, chỉ trả ngữ cảnh đọc được, không trả id để hành động).
- `gateway.ts`: `GET/POST /search/sessions` và `POST /search/sessions/:sessionId/ingest`; scope lấy từ transport. Route `/conversations/:id/messages` index message vừa ghi trong cùng request.
- `model-turn.ts`: `extraTools` để composition root đăng ký `search_history` cùng `show_view`; `services.ts` thêm `search: SessionSearchDeps`.
- Tests: `apps/runtime/test/session-search.spec.ts` (20) gồm parser, index/scope, ingest transcript, tool, và **baseline 39 truy vấn có nhãn**.
- Baseline: **lexical 30/31 (96.8%)**, **semantic-only 2/8 (25.0%)** — ghi tại `plans/reports/verification-260917-1615-fts5-retrieval-baseline.md`, kèm ca false positive do trùng token bộ phận được giữ nguyên làm bằng chứng.
- `pnpm verify` pass (725).

## Ghi chú cho phase sau

- Phase 9 chỉ nên dựa vào nhóm semantic-only để quyết định default `search.decider`; lớp lexical đã đủ tốt cho truy vấn trùng từ.
- `searchSessions` trả `mode: "rank"`; Phase 9 mở rộng thành `jev` | `clarify` mà không đổi shape `results`.
- Ingest transcript chạy theo batch; gọi lại là no-op nhờ cursor + `indexHistory` idempotent.

## Success criteria
- Search "bug login" + khoảng "hôm qua" trả đúng messages seed, theo rank hợp lý; cross-principal trả rỗng.
- `pnpm exec vitest run apps/runtime/test/session-search.spec.ts` + `pnpm typecheck` pass.
