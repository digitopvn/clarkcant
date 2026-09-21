---
title: "Architecture consolidation: hợp nhất policy, khoanh vùng Pi worker, khoá cài đặt, gọn hoá runtime"
description: "Sáu PR tuần tự cho issue #125: một execution policy chuẩn, projectRoots được host cưỡng chế, dependency closure đóng băng trước build, tách runtime composition, một nguồn sự thật cho implementation status, và các internal real-path proof."
status: in-progress
priority: P1
effort: "~6 PR tuần tự; mỗi PR độc lập xanh và review được"
issue: 125
branch: "architecture-consolidation-unify-policy-confine"
tags: [refactor, backend, security, tech-debt, critical, infra]
blockedBy: []
blocks: []
created: 2026-09-21
updated: 2026-09-21
---

# Architecture consolidation (issue #125)

## Outcome

ClarkCant giữ nguyên một mental model: **một conversation, một Clark**. Program này không thêm subsystem mới. Nó trả nợ tích hợp do feature velocity chạy nhanh hơn consolidation, theo đúng sáu phase trong issue #125:

1. Một execution policy chuẩn duy nhất, một resolver, cho command / widget / install / capability effect.
2. `WorkerBrief.projectRoots` trở thành ranh giới filesystem thật do host cưỡng chế.
3. Install plan mang theo dependency closure đã đóng băng trước khi build.
4. `apps/runtime` composition layer được tách theo routes/application/policy/bootstrap/test-support, không đổi behavior.
5. Một nguồn sự thật machine-readable cho implementation status, gắn với `pnpm invariants`.
6. Các internal real-path proof được đóng ở phần CI/local làm được; external gate vẫn để mở.

Mỗi phase là một PR riêng, nhánh riêng từ `main` mới nhất, merge xong mới sang phase kế tiếp. Không có PR khổng lồ, không có "xong một nửa rồi giả xanh".

## Facts từ codebase chốt plan

Các dữ kiện đã kiểm tra trực tiếp trên cây hiện tại (`026d981` + các commit sau, ngang bằng `origin/main`):

| # | Dữ kiện | Ảnh hưởng |
| --- | --- | --- |
| 1 | `packages/core/src/execution-policy.ts` (297 dòng) export `decideExecution()`, hiện chỉ được dùng bởi `packages/core/src/widget-service.ts:1190` và `apps/runtime/src/gateway.ts:1497` | Stack A mới phủ widget action + một nhánh gateway |
| 2 | `apps/runtime/src/autonomy-settings.ts` (97 dòng) đọc/ghi preference khoá `autonomy` qua `@clarkcant/storage` | Stack B là storage thật, đừng dựng storage thứ ba |
| 3 | `packages/contracts/src/execution.ts` định nghĩa `executionPolicySchema = auto \| guarded \| confirm \| deny`, `autonomySettingsSchema`, `guardClassFor()`, `DEFAULT_AUTONOMY_SETTINGS` | Vocabulary thứ hai cần fold vào policy chuẩn, không xoá mù |
| 4 | `packages/contracts/src/preferences.ts` có registry `execution.mode` (mặc định `autonomous`) và `execution.rules` | Preference cũ vẫn là nguồn đọc của widget path |
| 5 | `apps/runtime/src/node-tools.ts` có `policyForEffect()`, `decideGuardrailForCommand()`, dùng `preflightCommand()` trước guardrail | Deterministic preflight đã đứng trước model judgment — phải giữ nguyên thứ tự |
| 6 | `apps/runtime/src/preflight.ts` export `preflightCommand()`, `preflightCapability()`, `applyGuardrailConstraints()` (narrowing-only) | Đây là seam host-owned; Jev không được nới |
| 7 | `packages/conversation-client/src/settings/ControlSettings.tsx:124-127` tự ghi chú "Two policies is one more than this product wants" và render cả autonomy lẫn `execution.mode`/`execution.rules` | Có hai UI surface phải gộp thành một |
| 8 | `packages/pi-adapter/src/real.ts:618` chứa `TODO(P2): scope filesystem access to brief.projectRoots`; `types.ts:20` đã có `projectRoots: string[]` | Metadata đã có, cưỡng chế chưa có |
| 9 | `apps/runtime/src/project-session.ts:48` chỉ dùng `input.projectRoots[0]` làm cwd | Nhiều root hiện bị thu về một, phải giữ đủ |
| 10 | `apps/runtime/src/gateway.ts` ~3593 dòng, `main.ts` ~1946 dòng; route dispatch nằm trong một hàm tuần tự theo `request.path` | Phase 4 phải tách theo family, không đổi contract |
| 11 | `packages/capability-host/src/index.ts:192-193` tự ghi "Not built: dependency locking" | Phase 3 là đúng khoảng trống V08 |
| 12 | 18 chỗ `@implementation-status` rải rác (nhiều `stub`, ít `implemented`) | Phase 5 gom về một registry |
| 13 | `pnpm verify` = `invariants && typecheck && lint && test`; `pnpm verify:full` thêm `test:e2e`; CI chạy `verify` (Node 22.19 + 24), `e2e`, `desktop-smoke`, `secret-scan` | Gate thật đã có, không cần gate mới |
| 14 | `main` không được branch-protect; `allow_auto_merge = false` | Không dùng `gh pr merge --auto`; merge tường minh sau khi check xanh |
| 15 | `packages/pi-adapter` là package duy nhất được import Pi SDK | Phase 2 phải giải trong adapter, không rò ra runtime |

