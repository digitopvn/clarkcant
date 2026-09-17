---
title: "Phase 2: Jev selector server-side"
status: done
---

# Phase 2: Jev selector server-side

## Overview
- P1; effort ~2 agent-hours; lane L1 (song song Phase 3 và 7). Depends on Phase 1 và pre-flight exact-model gate (plan.md). Adapter này được Phase 9 dùng lại cho decision layer; tách policy/redaction/transport thành hàm dùng chung, question templates để riêng.
- Context: [report §2–3](../reports/analysis-260917-1211-jev-mini-app-rendering.md).
- Provider smoke đã pass; feature integration chưa tồn tại. Không tái gọi provider chỉ để render một spec đã lưu.

## Architecture và requirements

Runtime-only adapter nhận bounded authorized candidates và trả discriminated result: selected / abstained / unavailable. Choice output chỉ là IDs thuộc candidates. Host kiểm tra template/data compatibility sau khi validate response. Score là optional, không cần thêm nếu Choice đủ; Noul chỉ dùng cho optional section.

**Quyết định:** native fetch + AbortSignal, không cài `@typesafe-ai/sdk` (v0.6.0). Lý do: kiểm soát timeout/redaction, tránh retry mặc định của SDK, một endpoint duy nhất.

API contract đã xác minh 2026-09-17 (xem bảng trong plan.md): request `{state, model, questions}`; Choice `criteria` map (null OK, ≤255 options) trả `choice/probabilities/confidence`; Noul trả probability **không có confidence**; nhiều questions cùng request đánh giá độc lập trên cùng state; errors 401/422/429/529. Score không dùng trong M1 (criteria đã đổi sang array từ v0.6.0).

## Related files
Root: `/Volumes/GOON/www/digitop/clarkcant/`.
- Create `apps/runtime/src/jev-selector.ts`: HTTP adapter, typed schemas, deadlines, confidence policy.
- Create `apps/runtime/src/mini-app-candidates.ts`: metadata minimization và allowlist.
- Modify `apps/runtime/src/services.ts`: dependency injection, local-only/provider config.
- Create `apps/runtime/test/jev-selector.spec.ts`: schema/policy/failure tests.
- Create `apps/runtime/test/jev-live.spec.ts`: opt-in live provider test; không chạy nếu thiếu explicit opt-in/key.
- Create `docs/mini-app/jev-configuration.md`: env setup, privacy, exact-model gate, telemetry.

## Implementation steps
1. Server config: `TYPESAFE_API_KEY`, model id, enabled/local-only mode. Không hardcode external repo .env path; không copy secret vào docs/fixtures/frontend.
2. Exact `jev-1.13.0` đã smoke pass 2026-09-17 (200, 999 ms; alias `jev-latest` cũng resolve về id này). Adapter đọc `model` từ response và so với config; lệch → telemetry `model_drift` + reason, không silent accept. Lưu ý từ smoke: Noul trả 0.58 cho câu hỏi calendar với intent tổng quát — vùng uncertain là có thật, policy phải xử lý, không ép về boolean.
3. State là object có tên trường (`{intent, candidates:[{id, kind, schemaSummary}], locale}`) ≤16 KiB, chỉ intent đã sanitize, schema metadata và authorized opaque candidate IDs; không raw rows, private titles, image bytes hoặc full history. Nếu policy không cho third-party intent processing → local-only fallback.
4. Choice threshold đề xuất top ≥0.85, margin ≥0.20 (tính trên `probabilities`, không chỉ `confidence`); Noul dùng probability trực tiếp ≥0.85 bật, ≤0.15 tắt; còn lại uncertain. `none` luôn có mặt. Không coi confidence là authority hay joint probability.
5. Một batch mặc định; tối đa hai batch nếu template làm thay đổi candidate set. Total deadline 4 giây bao gồm toàn bộ calls; cancellation propagated; retry không làm vượt budget. 429/server/transport failures → unavailable có reason.
6. Validate response type, finite probabilities/ranges, answer keys, enum membership và complete shape; combination không tương thích phải abstain. Quyết định fallback thực hiện ở compose layer (pi agent/model mặc định, quyết định user 2026-09-17), không giả Jev đã chọn.
7. Telemetry allowlist: request id, model, duration, token counts, policy version, selected enum, reason. Redact SDK/transport errors; không log body, prompt, headers, key hay full URL có query.

