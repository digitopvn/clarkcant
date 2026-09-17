---
title: "Jev mini-app rendering — implementation plan"
description: "Jev chọn presentation; host compile catalog surface với snapshot bất biến và live actions."
status: pending
priority: P1
effort: "~33 agent-hours tuần tự, ~19h wall-clock với lanes song song (Phase 10 sau M1 +4h)"
branch: "main"
tags: [feature, frontend, backend, api]
blockedBy: []
blocks: []
created: 2026-09-17
updated: 2026-09-17
---

# Jev mini-app rendering — implementation plan

## Overview

Kế hoạch cho mini-app đủ sketch với dữ liệu local thật: KPI, filter, chart, calendar, image, CTA trong conversation và expanded/pinned. **Đây là plan chưa triển khai.**

[Đề xuất và gap analysis](../reports/analysis-260917-1211-jev-mini-app-rendering.md) là design contract chi tiết. Jev cung cấp typed selection; host validate/compile/persist spec; React chỉ render. Snapshot lịch sử giữ exact data; mở live dùng cùng logical instance.

Bản cập nhật 2026-09-17 (review lần 2): đối chiếu docs/ (blueprint v2), source hiện tại và tài liệu TypeSafe live; chốt các quyết định thiết kế còn mở để cook không phải hỏi lại; đổi ước lượng sang agent-hours.

## Ràng buộc kiến trúc kế thừa từ docs/

**Nguồn ưu tiên:** `docs/system-architecture.png` (sơ đồ mới nhất, thay thế `system-architecture.md` ở những chỗ khác nhau). Bổ sung: `docs/widgets-and-extensions.md` §3, §5, §6, §12; `docs/scope-lock.md` V11–V13.

Từ sơ đồ mới, những gì ràng buộc plan này:

- **Conversation Host** gồm Chat/Voice, "Text + rich widgets + pins", Context Builder, Command Gateway. Mini-app nằm trong "rich widgets + pins"; compose step chạy ở runtime phía sau Command Gateway, không trong UI.
- **Memory & Search (Critical)** là **shared service sống qua Pi swap**, local-first, gồm 5 lớp: Semantic retrieval (sqlite-vec, exact KNN), Lexical retrieval (SQLite FTS5, BM25), Structured filters (tasks, projects, source refs), Local embeddings (E5-small quantized ONNX), Rank + verify (RRF, branches, live status). Phase 7–9 phải là các lớp của service này, không phải tính năng riêng lẻ.
- **Session Manager** (search, resume, spawn, monitor) là control extension của Main Pi. Search session phải expose được cho Main Pi như tool, không chỉ là route HTTP cho client.
- **Knowledge & History Store** = Pi JSONL + operational SQLite: conversation history, session summaries, code embeddings, docs & notes, preferences. Corpus search gồm cả JSONL session của worker, không chỉ bảng `messages`.
- **Thin Lifecycle Supervisor** (drain, checkpoint, swap; không LLM) là lý do search service không được sống trong pi worker process.
- **Jev = lớp quyết định sau retrieval** (chốt với user 2026-09-17, ghi tại `docs/system-architecture.md` §7.2). Hai đường: (A) điều phối runtime: Session Manager liệt kê running runtimes → structured filters → Jev Choice chọn target → host verify lease/grant → dispatch qua gateway; (B) tìm session cũ: FTS5 + KNN → RRF → top-K → Jev Choice/Noul chọn context hoặc yêu cầu hỏi lại. (C) tìm project/thư mục để mở pi session: index cache trên **toàn thư mục home** (không chỉ code, vì app hướng đa tác vụ) → quét bounded khi miss → lexical + recent-use → Jev Choice → verify path/roots → `WorkerBrief.projectRoots` + initial prompt (yêu cầu user 2026-09-17, vì UX chỉ có một màn hình conversation). Jev không search, không sinh nội dung, không cấp quyền, không quyết định side effect. Cùng adapter Phase 2 dùng cho selector rich widgets.

