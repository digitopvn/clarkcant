---
phase: 2
title: "Pi projectRoots trở thành ranh giới filesystem thật"
status: pending
priority: P1
effort: "1.5-2 ngày (sau spike A3; nếu `builtinTools: []` không được SDK tôn trọng thì ước lượng này sai và phải re-plan)"
dependencies: []
---

# Phase 2 — Pi projectRoots confinement

PR 2. Nhánh riêng từ `main` mới nhất. **Độc lập kỹ thuật với Phase 1** (Phase 1 chạm `contracts/core/runtime/web`, Phase 2 chạm `packages/pi-adapter`), nên frontmatter không còn `dependencies: [1]`. Vẫn landed theo thứ tự issue.

## Pre-task 2.0 — Spike A3 (bắt buộc, 30-60 phút, làm TRƯỚC ước lượng Phase 2)

- Goal: trả lời dứt khoát `builtinTools: []` có được SDK tôn trọng hay không.
- Căn cứ: red-team A3 đánh dấu điều này là **unverified**. Option `builtinTools?: readonly string[]` tồn tại ở `packages/pi-adapter/src/real.ts:130` và được dùng ở dòng ~403, nhưng chưa ai chứng minh SDK thực sự bỏ built-in tool khi nhận mảng rỗng.
- Steps: đọc exported types của `@earendil-works/pi-coding-agent` (chỉ trong `packages/pi-adapter`); dựng một session thật với `builtinTools: []` và kiểm `session.agent.state.tools` có còn `read`/`grep`/`find`/`ls` hay không.
- Success criteria: biết chắc một trong hai kết quả, ghi vào `evidence.md`.
- Verify: một test hoặc probe chạy được in ra danh sách tool còn lại; nếu rỗng thì ghi `builtinTools: [] honoured`.
- Nếu **không** tôn trọng: dừng, báo lại, re-plan Phase 2 thành wrap `customTools` dưới tên che (shadowing) hoặc vá tool resolution của adapter — và ước lượng lại effort.

## Ranh giới phải giữ (advisory correction)

**Containment không được đi qua `decideExecution`.** Escape path là vi phạm capability boundary của host, không phải một quyết định policy. Doc comment của `packages/core/src/execution-policy.ts` đã nói rõ enforcement phải nằm "where the act happens rather than here". Cấm tường minh việc route containment qua resolver — đây là defense-in-depth, không phải một cạnh dependency.

## Goal

`WorkerBrief.projectRoots` trở thành capability boundary filesystem do host cưỡng chế: worker đọc được bên trong root đã duyệt và không thoát ra ngoài bằng `..`, absolute path, hay symlink trỏ ra ngoài.

## Files to Create / Modify

- Create: `packages/pi-adapter/src/scoped-fs.ts` — canonical hóa root/target + containment + bốn tool đọc có bound.
- Modify: `packages/pi-adapter/src/real.ts` — dùng `builtinTools` (khai báo `builtinTools?: readonly string[]`, dùng ở dòng ~403), `customTools` và `toSdkTool`/`agent.state.tools` (dòng ~464–479); xoá `TODO(P2)` ở dòng 618 **sau** khi test xanh.
- Modify: `packages/pi-adapter/src/types.ts` — `projectRoots: string[]` (dòng 20); ghi rõ nó là ranh giới được cưỡng chế.
- Modify: `packages/pi-adapter/src/index.ts` — export seam mới.
- Modify: `apps/runtime/src/project-session.ts` — bỏ việc chỉ dùng `input.projectRoots[0]` làm cwd (dòng 48); truyền đủ roots.
- Modify: `apps/runtime/src/gateway.ts` — call site `createProjectSessionStarter` (`projectRoots: [resolution.project.path]`, dòng ~3084) truyền đủ roots đã duyệt.
- Tests: tạo `packages/pi-adapter/test/scoped-fs.spec.ts`; mở rộng test project-session hiện có.
- Docs: `docs/system-architecture.md` nếu mô tả cũ sai; `docs/manifest.json` cập nhật bytes + sha256.

## Tasks & Steps

### Task 2.1 — Root/target canonicalization và containment
- Goal: một hàm containment chỉ nhận canonical path và trả allow/deny kèm lý do.
- Steps:
  1. Trong `packages/pi-adapter/src/scoped-fs.ts`, viết `canonicalRoots(roots: readonly string[]): Promise<string[]>` dùng `fs.realpath` cho root, bỏ root không tồn tại với lý do rõ ràng (không im lặng).
  2. Viết `resolveInsideRoots(roots, target): Promise<{ ok: true; path: string } | { ok: false; reason: string }>`:
     - resolve target thành absolute theo `path.resolve`;
     - `fs.realpath` target (kể cả khi target là symlink) rồi kiểm tra containment trên **canonical** path;
     - từ chối khi kết quả không nằm trong root nào, kể cả khi path gốc nằm trong nhưng symlink trỏ ra ngoài.
  3. Từ chối cứng `..` escape và absolute path ngoài mọi root; giữ path/symlink hợp lệ resolve bên trong root.
  4. Kiểm tra root identity: nếu root đã bị thay bằng mount/symlink khác khiến đường dẫn đã duyệt không còn hợp lệ, từ chối.
