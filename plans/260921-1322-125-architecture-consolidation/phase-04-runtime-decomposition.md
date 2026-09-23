---
phase: 4
title: "Tách runtime composition, không redesign domain"
status: pending
priority: P2
effort: "2-3 ngày"
dependencies: [3]
---

# Phase 4 — Runtime composition decomposition

PR 4. Chỉ bắt đầu khi PR 1–3 đã merge và xanh trên `main`.

## Goal

`apps/runtime/src/gateway.ts` (~3593 dòng) và `main.ts` (~1946 dòng) được tách theo route/application/bootstrap responsibility, với dependency tường minh, **không** đổi public contract và không đổi behavior.

## Files to Create / Modify

- Create: `apps/runtime/src/routes/` — mỗi family một module: conversation, interaction, package, widget, peer, attachment, preference, preview.
- Create: `apps/runtime/src/application/` — command-execution, package-install, widget-actions, peer-delivery.
- Create: `apps/runtime/src/policy/` — execution-policy, guardrail, preflight (di chuyển/wrap, không viết lại logic).
- Create: `apps/runtime/src/bootstrap/` — runtime-bootstrap, model-bootstrap, voice-bootstrap.
- Create: `apps/runtime/src/test-support/` — fixture-model, fixture-voice, fixture-composition.
- Modify: `apps/runtime/src/gateway.ts` — chỉ còn authenticate/parse/route; dispatch sang route module với dependency interface tường minh.
- Modify: `apps/runtime/src/main.ts` — chỉ còn parse config, build dependency, start transport, register shutdown.
- Modify: `apps/runtime/src/node-tools.ts` (~1.1k dòng), `apps/runtime/src/voice-session.ts` (~1.0k dòng) — chỉ khi cần cho biên sở hữu; không tách vì mục tiêu "file nhỏ hơn".
- Tests: giữ và di chuyển test tương ứng từng family; không đổi assertion.

## Tasks & Steps

### Task 4.1 — Bản đồ route và test baseline
- Goal: biết chính xác family nào tồn tại và behavior hiện tại đã được ghim bằng test.
- Steps:
  1. Liệt kê toàn bộ nhánh dispatch trong `gateway.ts` theo `request.path`/`segments` và gán mỗi nhánh vào một family.
  2. Với mỗi family, xác định test hiện có trong `apps/runtime/test/` (ví dụ `peers.spec.ts`, `attachment-routes.spec.ts`, `package-install-route.spec.ts`, `preference-routes.spec.ts`) và chạy để ghim baseline.
  3. Ghi baseline vào `evidence.md` của phase.
- Success criteria: mọi nhánh dispatch được gán family; baseline test xanh trước khi tách.
- Verify: `pnpm exec vitest run apps/runtime/test` exits 0 trước khi sửa cấu trúc.

### Task 4.2 — Tách route family
- Goal: mỗi family có module riêng, dependency tường minh.
- Steps:
  1. Với từng family (làm lần lượt, một PR-worth mỗi lần), tạo module trong `apps/runtime/src/routes/` nhận một dependency interface tường minh — không import mutable global, không service locator.
  2. Route module chỉ sở hữu HTTP parse/response mapping; business flow đẩy sang `application/`.
  3. Sau mỗi family: chạy test của family đó trước và sau khi di chuyển, so sánh.
  4. Không đổi path, method, status code, hay response shape.
- Success criteria: gateway không còn chứa business flow của family đã tách; test family xanh.
- Verify: `pnpm exec vitest run apps/runtime/test/<family>.spec.ts` exits 0 sau mỗi lần tách.

### Task 4.3 — application services
- Goal: command-execution, package-install, widget-actions, peer-delivery thành service có dependency inject.
- Steps:
  1. Di chuyển logic ra khỏi gateway vào `apps/runtime/src/application/`.
  2. Mỗi service nhận dependency qua interface, không tự đọc biến module-level có thể thay đổi.
  3. Giữ nguyên policy/preflight order: host preflight trước policy/Jev.
- Success criteria: không còn mutable "wire this after services boot" placeholder trong đường đã tách.
- Verify: `pnpm typecheck` exits 0 và `pnpm exec vitest run apps/runtime/test` exits 0.

### Task 4.4 — Tách fixture khỏi production composition
- Goal: fixture deterministic không nằm trong production bootstrap path.
- Steps:
  1. Di chuyển fixture model/voice/composition sang `apps/runtime/src/test-support/`.
  2. Fixture mode vẫn phải explicit và không bao giờ trông như live; giữ nhãn hiện có (ví dụ `CC_VOICE_FIXTURE=1`).
  3. Không để production bootstrap import test-support.
- Success criteria: production path không import `test-support/`; fixture mode vẫn bật được trong e2e.
- Verify: `grep -rn "test-support" apps/runtime/src/main.ts apps/runtime/src/bootstrap/` không trả về kết quả ngoài fixture gate tường minh.

### Task 4.5 — main.ts thành composition/startup
- Goal: `main.ts` chỉ compose.
- Steps:
  1. Chuyển phần còn lại của việc build dependency sang `bootstrap/runtime-bootstrap.ts`, model/voice sang module tương ứng.
  2. Giữ nguyên thứ tự start transport và register shutdown.
- Success criteria: `wc -l apps/runtime/src/main.ts` giảm rõ rệt và chỉ còn startup/composition.
- Verify: `pnpm exec vitest run apps/runtime/test` exits 0 và `pnpm test:e2e` exits 0 (giải phóng port 8876 và 4273 trước khi chạy).

### Task 4.6 — Gate
- Steps:
  1. Chạy focused tests → `pnpm invariants` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm verify` → `pnpm verify:full`.
  2. Chạy Playwright cho journey bị ảnh hưởng nếu observable behavior đổi (không được đổi).
  3. Cập nhật docs/manifest nếu file thuộc manifest bị sửa; cập nhật `docs/system-architecture.md` nếu mô tả cấu trúc runtime đổi tên.
- Success criteria: không regression; `pnpm verify` 0 failure; CI terminal xanh.
- Verify: `pnpm verify` exits 0 và `pnpm test:e2e` exits 0.

## Verification

Behavior-preserving: test phải xanh **trước và sau** mỗi lần di chuyển, với cùng assertion. Không sửa test để khớp cấu trúc mới. Thứ tự gate: focused → `pnpm invariants` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm verify` → `pnpm verify:full`.

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