- **Composition = "Declarative composition" tier** (widgets §7 trust tiers): không executable payload, chỉ existing components + bound actions. Đây chính là `canvas.overview@1`.
- **Action model** (widgets §5.3): client gửi `instanceId + actionId + expectedRevision + input + commandId`; host reauthorize. Plan dùng `ActionInvocation` schema đã có, không tạo action model mới. Filter/calendar là `view` action; save-view là `view` + pin; **không** có `invoke`/`agent` CTA trong M1.
- **Pin = cùng logical instance** (widgets §6; `widget_live_owners`, `pins` đã có trong `migrate.ts`). Một live owner; vị trí còn lại read-only.
- **Snapshot** (widgets §3.2): history không bị viết lại thành dữ liệu hiện tại. Contract hiện có `presentationRef` + `capturedRevision` chưa đủ, Phase 1 thêm bundle ref additive.
- **Model không cấp quyền** (arch §13.2): Jev output chỉ là enum trong candidates host cung cấp. Đây cũng là lý do `show_view` catalog không cho host-owned card (`apps/runtime/src/view-catalog.ts` header comment).
- **Secrets** (arch §10, §13.6): `TYPESAFE_API_KEY` chỉ ở runtime env; không renderer, không props, không snapshot, không log.
- **Catalog spec ≤256 KiB** (widgets §12) là trần cho composition spec; bundle snapshot 1 MiB là store riêng, không đi qua message.
- **Conformance ledger** (`docs/conformance-traceability.md`): T43 double-click, T44 fallback, T47 one live owner, T49 unpin preserves data, T50 disabled pack snapshot readable là các acceptance đã có test, mini-app phải giữ pass; Phase 6 chỉ thêm evidence, không promote status thiếu test.

## Jev (TypeSafe) — facts đã xác minh từ docs live 2026-09-17