## Không rebuild những gì đã có

| Seam | Đã có | Cách dùng lại |
| --- | --- | --- |
| Preference storage | `readRegisteredPreference`, `putPreference`, scope + revision + undo | Migration đọc/ghi qua seam này |
| Preflight | `preflightCommand`, `preflightCapability`, `OwnedResources`, `containingRoot` | Giữ nguyên thứ tự host trước policy |
| Narrowing | `applyGuardrailConstraints` | Jev chỉ deny/clarify/constrain |
| Approval + audit | approval digest, `recordEffectExecution`, activity route | Không xoá; Ask mode vẫn cần |
| Widget trust lanes | binding digest, lease, dedup, `decideExecution` | Parity test chạy trên seam này |
| Quarantine/build | `packages/capability-host/src/quarantine.ts`, `secrets.ts`, `activateFacet` | Phase 3 chỉ thêm lock, không thay build isolation |
| Path containment | `containingRoot()` trong `preflight.ts` | Phase 2 tái dùng khái niệm canonical containment |
| Plan/task state | `ak plan`, `ak plan validate`, plan index | Program dùng cho evidence journal |

## Phases

| Phase | Name | Status |
| --- | --- | --- |
| 1 | [Canonical execution policy](./phase-01-unify-execution-policy.md) | Pending |
| 2 | [Pi projectRoots confinement](./phase-02-pi-project-roots-confinement.md) | Pending |
| 3 | [Deterministic install dependency lock](./phase-03-install-dependency-lock.md) | Pending |
| 4 | [Runtime composition decomposition](./phase-04-runtime-decomposition.md) | Pending |
| 5 | [Implementation-status source of truth](./phase-05-status-source-of-truth.md) | Pending |
| 6 | [Internal real-path proofs](./phase-06-internal-real-path-proofs.md) | Pending |

Số PR tương ứng: phase *N* = PR *N*.

Thứ tự bắt buộc: 1 → 2 → 3 → 4 → 5 → 6. Phase 4 chỉ bắt đầu khi PR 1–3 đã merge, để không phải tách hai policy system cùng lúc. Phase 2 và 3 độc lập về kỹ thuật nhưng vẫn landed tuần tự theo issue.

## Acceptance criteria

### Policy (PR 1)

- [ ] Một execution policy chuẩn duy nhất chi phối command, widget, install và capability effect.
- [ ] Mode user-facing còn đúng một bộ: Autonomous / Guarded / Ask every time.
- [ ] `execution.*` và `autonomy` cũ migrate mà không âm thầm nới lỏng cấu hình chặt hơn của user.
- [ ] Có parity test cho các effect category tương đương giữa các surface.
- [ ] Host preflight và hard boundary vẫn không bypass được.

### Pi containment (PR 2)

- [ ] `projectRoots` là ranh giới filesystem được cưỡng chế, không còn là metadata.
- [ ] `read/grep/find/ls` tương đương không thoát được bằng `..`, absolute path ngoài root, hay symlink trỏ ra ngoài.
- [ ] Nhiều approved root cùng hoạt động.
- [ ] Test trên thư mục tạm thật chứng minh allow-inside / deny-outside.
- [ ] TODO phủ nhận confinement bị xoá **sau** khi test mạnh hơn đã xanh.

### Install determinism (PR 3)

- [ ] Build input mang theo dependency closure đã đóng băng với digest/reference ổn định.
- [ ] Dependency drift invalidate plan/consent cũ.
- [ ] Build không tự re-resolve floating range.
- [ ] Bảo đảm lifecycle-script và credential-isolation còn nguyên.

### Runtime architecture (PR 4)

- [ ] `main.ts` chủ yếu là composition/startup.
- [ ] Gateway route family có dependency interface tường minh và biên sở hữu nhỏ hơn.
- [ ] Test fixture tách khỏi production composition.
- [ ] Không regression public behavior.

