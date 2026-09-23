---
phase: 6
title: "Đóng internal real-path proof, không giả external gate"
status: pending
priority: P2
effort: "1.5-2 ngày"
dependencies: [5]
---

# Phase 6 — Internal real-path proofs

PR 6. Nhánh riêng từ `main` mới nhất sau khi PR 5 merge.

## Goal

Đóng phần real path làm được trong CI/local — browser takeover preview bằng byte thật từ BrowserDriver và Google Calendar pack nối qua internal connector thật — trong khi external gate #2/#3/#4/#5 vẫn mở và vẫn linked.

## Files to Create / Modify

- Modify: browser driver seam trong `packages/host-adapters/` (Playwright `capturePreview()`) — bảo đảm trả về image bytes thật.
- Modify: `apps/runtime/src/gateway.ts` — route blob store + authenticated `/previews/<digest>`.
- Modify: widget/preview client trong `packages/conversation-client/` — takeover card nhãn captured-at snapshot.
- Modify: `packs/google-calendar/src/index.ts` (comment `@implementation-status` ở dòng ~189) — nối qua `packages/integration-sdk` token/calendar API seam.
- Tests: tạo journey test thật cho preview path; mở rộng test calendar internal connector.
- Docs: `docs/conformance-traceability.md` + `docs/manifest.json` cho row được chứng minh.

## Tasks & Steps

### Task 6.1 — Browser takeover preview bằng byte thật
- Goal: một journey chứng minh `capturePreview()` → blob store → `/previews/<digest>` → takeover card.
- Steps:
  1. Xác nhận `packages/host-adapters/` trả về byte thật (không phải placeholder PNG) từ Playwright.
  2. Ghi byte vào runtime blob store, tính digest, phục vụ qua route có xác thực.
  3. Trong client, takeover card hiển thị ảnh đó với nhãn "captured at" đúng thời điểm; không được trình bày như live.
  4. Viết journey test đi hết đường; **không** dùng một PNG cố định làm evidence cuối.
- Success criteria: test chứng minh digest của ảnh tương ứng byte driver trả về, không phải fixture tĩnh.
- Verify: `pnpm exec vitest run apps/runtime/test/session-preview.spec.ts` exits 0 và journey mới pass với assertion trên digest bytes.

### Task 6.2 — Google Calendar internal wiring
- Goal: pack đi qua connector path thật (SDK/token/calendar API), không phải loopback fixture giả.
- Steps:
  1. Đọc `packs/google-calendar/src/index.ts` và `packages/integration-sdk/src/index.ts` để nối đúng seam hiện có (`integration-sdk` đã có authorization-code + PKCE và calendar read/write path theo commit gần nhất).
  2. Nối pack qua seam đó; giữ token handling ở boundary, secret không vào model-visible KV.
  3. Test internal path bằng endpoint shaped-like-Google đã có sẵn trong repo.
  4. **Không** đóng #2; live account/OAuth client proof vẫn thuộc #2.
- Success criteria: pack gọi được connector thật trong test; #2 vẫn mở và được link.
- Verify: `pnpm exec vitest run packs/google-calendar` exits 0.

### Task 6.3 — Không duplicate external gate
- Goal: #93/#3/#4/#5 vẫn mở, không bị "closed by fixture".
- Steps:
  1. Rà lại thay đổi của phase này có chạm vùng `#93` (widget trust / browser frame) không; nếu có, ghi rõ và coordinate thay vì duplicate.
  2. Kiểm tra refactor không làm #3/#4/#5 khó hơn; nếu thiếu seam nội bộ, sửa ở đây hoặc mở issue focused.
  3. Xác nhận state của #2/#3/#4/#5 vẫn là open sau PR này.
- Success criteria: cả bốn issue vẫn open; không có comment nào claim chúng đã xong.
- Verify: `gh issue view 2 --json state`, `gh issue view 3 --json state`, `gh issue view 4 --json state`, `gh issue view 5 --json state` đều trả `"OPEN"`.

### Task 6.4 — Gate
- Steps:
  1. Chạy focused tests → `pnpm invariants` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm verify` → `pnpm verify:full`.
  2. Giải phóng port 8876 và 4273 trước `pnpm test:e2e`.
  3. Cập nhật conformance row chỉ tới mức đã chứng minh; cập nhật `docs/manifest.json`.
- Success criteria: `pnpm verify` 0 failure; `pnpm verify:full` xanh hoặc ghi rõ điều kiện thiếu.
- Verify: `pnpm verify` exits 0 và `pnpm test:e2e` exits 0.

## Verification

Focused journey test trước, rồi `pnpm invariants`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm verify`, `pnpm verify:full`. Evidence phải phân biệt rõ phần real path đã chứng minh với external gate còn mở.

## Failure Protocol

If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.
