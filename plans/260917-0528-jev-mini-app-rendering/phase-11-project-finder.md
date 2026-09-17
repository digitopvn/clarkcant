---
title: "Phase 11: project-finder"
status: todo
---

# Phase 11: Workspace & Project Finder + start pi session

## Overview
- P1; effort ~4 agent-hours; lane L3b (sau Phase 7, cạnh Phase 8). Depends on Phase 2 (Jev adapter) và Phase 7 (session persistence để session mở ra là durable).
- Yêu cầu user 2026-09-17: UX chỉ có một màn hình conversation, nên "thêm skill mới cho dự án agentkit đi" phải tự tìm đúng thư mục trong máy, quyết định bằng Jev, rồi mở pi session với initial prompt. Đường C trong `docs/system-architecture.md` §7.2; box "Workspace & Project Finder" trong sơ đồ.
- Seam đã có: `packages/core/src/routing.ts` `disambiguate()` (T19: một câu hỏi làm rõ, không đoán); `WorkerBrief.projectRoots` trong `packages/pi-adapter/src/types.ts:16`; approved roots là chính sách hiện có của worker. Chưa có bảng project nào trong `migrate.ts`.

## Requirements
- [ ] Bảng `project_index(project_id, node_id, path, name, aliases, git_remote, markers, mtime, last_used_at, indexed_at)` per node; migration additive có backup/restore test.
- [ ] Quét bounded: chỉ trong approved roots (config `workspace.roots`, mặc định `~/Projects`, `~/Work`, `~/Repos`, `~/www` nếu tồn tại), depth ≤4, ignore `node_modules`, VCS dirs, `dist`, không theo symlink ra ngoài roots, chỉ metadata + markers (VCS dir, `package.json`, `pyproject.toml`, `README*`, `CLAUDE.md`, `AGENTS.md`), không đọc nội dung file.
- [ ] Cache: refresh incremental theo mtime khi app mở và khi query miss; quét full chỉ khi user yêu cầu hoặc index rỗng. Quét chạy async, không block turn; kết quả cache-first.
- [ ] Rank: exact alias > recent-use > tên/remote khớp (FTS5 trên `name/aliases/path`, bảng riêng nhỏ) → ≤K=8 candidates.
- [ ] Jev Choice chọn project (+ `none`); 1 candidate → không gọi Jev; uncertain/none → `disambiguate()` một câu hỏi; 0 candidate → hỏi user chỉ thư mục (host file dialog trên desktop, nhập path trên web).
- [ ] Verify sau chọn: path tồn tại, nằm trong approved roots, không bị lease writer khác; rồi tạo `WorkerBrief{goal, projectRoots:[path]}` và start session với initial prompt = intent gốc + project context ngắn. Ghi `last_used_at`.
- [ ] Privacy: state gửi Jev chỉ gồm intent + danh sách `{id, name, relPath-from-root, markers}`; không path tuyệt đối home dir, không nội dung file.

## Related code files
Root: `/Volumes/GOON/www/digitop/clarkcant/`.
- Modify `packages/storage/src/migrate.ts`: migration mới `project_index` + FTS nhỏ `project_fts`.
- Modify `packages/storage/src/repositories.ts`: upsert/search/touch cho project index.
- Create `apps/runtime/src/project-finder.ts`: scan bounded + incremental, rank, candidates cho Jev.
- Modify `apps/runtime/src/jev-decider.ts` (Phase 9): thêm `decideProject()` cùng adapter/policy.
- Modify `packages/core/src/routing.ts`: `disambiguate()` nhận thêm `chosen` từ decider; giữ contract T19.
- Modify `apps/runtime/src/services.ts`: wire finder + start session (`createWorkerSession`) từ command mới `start_session_in_project` qua gateway; expose tool `find_project` cho Main Pi.
- Create `apps/runtime/test/project-finder.spec.ts`: quét trên thư mục tạm thật với markers giả, symlink escape, depth/ignore, incremental mtime, cross-root reject.
- Modify `apps/runtime/test/api.spec.ts`: journey "thêm skill cho agentkit" → session mở đúng root, initial prompt đúng.

## Implementation steps
1. Migration + repository; backup/restore test như Phase 1.
2. Scanner: `fs.opendir` recursive có depth/ignore, `lstat` để chặn symlink, thu markers và mtime; incremental bằng so `mtime` thư mục. Đo thời gian trên ~200 repos, ghi vào report.
3. Rank + candidates → Jev Choice qua adapter Phase 2; threshold chung; verify; `disambiguate()` khi cần.
4. Start session: reuse `createWorkerSession` với `projectRoots=[path]`; initial prompt template ngắn; session file persist (Phase 7); message trả về conversation nêu rõ project đã chọn và cách đổi ("không phải, dùng dự án X").
5. Tool cho Main Pi `find_project(query)` và command gateway cho client.
6. Telemetry: cache hit/miss, scan duration, candidates count, mode (jev/rank/clarify).

## Success criteria
- "thêm skill mới cho dự án agentkit đi" với 2 thư mục tên gần nhau (`agentkit`, `agentkit-docs`) → chọn đúng theo recent-use/alias hoặc hỏi một câu; session mở với `projectRoots` đúng; không bao giờ mở ngoài approved roots.
- Cache hit trả candidates <50 ms; scan incremental không block turn.
- `pnpm exec vitest run apps/runtime/test/project-finder.spec.ts apps/runtime/test/api.spec.ts` + `pnpm verify` pass.