### Status / evidence (PR 5)

- [ ] Các claim implementation-status rải rác được reconcile về một nguồn sự thật.
- [ ] CI/invariants bắt được status reference thiếu hoặc cũ.
- [ ] PARTIAL/BLOCKED vẫn trung thực cho tới khi gate thật được chứng minh.

### Real paths (PR 6)

- [ ] Browser takeover preview được chứng minh bằng byte thật từ BrowserDriver qua runtime/client path.
- [ ] Google Calendar pack nối qua internal real connector path; live proof vẫn thuộc #2.
- [ ] #93/#3/#4/#5 vẫn linked và **không** bị "closed by fixture".

## Verification gates

Mỗi PR, theo thứ tự, ghi kết quả vào `evidence.md` của phase:

1. Test focused nhỏ nhất cho surface bị đổi.
2. `pnpm invariants`.
3. `pnpm typecheck`, `pnpm lint`, `pnpm test`.
4. `pnpm verify` — 0 failure.
5. Journey nhìn thấy được: `pnpm test:e2e` và `pnpm verify:full` sau khi giải phóng port 8876 và 4273.
6. PR check terminal và xanh trên đúng head đã review; sau merge, CI trên `main` xanh cho merge commit.
7. Fixture evidence phải được ghi nhãn là fixture evidence. Check bị môi trường chặn phải báo đúng điều kiện thiếu, không được chuyển thành skip xanh.

## Failure Protocol

Mọi phase file trong plan này đều chứa Failure Protocol. Khi một Verify step không đạt pass condition đã nêu: DỪNG phase, không tự sửa, không retry mù, không suy luận vòng quanh failure. Spawn subagent `kongming` với phase/task id, các bước đã chạy, command đầy đủ và output đầy đủ, và pass condition bị trượt. Áp dụng counsel rồi chạy lại Verify. Nếu không spawn được `kongming`, DỪNG và báo lại đúng failure evidence cho user.

## Merge và delivery constraints

Sáu PR là sáu lần merge vào `main`. Bốn ràng buộc cố định cho mọi PR:

1. **Merge bind reviewed SHA.** `main` không được branch-protect và `allow_auto_merge = false`, nên `gh pr merge --auto` không dùng được. Merge bằng `gh pr merge --merge --match-head-commit <sha>`, và ghi `<sha>` + URL run xanh vào `evidence.md`. Sau **mọi** rebase phải chạy lại `pnpm verify` trước khi merge.
2. **No auto-close, từ Phase 1 trở đi.** Mỗi PR body phải ghi rõ PR đó **không** đóng `#93`/`#2`/`#3`/`#4`/`#5` và không được chứa keyword `Closes`/`Fixes` cho chúng. Ở repo không có branch protection thì auto-close xảy ra ngay lúc merge, nên kiểm ở Phase 6 là quá muộn.
3. **Một PR mỗi phase, nhánh riêng từ `main` mới nhất.** Phase sau chỉ bắt đầu khi phase trước đã merge và CI trên `main` xanh cho merge commit.
4. **PR 1 là behavior change, không phải refactor.** PR body phải công bố điều đó cùng behavior-change ledger, không được mô tả là "không đổi hành vi".

## Advisory decisions đã chốt

Các quyết định dưới đây đã được kongming advisory checkpoint xác nhận hoặc điều chỉnh, và đã materialize vào phase-01 (mục "Advisory corrections"):

- Canonical default là `autonomous` theo `DESIGN.md` §1.3, §5.3 và `AGENTS.md`. `DEFAULT_EXECUTION_POLICY = "guarded"` và `DEFAULT_AUTONOMY_SETTINGS.executionPolicy = "guarded"` là drift legacy, không phải authority.
- Legacy `deny` được biểu diễn bằng field cấu trúc `prohibition`, **không** bằng 7 deny-rule đếm được, và được đánh giá trên `hardBoundary`.
- Precedence công bố: `prohibition > hard boundary > rules > mode`; Jev được gọi iff `guardrail.enabled && guardClass(effect) ∈ guardrail.classes`.
- Chỉ **một** module được đọc policy preference.

## Ngoài phạm vi

- #93 (isolated widget trust hardening), #2 (Google Calendar live account), #3 (Computer Use signing), #4 (live voice provider), #5 (two-host NodeLink). Không đóng, không chứng minh bằng fixture.
- Redesign `contracts`, `core`, `storage`, `pi-adapter` trust lanes, widget trust lanes, hay NodeLink chỉ để file nhỏ hơn.
- Surface/navigation mới; thay đổi UX invariant không có trong DESIGN.md.
- Sửa migration đã apply trong `packages/storage/src/migrate.ts`.
- Một PR gộp cho toàn program.
