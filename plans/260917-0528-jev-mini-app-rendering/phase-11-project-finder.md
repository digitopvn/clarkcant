---
title: "Phase 11: project-finder"
status: done
---

# Phase 11: Workspace & Folder Finder + start pi session

## Overview
- P1; effort ~4 agent-hours; lane L3b (sau Phase 7, cạnh Phase 8). Depends on Phase 2 (Jev adapter) và Phase 7 (session persistence để session mở ra là durable).
- Yêu cầu user 2026-09-17: UX chỉ có một màn hình conversation, nên "thêm skill mới cho dự án agentkit đi" phải tự tìm đúng thư mục trong máy, quyết định bằng Jev, rồi mở pi session với initial prompt. Đường C trong `docs/system-architecture.md` §7.2; box "Workspace & Project Finder" trong sơ đồ.
- Seam đã có: `packages/core/src/routing.ts` `disambiguate()` (T19: một câu hỏi làm rõ, không đoán); `WorkerBrief.projectRoots` trong `packages/pi-adapter/src/types.ts:16`; approved roots là chính sách hiện có của worker. Chưa có bảng project nào trong `migrate.ts`.

## Requirements
- [x] Bảng `project_index(project_id, node_id, path, name, aliases, git_remote, markers, mtime, last_used_at, indexed_at)` per node; migration additive có backup/restore test.
- [x] **Root = thư mục home `~`** (quyết định user 2026-09-17: app hướng đa tác vụ, không chỉ code; thư mục tài liệu, ảnh, dự án viết lách đều là candidate). Quét bounded: depth ≤5 từ `~`, ignore list hệ thống bắt buộc (`Library`, `.Trash`, `.cache`, mọi dotdir, `node_modules`, VCS dirs, `dist`, `build`, `.venv`, `Applications`, cloud-sync placeholder chưa tải), không theo symlink ra ngoài `~`, dừng descend khi gặp marker project (không index con của một repo). Chỉ metadata + markers (VCS dir, `package.json`, `pyproject.toml`, `README*`, `CLAUDE.md`, `AGENTS.md`, `.obsidian`, số lượng file theo loại cho thư mục không có marker). Không đọc nội dung file. Người dùng có thể thêm/bớt roots và ignore qua chat (`workspace.roots`, `workspace.ignore`).
- [x] Cache: refresh incremental theo mtime khi app mở và khi query miss; quét full chỉ khi user yêu cầu hoặc index rỗng. Quét chạy async, không block turn; kết quả cache-first.
- [x] Rank: exact alias > recent-use > tên/remote khớp (FTS5 trên `name/aliases/path`, bảng riêng nhỏ); với thư mục không phải code, `kind` suy từ markers/thành phần (`code`, `docs`, `media`, `generic`) là structured filter theo intent → ≤K=8 candidates.
- [x] Jev Choice chọn project (+ `none`); 1 candidate → không gọi Jev; uncertain/none → `disambiguate()` một câu hỏi; 0 candidate → hỏi user chỉ thư mục (host file dialog trên desktop, nhập path trên web).
- [x] Verify sau chọn: path tồn tại, nằm trong approved roots, không bị lease writer khác; rồi tạo `WorkerBrief{goal, projectRoots:[path]}` và start session với initial prompt = intent gốc + project context ngắn. Ghi `last_used_at`.
- [x] Privacy: state gửi Jev chỉ gồm intent + danh sách `{id, name, relPath-from-root, markers}`; không path tuyệt đối home dir, không nội dung file.

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

## Kết quả (2026-09-17)

- Migration 14: `project_index(project_id, node_id, path, name, aliases, git_remote, markers, kind, mtime, last_used_at, indexed_at)` + `project_fts(name, aliases, path, kind, project_id)` (unicode61, bỏ dấu).
- `repositories.ts`: `upsertProject` (giữ `last_used_at` qua refresh; thay row FTS để tên cũ không còn khớp), `searchProjects` (exact alias/name trước, rồi BM25), `touchProjectUse`, `pruneProjects` (theo danh sách path sống sót, không theo thời gian), `projectIndexStats`.
- `apps/runtime/src/project-finder.ts`: `scanProjects` **bounded** (depth ≤5, trần 20 000 entry, `AbortSignal`, yield giữa các root), ignore list hệ thống + mọi dot-dir + `.app`/`.icloud`, **không đi theo symlink**, dừng descend khi gặp marker, chỉ metadata (marker, mtime, git remote đọc từ `.git/config`); `refreshProjectIndex` incremental theo mtime + prune chỉ khi full/không bị cắt; `findProjectCandidates` (cache-first, alias > recent-use > kind > BM25), `verifyProject` (path còn tồn tại, **trong approved root**, không bị lease), `resolveProject` (cache → scan khi miss → 1 candidate tự quyết → nhiều candidate thì Jev hoặc **một câu hỏi**), `projectContext`, `createFindProjectTool`.
- `apps/runtime/src/project-session.ts`: `createProjectSessionStarter` (brief `{goal, projectRoots:[path], allowedCapabilityRefs: []}` — bắt đầu phiên không cấp capability) + `initialPrompt`.
- `jev-decider.ts`: `decideProject` (cùng policy/redaction; state chỉ có intent + `{id, name, relPath, kind}`, không path tuyệt đối) và `verify` sau khi chọn.
- `packages/core/src/routing.ts`: `disambiguate(candidates, chosen?)` — tôn trọng lựa chọn của decider nếu nó nằm trong candidates, giữ contract T19 khi không có.
- `services.ts`: `NodeServices.projects` + `projectSessions`; roots/ignore đọc từ preferences `workspace.roots` / `workspace.ignore` (mặc định `~` và rỗng, giá trị sai kiểu → về mặc định). `gateway.ts`: `POST /conversations/:id/start-session` → resolve → (clarify | needs-path | started) và ghi câu trả lời của host vào timeline (có index cho search). `main.ts` đăng ký tool `find_project` cho Main Pi.
- Tests: `apps/runtime/test/project-finder.spec.ts` (21) trên cây thư mục tạm thật — marker, không descend vào repo, ignore list, depth, symlink escape, kind, không lưu nội dung file, incremental theo mtime, abort/trần entry, alias/recent-use/kind, payload Jev không có path tuyệt đối, verify trong/ngoài root, cache hit <50 ms. Thêm journey `start-session` trong `apps/runtime/test/api.spec.ts` (brief có đúng `projectRoots`, prompt có ngữ cảnh + cách đổi, hoặc hỏi một câu).
- Đo full scan trên máy dev (`~`, ignore list hệ thống): **42 project, 20 033 entry, 1 270 ms, không bị cắt** — thấp hơn mục tiêu <30 s rất nhiều; incremental sau đó chỉ đọc lại thư mục có mtime đổi.
- `pnpm verify` pass (764, 5 skipped).

