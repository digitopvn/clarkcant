---
title: "Phase 10: semantic-retrieval"
status: todo
---

# Phase 10: Semantic retrieval + RRF

## Overview
- P2; effort ~4 agent-hours; depends on Phase 8; **sau M1**. Nguồn: `docs/system-architecture.png` — Memory & Search gồm Semantic retrieval (sqlite-vec, exact KNN), Local embeddings (E5-small quantized ONNX), Rank + verify (RRF, branches, live status).
- Mục tiêu: hybrid search = FTS5 (Phase 8) + KNN, hợp nhất bằng RRF, verify live status trước khi trả.

## Gates trước khi bắt đầu
- [x] **Native dep — đã chốt 2026-09-17:** user chấp nhận optional native deps (sqlite-vec loadable extension, onnxruntime-node) cho search. Ràng buộc: khai báo `optionalDependencies`, install path mặc định không fail khi thiếu, search rơi về FTS-only có reason. Cập nhật README câu "No native modules are required" → "không bắt buộc; semantic search là optional". Ghi ADR ngắn trong `docs/research-and-decisions.md`.
- [ ] `node:sqlite` `allowExtension: true` + `loadExtension()` đã xác minh khả dụng trên Node hiện tại (probe 2026-09-17). Cần probe load sqlite-vec thật trên macOS arm64 và Linux x64.
- [ ] Kích thước model E5-small quantized và thời gian embed/batch trên máy dev đo thật trước khi cam kết index toàn bộ history.

## Related code files
Root: `/Volumes/GOON/www/digitop/clarkcant/`.
- Modify `packages/storage/src/migrate.ts`: `history_vec` (sqlite-vec virtual table) + `history_embeddings_meta(ref, model, dims, created_at)`.
- Create `apps/runtime/src/embeddings-local.ts`: E5-small ONNX loader, batch embed, model digest pin.
- Create `apps/runtime/src/hybrid-rank.ts`: RRF hợp nhất FTS + KNN; verify live status (leases/live owners) và branch context.
- Modify `apps/runtime/src/session-search.ts`: đường hybrid phía sau flag; FTS-only vẫn là default khi extension/model vắng.
- Create `apps/runtime/test/hybrid-rank.spec.ts`, `apps/runtime/test/embeddings-local.spec.ts` (skip có lý do khi native dep vắng).

## Implementation steps
1. Probe extension + model trên CI matrix; thiếu → search vẫn FTS-only, log reason, không lỗi.
2. Ingest embeddings theo cùng cursor với Phase 8; model digest ghi vào meta; đổi model → reindex có kế hoạch, không trộn vectors khác model.
3. RRF k=60 mặc định; đo trên corpus calibration Phase 8 để so hybrid vs FTS thuần; ghi số.
4. Verify: kết quả trỏ runtime/worker đang chạy phải đối chiếu live status trước khi gắn nhãn "đang chạy".

## Success criteria
- Hybrid cải thiện acceptable rate so với baseline Phase 8 trên cùng corpus, hoặc ghi rõ không cải thiện và giữ FTS-only.
- Native deps chỉ optional; `pnpm verify` pass khi extension/model vắng; README/ADR đã cập nhật.
