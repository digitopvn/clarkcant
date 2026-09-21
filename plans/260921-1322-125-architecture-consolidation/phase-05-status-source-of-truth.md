---
phase: 5
title: "Một nguồn sự thật cho implementation status"
status: pending
priority: P2
effort: "1-1.5 ngày"
dependencies: [4]
---

# Phase 5 — Implementation-status source of truth

PR 5. Nhánh riêng từ `main` mới nhất sau khi PR 4 merge.

## Goal

Các claim implementation-status rải rác được gom về một registry machine-readable, source comment trỏ tới registry thay vì tự khẳng định, và `pnpm invariants` bắt được reference trỏ tới capability/test không tồn tại.

## Files to Create / Modify

- Create: `docs/status-registry.json` (hoặc `packages/contracts/src/status-registry.ts` nếu registry phải typed) — mỗi entry: `capabilityId`, `status` ∈ `implemented | partial | blocked | not-implemented`, `owningPackage`, `phase`, `evidenceTests[]`, `externalGate?`.
- Modify: `tools/check-invariants.mjs` — thêm check: mỗi `capabilityId` được reference phải tồn tại, và mỗi `evidenceTests[]` phải resolve tới file test thật.
- Modify: 18 chỗ `@implementation-status` hiện có:
  - `examples/media-widget-contract/src/index.ts`, `examples/mcp-app-fixture/src/index.ts`, `examples/note-widget/src/index.ts`
  - `packs/project-work/src/index.ts`, `packs/computer-macos/src/index.ts`, `packs/google-calendar/src/index.ts`, `packs/computer-linux-desktop/src/index.ts`, `packs/browser-playwright/src/index.ts`
  - `packages/widget-sdk/src/index.ts`, `packages/execution-supervisor/src/index.ts`, `packages/node-link/src/index.ts`, `packages/integration-sdk/src/index.ts`, `packages/host-adapters/src/index.ts`, `apps/web/src/index.ts`, `apps/runtime/src/node.ts`
- Modify: `docs/conformance-traceability.md` — reconcile với registry, giữ honesty fixture vs real-provider/real-driver.
- Modify: `docs/manifest.json` — bytes + sha256 cho mọi file thuộc manifest bị sửa.

## Tasks & Steps

### Task 5.1 — Registry schema và nội dung ban đầu
- Goal: một file/nguồn duy nhất biểu diễn status.
- Steps:
  1. Đọc toàn bộ 18 chỗ `@implementation-status` và `TODO(Px)` để lập inventory claim thật.
  2. Đọc `docs/conformance-traceability.md` để lấy T-id/V-id và evidence test đã có.
  3. Tạo registry với đúng các field đã nêu; mỗi entry trỏ tới test thật trong repo.
  4. Không thêm capability mới vào registry chỉ để "cho đủ".
- Success criteria: mọi claim hiện có đều map được vào một entry, hoặc bị xác định là stale.
- Verify: `node -e "JSON.parse(require('fs').readFileSync('docs/status-registry.json','utf8'))"` exits 0.

### Task 5.2 — Reconcile source comment cũ
- Goal: source comment không còn tự khẳng định status sai.
- Steps:
  1. Với từng chỗ `@implementation-status`, đối chiếu code thật: Unix socket, browser driver seam, peer transport là các ví dụ issue nêu là đã đi trước comment.
  2. Đổi comment thành trỏ registry (ví dụ `@status-ref <capabilityId>`) và bỏ phần prose tự khẳng định.
  3. Stub thật thì giữ nhãn stub mà repo invariant yêu cầu (package `clarkcant.phase/status/blueprint` marker).
  4. Không promote PARTIAL/BLOCKED lên implemented/PASS khi chưa có evidence.
- Success criteria: `grep -rn "@implementation-status"` giảm về 0, hoặc chỉ còn nơi registry không biểu diễn được và có lý do ghi rõ.
- Verify: `pnpm invariants` exits 0 sau khi registry và comment khớp nhau.

### Task 5.3 — Invariant bắt reference gãy
- Goal: CI chặn status reference trỏ vào capability/test không tồn tại.
- Steps:
  1. Trong `tools/check-invariants.mjs`, thêm bước: parse registry; với mỗi reference trong source, fail nếu `capabilityId` không có entry.
  2. Với mỗi `evidenceTests[]`, fail nếu file test không tồn tại trên đĩa.
  3. In ra entry nào hỏng, không chỉ "invariant failed".
- Success criteria: cố tình trỏ tới capability id sai ⇒ `pnpm invariants` exit khác 0 và in tên id sai.
- Verify: tạm thêm reference sai, chạy `pnpm invariants`, xác nhận non-zero và message nêu id; sau đó revert và xác nhận exit 0. Ghi cả hai output vào `evidence.md`.

### Task 5.4 — Conformance honesty
- Goal: traceability không tự nâng status.
- Steps:
  1. So từng T-id/V-id với registry; chỉ update khi test được nêu thực sự tồn tại.
  2. Giữ phân biệt fixture evidence vs real provider/driver evidence.
  3. Không đóng #2/#3/#4/#5.
- Success criteria: không dòng nào upgrade status mà không có test tương ứng.
- Verify: `pnpm invariants` exits 0 và `pnpm verify` 0 failure.

### Task 5.5 — Gate
- Steps:
  1. Chạy `pnpm invariants` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm verify`.
  2. Cập nhật `docs/manifest.json` cho mọi file thuộc manifest bị sửa.
- Success criteria: `pnpm verify` 0 failure; CI terminal xanh.
- Verify: `pnpm verify` exits 0.

## Verification

Focused: `pnpm invariants` phải fail được khi reference gãy (chứng minh bằng demo trong `evidence.md`), rồi pass trên cây sạch. Sau đó `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm verify`; sau merge CI `main` xanh.

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
