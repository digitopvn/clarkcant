---
title: "Phase 5: Compose trong turn pipeline"
status: done
---

# Phase 5: Compose trong turn pipeline

## Overview
- P1; effort ~3 agent-hours; join J1 (L1 + L2), song song Phase 9. Depends on Phase 2, 3 và 4. Phase duy nhất chạm `model-turn.ts`.
- Context: [report](../reports/analysis-260917-1211-jev-mini-app-rendering.md).
- Nối main LLM/show_view tới explicit awaited composition step. Renderer và catalog compiler không gọi network.

## Requirements / architecture

Main LLM cung cấp intent/caption và chỉ refs có nguồn gốc runtime; không tự gửi dữ liệu giả. Runtime lấy candidate set đã authorize rồi gọi selector. User explicit template hợp lệ → deterministic compile, không cần Jev. Ambiguous natural-language request → Jev selection → compatibility checks → pure compiler → atomic persistence → ordinary surface block.

Reuse show_view seam (`apps/runtime/src/model-turn.ts:56`, `ViewDescriptor.build` hiện là sync). **Quyết định:** thêm `canvas.overview@1` như một view entry; vì compose cần await selector, đổi `ViewDescriptor.build` sang trả `MessageBlock | Promise<MessageBlock>` và await trong tool handler; các view cũ không đổi. Tool execution được await trong turn pipeline, **không** nhét call vào React renderer hoặc synchronous ViewDescriptor.build. Giữ old named-view inputs hoạt động, không mở vocabulary host-owned cards.

## Related files
Root: `/Volumes/GOON/www/digitop/clarkcant/`.
- Create `apps/runtime/src/compose-mini-app.ts`: orchestration và pure compiler boundary.
- Modify `apps/runtime/src/model-turn.ts`: explicit awaited composition, cancellation, typed tool result.
- Modify `apps/runtime/src/view-catalog.ts`: host composition entry; pure validated layout build và storage service calls rõ ràng.
- Modify `apps/runtime/src/services.ts`: inject selector/data/compiler/storage dependencies.
- Create `apps/runtime/test/mini-app-compose.spec.ts`: pure compiler, fallback, rollback và idempotent turn replay.
- Modify `apps/runtime/test/view-tool.spec.ts`: existing tool contract compatibility và host-card boundary.
- Modify `apps/runtime/test/api.spec.ts`: real gateway/timeline composition assertions.

## Implementation steps
1. Trace turn/message ID allocation; reserve stable idempotency key theo conversation + turn + tool call, không hash toàn intent vì hai user requests giống nhau vẫn có thể là hai thao tác khác nhau.
2. Candidate builder chỉ lấy refs accessible ở thời điểm turn. Fetch data và authorize lại trước persistence để xử lý deletion/version changes trong lúc Jev đang chạy.
3. Await selector theo budget Phase 2. Missing provider/abstain/incompatible selection → **fallback do pi agent/model mặc định generate template** (quyết định user 2026-09-17: Jev là giải pháp thử nghiệm, fallback không phụ thuộc nó) trong cùng pipeline, vẫn qua pure compiler và validation; nếu model cũng không cho template hợp lệ thì trả text explanation hoặc câu hỏi làm rõ. Không invent missing calendar/image để đủ layout. Fallback được đánh dấu trong provenance, không mạo danh Jev.
4. Pure compiler ghép sections của template, validate leaf props/data schemas, text fallbacks và provenance. Lấy labels/bindings từ host catalog; Jev không cấp quyền hay lựa chọn executable targets.
5. Persist instance/spec/bindings/snapshot/message trong transaction Phase 1. Race duplicate execution cùng key trả kết quả đã lưu; không gọi Jev lần nữa khi replay đã có kết quả. Concurrent in-flight key cần lock/unique constraint phù hợp, không double write.
6. Preserve narration và streaming identity của existing model path. Tool error trả bounded actionable message cho model/user, không raw provider body.
7. Không invalidate composition khi đổi filter/mở pin/reload; chỉ explicit request “thiết kế lại” tạo composition revision/snapshot mới. Data schema/catalog change cần compatibility revalidation và fallback; không tự mutate old snapshot.

## Acceptance tests
- Real user turn → validated selection → persisted composite surface → timeline có snapshot ref + same logical instance.
- Old show_view table/chart path vẫn pass; arbitrary model names/host-owned card requests bị reject.
- Missing/low-confidence/malformed selector output không blank message và không orphan instance.
- Cancellation/deleted candidate giữa selection và commit không persist unauthorized/stale target.
- Repeated turn replay tạo một composition; repeated distinct user request vẫn có identity riêng theo product flow.
- Render/reload/pin/filter không gọi Jev; assert provider call count ở service seam.
- Commands: `pnpm exec vitest run apps/runtime/test/mini-app-compose.spec.ts apps/runtime/test/view-tool.spec.ts apps/runtime/test/api.spec.ts`, rồi `pnpm verify`.

## Todo
- [x] Integrate explicit compose step và backward-compatible tool input.
- [x] Implement fallback, cancellation, replay và atomic persistence.
- [x] Preserve narration, host-only boundaries và data authorization.
- [x] Pass integration/regression gates trước browser acceptance.

## Kết quả (2026-09-17)

- `apps/runtime/src/compose-mini-app.ts` (mới): `COMPOSITION_TEMPLATES` (overview/focused/agenda), `compileTemplate` **pure** (validate props bằng `validateProps`, pin digest, bỏ region optional không có rows, báo problem cho region bắt buộc thiếu), `composeMiniApp` orchestration: candidate set → template (explicit | Jev | fallback) → leaf defaults + `selectSections` khi có lựa chọn thật → `publishMiniAppData` → compile → `checkCompositionCoverage` → `captureCompositeSurface` (một transaction). `selectorMode` = explicit | jev | fallback, luôn ghi vào provenance.
- Idempotency: key = **message + tool call** (`findCompositionByMessage`), không hash intent; replay trả lại instance/snapshot cũ, không tạo composition thứ hai.
- Cancellation: `ViewRequest.signal` (AbortController mỗi turn, abort cùng deadline) — compose kiểm tra trước khi persist và trả `CANCELLED`, không ghi gì.
- `model-turn.ts`: `ViewDescriptor.build` có thể trả Promise và được **await** trong tool handler; turn mang `conversationId`; `notes` của view được nhắc trong description để model biết vocabulary template.
- `view-catalog.ts`: entry `canvas.overview@1` gọi `composeMiniApp`; **loại trừ** container khỏi vòng lặp view thường (nếu không nó được đăng ký hai lần và bản generic dựng instance rỗng).
- `services.ts`: `NodeServices.compose` (registry + jev budget + dataDir + timezone); `main.ts` báo catalog coverage và selector state lúc khởi động.
- Tests: `apps/runtime/test/mini-app-compose.spec.ts` (14); mở rộng `view-tool.spec.ts` (build async được await; build lỗi → refusal có lý do, không append block) và `api.spec.ts` (timeline + route composition cho surface thật). `pnpm verify` pass (689).

## Ghi chú cho phase sau

- Fallback hiện là template mặc định của host + leaf default theo thứ tự catalog; provenance ghi `mode: "fallback"` kèm `fallbackReason`, không mạo danh Jev.
- Phase 6 phải đo cả latency provider và user-visible latency; số smoke 1075 ms không phải SLO.

## Risks / next
Turn latency tăng một bounded provider step, không được gọi mọi turn khi không cần surface. Phase 6 phải đo cả provider và user-visible latency, không dùng số smoke 1075ms làm SLO.