| Item | Fact | Hệ quả cho plan |
|---|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer` | Native fetch đủ; adapter ~150 LOC |
| Request | `state` (string/object/array), `model`, `questions{id:{type,instructions,criteria}}` | State là object có tên trường; chỉ sanitized intent + candidate metadata |
| Choice | `criteria` map option→description (null cho phép), ≤255 options; trả `choice`, `probabilities` (sum 1), `confidence` 0–1 | Luôn thêm option `none`; validate `choice ∈ criteria keys` |
| Score | `criteria` là **ordered array** (breaking từ SDK v0.6.0, 2026-09-15) | Không dùng Score trong M1; nếu dùng sau, theo array shape |
| Noul | trả probability 0–1, **không có `confidence`** | Policy Noul dùng probability trực tiếp (≥0.85 bật, ≤0.15 tắt) |
| Batching | Nhiều questions cùng request, cùng state, **đánh giá độc lập** | Một batch cho template + optional sections; validate combination sau |
| Model | **Smoke 2026-09-17 14:40:** `model: "jev-1.13.0"` → HTTP 200, response `model = jev-1.13.0`, 999 ms; `jev-latest` → 200, resolve `jev-1.13.0`, 673 ms | **Gate đã mở.** Pin exact `jev-1.13.0`; adapter vẫn so `model` trả về với config và log drift |
| Errors | 401 key, 422 validation, 429 rate limit, 529 overloaded | 429/529 → `unavailable` có reason; không retry trong budget 4s |
| Limits | Docs không nêu size/rate limits/timeouts | Tự enforce: state ≤16 KiB, deadline 4 s, 1–2 calls/turn |
| JS SDK | `@typesafe-ai/sdk` v0.6.0, `TypeSafeClient.systemOne()`, đọc `TYPESAFE_API_KEY` | **Quyết định:** không cài SDK; adapter fetch riêng để kiểm soát timeout/redaction |
| Confidence guidance | Ngưỡng theo risk; ví dụ 0.5 floor, 0.9 high-stakes; "start conservative, calibrate" | Giữ 0.85/margin 0.20 làm default, calibrate Phase 6 |

## Quyết định thiết kế chốt trong review lần 2

1. **Route convention:** gateway đã có REST tree `/conversations/:id/{messages,timeline,pins,pins/:pinId}` và `/datasets/:id` (`apps/runtime/src/gateway.ts:149–304`). Phase 4 thêm routes cùng kiểu, không qua `/command` envelope.
2. **KPI "completed":** bảng `tasks` không có `completed_at`. Định nghĩa: completed = `state ∈ {succeeded}`, thời điểm = `updated_at` tại revision terminal; pending = mọi nonterminal; failed/cancelled đếm riêng, không gộp completed. Time bucket theo `created_at` cho "tạo" và `updated_at` cho "hoàn thành". Provenance ghi rõ.
3. **Renderer unit tests:** `vitest.config.ts` là `environment: "node"`, không jsdom. Phase 3 không tạo `.spec.tsx`; assertions render đi vào Playwright ở Phase 6, Phase 3 chỉ test pure helpers (range math, props validation).
4. **Session persistence (Phase 7):** pi SDK 0.85.1 có `SessionManager.create(cwd, sessionDir)`, `open(path)`, `continueRecent(cwd)` (đã đọc `.d.ts`). Theo sơ đồ mới, corpus = **hai nguồn**: bảng `messages` (conversation history, nguồn sự thật cho conversation) và Pi JSONL session files của worker (tool calls, reasoning, session summaries). Phase 7 persist JSONL vào `dataDir/sessions` và ghi index `session_files(session_id, task_id, principal, path, created_at)` trong SQLite để Phase 8 ingest. Redaction trước persist ở cả hai nguồn.
5. **FTS corpus (Phase 8):** một bảng `history_fts` với cột `source` (`message` | `session_entry`), `ref`, `conversation_id`, `task_id`, `principal_id`, `created_at`, `text`. `messages.document` là JSON → extract text ở write path; JSONL entries ingest theo batch có cursor (file offset) từ index `session_files`. Không index raw JSON. Kết quả trả về shape `{source, ref, score, snippet, provenance}` để lớp Rank + verify (RRF) ghép được với semantic sau này.
6. **Phase 9 = Jev decision layer**, không còn conditional vì user chốt vai trò Jev là bộ ra quyết định cho cả điều phối runtime và session search. Temporal parser + baseline đo vẫn ở Phase 8; baseline dùng để quyết định **bật Jev theo config** (không gỡ code) khi retrieval thuần chưa đủ. **Phase 10 (semantic retrieval, sqlite-vec + E5-small ONNX)** là lớp còn lại của Memory & Search theo sơ đồ. **Chốt 2026-09-17:** user chấp nhận optional native deps cho search; install path mặc định vẫn FTS-only khi extension/model vắng; README câu "no native modules" sửa thành "không bắt buộc" khi Phase 10 land.
7. **Fallback khi Jev uncertain/unavailable:** pi agent/model mặc định generate template qua cùng pure compiler (đã chốt với user).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Đủ sketch và tương tác với dữ liệu local thật | P1 |
| 2 | Snapshot bất biến, live owner duy nhất và action authorization | P1 |
| 3 | Jev selection có fallback, privacy và evidence thật | P1 |
| 4 | Search session history: durable persistence → FTS5 → Jev routing/rerank (conditional) | P2 |

## Phases

Cột **Lane** đánh dấu nhóm có thể chạy song song (file ownership tách biệt, không chung migration đang mở). Quy tắc: mọi lane chỉ bắt đầu sau Phase 1 vì Phase 1 sở hữu migration/contract; migration của lane sau phải là file migration mới, không sửa migration lane khác đang mở.

Ước lượng là **agent-hours** (một agent làm liên tục, gồm viết code + test + tự verify). Không gồm thời gian chờ user (credentials, data import, nghiệm thu visual) hoặc chờ provider.

| # | Phase | Effort | Depends | Lane | Status |
|---|-------|--------|---------|------|--------|
| 1 | [Composition và snapshot contracts](./phase-01-start.md) | 3h | — | **S0** (serial, chạy trước) | Done |
| 2 | [Jev selector server-side](./phase-02-jev-selector.md) | 2h | 1, exact-model gate | **L1** ∥ | Done |
| 3 | [Local data và composite catalog](./phase-03-local-data-and-catalog.md) | 5h | 1 | **L2** ∥ | Done |
| 7 | [Durable session history](./phase-07-durable-session-history.md) | 2h | 1 | **L3** ∥ | Pending (P2) |
| 4 | [Snapshot, live ownership và actions](./phase-04-snapshot-live-actions.md) | 4h | 3 | L2 (tiếp) | Pending |
| 8 | [FTS5 retrieval + temporal parser + baseline đo](./phase-08-fts5-retrieval.md) | 3h | 7 | L3 (tiếp) ∥ với 4 | Pending (P2) |
| 5 | [Compose trong turn pipeline](./phase-05-turn-composition.md) | 3h | 2, 3, 4 | **J1** (join L1+L2) | Pending |
| 9 | [Jev decision layer cho search và điều phối runtime](./phase-09-jev-query-routing.md) | 3h | 2, 8 | **J2** (join L1+L3) ∥ với 5 | Pending (P2) |
| 6 | [Release validation và evidence](./phase-06-release-validation.md) | 4h + chờ user | 5 (và 9 nếu muốn gộp evidence) | **S1** (serial, cuối) | Pending |
| 11 | [Workspace & Project Finder + start session](./phase-11-project-finder.md) | 4h | 2, 7 | **L3b** ∥ với 8 (sau 7) | Pending (P1) |
| 10 | [Semantic retrieval + RRF](./phase-10-semantic-retrieval.md) | 4h | 8 | sau M1 | Pending (P2) |

```text
S0: [1]
        ┌─ L1: [2] ──────────────┐
sau 1 ──┼─ L2: [3] → [4] ────────┼─ J1: [5] ─┐
        └─ L3: [7] → [8] ────────┼─ J2: [9] ─┼─ S1: [6]
                └─ L3b: [11] ────┘           │
                                 └───────────┘