## Ghi chú cho phase sau

- Phase 6 e2e cần: cây thư mục tạm + preference `workspace.roots` trỏ vào đó, không quét home thật.
- Tool `find_project` trả `~/<relPath>`; `start_session_in_project` là command gateway (không phải tool) để việc mở phiên vẫn qua authorization của gateway.

## Success criteria
- "thêm skill mới cho dự án agentkit đi" với 2 thư mục tên gần nhau (`agentkit`, `agentkit-docs`) → chọn đúng theo recent-use/alias hoặc hỏi một câu; session mở với `projectRoots` đúng; không bao giờ mở ngoài approved roots.
- Cache hit trả candidates <50 ms; scan incremental không block turn; full scan `~` với ignore list trên máy dev đo và ghi vào report (mục tiêu <30 s lần đầu, sau đó incremental).
- `pnpm exec vitest run apps/runtime/test/project-finder.spec.ts apps/runtime/test/api.spec.ts` + `pnpm verify` pass.

**Bằng chứng (2026-09-17, kiểm lại):**

- Bảng + migration: migration 14 `project_index`/`project_fts`, có test backup/restore của storage; `apps/runtime/test/project-finder.spec.ts` chạy trên cây thư mục thật.
- Root + luật quét: `project-finder.spec.ts` "the scan" — bỏ qua `node_modules`, `Library`, giới hạn depth, không theo symlink ra ngoài root, dừng descend khi gặp marker; quét thật trên `~` (42 project, 20 033 entry) mất ~1,3 s, không truncate.
- Cache + rank: `refreshProjectIndex` incremental theo mtime; `rankProjectCandidates` xếp alias > recent-use > kind > score; test "prefers an exact alias, then recent use, and filters by kind".
- Chọn project: `resolveProject` gọi Jev khi >1 candidate, `disambiguate()` một câu hỏi khi uncertain. **Thay đổi 2026-09-17:** candidate chỉ đến từ recent-use nay được **hỏi** thay vì tự mở — trước đó một câu hỏi không khớp gì vẫn mở thư mục dùng gần nhất, tức là "invent a directory" mà plan cấm. Test: `apps/web/e2e/project-session.spec.ts` "an unknown name offers the directory used last instead of opening it".
- Verify + start: `verifyProject` kiểm path tồn tại, nằm trong approved roots, không bị lease; `WorkerBrief{goal, projectRoots:[path]}` được dựng trong `project-session.ts`; journey `apps/web/e2e/project-session.spec.ts` "a project session is started from a path the user types" chạy hết trên browser.
- Privacy: `relPath` nay tính từ **approved root chứa nó** (trước đó tính từ home, nên một workspace ngoài home bị rò thành `../../Volumes/…`); test "offers names and relative paths, never an absolute home path" giữ tính chất này.
- **Không làm:** không còn mục nào. **Cập nhật 2026-09-17 (vòng rework sau audit):** file dialog native trên desktop đã làm — `desktop:pickDirectory` trong allowlist của `security.mjs`, handler `dialog.showOpenDialog({properties:["openDirectory"]})` trong `main.mjs`, method `pickDirectory()` trong `preload.cjs`/`DesktopBridge`; client (`Conversation.tsx`) chỉ render nút "Chọn thư mục…" khi bridge tồn tại và trả path qua đúng đường của path gõ tay, nên web vẫn dùng ô nhập. Bằng chứng: `apps/desktop/test/security.spec.ts` (channel allowlist), `packages/conversation-client/test/directory-picker.spec.ts`, journey `apps/web/e2e/project-session.spec.ts` "the desktop shell picks a directory in an OS dialog…" + "the web build offers no directory picker".
