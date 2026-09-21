---
phase: 3
title: "Khoá dependency closure trước khi build install"
status: pending
priority: P1
effort: "1.5-2 ngày"
dependencies: []
---

# Phase 3 — Deterministic install dependency lock

PR 3. Nhánh riêng từ `main` mới nhất. **Độc lập kỹ thuật với Phase 2** (toàn bộ trong `packages/capability-host`), nên frontmatter không còn `dependencies: [2]`. Vẫn landed theo thứ tự issue: advisor khuyến nghị đảo 3 lên trước 2 vì Phase 3 chắc chắn làm được trong repo còn Phase 2 phụ thuộc spike A3 — nhưng thứ tự issue là authoritative và cả hai độc lập nên rủi ro thấp; rủi ro Phase 2 được xử bằng Pre-task 2.0 thay vì đảo thứ tự.

## Goal

Install plan định danh không chỉ source artifact mà cả dependency closure/build input chính xác mà generation đã kích hoạt dùng; build tiêu thụ đúng trạng thái đã đóng băng và fail thay vì tự re-resolve floating range.

## Files to Create / Modify

- Create: `packages/capability-host/src/dependency-lock.ts` — resolve metadata trước bước build, tạo lock artifact bất biến, tính digest.
- Modify: `packages/capability-host/src/index.ts` — comment hiện ghi "Not built: dependency locking" (dòng ~192–193) phải được thay bằng mô tả đúng sau khi build; `activateFacet()` (dòng ~118) và `FacetGeneration` (dòng ~90) mang theo lock reference.
- Modify: `packages/capability-host/src/quarantine.ts` — build chỉ đọc trạng thái đã đóng băng.
- Modify: `packages/core/src/package-install.ts` hoặc seam install tương ứng trong `packages/core` — gắn lock digest vào install plan/consent.
- Modify: `packages/contracts/src/package.ts` (hoặc file contract của package/install) — thêm trường lock reference/digest vào plan/generation.
- Modify: `packages/storage` — **thêm migration mới** nếu cần cột/bảng; tuyệt đối không sửa migration đã apply trong `packages/storage/src/migrate.ts`.
- Modify: `apps/runtime/src/gateway.ts` — route `/packages/install` (~1461) và route package khác truyền lock reference.
- Tests: tạo `packages/capability-host/test/dependency-lock.spec.ts`; mở rộng `apps/runtime/test/package-install-route.spec.ts`.

## Tasks & Steps

### Task 3.1 — Resolve metadata trước build
- Goal: không bước thực thi nào chạy trước khi biết dependency closure.
- Steps:
  1. Trong `packages/capability-host/src/dependency-lock.ts`, viết `resolveDependencyClosure(input)` nhận nguồn package (`npm` / `git` / `local`) và trả về danh sách `{ name, version, integrity, resolvedFrom }`.
  2. Resolve **trước** mọi bước build/quarantine-execute; nếu resolve thất bại, install fail closed với lý do rõ ràng.
  3. Ghi nhận `resolvedFrom` để phân biệt provenance npm/git/local; không giả định ba nguồn có cùng semantics.
- Success criteria: floating range (`^1.2.0`, `latest`) được resolve thành version chính xác trước build.
- Verify: `pnpm exec vitest run packages/capability-host/test/dependency-lock.spec.ts` exits 0 và case "floating resolves to exact" pass.

### Task 3.2 — Lock artifact bất biến + digest
- Goal: có một artifact đóng băng và một digest ổn định để bind consent.
- Steps:
  1. Materialize lock artifact (cấu trúc deterministic, key đã sort) và tính digest bằng hàm hash đã dùng trong repo (không tự phát minh).
  2. Bind `lockRef` + `lockDigest` vào install plan và `FacetGeneration`.
  3. Persist lock reference cạnh plan/generation; nếu cần cột mới, thêm migration **mới** và chạy `VACUUM INTO` backup trước khi chạy migration trên DB có dữ liệu.
  4. Đảm bảo build/activate chỉ đọc lock artifact đã persist, không đọc lại package manager metadata.
- Success criteria: hai lần build cùng input cho cùng digest; digest đổi khi bất kỳ version/integrity/build input nào đổi.
- Verify: `pnpm exec vitest run packages/capability-host/test/dependency-lock.spec.ts` exits 0 với assertion digest ổn định.

### Task 3.3 — Drift invalidates consent
- Goal: đổi dependency thì consent cũ hết hiệu lực.
- Steps:
  1. Khi build phát hiện metadata resolve ra closure khác `lockDigest` đã được consent, **fail** với lý do nêu rõ dependency nào đổi.
  2. Không tự động re-resolve rồi chạy tiếp.
  3. Missing hoặc mutated lock material ⇒ fail closed, không fallback im lặng.
- Success criteria: case drift trả về lỗi nêu tên dependency; case lock thiếu/hỏng không chạy build.
- Verify: `pnpm exec vitest run packages/capability-host/test/dependency-lock.spec.ts` exits 0 với case "drift invalidates" và "missing lock fails closed".

### Task 3.4 — Giữ nguyên supply-chain guarantee
- Goal: không nới bất kỳ bảo đảm nào đang có.
- Steps:
  1. Giữ quarantine, digest-before-inspect, isolated build process, environment tối thiểu credential, và lifecycle-script bị tắt trừ khi policy cho phép.
  2. Thêm test khẳng định lifecycle script không được cấp execution khi chưa được approve.
  3. Comment trong `packages/capability-host/src/index.ts` về dependency locking phải phản ánh đúng trạng thái sau khi làm; không để claim cũ.
  4. Không dùng package-manager lockfile như bằng chứng native code an toàn; lockfiles chỉ chứng minh reproducibility.
- Success criteria: test lifecycle-script refusal pass; comment cũ không còn nói "Not built".
- Verify: `grep -n "Not built: dependency locking" packages/capability-host/src/index.ts` không trả về kết quả.

### Task 3.5 — Gate và V08 evidence
- Steps:
  1. Chạy focused tests → `pnpm invariants` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm verify`.
  2. Chỉ cập nhật evidence V08 khi claim dependency-locking thực sự được chứng minh; nếu chưa đủ, giữ PARTIAL và nói rõ thiếu gì.
  3. Cập nhật `docs/conformance-traceability.md` và `docs/manifest.json` nếu cần.
- Success criteria: `pnpm verify` 0 failure; V08 honest.
- Verify: `pnpm verify` exits 0 và `pnpm invariants` exits 0.

## Verification

Focused tests trước, rồi `pnpm invariants`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm verify`; sau merge CI `main` xanh.

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