```

Wall-clock nếu chạy 3 lane song song: 3h (S0) + 9h (L2 là lane dài nhất: 3→4) + 3h (J1 ∥ J2) + 4h (S1) ≈ **19h**, so với ~33h tuần tự. L3b (Phase 11) cần Phase 7 và Phase 2, chạy cạnh Phase 8; sở hữu `project-finder.ts`, migration `project_index` mới, seam `disambiguate` trong `routing.ts`. Ownership: L1 chỉ `apps/runtime/src/jev-*`; L2 chỉ `packs/data-canvas`, `conversation-client`, `mini-app-*`, gateway routes mini-app; L3 chỉ `pi-adapter`, `storage` FTS migration mới, `session-search.ts`, `temporal-parse.ts`. Cả ba không chạm `model-turn.ts` (J1 mới chạm).

Tổng agent-hours: ~21h core (1–6), ~5h search (7–8), ~3h Phase 9, ~4h Phase 11, +4h Phase 10 sau M1 → ~33h tuần tự, ~19h wall-clock với lanes. Phase 7–8 có thể chạy song song với 3–5 vì file ownership tách biệt (`pi-adapter`, `storage` FTS, `session-search.ts`), nhưng migration phải tuần tự sau Phase 1.

## Success Criteria

- [ ] Đủ component regions, filter/calendar/save hoạt động, responsive và accessible.
- [ ] Snapshot N không đổi theo live N+1; restart/pin/ownership/conflict pass; T43/T44/T47/T49/T50 vẫn pass.
- [ ] Provider unavailable vẫn dùng view đã lưu; no secrets/raw private rows sent/logged.
- [ ] Full `pnpm verify` + `pnpm build` + `pnpm test:e2e` và opt-in live integration pass; evidence nói rõ giới hạn.

## Pre-flight trước khi cook

1. Branch: user chọn commit thẳng `main` cho plan/docs (2026-09-17). Code implementation vẫn nên đi feature branch + PR theo CLAUDE.md, trừ khi user nói khác.
2. ~~Smoke exact model id~~ **Đã chạy 2026-09-17 14:40**, state tổng hợp không chứa user data: exact `jev-1.13.0` 200/999 ms, Choice `c1` confidence 1.0, Noul calendar 0.58 (vùng uncertain, đúng kỳ vọng "không đoán"), usage 412/58 tokens. Alias `jev-latest` resolve về cùng id.
3. `TYPESAFE_API_KEY` **chưa có** trong `.env` của repo này; hiện nằm ở `.env` của một repo demo khác trong workspace. Trước Phase 2: thêm `TYPESAFE_API_KEY` vào `.env` local của repo này (đã gitignore) hoặc export trong shell runtime. Implementation không được hardcode path repo khác.

## Gates còn mở

- Dataset/ảnh acceptance do user tạo/import khi nghiệm thu Phase 6; không fake default.
- Thresholds 0.85/0.20 và deadline 4 s là proposed defaults; calibration Phase 6 với ≥30 intent Việt/Anh.
- Task execution/session/memory/supervisor/multi-node gaps trong report §5 không được plan này giải quyết; CTA M1 chỉ save-view.
- Google Calendar OAuth, custom iframe/MCP app runtime: ngoài scope.

## Validation log

- 2026-09-17 (v1): ba quyết định user: Jev chọn + code ghép; snapshot + mở live; đủ sketch với local data. Advisor review tiếp thu (compose trong turn step, contracts trước adapter).
- 2026-09-17 (v4): smoke exact model pass; approved root = `~` (đa tác vụ, không chỉ code); Phase 11 đổi sang index thư mục tổng quát với ignore list hệ thống; Phase 10 chấp nhận optional native deps; đường C ghi vào docs §7.2.
- 2026-09-17 (v3): user chỉ định `docs/system-architecture.png` là kiến trúc mới nhất thay `system-architecture.md`. Điều chỉnh: Phase 7–9 tái định vị thành các lớp của "Memory & Search" shared service; corpus gồm JSONL session + `messages`; thêm Phase 10 semantic retrieval; FTS output shape sẵn cho RRF. Đã kiểm tra `node:sqlite` hỗ trợ `allowExtension`/`loadExtension` (cần cho sqlite-vec).
- 2026-09-17 (v2 review): đọc docs/ blueprint, đối chiếu source, đọc TypeSafe live docs; chốt 7 quyết định ở trên; sửa priority Phase 7–8 về P2; đổi effort sang agent-hours; ghi chú branch cũ (`feat/restart-session-on-logo`) đã lỗi thời, checkout hiện ở `main`.
- `ak plan validate` pass.

<!-- slug: jev-mini-app-rendering -->