- Success criteria: hàm thuần, không đọc filesystem ngoài root, không nhận nhiều hơn các root đã cho.
- Verify: `pnpm exec vitest run packages/pi-adapter/test/scoped-fs.spec.ts` exits 0.

### Task 2.2 — Bốn tool đọc có bound, do ClarkCant sở hữu
- Goal: `read`, `grep`, `find`, `ls` tương đương chạy qua containment.
- Steps:
  1. Viết bốn custom tool trong `scoped-fs.ts`, mỗi tool nhận `roots` đã canonical hóa và gọi `resolveInsideRoots` trước khi chạm filesystem.
  2. Giữ bound tường minh: số file tối đa, kích thước output tối đa, độ sâu traversal tối đa; vượt bound phải trả về kết quả bị cắt kèm lý do, không treo.
  3. Không export Node `fs` primitive thô cho Pi tool/extension.
  4. `grep`/`find` không được đi theo symlink ra ngoài root.
- Success criteria: cả bốn tool từ chối path ngoài root với lý do đọc được, và mọi kết quả đều nằm trong root.
- Verify: `pnpm exec vitest run packages/pi-adapter/test/scoped-fs.spec.ts` exits 0 và case "deny outside" có assertion trên lý do.

### Task 2.3 — Adapter dùng scoped tools thay built-in
- Goal: project worker không còn built-in filesystem tool thô.
- Steps:
  1. Trong `real.ts`, thêm đường cấu hình để session dự án chạy với `builtinTools: []` và `customTools` là bốn scoped tool; vẫn giữ `READ_ONLY_TOOLS` như mặc định cho đường hội thoại (nơi built-in đã bị tắt).
  2. Truyền `brief.projectRoots` xuống seam tạo session; không suy ra root từ cwd.
  3. Giữ `agent.state.tools` là nguồn hiển thị tool cho model, dùng `toSdkTool` như hiện có.
  4. Xoá `TODO(P2)` ở `real.ts:618` **chỉ sau** khi Task 2.4 xanh; thay bằng một câu khẳng định ranh giới đã được cưỡng chế và trỏ tới test.
- Success criteria: grep cho `READ_ONLY_TOOLS` ở đường project-session không còn trả về; TODO cũ đã bị xoá.
- Verify: `pnpm typecheck` exits 0 và `grep -n "TODO(P2)" packages/pi-adapter/src/real.ts` không trả về kết quả.

### Task 2.4 — Test thư mục tạm thật + integration project-session
- Goal: chứng minh allow-inside/deny-outside trên filesystem thật, không mock.
- Steps:
  1. Trong `packages/pi-adapter/test/scoped-fs.spec.ts`, tạo cây thư mục tạm bằng `fs.mkdtemp` gồm: file trong root, file ở sibling ngoài root, symlink trong root trỏ ra ngoài, symlink ngoài trỏ vào trong.
  2. Assert: đọc file trong root thành công; `..` escape bị từ chối; absolute path ngoài bị từ chối; symlink trỏ ra ngoài bị từ chối; symlink trỏ vào trong được chấp nhận.
  3. Assert nhiều root: hai root cùng hoạt động, file trong root thứ hai đọc được.
  4. Thêm một integration test ở tầng project-session: worker đọc được file trong project đã chọn và **không** đọc được file sibling ngoài project.
  5. Dọn thư mục tạm trong `afterEach`.
- Success criteria: tất cả case chạy thật, không case nào bị skip hay bị mock.
- Verify: `pnpm exec vitest run packages/pi-adapter/test/scoped-fs.spec.ts apps/runtime/test/project-session.confinement.spec.ts` exits 0.

### Task 2.5 — Gate
- Steps:
  1. Chạy focused tests → `pnpm invariants` → `pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm verify`.
  2. Cập nhật docs/manifest nếu file thuộc manifest bị sửa.
  3. PR description nêu rõ: ai canonical hóa, ai từ chối, vì sao cwd không phải ranh giới.
- Success criteria: `pnpm verify` 0 failure; CI terminal xanh trên đúng head.
- Verify: `pnpm verify` exits 0.

## Verification

Focused tests trước, rồi `pnpm invariants`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm verify`; sau merge CI `main` xanh. Nếu môi trường thiếu browser cho `verify:full`, ghi rõ điều kiện thiếu.

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
