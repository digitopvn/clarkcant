---
title: "Phase 9: jev-decision-layer"
status: todo
---

# Phase 9: Jev decision layer cho search và điều phối runtime

## Overview
- P2; effort ~3 agent-hours; lane J2 (join L1 + L3), chạy song song Phase 5. Depends on Phase 2 (adapter) và Phase 8 (retrieval + temporal parser + baseline).
- Vai trò chốt với user 2026-09-17, ghi tại `docs/system-architecture.md` §7.2: Jev là **lớp ra quyết định sau retrieval**, cho hai đường:
  - **A. Điều phối runtime:** Session Manager liệt kê running runtimes/workers → structured filters → Jev chọn target → host verify → dispatch qua gateway.
  - **B. Tìm session cũ:** FTS5 (+ KNN khi có) → RRF → top-K → Jev chọn context hoặc yêu cầu hỏi lại.
- Jev không search, không sinh nội dung, không cấp quyền, không quyết định side effect.

## Requirements
- [ ] Đường A: với intent + ≤12 runtime candidates (id opaque, mô tả: project, capabilities, live status, load), Jev Choice trả target hoặc `none`; host verify lease/grant/revision trước dispatch; 0–1 candidate → không gọi Jev.
- [ ] Đường B: với query + top-K (K ≤ 10) từ Phase 8, Jev Choice chọn kết quả đúng ý hoặc `none`; Noul "cần hỏi lại?" khi mơ hồ; 0–1 kết quả hoặc rank cách xa → không gọi Jev.
- [ ] Deadline Jev ≤2 s, tổng search ≤2.5 s; Jev unavailable/uncertain → rank RRF thuần; còn mơ hồ → main Pi hỏi lại. Không trả fallback như thể Jev đã chọn.
- [ ] Privacy: state chỉ intent đã redact + mô tả candidate ngắn; local-only mode tắt call ngoài. Không snippet chứa secret (redaction Phase 7 là tiền đề).
- [ ] Bật/tắt theo config (`search.decider = jev | none`); baseline Phase 8 và calibration ở đây quyết định default.

## Related code files
Root: `/Volumes/GOON/www/digitop/clarkcant/`.
- Create `apps/runtime/src/jev-decider.ts`: hai hàm `decideRuntimeTarget(intent, candidates)` và `decideSearchResult(query, results)`; dùng chung adapter/policy/redaction từ `jev-selector.ts` (Phase 2); question templates riêng.
- Modify `apps/runtime/src/session-search.ts`: sau RRF gọi decider khi ≥2 kết quả gần nhau; trả `{chosen?, candidates, mode: "jev" | "rank" | "clarify", provenance}`.
- Create `apps/runtime/src/runtime-candidates.ts`: liệt kê running runtimes/workers từ leases/live owners/node registry, structured filters, mô tả ngắn cho Jev.
- Modify `packages/core/src/conductor.ts:270` (chọn `usable[0]`): thay bằng decider khi có >1 usable; giữ `usable[0]` khi decider tắt/unavailable; **không** đổi lease/dispatch semantics.
- Expose tool cho Main Pi qua `pi-adapter` custom tools: `search_history`, `find_runtime` (Session Manager là control extension theo sơ đồ).
- Create `apps/runtime/test/jev-decider.spec.ts`, `apps/runtime/test/runtime-candidates.spec.ts`; modify `packages/core/test/*conductor*` cho nhánh decider.

## Implementation steps
1. Candidate builders: runtime candidates từ leases/live owners (đường A); search candidates từ Phase 8 output shape (đường B). Mỗi candidate ≤300 ký tự mô tả, id opaque.
2. Question templates: Choice `target`/`result` với criteria từ candidates + `none`; Noul `needs_clarification` cho đường B. Validate `choice ∈ candidates`, threshold top ≥0.85 & margin ≥0.20 (đề xuất, calibrate).
3. Verify sau chọn: đường A kiểm tra lease còn sống, grant giao việc, node reachable; đường B kiểm tra kết quả còn tồn tại và principal scope. Verify fail → rơi về rank thuần, ghi reason.
4. Conductor: nhánh decider chỉ chọn trong `usable`; dispatch giữ nguyên gateway/lease/consent path (T05, T07, T09, T14 phải vẫn pass).
5. Telemetry: mode, fallback reason, latency split, model id thực tế; không body/prompt.
6. Calibration: ≥30 query (đường B) và ≥15 tình huống điều phối (đường A) Việt/Anh, human-label; so `jev` vs `rank` thuần; đặt default config theo số đo, ghi vào report.

## Success criteria
- Đường A: nhiều runtime phù hợp → chọn đúng target theo label; unauthorized/lease chết không bao giờ được dispatch dù Jev chọn.
- Đường B: "phiên làm việc hôm qua về bug login" trả đúng kết quả; Jev timeout/disabled → search vẫn hoạt động.
- `pnpm exec vitest run apps/runtime/test/jev-decider.spec.ts apps/runtime/test/runtime-candidates.spec.ts` + `pnpm verify` pass.