## Test matrix và gates
| Scenario | Expected |
|---|---|
| Valid authorized selection | Typed IDs đúng, chưa tạo UI/effect |
| Low confidence, tie, none, intermediate Noul | Abstain; reason rõ |
| Wrong answer type, unknown id, NaN/out-of-range | Reject boundary, no persistence |
| Missing key / local-only / permission to send absent | No network call |
| Timeout / abort / 429 / 5xx | Bounded unavailable; không retry storm |
| Prompt chứa yêu cầu vượt catalog | Không thay đổi candidates hoặc authorization |
| Log capture | Không có secret, raw intent/rows/headers |

Unit tests dùng pure response parsing và controlled HTTP fault harness để exercise errors; không mock để chứng minh production success. Live test dùng endpoint thật, synthetic non-sensitive intent, kiểm tra allowed result shape thay vì exact probabilities. Acceptance phải phân biệt live evidence với test harness.

Commands: `pnpm exec vitest run apps/runtime/test/jev-selector.spec.ts`; live opt-in command sẽ được ghi vào configuration doc sau khi implementation định nghĩa flag. `pnpm typecheck` phải pass. Chưa có flag live test được triển khai ở thời điểm lập plan.

## Todo
- [x] Implement adapter/config và minimized candidate builder.
- [x] Verify supported exact model id hoặc ghi explicit blocker.
- [x] Pass selection, privacy và failure-boundary tests.
- [x] Record sanitized live evidence và operational configuration.

## Kết quả (2026-09-17)

- `apps/runtime/src/jev-selector.ts`: `jevConfigFromEnv`, endpoint validation (https, không credentials, không loopback/private), `createFetchTransport` (không đọc error body), `askChoice`/`askNoul`, `selectTemplate`/`selectSections`, `JevBudget` một clock duy nhất qua `remainingBudget(deps, budget)`, telemetry allowlist một dòng mỗi call.
- `apps/runtime/src/mini-app-candidates.ts`: `sanitizeIntent` (control chars, token/JWT/base64/hex/email/phone → `[redacted]`, trần 1000 ký tự), `schemaFieldSummary` (chỉ tên field + type), `buildSelectionState` + `checkSelectionStateSize` (16 KiB) + `stateLooksRedacted` kiểm tra lần hai trên state đã serialize.
- `apps/runtime/src/services.ts`: `NodeServices.jev` với config + deps + `providerCallCount()` + telemetry bounded 200 dòng; `RuntimeOptions.jev` cho phép inject transport (test seam).
- `docs/mini-app/jev-configuration.md`: bảng env, exact-model gate, policy, bảng failure behaviour, telemetry, lệnh chạy unit/live.
- Tests: `apps/runtime/test/jev-selector.spec.ts` (23) — refusal path không gọi mạng, sanitize, confidence/margin, malformed/NaN/out-of-range, model drift, không retry, timeout 40 ms, oversized state, section combination, telemetry không chứa key/intent. `apps/runtime/test/jev-live.spec.ts` opt-in hai lớp (`CLARKCANT_JEV_LIVE=1` + key) và báo BLOCKED khi thiếu.
- `pnpm verify` pass (615 passed, 3 skipped là live tests). Exact model `jev-1.13.0` giữ nguyên là gate đã smoke 2026-09-17; adapter từ chối mọi response mang model khác.

## Ghi chú cho phase sau

- `selectTemplate` trả `probedAt`; Phase 5 dùng nó cho provenance và **không** gọi lại provider khi replay.
- `selectSections` chỉ hỏi slot không nằm trong `fixedSlots`; Phase 5 truyền `fixedSlots` cho các region do template tự quyết (metrics/filter/cta).
- `askChoice`/`askNoul` là API chung cho Phase 9; policy nằm ở đây, không nhân bản.

## Risks / next
Threshold chưa calibrated; Phase 6 đánh giá corpus trước release. Một request smoke không đủ SLO. Adapter có thể phát triển song song Phase 3 sau Phase 1; chỉ tích hợp turn sau Phase 4.
